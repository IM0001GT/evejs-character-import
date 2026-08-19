"use strict";

/**
 * Repair already-imported inventory rows:
 * - Fitted modules (non-charge in a ship slot): ensure moduleState.online=true
 * - Fitted charges (category 8 in a ship slot): force stack form, strip moduleState
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadTypeIndex,
  DEFAULT_FITTED_MODULE_STATE,
} = require("./convert");

function repairDockerVolume({ volume, image, typesJson, dryRun = false } = {}) {
  const { spawnSync } = require("child_process");
  const typeIndex = loadTypeIndex({ typesJson });
  if (!typeIndex.source || typeIndex.byTypeID.size === 0) {
    throw new Error(
      "itemTypes static data required for repair-fittings (pass --types-json or use Docker volume)",
    );
  }

  const vol = volume || "evejs-xeve-data";
  const img = image || "evejs-xeve-local";

  const typeMap = {};
  for (const [id, meta] of typeIndex.byTypeID.entries()) {
    typeMap[String(id)] = {
      categoryID: meta.categoryID,
      groupID: meta.groupID,
      mass: meta.mass,
      volume: meta.volume,
      capacity: meta.capacity,
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-repair-"));
  const typeMapPath = path.join(tmpDir, "typemap.json");
  const scriptPath = path.join(tmpDir, "repair.js");
  fs.writeFileSync(typeMapPath, JSON.stringify(typeMap));

  const script = `"use strict";
const fs = require("fs");
const Database = require("better-sqlite3");
const typeMap = JSON.parse(fs.readFileSync("./evejs-repair-typemap.json", "utf8"));
const CHARGE_CATEGORY_ID = 8;
// Mirrors buildMovedItemState in itemStore.js (11..132 inclusive).
const FITTING_FLAG_MIN = 11;
const FITTING_FLAG_MAX = 132;
const DEFAULT_MODULE_STATE = ${JSON.stringify(DEFAULT_FITTED_MODULE_STATE)};
const dryRun = ${dryRun ? "true" : "false"};

function isFit(flag) {
  const f = Number(flag) || 0;
  return f >= FITTING_FLAG_MIN && f <= FITTING_FLAG_MAX;
}

const db = new Database(
  "/var/lib/evejs/gameStore/gamestore.sqlite",
  dryRun ? { readonly: true } : undefined,
);
if (!dryRun) db.pragma("journal_mode = WAL");

const rows = db.prepare("SELECT key, json FROM items").all();
let modulesFixed = 0;
let chargesFixed = 0;
const upd = dryRun ? null : db.prepare("UPDATE items SET json = ? WHERE key = ?");

for (const row of rows) {
  const item = JSON.parse(row.json);
  if (!isFit(item.flagID)) continue;
  const typeID = Number(item.typeID) || 0;
  const meta = typeMap[String(typeID)] || null;
  const categoryID = Number(item.categoryID) || (meta && meta.categoryID) || 0;
  let changed = false;

  if (categoryID === CHARGE_CATEGORY_ID) {
    const qty = Math.max(
      1,
      Number(item.stacksize) || Math.abs(Number(item.quantity)) || 1,
    );
    if (item.singleton !== 0) { item.singleton = 0; changed = true; }
    if (Number(item.quantity) !== qty) { item.quantity = qty; changed = true; }
    if (Number(item.stacksize) !== qty) { item.stacksize = qty; changed = true; }
    if (Object.prototype.hasOwnProperty.call(item, "moduleState")) {
      delete item.moduleState;
      changed = true;
    }
    if (meta) {
      if (!item.categoryID) item.categoryID = meta.categoryID;
      if (!item.groupID) item.groupID = meta.groupID;
    }
    if (changed) chargesFixed += 1;
  } else {
    if (!item.moduleState || typeof item.moduleState !== "object") {
      item.moduleState = Object.assign({}, DEFAULT_MODULE_STATE);
      changed = true;
    } else if (item.moduleState.online !== true) {
      item.moduleState = Object.assign(
        {},
        DEFAULT_MODULE_STATE,
        item.moduleState,
        { online: true },
      );
      changed = true;
    }
    if (item.singleton !== 1) {
      item.singleton = 1;
      item.quantity = -1;
      item.stacksize = 1;
      changed = true;
    }
    if (meta) {
      if (!item.categoryID) { item.categoryID = meta.categoryID; changed = true; }
      if (!item.groupID) { item.groupID = meta.groupID; changed = true; }
    }
    if (changed) modulesFixed += 1;
  }

  if (changed && upd) upd.run(JSON.stringify(item), row.key);
}

if (!dryRun) db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
process.stdout.write(JSON.stringify({ modulesFixed, chargesFixed, dryRun }));
`;
  fs.writeFileSync(scriptPath, script);

  try {
    // Script must live under /app/server so better-sqlite3 resolves from
    // server/node_modules (NODE_PATH alone is flaky across images).
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "node",
        "-v",
        `${vol}:/var/lib/evejs`,
        "-v",
        `${tmpDir}:/repair:ro`,
        "-w",
        "/app/server",
        img,
        "sh",
        "-c",
        "cp /repair/repair.js ./evejs-repair-fittings.js && cp /repair/typemap.json ./evejs-repair-typemap.json && node ./evejs-repair-fittings.js; ec=$?; rm -f ./evejs-repair-fittings.js ./evejs-repair-typemap.json; exit $ec",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      throw new Error(
        `Docker repair failed (status ${result.status}): ${result.stderr || result.stdout || ""}`,
      );
    }
    const out = String(result.stdout || "").trim();
    try {
      return JSON.parse(out);
    } catch (error) {
      throw new Error(`Docker repair returned non-JSON: ${out.slice(0, 500)}`);
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      // ignore
    }
  }
}

module.exports = {
  repairDockerVolume,
};
