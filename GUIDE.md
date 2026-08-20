# EveJS Character Import — Guide

## Purpose

Take a **local character data export folder** and load it into a **local EveJS**
private server for practice and learning.

This tool does not connect to Tranquility and does not run ESI SSO.

## Fitting / ammo (v1.1+)

Packaging reads EveJS `itemTypes/data.json` so it can:

- write fitted modules (flags **11–132**, matching EveJS `buildMovedItemState`) with `moduleState.online = true`
- write category **8** charges/crystals/scripts/ammo as **stacks** (never singleton + `moduleState`)

Without that table, packaging **fails** rather than emitting a broken bundle.

Lookup order: `--type-data`, `$EVEJS_GAMESTORE_DATA_DIR`, `_local/gameStore/data`, `server/src/gameStore/data`, then Docker volumes when available.

Already imported with the old bug (server stopped):

```bash
node tools/evejs-character-import/evejs-character-import.js repair-fittings
```

Or re-`package` and re-`import`.

## Expected export layout

Point `--export-dir` at a folder that contains:

```text
export-folder/
  account.json
  characters/
    <id>_<name>/
      public.json
      skills.json
      assets.json
      ...
```

That is the usual personal ESI dump shape produced by common character-export
tooling.

## Requirements

1. A working EveJS install (stock or DML) you can start/stop  
2. Node.js (v20+ recommended)  
3. Docker recommended (volume-backed gameStore)  

## Package (convert export → players-bundle)

```bash
node tools/evejs-character-import/evejs-character-import.js package \
  --export-dir /path/to/export-folder
```

You can point `--export-dir` at one account folder, or at a parent `exports/`
root that contains several account folders — each is packaged in turn.

Output under `_local/evejs-character-import/bundles/`.

Citadel hangars and similar locations are remapped to a fallback NPC station
(default **Jita 4-4**).

```bash
node tools/evejs-character-import/evejs-character-import.js package \
  --export-dir /path/to/export-folder \
  --type-data /path/to/gameStore/data/itemTypes/data.json
```

## Import into EveJS

**Stop the server first.**

### Native / non-Docker install (EveJS 0.12.x including 0.12.6)

If Docker EveJS volumes also exist on the machine, the tool will **ask** whether
to use Docker or the native/host gameStore. To force native:

```bash
# From your EveJS install root (where _local/gameStore lives)
node tools/evejs-character-import/evejs-character-import.js import \
  --bundle path/to/players-bundle.json \
  --host-only \
  --on-conflict overwrite
```

Or point at the data dir explicitly (always skips Docker):

```bash
node tools/evejs-character-import/evejs-character-import.js import \
  --bundle path/to/players-bundle.json \
  --target /path/to/EveJS/_local/gameStore/data \
  --on-conflict overwrite
```

`--native` is an alias for `--host-only`.  
Typical native layout: `_local/gameStore/data` (sqlite is `_local/gameStore/gamestore.sqlite`).

If you pass `--target …/_local/gameStore` (store root), the tool normalizes to
`…/_local/gameStore/data` automatically.

### Native Node.js ABI (`better-sqlite3`)

Host import loads EveJS’s `server/node_modules/better-sqlite3`. That native
addon must match the **same Node major** you use to run `import`.

Example error: `NODE_MODULE_VERSION 137` vs `147` (Node 24 vs Node 26).

Fix (from the EveJS install):

```bash
node -p "process.version + ' modules=' + process.versions.modules"
cd /path/to/evejs/server
npm rebuild better-sqlite3
# or: rm -rf node_modules && npm ci
```

Prefer using the same Node the server was installed/started with (nvm/fnm help).

### Docker install

```bash
node tools/evejs-character-import/evejs-character-import.js import \
  --bundle path/to/players-bundle.json \
  --on-conflict overwrite
```

| Layout | Volume | Image |
|--------|--------|-------|
| Stock | `evejs-data` | `evejs-local` |
| DML | `evejs-xeve-data` | `evejs-xeve-local` |

```bash
# Explicit Docker volume
... import --bundle ... --volume evejs-data --image evejs-local
```

## Portraits

```bash
node tools/evejs-character-import/evejs-character-import.js restore-portraits
node tools/evejs-character-import/evejs-character-import.js restore-portraits --sync-only
```

On EveJS 0.12.5+, faces live in the Docker volume under
`gameStore/images/Character/`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Native install but Docker volume used | Pass `--host-only` / `--native` or `--target …/_local/gameStore/data` |
| `NODE_MODULE_VERSION` / better-sqlite3 | Same Node as the server; `cd server && npm rebuild better-sqlite3` |
| Wrong volume / empty characters | Pass `--volume` / `--image` for Docker, or `--target` for host |
| Import while server running | Stop the server first (compose or native) |
| Blank faces after upgrade | `restore-portraits` |
