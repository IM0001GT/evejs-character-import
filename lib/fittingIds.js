"use strict";

/**
 * Saved-fitting IDs for an import.
 *
 * fittingIDs are global in an EVE.js store: fittingStore.js allocates them from
 * savedFittings `_meta.nextFittingID` and looks fittings up by ID across every
 * owner. A bundle is built offline, so convert.js can only give its fittings
 * provisional IDs (1..N). importPlayers.js copies the savedFittings row as-is
 * and never touches `_meta`, so importing those IDs verbatim would reuse IDs
 * the target already holds and leave the counter behind them.
 *
 * So before importPlayers.js runs, `reserve` (run inside the target server tree,
 * with the server stopped) takes N IDs from the target the way
 * fittingStore.allocateNextFittingIDs does, writes the advanced counter, and
 * writes a copy of the bundle with its fittings re-numbered into that range.
 * If the import is then skipped or fails, the reserved IDs are simply unused.
 *
 * CLI (cwd = the server directory, i.e. /app/server in the image):
 *   node fittingIds.js reserve <bundle-in.json> <bundle-out.json>
 * Prints one JSON line: {reserved, firstFittingID, nextFittingID}.
 */

const fs = require("fs");
const path = require("path");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function* bundleFittingRows(bundle) {
  for (const account of (bundle && bundle.accounts) || []) {
    for (const character of (account && account.characters) || []) {
      const row = character && character.simple && character.simple.savedFittings;
      if (row && row.fittings && typeof row.fittings === "object") yield row;
    }
  }
}

function countBundleFittings(bundle) {
  let count = 0;
  for (const row of bundleFittingRows(bundle)) count += Object.keys(row.fittings).length;
  return count;
}

/** Re-key every bundle fitting to firstFittingID, firstFittingID + 1, ... */
function renumberBundleFittings(bundle, firstFittingID) {
  let next = toInt(firstFittingID, 0);
  if (next <= 0) throw new Error(`invalid first fittingID ${firstFittingID}`);
  for (const row of bundleFittingRows(bundle)) {
    const renumbered = {};
    for (const record of Object.values(row.fittings)) {
      const fittingID = next;
      next += 1;
      renumbered[String(fittingID)] = { ...record, fittingID };
    }
    row.fittings = renumbered;
  }
  return next;
}

/** First free ID: past both the counter and every ID already stored. */
function firstFreeFittingID(storeRoot) {
  const meta = storeRoot && storeRoot._meta && typeof storeRoot._meta === "object"
    ? storeRoot._meta
    : {};
  let maxUsed = 0;
  const owners = storeRoot && storeRoot.owners && typeof storeRoot.owners === "object"
    ? storeRoot.owners
    : {};
  for (const owner of Object.values(owners)) {
    for (const key of Object.keys((owner && owner.fittings) || {})) {
      maxUsed = Math.max(maxUsed, toInt(key, 0));
    }
  }
  return Math.max(1, toInt(meta.nextFittingID, 1), maxUsed + 1);
}

function requireSuccess(result, operation) {
  if (!result || result.success !== true) {
    throw new Error(`${operation} failed: ${(result && (result.errorMsg || result.code)) || "unknown error"}`);
  }
  return result;
}

async function reserveInStore(count, serverRoot) {
  // Same lifecycle importPlayers.js uses: maintenance owner, lease, write,
  // flush, checked shutdown. Role must be set before the store is required.
  process.env.EVEJS_GAMESTORE_OWNER_ROLE = "maintenance";
  const database = require(path.join(serverRoot, "src", "gameStore", "index"));
  const { prepareSharedStore } = require(path.join(serverRoot, "src", "gameStore", "startupSharedStore"));
  let failure = null;
  let reservation = null;
  try {
    if (!fs.existsSync(database._sqliteDbPath)) prepareSharedStore(database._sqliteDbPath);
    database.acquirePersistenceOwnerLease({ recover: true });
    const read = database.read("savedFittings", "/");
    const root = read && read.success && read.data && typeof read.data === "object" ? read.data : {};
    const firstFittingID = firstFreeFittingID(root);
    const meta = root._meta && typeof root._meta === "object" ? root._meta : {};
    const nextMeta = {
      ...meta,
      version: toInt(meta.version, 0) > 0 ? toInt(meta.version, 1) : 1,
      nextFittingID: firstFittingID + count,
    };
    requireSuccess(database.write("savedFittings", "/_meta", nextMeta), "write savedFittings/_meta");
    requireSuccess(database.flushTablesSync(["savedFittings"]), "flush savedFittings");
    reservation = { reserved: count, firstFittingID, nextFittingID: nextMeta.nextFittingID };
  } catch (error) {
    failure = error;
  } finally {
    try {
      requireSuccess(await database.shutdown("tq-import-fitting-ids"), "GameStore shutdown");
    } catch (shutdownError) {
      failure = failure || shutdownError;
    }
  }
  if (failure) throw failure;
  return reservation;
}

async function cli(argv) {
  const [command, inPath, outPath] = argv;
  if (command !== "reserve" || !inPath || !outPath) {
    console.error("usage: node fittingIds.js reserve <bundle-in.json> <bundle-out.json>");
    process.exitCode = 2;
    return;
  }
  const bundle = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const count = countBundleFittings(bundle);
  let result = { reserved: 0, firstFittingID: null, nextFittingID: null };
  if (count > 0) {
    result = await reserveInStore(count, process.cwd());
    renumberBundleFittings(bundle, result.firstFittingID);
  }
  fs.writeFileSync(outPath, JSON.stringify(bundle));
  console.log(`fitting IDs: ${JSON.stringify(result)}`);
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  countBundleFittings,
  renumberBundleFittings,
  firstFreeFittingID,
};
