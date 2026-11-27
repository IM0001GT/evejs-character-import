#!/usr/bin/env node
"use strict";

/**
 * EveJS Character Import
 *
 * Load a personal character data export into a local EveJS gameStore.
 * Does not perform ESI SSO. Expects a standard export folder layout
 * (account.json + characters/).
 */

const path = require("path");
const fs = require("fs");
const readline = require("readline");

const {
  ensureDataRoot,
  ensureDir,
} = require("./lib/config");
const { convertDump } = require("./lib/convert");
const {
  DEFAULT_DUMP_ROOT,
  DEFAULT_BUNDLE_ROOT,
  DEFAULT_CONFIG_PATH,
  JITA_44_STATION_ID,
  REPO_ROOT,
} = require("./lib/paths");

function printHelp() {
  console.log(`
EveJS Character Import  v1.1.3
==============================

Convert a personal character *data export* folder into an EveJS players-bundle
and load it into a local EveJS gameStore (Docker or host).

This tool does not talk to Tranquility or perform ESI SSO. Provide an export
directory that contains account.json and characters/ (standard ESI dump layout).

Usage:
  node tools/evejs-character-import/evejs-character-import.js <command> [options]

Commands:
  package               Build players-bundle.json from an export directory
  import                Load a bundle into a STOPPED EveJS gameStore
  portraits             Download face JPEGs for imported characters
  restore-portraits     Re-sync faces after a server upgrade
  import-appearance     Copy paper dolls out of an EVE client cache into the DB
  repair-fittings       Fix already-imported fitted modules/charges in live DB
  help

Options:
  --export-dir <path>   Character data export folder
  --dump <path>         Alias for --export-dir
  --bundle <path>       players-bundle.json path
  --username <name>     Filter / label for portraits
  --fallback-station <id>  Default ${JITA_44_STATION_ID} (Jita 4-4 remaps)
  --type-data <path>    EveJS itemTypes/data.json (required for correct fittings;
                        also --types-json; auto-detects gameStore / Docker)
  --target <dataDir>    Native/host gameStore *data* dir (skips Docker)
  --host-only, --native Force native/host DB (not Docker)
  --volume <name>       Docker volume (auto-detect evejs-data / evejs-xeve-data)
  --image <name>        Docker image (auto-detect evejs-local / evejs-xeve-local)
  --on-conflict <mode>  skip|rename|overwrite (default skip)
  --dry-run
  --sync-only           restore-portraits: host JPGs to volume only
  --force-download      restore-portraits: re-download faces
  --cache-dir <path>    import-appearance: EVE client cache dir to read
  --all-caches          import-appearance: include non-Tranquility cache trees
  --list                import-appearance: show cached dolls, write nothing
  --map <local>=<src>   import-appearance: pair one character by hand (repeatable)
  --overwrite           import-appearance: replace an existing stored doll
  --no-interactive      Do not prompt when multiple Docker volumes exist

Examples:
  node tools/evejs-character-import/evejs-character-import.js package --export-dir /path/to/export-folder
  node tools/evejs-character-import/evejs-character-import.js import --bundle path/to/players-bundle.json
  node tools/evejs-character-import/evejs-character-import.js restore-portraits
  node tools/evejs-character-import/evejs-character-import.js import-appearance --list
`);
}

function parseArgs(argv) {
  const args = {
    command: null,
    username: null,
    dump: null,
    bundle: null,
    fallbackStation: JITA_44_STATION_ID,
    target: null,
    dryRun: false,
    onConflict: "skip",
    reuseTokens: false,
    interactive: true,
    maxCharacters: 0,
    out: null,
    hostOnly: false,
    volume: null,
    image: null,
    syncOnly: false,
    forceDownload: false,
    withEvejsImport: false,
    cacheDir: null,
    allCaches: false,
    list: false,
    overwrite: false,
    map: [],
    typesJson: null,
    typeData: null,
    help: false,
  };

  if (argv.length === 0) {
    args.help = true;
    return args;
  }

  if (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    args.help = true;
    return args;
  }
  args.command = argv[0];
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--username":
        args.username = next();
        break;
      case "--dump":
        args.dump = next();
        break;
      case "--bundle":
        args.bundle = next();
        break;
      case "--fallback-station":
        args.fallbackStation = Number(next()) || JITA_44_STATION_ID;
        break;
      case "--target":
        args.target = next();
        break;
      case "--host-only":
      case "--native":
        args.hostOnly = true;
        break;
      case "--volume":
        args.volume = next();
        break;
      case "--image":
        args.image = next();
        break;
      case "--sync-only":
        args.syncOnly = true;
        break;
      case "--force-download":
        args.forceDownload = true;
        break;
      case "--cache-dir":
        args.cacheDir = next();
        break;
      case "--all-caches":
        args.allCaches = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--overwrite":
        args.overwrite = true;
        break;
      case "--map": {
        // --map <localCharacterID>=<sourceCharacterID>
        const pair = String(next() || "");
        const [left, right] = pair.split("=");
        const localCharacterID = Number(left);
        const tqCharacterID = Number(right);
        if (!(localCharacterID > 0) || !(tqCharacterID > 0)) {
          throw new Error(`Invalid --map value: ${pair} (expected <localID>=<sourceID>)`);
        }
        args.map.push({ localCharacterID, tqCharacterID });
        break;
      }
      case "--with-evejs-import":
      case "--import-evejs":
        args.withEvejsImport = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--on-conflict":
        args.onConflict = next();
        break;
      case "--reuse-tokens":
        args.reuseTokens = true;
        break;
      case "--no-interactive":
        args.interactive = false;
        break;
      case "--max-characters":
        args.maxCharacters = Number(next()) || 0;
        break;
      case "--out":
        args.out = next();
        break;
      case "--types-json":
      case "--type-data":
        args.typesJson = next();
        args.typeData = args.typesJson;
        break;
      case "--export-dir":
        args.dump = next();
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        args.help = true;
    }
  }
  return args;
}

function ask(question, defaultValue = "") {
  if (!process.stdin.isTTY) {
    return Promise.resolve(defaultValue);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const hint = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${hint}: `, (answer) => {
      rl.close();
      const text = String(answer || "").trim();
      resolve(text || defaultValue);
    });
  });
}

async function cmdSetup() {
  ensureDataRoot();
  const existing = loadSsoConfig();
  console.log("EVE SSO application setup");
  console.log("Create an app at: https://developers.eveonline.com/");
  console.log("Callback URL must be exactly: http://127.0.0.1:8731/callback");
  console.log("Enable all character READ scopes listed in tools/tq-import/README.md");
  console.log("");

  const clientId = await ask("Client ID", existing.clientId || "");
  if (!clientId) {
    throw new Error("Client ID is required");
  }
  const clientSecret = await ask(
    "Client Secret (leave blank for PKCE / native app)",
    existing.clientSecret || "",
  );
  const callbackUrl = await ask(
    "Callback URL",
    existing.callbackUrl || "http://127.0.0.1:8731/callback",
  );

  const saved = saveSsoConfig({
    clientId,
    clientSecret: clientSecret || null,
    callbackUrl,
    callbackPort: 8731,
    usePkce: !clientSecret,
  });
  console.log(`\nSaved SSO config → ${DEFAULT_CONFIG_PATH}`);
  console.log(JSON.stringify({ ...saved, clientSecret: saved.clientSecret ? "(set)" : null }, null, 2));
}

function resolveDumpPath(dumpArg) {
  if (!dumpArg) return null;
  if (fs.existsSync(dumpArg)) {
    return path.resolve(dumpArg);
  }
  const under = path.join(DEFAULT_DUMP_ROOT, dumpArg);
  if (fs.existsSync(under)) {
    return under;
  }
  return path.resolve(dumpArg);
}

async function cmdDump(args) {
  const ssoConfig = loadSsoConfig();
  if (!ssoConfig.clientId) {
    throw new Error("SSO not configured. Run: node tools/tq-import/tq-import.js setup");
  }
  if (!args.username) {
    throw new Error("--username is required (local login name for this TQ account)");
  }

  return dumpAccount({
    username: args.username,
    ssoConfig,
    fallbackStationID: args.fallbackStation,
    reuseTokens: args.reuseTokens,
    interactive: args.interactive,
    maxCharacters: args.maxCharacters,
  });
}

/**
 * An export dir is either one account folder (account.json + characters/),
 * or a parent holding several of them (shared exports/ root).
 */
function listExportDirs(root) {
  if (fs.existsSync(path.join(root, "account.json"))) {
    return [root];
  }
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name))
    .filter((dir) => fs.existsSync(path.join(dir, "account.json")));
}

async function cmdConvert(args) {
  const dumpPath = resolveDumpPath(args.dump);
  if (!dumpPath) {
    throw new Error("--export-dir <path> is required (character data export folder)");
  }
  if (!fs.existsSync(dumpPath)) {
    throw new Error(`Dump not found: ${dumpPath}`);
  }

  const exportDirs = listExportDirs(dumpPath);
  if (exportDirs.length === 0) {
    throw new Error(
      `No account.json in ${dumpPath}, and no subfolder contains one either.\n` +
        "Point --export-dir at an export folder (account.json + characters/) " +
        "or at the exports/ root that holds them.",
    );
  }

  const results = [];
  for (const dir of exportDirs) {
    if (exportDirs.length > 1) {
      console.log(`\n=== ${path.basename(dir)} ===`);
    }
    results.push(
      convertDump(dir, {
        username: args.username,
        fallbackStationID: args.fallbackStation,
        typeDataPath: args.typeData || args.typesJson,
        typesJson: args.typesJson || args.typeData,
        out: exportDirs.length === 1 ? args.out || args.bundle : undefined,
      }),
    );
  }
  return exportDirs.length === 1 ? results[0] : results;
}

/**
 * Known Docker layouts:
 *   Stock EveJS 0.12.x : volume evejs-data,       image evejs-local
 *   DML / evejs-xeve    : volume evejs-xeve-data,  image evejs-xeve-local
 * Plus fuzzy matches for renamed compose projects.
 */
const DOCKER_VOLUME_PREFERRED = [
  "evejs-xeve-data",
  "evejs-data",
];
const DOCKER_IMAGE_PREFERRED = [
  "evejs-xeve-local",
  "evejs-local",
];

function dockerAvailable() {
  const { spawnSync } = require("child_process");
  const r = spawnSync("docker", ["info"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0;
}

function listDockerVolumes() {
  const { spawnSync } = require("child_process");
  const r = spawnSync("docker", ["volume", "ls", "--format", "{{.Name}}"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  return String(r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function listDockerImages() {
  const { spawnSync } = require("child_process");
  // Repository names only (ignore tags for matching local builds)
  const r = spawnSync(
    "docker",
    ["images", "--format", "{{.Repository}}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return [];
  const seen = new Set();
  const out = [];
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    const name = line.trim();
    if (!name || name === "<none>") continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function isEvejsDataVolume(name) {
  const n = String(name || "").toLowerCase();
  if (!n.includes("evejs")) return false;
  // Prefer names that look like data volumes for the game server
  if (n.includes("data")) return true;
  // e.g. project_evejs-data style without extra words
  if (/(^|[-_])evejs([-_].*)?$/.test(n) && !n.includes("log")) return false;
  return false;
}

function isEvejsServerImage(name) {
  const n = String(name || "").toLowerCase();
  if (!n.includes("evejs")) return false;
  if (n.includes("web") || n.includes("companion")) return false;
  // local build tags used by compose
  if (n.endsWith("-local") || n.includes("local")) return true;
  if (n === "evejs" || n.endsWith("/evejs")) return true;
  return false;
}

function guessImageForVolume(volumeName, availableImages) {
  const v = String(volumeName || "").toLowerCase();
  const images = availableImages || [];
  const prefer = [];
  if (v.includes("xeve")) {
    prefer.push("evejs-xeve-local", "evejs-local");
  } else {
    prefer.push("evejs-local", "evejs-xeve-local");
  }
  for (const name of prefer) {
    if (images.includes(name)) return name;
  }
  // Fuzzy: first evejs*local image
  const fuzzy = images.find((n) => isEvejsServerImage(n));
  return fuzzy || prefer[0];
}

function promptChoice(question, options) {
  // options: [{ label, value }]
  if (!options.length) return null;
  if (options.length === 1) return options[0].value;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    console.log(question);
    options.forEach((opt, i) => {
      console.log(`  ${i + 1}) ${opt.label}`);
    });
    rl.question(`Pick 1-${options.length} [1]: `, (answer) => {
      rl.close();
      const raw = String(answer || "").trim();
      if (!raw) {
        resolve(options[0].value);
        return;
      }
      const idx = Number(raw);
      if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
        resolve(options[idx - 1].value);
        return;
      }
      // allow typing the volume/image name
      const byValue = options.find((o) => o.value === raw);
      if (byValue) {
        resolve(byValue.value);
        return;
      }
      console.log(`Invalid choice; using ${options[0].label}`);
      resolve(options[0].value);
    });
  });
}

/**
 * Resolve Docker volume + image for import / portraits / list.
 * Supports stock EveJS (evejs-data / evejs-local) and DML (evejs-xeve-*).
 *
 * @param {object} args
 * @returns {Promise<null|{volume,image,dataDir,label}>}
 */

/**
 * Candidate native/host gameStore data dirs for this checkout.
 * EveJS keeps runtime DB at <dataDir>/../gamestore.sqlite.
 */
function listHostGameStoreDataDirs() {
  const candidates = [];
  const seen = new Set();
  const add = (dir, label) => {
    if (!dir) return;
    const abs = path.resolve(dir);
    if (seen.has(abs)) return;
    const sqlite = path.join(abs, "..", "gamestore.sqlite");
    const hasData =
      fs.existsSync(path.join(abs, "itemTypes", "data.json")) ||
      fs.existsSync(path.join(abs, "..", "manifest.json")) ||
      fs.existsSync(sqlite);
    if (!hasData && !fs.existsSync(abs)) return;
    seen.add(abs);
    candidates.push({ dataDir: abs, label, sqlitePath: path.resolve(sqlite) });
  };

  if (process.env.EVEJS_GAMESTORE_DATA_DIR) {
    add(process.env.EVEJS_GAMESTORE_DATA_DIR, "EVEJS_GAMESTORE_DATA_DIR");
  }
  add(path.join(REPO_ROOT, "_local", "gameStore", "data"), "_local/gameStore/data");
  add(path.join(REPO_ROOT, "server", "src", "gameStore", "data"), "server/src/gameStore/data");
  return candidates;
}

/**
 * Normalize a user --target path to the EveJS *data* dir.
 *
 * Accepts either:
 *   .../_local/gameStore/data     (correct)
 *   .../_local/gameStore          (store root; common mistake)
 *   .../_local/gameStore/gamestore.sqlite
 */
function normalizeHostDataDir(inputPath) {
  let abs = path.resolve(inputPath);
  const base = path.basename(abs);

  if (base === "gamestore.sqlite" || base.endsWith(".sqlite")) {
    // .../gameStore/gamestore.sqlite -> .../gameStore/data
    abs = path.join(path.dirname(abs), "data");
  } else if (base === "gameStore" || base === "newDatabase") {
    // .../_local/gameStore -> .../_local/gameStore/data
    abs = path.join(abs, "data");
  } else if (
    fs.existsSync(path.join(abs, "gamestore.sqlite")) &&
    !fs.existsSync(path.join(abs, "itemTypes"))
  ) {
    // User pointed at store root that already contains sqlite beside data/
    abs = path.join(abs, "data");
  }

  return abs;
}

function resolveHostImportTarget(args = {}) {
  if (args.target) {
    const dataDir = normalizeHostDataDir(args.target);
    const storeRoot = path.resolve(dataDir, "..");
    return {
      dataDir,
      sqlitePath: path.join(storeRoot, "gamestore.sqlite"),
      label: "manual --target",
      normalizedFrom: path.resolve(args.target) !== dataDir ? path.resolve(args.target) : null,
    };
  }
  const hosts = listHostGameStoreDataDirs();
  if (hosts.length === 0) {
    // Still allow default resolution via importPlayers + env; point at _local
    const fallback = path.join(REPO_ROOT, "_local", "gameStore", "data");
    return {
      dataDir: fallback,
      sqlitePath: path.resolve(fallback, "..", "gamestore.sqlite"),
      label: "default _local/gameStore/data (may be created)",
      missing: !fs.existsSync(fallback),
    };
  }
  return hosts[0];
}

function formatBetterSqlite3AbiHint(errorText) {
  const text = String(errorText || "");
  if (!/NODE_MODULE_VERSION|better_sqlite3|better-sqlite3/i.test(text)) {
    return null;
  }
  return (
    "\nNative module ABI mismatch (better-sqlite3).\n" +
      "The Node.js you used to run *import* is not the same ABI as the one that\n" +
      "built server/node_modules/better-sqlite3.\n\n" +
      "  MODULE 137 ≈ Node.js 24.x\n" +
      "  MODULE 147 ≈ Node.js 26.x\n\n" +
      "Fix (pick one):\n" +
      "  1) Use the same Node major the EveJS server uses, then re-run import.\n" +
      "     Check with:  node -p \"process.versions\"   (look at node + modules)\n" +
      "  2) Rebuild native modules for *this* Node, from the EveJS install:\n" +
      "       cd /path/to/evejs/server && npm rebuild better-sqlite3\n" +
      "     (or: cd server && rm -rf node_modules && npm ci)\n"
  );
}

/**
 * Decide Docker vs native host.
 * - --host-only / --native / --target => host
 * - --volume / --image => docker
 * - both available + interactive => prompt
 */
async function chooseImportBackend(args = {}) {
  if (args.hostOnly || args.target) {
    const host = resolveHostImportTarget(args);
    return { mode: "host", host, docker: null };
  }

  // Explicit docker request
  const forceDocker = Boolean(args.volume || args.image);
  const docker = await detectDockerGameStore(args);
  const hosts = listHostGameStoreDataDirs();

  if (forceDocker) {
    if (!docker) {
      throw new Error("Docker volume/image requested but none could be resolved.");
    }
    return { mode: "docker", docker, host: null };
  }

  if (docker && hosts.length > 0) {
    if (args.interactive !== false && process.stdin.isTTY) {
      const choice = await promptChoice(
        "\nBoth a Docker EveJS volume and a native/host gameStore look available.\nWhich install should this command use?",
        [
          {
            label: `Docker  — volume ${docker.volume} (image ${docker.image})`,
            value: "docker",
          },
          {
            label: `Native/host — ${hosts[0].dataDir}`,
            value: "host",
          },
        ],
      );
      if (choice === "host") {
        return { mode: "host", host: hosts[0], docker: null };
      }
      return { mode: "docker", docker, host: null };
    }
    // Non-interactive: keep Docker-first for backwards compatibility, but warn.
    console.warn(
      `  Both Docker (${docker.volume}) and host (${hosts[0].dataDir}) look available.\n` +
        `  Using Docker. Pass --host-only / --native or --target <dataDir> for a native install.`,
    );
    return { mode: "docker", docker, host: null };
  }

  if (docker) {
    return { mode: "docker", docker, host: null };
  }

  return { mode: "host", host: resolveHostImportTarget(args), docker: null };
}

async function detectDockerGameStore(args = {}) {
  if (args.hostOnly) return null;
  if (!dockerAvailable()) {
    return null;
  }

  const volumes = listDockerVolumes();
  const images = listDockerImages();

  // Explicit overrides
  if (args.volume) {
    if (!volumes.includes(args.volume)) {
      // Still allow if inspect works (race / different context)
      const { spawnSync } = require("child_process");
      const probe = spawnSync(
        "docker",
        ["volume", "inspect", args.volume, "--format", "{{.Name}}"],
        { encoding: "utf8" },
      );
      if (probe.status !== 0) {
        throw new Error(
          `Docker volume not found: ${args.volume}\n` +
            `  Known EveJS-like volumes: ${volumes.filter(isEvejsDataVolume).join(", ") || "(none)"}`,
        );
      }
    }
    const image =
      args.image ||
      guessImageForVolume(args.volume, images);
    if (args.image && !images.includes(args.image)) {
      console.warn(
        `  Warning: image "${args.image}" not listed by docker images (will try anyway)`,
      );
    }
    return {
      volume: args.volume,
      image,
      dataDir: "/var/lib/evejs/gameStore/data",
      label: "manual",
    };
  }

  // Collect candidate volumes (preferred names first, then fuzzy)
  const candidates = [];
  const seen = new Set();
  for (const name of DOCKER_VOLUME_PREFERRED) {
    if (volumes.includes(name) && !seen.has(name)) {
      seen.add(name);
      candidates.push(name);
    }
  }
  for (const name of volumes) {
    if (seen.has(name)) continue;
    if (isEvejsDataVolume(name)) {
      seen.add(name);
      candidates.push(name);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  let volume = candidates[0];
  if (candidates.length > 1) {
    if (args.interactive !== false && process.stdin.isTTY) {
      const choice = await promptChoice(
        "\nMultiple EveJS Docker data volumes found — which server should import/portraits use?",
        candidates.map((name) => {
          const img = guessImageForVolume(name, images);
          let kind = "EveJS";
          if (name.includes("xeve")) kind = "DML / evejs-xeve";
          else if (name === "evejs-data") kind = "stock EveJS";
          return {
            label: `${name}  (${kind}; image ~ ${img})`,
            value: name,
          };
        }),
      );
      volume = choice;
    } else {
      // Non-interactive: prefer DML name if present, else first preferred, else first candidate
      volume =
        candidates.find((n) => n === "evejs-xeve-data") ||
        candidates.find((n) => n === "evejs-data") ||
        candidates[0];
      console.warn(
        `  Multiple volumes found; using "${volume}" (pass --volume to override). Candidates: ${candidates.join(", ")}`,
      );
    }
  }

  let image = args.image || guessImageForVolume(volume, images);
  if (!args.image) {
    // If preferred image missing, try the other known names or fuzzy
    if (!images.includes(image)) {
      const fallback =
        DOCKER_IMAGE_PREFERRED.find((n) => images.includes(n)) ||
        images.find((n) => isEvejsServerImage(n));
      if (fallback) image = fallback;
    }
  }

  if (!images.includes(image)) {
    console.warn(
      `  Warning: Docker image "${image}" not found. Import may fail until you build:\n` +
        `    docker compose build\n` +
        `  Available EveJS-like images: ${images.filter(isEvejsServerImage).join(", ") || "(none)"}`,
    );
  }

  let label = "detected";
  if (volume === "evejs-data" || image === "evejs-local") label = "stock EveJS";
  if (volume.includes("xeve") || image.includes("xeve")) label = "DML / evejs-xeve";

  return {
    volume,
    image,
    dataDir: "/var/lib/evejs/gameStore/data",
    label,
  };
}

function stopComposeServices(repoRoot) {
  const { spawnSync } = require("child_process");
  const composeFile = path.join(repoRoot, "compose.yaml");
  const composeFileYml = path.join(repoRoot, "compose.yml");
  if (!fs.existsSync(composeFile) && !fs.existsSync(composeFileYml)) {
    // Best-effort: stop containers that look like evejs server/market
    spawnSync(
      "docker",
      [
        "ps",
        "-q",
        "--filter",
        "name=evejs",
      ],
      { encoding: "utf8" },
    );
    return;
  }
  spawnSync("docker", ["compose", "stop", "server", "market"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

async function cmdImport(args) {
  let bundlePath = args.bundle;
  if (!bundlePath && args.dump) {
    const dumpPath = resolveDumpPath(args.dump);
    const candidate = path.join(
      DEFAULT_BUNDLE_ROOT,
      path.basename(dumpPath),
      "players-bundle.json",
    );
    if (fs.existsSync(candidate)) {
      bundlePath = candidate;
    }
  }
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    throw new Error("--bundle <players-bundle.json> is required (or convert first)");
  }
  bundlePath = path.resolve(bundlePath);

  const { spawnSync } = require("child_process");
  const backend = await chooseImportBackend(args);

  console.log("Running importPlayers.js ...");
  console.log(`  bundle: ${bundlePath}`);
  console.log(
    "  NOTE: The EVE.js server must be STOPPED before a real import.",
  );

  if (backend.mode === "docker") {
    const docker = backend.docker;
    // Docker play uses the named volume (stock: evejs-data, DML: evejs-xeve-data).
    // Import must write into that volume, not a host fallback path.
    console.log(`  mode: docker (${docker.label || "detected"})`);
    console.log(`  volume: ${docker.volume}`);
    console.log(`  image:  ${docker.image}`);
    console.log(`  target: ${docker.dataDir}`);
    console.log("  Stopping server/market if running ...");
    stopComposeServices(REPO_ROOT);

    const containerBundle = "/tq-import-bundle.json";
    const containerLib = "/tq-import-lib";
    const importArgs = ["--target", docker.dataDir];
    if (args.onConflict) {
      importArgs.push("--on-conflict", args.onConflict);
    }
    if (args.dryRun) {
      importArgs.push("--dry-run");
    }
    // A real import first reserves saved-fitting IDs from the target's
    // _meta.nextFittingID and re-numbers a container-local copy of the bundle
    // (lib/fittingIds.js); importPlayers.js then reads that copy.
    const script = args.dryRun
      ? 'exec node src/gameStore/importPlayers.js --in "$0" "$@"'
      : `node ${containerLib}/fittingIds.js reserve "$0" /tmp/tq-import-bundle.json && ` +
        'exec node src/gameStore/importPlayers.js --in /tmp/tq-import-bundle.json "$@"';
    const dockerArgs = [
      "run",
      "--rm",
      "--user",
      "node",
      "-v",
      `${docker.volume}:/var/lib/evejs`,
      "-v",
      `${bundlePath}:${containerBundle}:ro`,
      "-v",
      `${path.join(__dirname, "lib")}:${containerLib}:ro`,
      "-e",
      `EVEJS_GAMESTORE_DATA_DIR=${docker.dataDir}`,
      "-w",
      "/app/server",
      docker.image,
      "sh",
      "-c",
      script,
      containerBundle,
      ...importArgs,
    ];

    const result = spawnSync("docker", dockerArgs, {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
      return;
    }
    console.log(
      "\nImport finished into Docker volume. Start with: docker compose up --detach",
    );
    return;
  }

  const importScript = path.join(
    REPO_ROOT,
    "server",
    "src",
    "gameStore",
    "importPlayers.js",
  );
  if (!fs.existsSync(importScript)) {
    throw new Error(`importPlayers.js not found at ${importScript}`);
  }

  const host = backend.host || resolveHostImportTarget(args);
  const serverDir = path.join(REPO_ROOT, "server");
  const hostEnv = { ...process.env, EVEJS_GAMESTORE_DATA_DIR: host.dataDir };
  console.log(`  mode: native/host`);
  console.log(`  target: ${host.dataDir}  (${host.label})`);
  console.log(`  sqlite: ${host.sqlitePath}`);
  if (host.normalizedFrom) {
    console.log(
      `  note: normalized --target from ${host.normalizedFrom} → ${host.dataDir}`,
    );
  }
  if (host.missing) {
    console.warn(
      "  Warning: that data dir does not exist yet; importPlayers may create an empty store.\n" +
        "  Prefer --target /path/to/your/_local/gameStore/data for a known native install.",
    );
  }

  let importBundlePath = bundlePath;
  if (!args.dryRun) {
    // Reserve saved-fitting IDs from the target first (see lib/fittingIds.js).
    importBundlePath = path.join(
      require("os").tmpdir(),
      `tq-import-bundle-${process.pid}.json`,
    );
    const reserve = spawnSync(
      process.execPath,
      [path.join(__dirname, "lib", "fittingIds.js"), "reserve", bundlePath, importBundlePath],
      { cwd: serverDir, encoding: "utf8", env: hostEnv },
    );
    if (reserve.stdout) process.stdout.write(reserve.stdout);
    if (reserve.stderr) process.stderr.write(reserve.stderr);
    if (reserve.status !== 0) {
      const combined = `${reserve.stdout || ""}\n${reserve.stderr || ""}\n${reserve.error || ""}`;
      const hint = formatBetterSqlite3AbiHint(combined);
      if (hint) console.error(hint);
      fs.rmSync(importBundlePath, { force: true });
      process.exitCode = reserve.status || 1;
      return;
    }
  }

  const nodeArgs = [importScript, "--in", importBundlePath, "--target", host.dataDir];
  if (args.onConflict) {
    nodeArgs.push("--on-conflict", args.onConflict);
  }
  if (args.dryRun) {
    nodeArgs.push("--dry-run");
  }

  // Run from server/ so better-sqlite3 resolves correctly.
  // Capture output so we can add a clear ABI rebuild hint on failure.
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: serverDir,
    encoding: "utf8",
    env: hostEnv,
  });
  if (importBundlePath !== bundlePath) {
    fs.rmSync(importBundlePath, { force: true });
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const combined = `${result.stdout || ""}\n${result.stderr || ""}\n${result.error || ""}`;
    const hint = formatBetterSqlite3AbiHint(combined);
    if (hint) {
      console.error(hint);
    }
    process.exitCode = result.status || 1;
    return;
  }
  console.log("\nImport finished into native/host gameStore.");
  console.log(`  Data dir: ${host.dataDir}`);
}

async function cmdPipeline(args) {
  if (!args.username) {
    throw new Error("--username is required");
  }
  const manifest = await cmdDump(args);
  const dumpPath = manifest.dumpRoot;
  const converted = await convertDump(dumpPath, {
    username: args.username,
    fallbackStationID: args.fallbackStation,
  });
  console.log("\nPersonal export + portable package ready.");
  console.log(`  Export folder: ${dumpPath}`);
  console.log(`  Bundle:        ${converted.bundlePath}`);
  console.log(
    "That export is useful on its own (backup / offline study of your own data).",
  );
  console.log(
    "Optional — load into a local EveJS practice server (server must be STOPPED):",
  );
  console.log(
    `  node tools/tq-import/eve-character-export.js import-evejs --bundle "${converted.bundlePath}"`,
  );
  console.log(
    `  node tools/tq-import/eve-character-export.js portraits --dump "${dumpPath}" --username ${args.username}`,
  );

  if (args.withEvejsImport || args.dryRun) {
    args.bundle = converted.bundlePath;
    await cmdImport(args);
  }
}

/**
 * List local characters from Docker volume or host gameStore.
 */
async function listLocalCharacters(args) {
  const { spawnSync } = require("child_process");
  const docker = args.hostOnly ? null : await detectDockerGameStore(args);

  if (docker) {
    console.log(
      `  using docker ${docker.label || ""} volume=${docker.volume} image=${docker.image}`,
    );
    const script = `
const Database = require("better-sqlite3");
const db = new Database("/var/lib/evejs/gameStore/gamestore.sqlite", { readonly: true });
const rows = db.prepare(
  "SELECT key, json FROM characters"
).all();
const out = [];
for (const row of rows) {
  const rec = JSON.parse(row.json);
  const tq = rec.tqImport && rec.tqImport.sourceCharacterID
    ? Number(rec.tqImport.sourceCharacterID)
    : 0;
  out.push({
    characterID: Number(row.key),
    characterName: rec.characterName || null,
    accountId: Number(rec.accountId) || 0,
    sourceCharacterID: tq || 0,
  });
}
process.stdout.write(JSON.stringify(out));
`;
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "node",
        "-v",
        `${docker.volume}:/var/lib/evejs`,
        "-w",
        "/app/server",
        docker.image,
        "node",
        "-e",
        script,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `Failed to list Docker characters: ${result.stderr || result.stdout}`,
      );
    }
    return JSON.parse(result.stdout || "[]");
  }

  // Host fallback
  const Database = require(path.join(
    REPO_ROOT,
    "server",
    "node_modules",
    "better-sqlite3",
  ));
  const dataDir =
    args.target ||
    process.env.EVEJS_GAMESTORE_DATA_DIR ||
    path.join(REPO_ROOT, "_local", "gameStore", "data");
  const sqlitePath = path.resolve(dataDir, "..", "gamestore.sqlite");
  if (!fs.existsSync(sqlitePath)) {
    // also try the accidental import path
    const alt = path.join(
      REPO_ROOT,
      "server",
      "src",
      "gameStore",
      "gamestore.sqlite",
    );
    if (!fs.existsSync(alt)) {
      throw new Error(`No gamestore.sqlite found at ${sqlitePath}`);
    }
    return listFromSqlite(alt);
  }
  return listFromSqlite(sqlitePath);
}

function listFromSqlite(sqlitePath) {
  const Database = require(path.join(
    REPO_ROOT,
    "server",
    "node_modules",
    "better-sqlite3",
  ));
  const db = new Database(sqlitePath, { readonly: true });
  const rows = db.prepare("SELECT key, json FROM characters").all();
  const out = [];
  for (const row of rows) {
    const rec = JSON.parse(row.json);
    const tq =
      rec.tqImport && rec.tqImport.sourceCharacterID
        ? Number(rec.tqImport.sourceCharacterID)
        : 0;
    out.push({
      characterID: Number(row.key),
      characterName: rec.characterName || null,
      accountId: Number(rec.accountId) || 0,
      sourceCharacterID: tq || 0,
    });
  }
  db.close();
  return out;
}

/**
 * Auto-load TQ name→id maps from dumps under _local/tq-import/dumps when
 * characters lack tqImport.sourceCharacterID (older imports).
 */
function autoLoadDumpMappings() {
  const {
    loadMappingsFromDump,
  } = require("./lib/portraits");
  if (!fs.existsSync(DEFAULT_DUMP_ROOT)) {
    return [];
  }
  const mappings = [];
  const seen = new Set();
  let entries = [];
  try {
    entries = fs
      .readdirSync(DEFAULT_DUMP_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        mtime: fs.statSync(path.join(DEFAULT_DUMP_ROOT, e.name)).mtimeMs || 0,
      }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {
    return [];
  }
  for (const entry of entries.slice(0, 20)) {
    const loaded = loadMappingsFromDump(path.join(DEFAULT_DUMP_ROOT, entry.name));
    for (const m of loaded.mappings || []) {
      const key = String(m.characterName || "").toLowerCase();
      if (!key || !m.tqCharacterID || seen.has(key)) continue;
      seen.add(key);
      mappings.push(m);
    }
  }
  return mappings;
}

function hostPortraitSizesPresent(localCharacterID) {
  const {
    CHARACTER_ROOT,
    CHARACTER_PORTRAIT_SIZES,
  } = require("./lib/portraits");
  const id = Number(localCharacterID) || 0;
  if (id <= 0 || !fs.existsSync(CHARACTER_ROOT)) return 0;
  let n = 0;
  for (const size of CHARACTER_PORTRAIT_SIZES) {
    if (fs.existsSync(path.join(CHARACTER_ROOT, `${id}_${size}.jpg`))) n += 1;
  }
  return n;
}

async function finishPortraitSync(args, localIds) {
  const {
    seedClientPortraitCache,
    syncPortraitsIntoDockerVolume,
    CHARACTER_ROOT,
  } = require("./lib/portraits");

  console.log(`  legacy host path: ${CHARACTER_ROOT}`);

  const docker = args.hostOnly ? null : await detectDockerGameStore(args);
  if (docker && docker.volume) {
    const sync = syncPortraitsIntoDockerVolume(docker.volume);
    if (sync.ok) {
      console.log(
        `  synced into Docker volume ${docker.volume} (${docker.label || "detected"}): gameStore/images/Character/ (${sync.count} file(s))`,
      );
    } else {
      console.log(`  volume sync skipped/failed: ${sync.error}`);
    }
  } else {
    console.log(
      "  no Docker volume detected — host generated/Character/ only (ensure compose bind-mounts it if needed)",
    );
  }

  const seed = seedClientPortraitCache(localIds || []);
  if (seed.cacheDirs.length === 0) {
    console.log(
      "No client portrait cache found under evejs-prefix; if select still shows the default icon, clear cache/Pictures/Characters/ or re-run after launching the client once.",
    );
  } else {
    console.log(
      `Seeded ${seed.files.length} file(s) into client cache (${seed.cacheDirs.length} dir(s)).`,
    );
    for (const dir of seed.cacheDirs) {
      console.log(`  ${dir}`);
    }
  }

  console.log(
    "Fully quit and relaunch the EVE client so character select reloads cached portraits.",
  );
}

async function cmdPortraits(args) {
  const {
    fetchAndStoreCharacterPortraits,
    loadMappingsFromDump,
    loadMappingsFromBundle,
    pairByName,
    CHARACTER_ROOT,
  } = require("./lib/portraits");

  ensureDir(CHARACTER_ROOT);

  let tqMappings = [];
  if (args.dump) {
    const dumpPath = resolveDumpPath(args.dump);
    if (!dumpPath || !fs.existsSync(dumpPath)) {
      throw new Error(`Dump not found: ${args.dump}`);
    }
    const loaded = loadMappingsFromDump(dumpPath);
    tqMappings = loaded.mappings;
    console.log(
      `TQ identities from dump (${path.basename(dumpPath)}): ${tqMappings.length}`,
    );
  } else if (args.bundle) {
    tqMappings = loadMappingsFromBundle(path.resolve(args.bundle));
    console.log(`TQ identities from bundle: ${tqMappings.length}`);
  }

  const localChars = await listLocalCharacters(args);
  let filtered = localChars;
  if (args.username) {
    filtered = await filterCharactersByUsername(localChars, args);
  }

  // Prefer tqImport.sourceCharacterID on the local record; fill gaps via dump names.
  const pairs = pairByName(filtered, tqMappings);
  if (pairs.length === 0) {
    throw new Error(
      "No local characters matched. Pass --dump <dump-id> and/or ensure characters were imported with tqImport metadata.\n" +
        "  Tip: try  node tools/tq-import/tq-import.js restore-portraits",
    );
  }

  console.log(`Downloading portraits for ${pairs.length} character(s) →`);
  console.log(`  ${CHARACTER_ROOT}`);

  const results = [];
  for (const pair of pairs) {
    process.stdout.write(
      `  ${pair.characterName} local=${pair.localCharacterID} tq=${pair.tqCharacterID} ... `,
    );
    const result = await fetchAndStoreCharacterPortraits(
      pair.localCharacterID,
      pair.tqCharacterID,
    );
    if (result.ok) {
      console.log("ok");
    } else {
      console.log(`FAIL: ${result.error}`);
    }
    results.push({ ...pair, ...result });
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nPortraits stored: ${okCount}/${results.length}`);
  await finishPortraitSync(
    args,
    results.filter((r) => r.ok).map((r) => r.localCharacterID),
  );
  return results;
}

/**
 * Restore character-select JPGs for accounts that are already imported.
 * Does not re-import skills/assets/ISK — only faces.
 *
 * Sources (in order):
 *   1) Existing host JPGs under generated/Character/  (--sync-only stops here)
 *   2) Re-download from images.evetech.net using tqImport.sourceCharacterID
 *   3) Name match against local dumps under _local/tq-import/dumps
 *   4) Optional --dump / --bundle mappings
 */
async function cmdRestorePortraits(args) {
  const {
    fetchAndStoreCharacterPortraits,
    loadMappingsFromDump,
    loadMappingsFromBundle,
    pairByName,
    CHARACTER_ROOT,
    CHARACTER_PORTRAIT_SIZES,
  } = require("./lib/portraits");

  ensureDir(CHARACTER_ROOT);

  console.log("Restore portraits for already-imported characters");
  console.log("(no account re-import — JPGs only)\n");

  let tqMappings = [];
  if (args.dump) {
    const dumpPath = resolveDumpPath(args.dump);
    if (!dumpPath || !fs.existsSync(dumpPath)) {
      throw new Error(`Dump not found: ${args.dump}`);
    }
    const loaded = loadMappingsFromDump(dumpPath);
    tqMappings = loaded.mappings;
    console.log(
      `TQ identities from dump (${path.basename(dumpPath)}): ${tqMappings.length}`,
    );
  } else if (args.bundle) {
    tqMappings = loadMappingsFromBundle(path.resolve(args.bundle));
    console.log(`TQ identities from bundle: ${tqMappings.length}`);
  } else {
    tqMappings = autoLoadDumpMappings();
    if (tqMappings.length) {
      console.log(
        `TQ identities auto-loaded from dumps: ${tqMappings.length} name(s)`,
      );
    }
  }

  const localChars = await listLocalCharacters(args);
  let filtered = localChars;
  if (args.username) {
    filtered = await filterCharactersByUsername(localChars, args);
    console.log(`Filter username=${args.username}: ${filtered.length} character(s)`);
  } else {
    console.log(`Local characters found: ${filtered.length}`);
  }

  if (!filtered.length) {
    throw new Error(
      "No local characters found in gameStore. Is the Docker volume present / server data path correct?\n" +
        "  Tip: pass --volume evejs-data (stock) or --volume evejs-xeve-data (DML), or --host-only",
    );
  }

  const pairs = pairByName(filtered, tqMappings);
  const withTq = pairs.filter((p) => p.tqCharacterID > 0);
  const localOnly = filtered.filter(
    (c) => !withTq.some((p) => p.localCharacterID === c.characterID),
  );

  // --sync-only: push whatever host JPGs we have for known local IDs into the volume
  if (args.syncOnly) {
    const ids = filtered.map((c) => c.characterID);
    let withFiles = 0;
    for (const id of ids) {
      if (hostPortraitSizesPresent(id) > 0) withFiles += 1;
    }
    console.log(
      `\nSync-only: ${withFiles}/${ids.length} character(s) have host JPGs under generated/Character/`,
    );
    if (withFiles === 0) {
      throw new Error(
        "No host portrait JPGs found. Re-run without --sync-only to download from Tranquility, or pass --dump <id>.",
      );
    }
    await finishPortraitSync(args, ids);
    return { mode: "sync-only", withFiles, ids };
  }

  if (withTq.length === 0) {
    // Maybe we only have host files and no TQ ids — still try volume sync
    const ids = filtered.map((c) => c.characterID);
    let withFiles = 0;
    for (const id of ids) {
      if (hostPortraitSizesPresent(id) > 0) withFiles += 1;
    }
    if (withFiles > 0) {
      console.log(
        `\nNo TQ character IDs on records, but found host JPGs for ${withFiles} character(s). Syncing to volume…`,
      );
      await finishPortraitSync(args, ids);
      return { mode: "sync-host-only", withFiles, ids };
    }
    throw new Error(
      "Could not map local characters to Tranquility IDs.\n" +
        "  Characters need tqImport.sourceCharacterID (set at import), or pass:\n" +
        "    --dump <dump-id>   or keep dumps under _local/tq-import/dumps/\n" +
        "  If JPGs still exist on disk only:\n" +
        "    node tools/tq-import/tq-import.js restore-portraits --sync-only",
    );
  }

  console.log(
    `\nRestoring faces for ${withTq.length} character(s) with TQ ids` +
      (localOnly.length
        ? ` (${localOnly.length} local-only skipped — no TQ id)`
        : ""),
  );
  console.log(`  host path: ${CHARACTER_ROOT}`);
  if (args.forceDownload) {
    console.log("  mode: force re-download from images.evetech.net");
  } else {
    console.log(
      "  mode: reuse host JPGs when present; download missing from images.evetech.net",
    );
  }

  const results = [];
  for (const pair of withTq) {
    const present = hostPortraitSizesPresent(pair.localCharacterID);
    const needDownload =
      args.forceDownload || present < CHARACTER_PORTRAIT_SIZES.length;

    process.stdout.write(
      `  ${pair.characterName} local=${pair.localCharacterID} tq=${pair.tqCharacterID} `,
    );

    if (!needDownload) {
      console.log(`keep (${present} sizes on disk)`);
      results.push({ ...pair, ok: true, skippedDownload: true, present });
      continue;
    }

    process.stdout.write(present > 0 ? "refresh ... " : "download ... ");
    const result = await fetchAndStoreCharacterPortraits(
      pair.localCharacterID,
      pair.tqCharacterID,
    );
    if (result.ok) {
      console.log("ok");
    } else {
      console.log(`FAIL: ${result.error}`);
    }
    results.push({ ...pair, ...result, present });
  }

  const okCount = results.filter((r) => r.ok).length;
  const downloaded = results.filter((r) => r.ok && !r.skippedDownload).length;
  const kept = results.filter((r) => r.ok && r.skippedDownload).length;
  console.log(
    `\nPortrait restore: ${okCount}/${results.length} ok` +
      ` (${kept} reused on disk, ${downloaded} downloaded/refreshed)`,
  );

  await finishPortraitSync(
    args,
    results.filter((r) => r.ok).map((r) => r.localCharacterID),
  );
  return results;
}

async function filterCharactersByUsername(localChars, args) {
  if (!args.username) return localChars;
  const { spawnSync } = require("child_process");
  const docker = args.hostOnly ? null : await detectDockerGameStore(args);
  const username = String(args.username);

  if (docker) {
    const script = `
const Database = require("better-sqlite3");
const db = new Database("/var/lib/evejs/gameStore/gamestore.sqlite", { readonly: true });
const row = db.prepare("SELECT json FROM accounts WHERE key = ?").get(${JSON.stringify(username)});
if (!row) { process.stdout.write("0"); process.exit(0); }
const id = Number(JSON.parse(row.json).id) || 0;
process.stdout.write(String(id));
`;
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "node",
        "-v",
        `${docker.volume}:/var/lib/evejs`,
        "-w",
        "/app/server",
        docker.image,
        "node",
        "-e",
        script,
      ],
      { encoding: "utf8" },
    );
    const accountId = Number(result.stdout || 0);
    if (accountId > 0) {
      return localChars.filter((c) => Number(c.accountId) === accountId);
    }
  }
  // Fallback: match by character names from dump for this username, or keep all with tq metadata
  return localChars.filter((c) => c.sourceCharacterID > 0);
}

/**
 * Copy paper dolls (sculpts / modifiers / colors / hair) out of an EVE client's
 * own CachedMethodCalls store into characters.appearanceInfo.
 *
 * The doll is not available from any web API — only the client that rendered it
 * has a copy. Pairing works the same way portraits do: tqImport.sourceCharacterID
 * on the local record first, then name matching against a dump or bundle, then
 * explicit --map pairs.
 */
async function cmdImportAppearance(args) {
  const {
    buildAppearanceInfo,
    findCachedMethodCallDirs,
    hasRunningVolumeUsers,
    scanCachedDolls,
    writeAppearanceUpdates,
  } = require("./lib/appearance");
  const { loadMappingsFromDump, loadMappingsFromBundle, pairByName } =
    require("./lib/portraits");

  const cacheDirs = findCachedMethodCallDirs({
    cacheDir: args.cacheDir,
    allServers: args.allCaches,
  });
  if (cacheDirs.length === 0) {
    throw new Error(
      "No EVE client cache found.\n" +
        "  Looked under %LOCALAPPDATA%\\CCP\\EVE\\*_tranquility and evejs-prefix.\n" +
        "  Pass --cache-dir <path to a cache folder>, or --all-caches to include other servers.",
    );
  }
  console.log(`Client cache directories: ${cacheDirs.length}`);
  for (const entry of cacheDirs) {
    console.log(`  ${entry.dir}`);
  }

  const { dolls, scanned } = scanCachedDolls(cacheDirs);
  console.log(`Scanned ${scanned} cached call(s); paper dolls found: ${dolls.size}`);
  if (dolls.size === 0) {
    throw new Error(
      "No GetPaperDollData replies in that cache.\n" +
        "  The client only caches a doll it has actually rendered — log the character\n" +
        "  in (or open its info window) on the source client once, then retry.",
    );
  }

  // Convert everything up front so a malformed row set fails before any write.
  const converted = new Map();
  for (const [tqCharacterID, doll] of dolls) {
    try {
      converted.set(tqCharacterID, buildAppearanceInfo(doll.keyVal));
    } catch (error) {
      console.log(`  source=${tqCharacterID} unusable: ${error.message || error}`);
    }
  }

  if (args.list) {
    console.log("\nCached dolls:");
    for (const [tqCharacterID, built] of converted) {
      const hair =
        built.hairDarkness === null ? "n/a" : built.hairDarkness.toFixed(3);
      console.log(
        `  source=${tqCharacterID}  sculpts=${built.counts.sculpts}` +
          ` modifiers=${built.counts.modifiers} colors=${built.counts.colors} hair=${hair}`,
      );
    }
    console.log("\nNothing written (--list).");
    return converted;
  }

  let tqMappings = [];
  if (args.dump) {
    const dumpPath = resolveDumpPath(args.dump);
    if (!dumpPath || !fs.existsSync(dumpPath)) {
      throw new Error(`Dump not found: ${args.dump}`);
    }
    tqMappings = loadMappingsFromDump(dumpPath).mappings;
  } else if (args.bundle) {
    tqMappings = loadMappingsFromBundle(path.resolve(args.bundle));
  }

  const localChars = await listLocalCharacters(args);
  const filtered = args.username
    ? await filterCharactersByUsername(localChars, args)
    : localChars;

  const byLocalID = new Map();
  for (const pair of pairByName(filtered, tqMappings)) {
    byLocalID.set(pair.localCharacterID, pair);
  }
  // Explicit --map wins over anything inferred.
  const localByID = new Map(filtered.map((c) => [c.characterID, c]));
  for (const manual of args.map) {
    const local = localByID.get(manual.localCharacterID);
    byLocalID.set(manual.localCharacterID, {
      localCharacterID: manual.localCharacterID,
      tqCharacterID: manual.tqCharacterID,
      characterName: local ? local.characterName : "(not in this store)",
    });
  }

  const updates = [];
  const unmatched = [];
  for (const pair of byLocalID.values()) {
    const built = converted.get(pair.tqCharacterID);
    if (!built) {
      unmatched.push(pair);
      continue;
    }
    updates.push({
      localCharacterID: pair.localCharacterID,
      characterName: pair.characterName,
      counts: built.counts,
      appearanceInfo: built.appearanceInfo,
      overwrite: Boolean(args.overwrite),
    });
  }

  if (unmatched.length > 0) {
    console.log(`\nNo cached doll for ${unmatched.length} local character(s):`);
    for (const pair of unmatched) {
      console.log(`  ${pair.characterName} local=${pair.localCharacterID}`);
    }
  }

  if (updates.length === 0) {
    throw new Error(
      "Nothing to import — no local character paired with a cached doll.\n" +
        "  Run with --list to see which source characters are cached, then pair one\n" +
        "  explicitly: --map <localCharacterID>=<sourceCharacterID>",
    );
  }

  console.log(`\nImporting ${updates.length} doll(s):`);
  for (const update of updates) {
    console.log(
      `  ${update.characterName} local=${update.localCharacterID}` +
        ` sculpts=${update.counts.sculpts} modifiers=${update.counts.modifiers}` +
        ` colors=${update.counts.colors}`,
    );
  }

  const docker = args.hostOnly ? null : await detectDockerGameStore(args);
  if (docker && !args.dryRun) {
    const running = hasRunningVolumeUsers(docker.volume);
    if (running.other.length > 0) {
      console.log(
        `\n  Note: ${running.other.join(", ")} also mount ${docker.volume};` +
          " they keep their own sqlite and do not need stopping.",
      );
    }
    if (running.blocking.length > 0) {
      throw new Error(
        `The gameStore is in use by: ${running.blocking.join(", ")}\n` +
          "  The server caches characters in memory and flushes over the file, so it\n" +
          "  would undo this edit. Stop it first:\n" +
          "    docker compose stop server\n" +
          "  then re-run, and start it again with: docker compose start server",
      );
    }
  }

  let sqlitePath = null;
  if (!docker) {
    const dataDir =
      args.target ||
      process.env.EVEJS_GAMESTORE_DATA_DIR ||
      path.join(REPO_ROOT, "_local", "gameStore", "data");
    sqlitePath = path.resolve(dataDir, "..", "gamestore.sqlite");
    if (!fs.existsSync(sqlitePath)) {
      throw new Error(`No gamestore.sqlite found at ${sqlitePath}`);
    }
  }

  const results = writeAppearanceUpdates({
    docker,
    sqlitePath,
    updates,
    dryRun: args.dryRun,
  });

  let applied = 0;
  for (const result of results) {
    if (result.ok) {
      applied += 1;
      if (result.replaced) {
        console.log(`  local=${result.localCharacterID} replaced existing doll`);
      }
    } else {
      console.log(`  local=${result.localCharacterID} FAILED: ${result.error}`);
    }
  }

  console.log(
    `\nAppearance imported: ${applied}/${results.length}${args.dryRun ? " (dry-run, nothing written)" : ""}`,
  );
  if (!args.dryRun && applied > 0) {
    console.log("Start the server again, then relog the character to see the doll.");
    console.log(
      "Note: re-customising in the creator makes the client upload its own portrait,\n" +
        "  which overwrites imported JPEGs — re-run restore-portraits --force-download after.",
    );
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    printHelp();
    return;
  }

  ensureDataRoot();
  ensureDir(DEFAULT_DUMP_ROOT);
  ensureDir(DEFAULT_BUNDLE_ROOT);

  switch (args.command) {
    case "package":
    case "package-bundle":
    case "convert":
      await cmdConvert(args);
      break;
    case "import":
    case "import-evejs":
      await cmdImport(args);
      break;
    case "portraits":
      await cmdPortraits(args);
      break;
    case "restore-portraits":
    case "restore-portrait":
    case "portraits-restore":
      await cmdRestorePortraits(args);
      break;
    case "import-appearance":
    case "appearance":
    case "import-doll":
      await cmdImportAppearance(args);
      break;
    case "repair-fittings":
    case "repair-fitting":
    case "fix-fittings":
      await cmdRepairFittings(args);
      break;
    case "help":
      printHelp();
      break;
    default:
      printHelp();
      throw new Error(`Unknown command: ${args.command}`);
  }
}

async function cmdRepairFittings(args) {
  const { repairDockerVolume, repairHostSqlite } = require("./lib/repairFittings");
  const backend = await chooseImportBackend(args);
  console.log(
    "Repairing fitted modules/charges (server should be STOPPED)...",
  );

  let summary;
  if (backend.mode === "docker") {
    const { spawnSync } = require("child_process");
    spawnSync("docker", ["compose", "stop", "server", "market"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    summary = repairDockerVolume({
      volume: backend.docker.volume,
      image: backend.docker.image,
      typesJson: args.typesJson || args.typeData,
      dryRun: args.dryRun,
    });
  } else {
    const host = backend.host || resolveHostImportTarget(args);
    console.log(`  mode: native/host`);
    console.log(`  sqlite: ${host.sqlitePath}`);
    summary = repairHostSqlite({
      sqlitePath: host.sqlitePath,
      typesJson: args.typesJson || args.typeData,
      dryRun: args.dryRun,
    });
  }

  console.log(
    `Done. modulesFixed=${summary.modulesFixed} chargesFixed=${summary.chargesFixed}` +
      (summary.dryRun ? " (dry-run)" : ""),
  );
  console.log(
    "Restart the server, then refit/reload ships if the client still shows sticky charges.",
  );
}

main().catch((error) => {
  console.error(`\nError: ${error.message || error}`);
  process.exitCode = 1;
});
