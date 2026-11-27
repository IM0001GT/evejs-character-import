"use strict";

/**
 * Import a character's paper doll (sculpts / modifiers / colors / hair) out of
 * an EVE client's own on-disk method-call cache and into an EveJS gameStore.
 *
 * No public API exposes doll data — ESI only serves rendered portrait JPEGs.
 * The client, however, persists every `paperDollServer.GetPaperDollData` reply
 * it receives as a marshalled CachedMethodCallResult under
 *
 *   <client cache>/MachoNet/<address>/<version>/CachedMethodCalls/<hash>.cache
 *
 * so a doll the client has rendered is already sitting on this machine. This
 * module decodes those files with the server's own marshal implementation and
 * rewrites them into the shape `characters.appearanceInfo` holds, which is the
 * shape the client itself uploads through
 * paperDollServer.UpdateExistingCharacter*.
 *
 * The two shapes are NOT the same. The cached reply carries CRowsets of packed
 * rows; the stored record carries plain row objects whose header tuple is
 * [token, ...column values]. Converting between them is what this module does.
 */

const fs = require("fs");
const path = require("path");

const { REPO_ROOT } = require("./paths");

const CALL_SERVICE = "paperDollServer";
const CALL_METHOD = "GetPaperDollData";

const PAPERDOLL_DEFINITIONS = "eve.common.script.paperDoll.paperDollDefinitions";
const ROW_TOKENS = Object.freeze({
  colors: `${PAPERDOLL_DEFINITIONS}.ColorSelectionRow`,
  modifiers: `${PAPERDOLL_DEFINITIONS}.ModifierRow`,
  sculpts: `${PAPERDOLL_DEFINITIONS}.SculptingRow`,
  appearance: `${PAPERDOLL_DEFINITIONS}.AppearanceRow`,
});

/**
 * Column order inside each row's header tuple. Names are matched against the
 * DBRowDescriptor of the cached packed row; the aliases exist because that
 * descriptor decodes `colorNameB` as `colorNameBC` on at least one client
 * build, and the positional fallback covers a build that renames a column
 * without moving it.
 */
const ROW_COLUMNS = Object.freeze({
  colors: [
    { names: ["colorID"], fallbackIndex: 0, integer: true },
    { names: ["colorNameA"], fallbackIndex: 1, integer: true },
    { names: ["colorNameB", "colorNameBC"], fallbackIndex: 2, integer: true },
    { names: ["weight"], fallbackIndex: 3 },
    { names: ["gloss"], fallbackIndex: 4 },
  ],
  modifiers: [
    { names: ["modifierLocationID"], fallbackIndex: 0, integer: true },
    { names: ["paperdollResourceID"], fallbackIndex: 1, integer: true },
    { names: ["paperdollResourceVariation"], fallbackIndex: 2, integer: true },
  ],
  sculpts: [
    { names: ["sculptLocationID"], fallbackIndex: 0, integer: true },
    { names: ["weightUpDown"], fallbackIndex: 1 },
    { names: ["weightLeftRight"], fallbackIndex: 2 },
    { names: ["weightForwardBack"], fallbackIndex: 3 },
  ],
  // The cached appearance row is (lastUpdate, hairDarkness); only the second
  // column survives into the stored AppearanceRow.
  appearance: [{ names: ["hairDarkness"], fallbackIndex: 1 }],
});

function loadMarshal() {
  return require(
    path.join(REPO_ROOT, "server", "src", "network", "tcp", "utils", "marshal.js"),
  );
}

function loadPaperDollPayloads() {
  return require(
    path.join(
      REPO_ROOT,
      "server",
      "src",
      "services",
      "character",
      "paperDollPayloads.js",
    ),
  );
}

function toText(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value && typeof value === "object" && value.type === "token") {
    return toText(value.value);
  }
  return typeof value === "string" ? value : "";
}

function toNumber(value, fallback = null) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = toNumber(value, null);
  if (numeric === null) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
}

// ───────────────────────────────────────────────────────────────────────────
//  Locating client caches
// ───────────────────────────────────────────────────────────────────────────

/**
 * Roots that may hold a `CCP/EVE/<tree>/cache` layout: the native Windows
 * location plus the Wine/Proton prefixes the portrait helper already walks.
 */
function candidateEveRoots() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const roots = [];
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, "CCP", "EVE"));
  }
  if (home) {
    roots.push(path.join(home, "AppData", "Local", "CCP", "EVE"));
    const prefixUsers = path.join(home, "evejs-prefix", "pfx", "drive_c", "users");
    if (fs.existsSync(prefixUsers)) {
      for (const entry of fs.readdirSync(prefixUsers, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        roots.push(
          path.join(prefixUsers, entry.name, "AppData", "Local", "CCP", "EVE"),
        );
      }
    }
  }

  const seen = new Set();
  return roots.filter((root) => {
    const abs = path.resolve(root);
    if (seen.has(abs) || !fs.existsSync(abs)) return false;
    seen.add(abs);
    return true;
  });
}

function collectCachedMethodCallDirs(root, maxDepth) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "CachedMethodCalls") {
        out.push(full);
      } else {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return out;
}

/**
 * Find CachedMethodCalls directories.
 *
 * Cache trees are named `<install path>_<server>`, so the default filter keeps
 * only `*_tranquility` — a tree belonging to a private server holds dolls this
 * tool would just be copying back onto themselves.
 *
 * @param {{cacheDir?: string, allServers?: boolean}} options
 * @returns {Array<{dir: string, tree: string}>}
 */
function findCachedMethodCallDirs(options = {}) {
  if (options.cacheDir) {
    const explicit = path.resolve(options.cacheDir);
    if (!fs.existsSync(explicit)) {
      throw new Error(`Cache directory not found: ${explicit}`);
    }
    // Accept the CachedMethodCalls directory itself or any parent of one.
    if (path.basename(explicit) === "CachedMethodCalls") {
      return [{ dir: explicit, tree: explicit }];
    }
    return collectCachedMethodCallDirs(explicit, 6).map((dir) => ({
      dir,
      tree: explicit,
    }));
  }

  const found = [];
  for (const root of candidateEveRoots()) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!options.allServers && !/_tranquility$/i.test(entry.name)) continue;
      const machoNet = path.join(root, entry.name, "cache", "MachoNet");
      if (!fs.existsSync(machoNet)) continue;
      for (const dir of collectCachedMethodCallDirs(machoNet, 4)) {
        found.push({ dir, tree: path.join(root, entry.name) });
      }
    }
  }
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
//  Reading cached GetPaperDollData replies
// ───────────────────────────────────────────────────────────────────────────

function dictEntries(value) {
  if (!value || typeof value !== "object") return [];
  if (value.type === "dict" && Array.isArray(value.entries)) return value.entries;
  return [];
}

function dictLookup(value, key) {
  for (const [entryKey, entryValue] of dictEntries(value)) {
    if (toText(entryKey) === key) return entryValue;
  }
  return null;
}

function isKeyVal(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.type === "object" &&
      toText(value.name).endsWith("KeyVal"),
  );
}

/**
 * A cache file decodes to [callKey, resultDict]. The doll appears twice: as
 * `lret` (the decoded local return) and inside `rret` as a substream. Prefer
 * `lret`, fall back to the substream so a file written without a local copy
 * still imports.
 */
function extractKeyVal(resultDict) {
  const local = dictLookup(resultDict, "lret");
  if (isKeyVal(local)) return local;

  const remote = dictLookup(resultDict, "rret");
  const remoteArgs = remote && remote.args;
  const items = remoteArgs && Array.isArray(remoteArgs.items) ? remoteArgs.items : [];
  for (const item of items) {
    if (item && item.type === "substream" && isKeyVal(item.value)) {
      return item.value;
    }
    if (isKeyVal(item)) return item;
  }
  return null;
}

/**
 * Decode one .cache file. Returns null for anything that is not a decodable
 * GetPaperDollData reply.
 *
 * @param {string} filePath
 * @returns {null|{tqCharacterID:number, keyVal:object, filePath:string, mtimeMs:number}}
 */
function readCachedDoll(filePath) {
  const { marshalDecode } = loadMarshal();
  let decoded;
  try {
    decoded = marshalDecode(fs.readFileSync(filePath));
  } catch (_) {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length < 2) return null;

  const callKey = decoded[0];
  if (!Array.isArray(callKey) || callKey.length < 3) return null;
  if (toText(callKey[0]) !== CALL_SERVICE) return null;
  if (toText(callKey[1]) !== CALL_METHOD) return null;

  const tqCharacterID = toPositiveInt(callKey[2], 0);
  if (tqCharacterID <= 0) return null;

  const keyVal = extractKeyVal(decoded[1]);
  if (!keyVal) return null;

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch (_) {
    mtimeMs = 0;
  }

  return { tqCharacterID, keyVal, filePath, mtimeMs };
}

/**
 * Scan every cache directory, keeping the newest reply per character.
 *
 * @param {Array<{dir:string}>} cacheDirs
 * @returns {{dolls: Map<number, object>, scanned: number}}
 */
function scanCachedDolls(cacheDirs) {
  const dolls = new Map();
  let scanned = 0;
  for (const { dir } of cacheDirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".cache")) continue;
      scanned += 1;
      const doll = readCachedDoll(path.join(dir, entry.name));
      if (!doll) continue;
      const existing = dolls.get(doll.tqCharacterID);
      if (!existing || doll.mtimeMs > existing.mtimeMs) {
        dolls.set(doll.tqCharacterID, doll);
      }
    }
  }
  return { dolls, scanned };
}

// ───────────────────────────────────────────────────────────────────────────
//  Cached reply  ->  characters.appearanceInfo
// ───────────────────────────────────────────────────────────────────────────

function packedRowFields(row) {
  if (!row || typeof row !== "object" || row.type !== "packedrow") return null;
  if (row.fields && typeof row.fields === "object") return row.fields;

  // Decode paths that expose columns/values instead of a field map.
  const fields = {};
  const columns = Array.isArray(row.columns) ? row.columns : [];
  const values = Array.isArray(row.values) ? row.values : [];
  columns.forEach((column, index) => {
    const name = toText(Array.isArray(column) ? column[0] : column && column.name);
    if (name) fields[name] = values[index];
  });
  return fields;
}

function pickColumn(fields, spec, index) {
  for (const name of spec.names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) {
      return fields[name];
    }
  }
  // Descriptor names drifted: fall back to declaration order.
  const keys = Object.keys(fields);
  const position = spec.fallbackIndex !== undefined ? spec.fallbackIndex : index;
  const fallbackKey = keys[position];
  return fallbackKey === undefined ? null : fields[fallbackKey];
}

function buildRow(kind, fields) {
  const values = ROW_COLUMNS[kind].map((spec, index) => {
    const raw = pickColumn(fields, spec, index);
    if (raw === null || raw === undefined) return null;
    const numeric = toNumber(raw, null);
    if (numeric === null) return null;
    return spec.integer ? Math.trunc(numeric) : numeric;
  });

  return {
    type: "objectex2",
    header: [[{ type: "token", value: ROW_TOKENS[kind] }, ...values]],
    list: [],
    dict: [],
  };
}

function rowsetRows(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.list)) return value.list;
  if (Array.isArray(value.items)) return value.items;
  return [];
}

/**
 * Rewrite a decoded GetPaperDollData KeyVal into the record shape the server
 * persists and hands straight back from GetPaperDollData.
 *
 * @param {object} keyVal
 * @returns {{appearanceInfo: object, counts: object, hairDarkness: number|null}}
 */
function buildAppearanceInfo(keyVal) {
  const args = keyVal && keyVal.args;
  const counts = { colors: 0, modifiers: 0, sculpts: 0 };

  const listFor = (kind) => {
    const items = [];
    for (const row of rowsetRows(dictLookup(args, kind))) {
      const fields = packedRowFields(row);
      if (!fields) continue;
      items.push(buildRow(kind, fields));
      counts[kind] += 1;
    }
    return { type: "list", items };
  };

  const colors = listFor("colors");
  const modifiers = listFor("modifiers");
  const sculpts = listFor("sculpts");

  if (counts.sculpts === 0 && counts.modifiers === 0) {
    throw new Error("cached reply carried no sculpt or modifier rows");
  }

  const appearanceFields = packedRowFields(dictLookup(args, "appearance")) || {};
  const hairDarkness = toNumber(
    pickColumn(appearanceFields, ROW_COLUMNS.appearance[0], 0),
    null,
  );

  // Entry order matches what the client uploads on save.
  const appearanceInfo = {
    type: "object",
    name: "utillib.KeyVal",
    args: {
      type: "dict",
      entries: [
        ["colors", colors],
        ["modifiers", modifiers],
        ["appearance", buildRow("appearance", appearanceFields)],
        ["sculpts", sculpts],
      ],
    },
  };

  // Normalise through the server's own helper so what lands in the record is
  // exactly what the server would have stored from a client upload.
  const { clonePaperDollPayload } = loadPaperDollPayloads();
  return {
    appearanceInfo: clonePaperDollPayload(appearanceInfo),
    counts,
    hairDarkness,
  };
}

// ───────────────────────────────────────────────────────────────────────────
//  Writing into the gameStore
// ───────────────────────────────────────────────────────────────────────────

/**
 * Apply appearance updates to a gameStore.
 *
 * Writes go through the server's own gameStore module (lib/gameStoreJob.js):
 * from 261125.x the `characters` table is a typed view that refuses
 * `UPDATE ... SET json`, and a record the schema does not accept is refused.
 *
 * The server keeps characters in an in-memory cache that flushes over the
 * file, so it must be stopped before this runs — see hasRunningVolumeUsers().
 *
 * @param {{docker: ?object, sqlitePath: ?string, updates: Array, dryRun: boolean}} options
 * @returns {Array<{localCharacterID:number, ok:boolean, error?:string, replaced?:boolean}>}
 */
function writeAppearanceUpdates(options = {}) {
  const updates = options.updates || [];
  if (updates.length === 0 || options.dryRun) {
    return updates.map((entry) => ({
      localCharacterID: entry.localCharacterID,
      ok: true,
      dryRun: true,
    }));
  }

  const { spawnJob } = require("./gameStoreJob");
  if (options.docker) {
    return spawnJob("appearance", { updates }, { docker: options.docker });
  }
  if (!options.sqlitePath) {
    throw new Error("No gameStore sqlite path resolved for host write");
  }
  // The store resolves <dataDir>/../gamestore.sqlite.
  return spawnJob("appearance", { updates }, {
    dataDir: path.join(path.dirname(options.sqlitePath), "data"),
    repoRoot: REPO_ROOT,
  });
}

/**
 * Running containers that mount the gameStore volume.
 *
 * Only the server owns the character rows — it caches them in memory and
 * flushes over the file, so an external edit made while it runs is silently
 * undone. The market containers mount the same volume but keep their state in
 * their own sqlite, so they are reported without blocking; splitting the two
 * matters because otherwise `docker compose stop server` would never be enough
 * to clear the check.
 *
 * @param {string} volume
 * @returns {{blocking: string[], other: string[]}}
 */
function hasRunningVolumeUsers(volume) {
  const { spawnSync } = require("child_process");
  const empty = { blocking: [], other: [] };

  const ps = spawnSync("docker", ["ps", "--format", "{{.ID}}"], {
    encoding: "utf8",
  });
  if (ps.status !== 0) return empty;

  const ids = String(ps.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length === 0) return empty;

  const inspect = spawnSync(
    "docker",
    [
      "inspect",
      ...ids,
      "--format",
      '{{.Name}}\t{{index .Config.Labels "com.docker.compose.service"}}\t{{range .Mounts}}{{.Name}} {{end}}',
    ],
    { encoding: "utf8" },
  );
  if (inspect.status !== 0) return empty;

  const users = { blocking: [], other: [] };
  for (const line of String(inspect.stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawName, service = "", mounts = ""] = line.split("\t");
    if (!mounts.split(/\s+/).includes(volume)) continue;
    const name = rawName.replace(/^\//, "");
    // "market" and "marketmanager" both contain "market" but not "server".
    const isServer = /(^|[^a-z])server([^a-z]|$)/i.test(service || name);
    users[isServer ? "blocking" : "other"].push(name);
  }
  return users;
}

module.exports = {
  CALL_METHOD,
  CALL_SERVICE,
  ROW_COLUMNS,
  ROW_TOKENS,
  buildAppearanceInfo,
  findCachedMethodCallDirs,
  hasRunningVolumeUsers,
  readCachedDoll,
  scanCachedDolls,
  writeAppearanceUpdates,
};
