"use strict";

/**
 * Run one write job against an EVE.js gameStore through the server's own
 * gameStore module, never raw SQL.
 *
 * From 261125.x the legacy `characters` / `items` tables are views over typed
 * tables with INSTEAD OF INSERT/DELETE triggers only, so `UPDATE ... SET json`
 * fails ("cannot modify characters because it is a view"), and a record the
 * schema does not accept is refused. Going through the module gets the same
 * validation, persistence lease and flush the server uses, as importPlayers.js
 * does: maintenance owner, lease, write, flush, checked shutdown.
 *
 * The server must be stopped: it caches tables in memory and flushes over them.
 *
 * CLI (cwd = the server directory, /app/server in the image; job input on stdin):
 *   node gameStoreJob.js <appearance|repair-fittings> [--dry-run]
 * The job's result is printed as one line `@@RESULT@@<json>`; the store's own
 * log lines also go to stdout, so callers parse with parseJobOutput().
 */

const fs = require("fs");
const path = require("path");

const RESULT_PREFIX = "@@RESULT@@";
const CHARGE_CATEGORY_ID = 8;
// itemStore.js buildMovedItemState: only modules (7), subsystems (32) and
// structure modules (66) carry a moduleState. Drones and fighters sit in bays
// inside 11..132 but are stacks, never modules.
const FITTABLE_MODULE_CATEGORY_IDS = new Set([7, 32, 66]);
// Mirrors buildMovedItemState in itemStore.js (11..132 inclusive).
const FITTING_FLAG_MIN = 11;
const FITTING_FLAG_MAX = 132;

function requireSuccess(result, operation) {
  if (!result || result.success !== true) {
    throw new Error(`${operation} failed: ${(result && (result.errorMsg || result.code)) || "unknown error"}`);
  }
  return result;
}

function readData(database, table, recordPath) {
  const result = database.read(table, recordPath);
  return result && result.success ? result.data : undefined;
}

/** Set appearanceInfo on imported characters. input: {updates: [{localCharacterID, appearanceInfo, overwrite}]} */
function appearanceJob(database, input, { dryRun }) {
  const results = [];
  for (const entry of (input && input.updates) || []) {
    const key = String(entry.localCharacterID);
    const record = readData(database, "characters", `/${key}`);
    if (!record || typeof record !== "object") {
      results.push({ localCharacterID: entry.localCharacterID, ok: false, error: "character not found" });
      continue;
    }
    const had = Boolean(record.appearanceInfo && typeof record.appearanceInfo === "object");
    if (had && !entry.overwrite) {
      results.push({ localCharacterID: entry.localCharacterID, ok: false, error: "already has appearanceInfo (pass --overwrite)" });
      continue;
    }
    const next = {
      ...record,
      appearanceInfo: entry.appearanceInfo,
      paperDollState: 0,
      tqImport: { ...(record.tqImport || {}), appearanceImportedAt: new Date().toISOString() },
    };
    if (!dryRun) requireSuccess(database.write("characters", `/${key}`, next), `write character ${key}`);
    results.push({ localCharacterID: entry.localCharacterID, ok: true, replaced: had, dryRun: Boolean(dryRun) });
  }
  return { tables: ["characters"], result: results };
}

/**
 * Online fitted modules and stack fitted charges on imported items.
 * input: {typeMap: {typeID: {categoryID, groupID}}, defaultModuleState}
 */
function repairFittingsJob(database, input, { dryRun }) {
  const typeMap = (input && input.typeMap) || {};
  const defaultModuleState = (input && input.defaultModuleState) || { online: true };
  const items = readData(database, "items", "/") || {};
  let modulesFixed = 0;
  let chargesFixed = 0;
  for (const [key, original] of Object.entries(items)) {
    if (!original || typeof original !== "object") continue;
    const flagID = Number(original.flagID) || 0;
    if (flagID < FITTING_FLAG_MIN || flagID > FITTING_FLAG_MAX) continue;
    const item = { ...original };
    const meta = typeMap[String(Number(item.typeID) || 0)] || null;
    const categoryID = Number(item.categoryID) || (meta && meta.categoryID) || 0;
    let changed = false;

    if (categoryID === CHARGE_CATEGORY_ID) {
      const qty = Math.max(1, Number(item.stacksize) || Math.abs(Number(item.quantity)) || 1);
      if (item.singleton !== 0) { item.singleton = 0; changed = true; }
      if (Number(item.quantity) !== qty) { item.quantity = qty; changed = true; }
      if (Number(item.stacksize) !== qty) { item.stacksize = qty; changed = true; }
      if (Object.prototype.hasOwnProperty.call(item, "moduleState")) { delete item.moduleState; changed = true; }
      if (meta) {
        if (!item.categoryID && meta.categoryID) { item.categoryID = meta.categoryID; changed = true; }
        if (!item.groupID && meta.groupID) { item.groupID = meta.groupID; changed = true; }
      }
      if (changed) chargesFixed += 1;
    } else if (FITTABLE_MODULE_CATEGORY_IDS.has(categoryID)) {
      if (!item.moduleState || typeof item.moduleState !== "object") {
        item.moduleState = { ...defaultModuleState };
        changed = true;
      } else if (item.moduleState.online !== true) {
        item.moduleState = { ...defaultModuleState, ...item.moduleState, online: true };
        changed = true;
      }
      if (item.singleton !== 1) {
        item.singleton = 1;
        item.quantity = -1;
        item.stacksize = 1;
        changed = true;
      }
      if (meta) {
        if (!item.categoryID && meta.categoryID) { item.categoryID = meta.categoryID; changed = true; }
        if (!item.groupID && meta.groupID) { item.groupID = meta.groupID; changed = true; }
      }
      if (changed) modulesFixed += 1;
    }
    if (changed && !dryRun) requireSuccess(database.write("items", `/${key}`, item), `write item ${key}`);
  }
  return { tables: ["items"], result: { modulesFixed, chargesFixed, dryRun: Boolean(dryRun) } };
}

/**
 * Mark characters so character select asks the image server for their portrait.
 * input: {localCharacterIDs, portraitSizes, defaultPortraitInfo}
 */
function portraitReadyJob(database, input, { dryRun }) {
  const results = [];
  for (const id of (input && input.localCharacterIDs) || []) {
    const key = String(id);
    const record = readData(database, "characters", `/${key}`);
    if (!record || typeof record !== "object") {
      results.push({ localCharacterID: id, ok: false, error: "character not found" });
      continue;
    }
    const portraitInfo = record.portraitInfo && typeof record.portraitInfo === "object"
      ? { ...record.portraitInfo, paperdollState: 0 }
      : { ...(input.defaultPortraitInfo || {}) };
    const next = {
      ...record,
      paperDollState: 0,
      portraitInfo,
      portraitUploadedAt: new Date().toISOString(),
      portraitSizes: (input.portraitSizes || []).slice(),
    };
    if (!dryRun) requireSuccess(database.write("characters", `/${key}`, next), `write character ${key}`);
    results.push({ localCharacterID: id, ok: true, dryRun: Boolean(dryRun) });
  }
  return { tables: ["characters"], result: results };
}

const JOBS = {
  appearance: appearanceJob,
  "portrait-ready": portraitReadyJob,
  "repair-fittings": repairFittingsJob,
};

async function runJob(name, input, { dryRun = false, serverRoot = process.cwd() } = {}) {
  const job = JOBS[name];
  if (!job) throw new Error(`unknown gameStore job ${name}`);
  // Role must be set before the store is required. A dry run only reads.
  process.env.EVEJS_GAMESTORE_OWNER_ROLE = dryRun ? "reader" : "maintenance";
  const database = require(path.join(serverRoot, "src", "gameStore", "index"));
  let failure = null;
  let outcome = null;
  try {
    if (!fs.existsSync(database._sqliteDbPath)) {
      throw new Error(`No gamestore.sqlite at ${database._sqliteDbPath}`);
    }
    if (!dryRun) database.acquirePersistenceOwnerLease({ recover: true });
    outcome = job(database, input, { dryRun });
    if (!dryRun) requireSuccess(database.flushTablesSync(outcome.tables), `flush ${outcome.tables.join(", ")}`);
  } catch (error) {
    failure = error;
  } finally {
    try {
      requireSuccess(await database.shutdown(`tq-import-${name}`), "GameStore shutdown");
    } catch (shutdownError) {
      failure = failure || shutdownError;
    }
  }
  if (failure) throw failure;
  return outcome.result;
}

/** Pull the job result out of a run's stdout (store log lines are mixed in). */
function parseJobOutput(stdout) {
  const line = String(stdout || "").split(/\r?\n/).reverse().find((l) => l.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`gameStore job printed no result: ${String(stdout || "").slice(-500)}`);
  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

/**
 * Run a job in a one-off container of the server image on a Docker volume
 * (docker: {volume, image}), or on the host server tree (dataDir optional).
 */
function spawnJob(name, input, { docker = null, dataDir = null, dryRun = false, repoRoot } = {}) {
  const { spawnSync } = require("child_process");
  const jobArgs = [name, ...(dryRun ? ["--dry-run"] : [])];
  const options = { encoding: "utf8", input: JSON.stringify(input), maxBuffer: 64 * 1024 * 1024 };
  let result;
  if (docker) {
    result = spawnSync("docker", [
      "run", "--rm", "-i", "--user", "node",
      "-v", `${docker.volume}:/var/lib/evejs`,
      "-v", `${__dirname}:/tq-import-lib:ro`,
      "-e", "EVEJS_GAMESTORE_DATA_DIR=/var/lib/evejs/gameStore/data",
      "-w", "/app/server",
      docker.image,
      "node", "/tq-import-lib/gameStoreJob.js", ...jobArgs,
    ], options);
  } else {
    const env = { ...process.env };
    if (dataDir) env.EVEJS_GAMESTORE_DATA_DIR = path.resolve(dataDir);
    result = spawnSync(process.execPath, [path.join(__dirname, "gameStoreJob.js"), ...jobArgs], {
      ...options,
      cwd: path.join(repoRoot, "server"),
      env,
    });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gameStore job ${name} failed (status ${result.status}): ${result.stderr || result.stdout || ""}`);
  }
  return parseJobOutput(result.stdout);
}

if (require.main === module) {
  const [name, ...rest] = process.argv.slice(2);
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  runJob(name, input, { dryRun: rest.includes("--dry-run") })
    .then((result) => { process.stdout.write(`\n${RESULT_PREFIX}${JSON.stringify(result)}\n`); })
    .catch((error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
}

module.exports = { runJob, spawnJob, parseJobOutput, RESULT_PREFIX };
