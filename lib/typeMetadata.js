"use strict";

/**
 * Resolve EveJS SDE-built itemTypes/data.json and index by typeID.
 *
 * Required to tell charges (category 8) from modules: ESI does not send
 * categoryID, and crystals are often is_singleton=true even though EveJS
 * stores loaded ammo as stacks.
 *
 * Resolution order:
 *   1. explicit --type-data / --types-json path
 *   2. $EVEJS_ITEMTYPES_JSON
 *   3. $EVEJS_GAMESTORE_DATA_DIR/itemTypes/data.json
 *   4. <repo>/_local/gameStore/data/itemTypes/data.json
 *   5. <repo>/server/src/gameStore/data/itemTypes/data.json
 *   6. Docker volumes evejs-xeve-data / evejs-data (read-only)
 *
 * Fails loudly if nothing usable is found — silently packaging without
 * type metadata reintroduces the sticky-ammo / offline-module bugs.
 */

const fs = require("fs");
const path = require("path");
const { REPO_ROOT } = require("./paths");

const TYPE_TABLE_RELATIVE = path.join("itemTypes", "data.json");
const cache = new Map();

function candidateTypeDataPaths(explicitPath) {
  if (explicitPath) {
    const abs = path.resolve(explicitPath);
    // Explicit path never soft-falls-back: wrong --type-data must fail.
    return [abs, path.join(abs, TYPE_TABLE_RELATIVE)];
  }
  const candidates = [];
  if (process.env.EVEJS_ITEMTYPES_JSON) {
    candidates.push(path.resolve(process.env.EVEJS_ITEMTYPES_JSON));
  }
  if (process.env.EVEJS_GAMESTORE_DATA_DIR) {
    candidates.push(
      path.join(path.resolve(process.env.EVEJS_GAMESTORE_DATA_DIR), TYPE_TABLE_RELATIVE),
    );
  }
  candidates.push(
    path.join(REPO_ROOT, "_local", "gameStore", "data", TYPE_TABLE_RELATIVE),
    path.join(REPO_ROOT, "server", "src", "gameStore", "data", TYPE_TABLE_RELATIVE),
  );
  return candidates;
}

function resolveTypeDataPath(explicitPath) {
  const tried = candidateTypeDataPaths(explicitPath);
  for (const candidate of tried) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { filePath: candidate, tried };
      }
    } catch (_) {
      // continue
    }
  }
  return { filePath: null, tried };
}

function buildTableFromParsed(parsed, sourceLabel) {
  const types = parsed && Array.isArray(parsed.types)
    ? parsed.types
    : parsed && parsed.typesByTypeID
      ? Object.values(parsed.typesByTypeID)
      : Array.isArray(parsed)
        ? parsed
        : null;
  if (!types || types.length === 0) {
    throw new Error(
      `Unexpected item type table shape in ${sourceLabel}: expected ` +
        "{ types: [ { typeID, categoryID, ... } ] }.",
    );
  }

  const byTypeID = new Map();
  for (const row of types) {
    const typeID = Number(row && row.typeID);
    if (Number.isFinite(typeID) && typeID > 0) {
      byTypeID.set(typeID, row);
    }
  }
  if (byTypeID.size === 0) {
    throw new Error(`No usable typeID rows in ${sourceLabel}.`);
  }

  return {
    path: sourceLabel,
    size: byTypeID.size,
    byTypeID,
    get(typeID) {
      return byTypeID.get(Number(typeID)) || null;
    },
    categoryIdOf(typeID) {
      const row = byTypeID.get(Number(typeID));
      const categoryID = row ? Number(row.categoryID) : NaN;
      return Number.isFinite(categoryID) ? categoryID : 0;
    },
  };
}

function tryLoadDockerTypeTable() {
  const { spawnSync } = require("child_process");
  for (const volume of ["evejs-xeve-data", "evejs-data"]) {
    for (const image of ["evejs-xeve-local", "evejs-local"]) {
      const result = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--user",
          "node",
          "-v",
          `${volume}:/var/lib/evejs`,
          image,
          "node",
          "-e",
          'process.stdout.write(require("fs").readFileSync("/var/lib/evejs/gameStore/data/itemTypes/data.json","utf8"))',
        ],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      );
      if (result.status === 0 && result.stdout && result.stdout.length > 100) {
        try {
          return buildTableFromParsed(JSON.parse(result.stdout), `docker:${volume}`);
        } catch (_) {
          // try next
        }
      }
    }
  }
  return null;
}

/**
 * @param {string|null} explicitPath --type-data / --types-json
 * @param {{ required?: boolean }} options  required=true (default) throws if missing
 */
function loadTypeMetadata(explicitPath, options = {}) {
  const required = options.required !== false;
  const cacheKey = String(explicitPath || "") + "|" + String(required);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const { filePath, tried } = resolveTypeDataPath(explicitPath);
  if (filePath) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Failed to parse the EveJS item type table ${filePath}: ${error.message}`,
      );
    }
    const table = buildTableFromParsed(parsed, filePath);
    cache.set(cacheKey, table);
    return table;
  }

  // Explicit path must not soft-fallback to Docker.
  if (!explicitPath) {
    const dockerTable = tryLoadDockerTypeTable();
    if (dockerTable) {
      cache.set(cacheKey, dockerTable);
      return dockerTable;
    }
  }

  if (!required) {
    const empty = {
      path: null,
      size: 0,
      byTypeID: new Map(),
      get() {
        return null;
      },
      categoryIdOf() {
        return 0;
      },
    };
    cache.set(cacheKey, empty);
    return empty;
  }

  throw new Error(
    "Cannot find the EveJS item type table (itemTypes/data.json). Tried:\n" +
      tried.map((p) => `  ${p}`).join("\n") +
      "\n  (plus Docker volumes evejs-xeve-data / evejs-data when available)\n" +
      "Pass --type-data <path-to-itemTypes/data.json> or set EVEJS_GAMESTORE_DATA_DIR.",
  );
}

module.exports = {
  loadTypeMetadata,
  resolveTypeDataPath,
  candidateTypeDataPaths,
};
