"use strict";

/**
 * Repair already-imported inventory rows:
 * - Fitted modules (category 7 in a ship slot): ensure moduleState.online=true
 * - Fitted charges (category 8 in a ship slot): force stack form, strip moduleState
 *
 * Safe to re-run. Requires itemTypes static data (same as convert).
 */

const fs = require("fs");
const path = require("path");
const {
  loadTypeIndex,
  isShipFittingFlag,
  CHARGE_CATEGORY_ID,
  DEFAULT_FITTED_MODULE_STATE,
} = require("./convert");
const { REPO_ROOT } = require("./paths");

function toPositiveInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
}

function repairItemsObject(itemsRoot, typeIndex) {
  const byTypeID = typeIndex.byTypeID;
  let modulesFixed = 0;
  let chargesFixed = 0;
  let skipped = 0;

  for (const [key, item] of Object.entries(itemsRoot || {})) {
    if (!item || typeof item !== "object") continue;
    const flagID = toPositiveInt(item.flagID, 0);
    if (!isShipFittingFlag(flagID)) {
      skipped += 1;
      continue;
    }
    const typeID = toPositiveInt(item.typeID, 0);
    const meta = byTypeID.get(typeID) || null;
    const categoryID =
      toPositiveInt(item.categoryID, 0) ||
      (meta && meta.categoryID) ||
      0;

    if (categoryID === CHARGE_CATEGORY_ID) {
      const qty = Math.max(
        1,
        toPositiveInt(item.stacksize, 0) ||
          Math.abs(toPositiveInt(item.quantity, 0)) ||
          1,
      );
      let changed = false;
      if (item.singleton !== 0) {
        item.singleton = 0;
        changed = true;
      }
      if (Number(item.quantity) !== qty) {
        item.quantity = qty;
        changed = true;
      }
      if (Number(item.stacksize) !== qty) {
        item.stacksize = qty;
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(item, "moduleState")) {
        delete item.moduleState;
        changed = true;
      }
      if (meta) {
        if (!item.categoryID) item.categoryID = meta.categoryID;
        if (!item.groupID) item.groupID = meta.groupID;
        if (item.mass == null && meta.mass != null) item.mass = meta.mass;
        if (item.volume == null && meta.volume != null) item.volume = meta.volume;
      }
      if (changed) chargesFixed += 1;
      itemsRoot[key] = item;
      continue;
    }

    // Non-charge fitted item → module
    let changed = false;
    if (!item.moduleState || typeof item.moduleState !== "object") {
      item.moduleState = { ...DEFAULT_FITTED_MODULE_STATE };
      changed = true;
    } else if (item.moduleState.online !== true) {
      item.moduleState = {
        ...DEFAULT_FITTED_MODULE_STATE,
        ...item.moduleState,
        online: true,
      };
      changed = true;
    }
    if (item.singleton !== 1) {
      item.singleton = 1;
      item.quantity = -1;
      item.stacksize = 1;
      changed = true;
    }
    if (meta) {
      if (!item.categoryID) {
        item.categoryID = meta.categoryID;
        changed = true;
      }
      if (!item.groupID) {
        item.groupID = meta.groupID;
        changed = true;
      }
    }
    if (changed) modulesFixed += 1;
    itemsRoot[key] = item;
  }

  return { modulesFixed, chargesFixed, skipped };
}

/**
 * Repair fittings inside a Docker volume gamestore.sqlite
 */
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
    typeMap[String(id)] = meta;
  }

  const script = `
const Database = require("better-sqlite3");
const typeMap = ${JSON.stringify(typeMap)};
const CHARGE_CATEGORY_ID = 8;
const FITTING_RANGES = [[11,34],[92,99],[125,132],[164,171]];
const DEFAULT_MODULE_STATE = ${JSON.stringify(DEFAULT_FITTED_MODULE_STATE)};
function isFit(flag) {
  const f = Number(flag)||0;
  return FITTING_RANGES.some(([lo,hi]) => f>=lo && f<=hi);
}
const db = new Database("/var/lib/evejs/gameStore/gamestore.sqlite"${dryRun ? ", { readonly: true }" : ""});
${!dryRun ? 'db.pragma("journal_mode = WAL");' : ""}
const rows = db.prepare("SELECT key, json FROM items").all();
let modulesFixed=0, chargesFixed=0;
const upd = ${dryRun ? "null" : 'db.prepare("UPDATE items SET json=? WHERE key=?")'};
for (const row of rows) {
  const item = JSON.parse(row.json);
  if (!isFit(item.flagID)) continue;
  const typeID = Number(item.typeID)||0;
  const meta = typeMap[String(typeID)] || null;
  const categoryID = Number(item.categoryID)|| (meta && meta.categoryID) || 0;
  let changed = false;
  if (categoryID === CHARGE_CATEGORY_ID) {
    const qty = Math.max(1, Number(item.stacksize)||Math.abs(Number(item.quantity))||1);
    if (item.singleton !== 0) { item.singleton = 0; changed = true; }
    if (Number(item.quantity) !== qty) { item.quantity = qty; changed = true; }
    if (Number(item.stacksize) !== qty) { item.stacksize = qty; changed = true; }
    if (item.moduleState != null) { delete item.moduleState; changed = true; }
    if (meta) {
      if (!item.categoryID) item.categoryID = meta.categoryID;
      if (!item.groupID) item.groupID = meta.groupID;
    }
    if (changed) chargesFixed++;
  } else {
    if (!item.moduleState || typeof item.moduleState !== "object") {
      item.moduleState = Object.assign({}, DEFAULT_MODULE_STATE);
      changed = true;
    } else if (item.moduleState.online !== true) {
      item.moduleState = Object.assign({}, DEFAULT_MODULE_STATE, item.moduleState, { online: true });
      changed = true;
    }
    if (item.singleton !== 1) {
      item.singleton = 1; item.quantity = -1; item.stacksize = 1; changed = true;
    }
    if (meta) {
      if (!item.categoryID) { item.categoryID = meta.categoryID; changed = true; }
      if (!item.groupID) { item.groupID = meta.groupID; changed = true; }
    }
    if (changed) modulesFixed++;
  }
  if (changed && upd) upd.run(JSON.stringify(item), row.key);
}
${!dryRun ? 'db.pragma("wal_checkpoint(TRUNCATE)");' : ""}
db.close();
process.stdout.write(JSON.stringify({ modulesFixed, chargesFixed, dryRun: ${dryRun ? "true" : "false"} }));
`;

  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "node",
      "-v",
      `${vol}:/var/lib/evejs`,
      "-w",
      "/app/server",
      img,
      "node",
      "-e",
      script,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `Docker repair failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  return JSON.parse(result.stdout || "{}");
}

module.exports = {
  repairItemsObject,
  repairDockerVolume,
};
