"use strict";

/**
 * Repair already-imported inventory rows:
 * - Fitted modules (non-charge in a ship slot): ensure moduleState.online=true
 * - Fitted charges (category 8 in a ship slot): force stack form, strip moduleState
 *
 * The repair itself is the `repair-fittings` job in lib/gameStoreJob.js, written
 * through the server's own gameStore module, either in a one-off container of the
 * server image or on the host server tree: from 261125.x `items` is a typed view
 * that refuses `UPDATE ... SET json`.
 */

const fs = require("fs");
const path = require("path");
const {
  loadTypeIndex,
  DEFAULT_FITTED_MODULE_STATE,
} = require("./convert");
const { spawnJob } = require("./gameStoreJob");
const { REPO_ROOT } = require("./paths");

function buildJobInput(typeIndex) {
  const typeMap = {};
  for (const [id, meta] of typeIndex.byTypeID.entries()) {
    typeMap[String(id)] = {
      categoryID: meta.categoryID,
      groupID: meta.groupID,
    };
  }
  return { typeMap, defaultModuleState: DEFAULT_FITTED_MODULE_STATE };
}

function repairDockerVolume({ volume, image, typesJson, dryRun = false } = {}) {
  const typeIndex = loadTypeIndex({ typesJson });
  if (!typeIndex.source || typeIndex.byTypeID.size === 0) {
    throw new Error(
      "itemTypes static data required for repair-fittings (pass --types-json or use Docker volume)",
    );
  }

  const vol = volume || "evejs-xeve-data";
  const img = image || "evejs-xeve-local";

  return spawnJob("repair-fittings", buildJobInput(typeIndex), {
    docker: { volume: vol, image: img },
    dryRun,
  });
}

/**
 * Repair fittings in a native/host gameStore (gamestore.sqlite beside data/).
 */
function repairHostSqlite({ sqlitePath, typesJson, dryRun = false } = {}) {
  const abs = path.resolve(sqlitePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Host sqlite not found: ${abs}`);
  }

  const typeIndex = loadTypeIndex({ typesJson, required: true });
  if (!typeIndex.source || typeIndex.byTypeID.size === 0) {
    throw new Error(
      "itemTypes static data required for repair-fittings (pass --type-data)",
    );
  }

  return spawnJob("repair-fittings", buildJobInput(typeIndex), {
    dataDir: path.join(path.dirname(abs), "data"),
    repoRoot: REPO_ROOT,
    dryRun,
  });
}

module.exports = {
  repairDockerVolume,
  repairHostSqlite,
};
