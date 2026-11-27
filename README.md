# EveJS Character Import

**v1.1.3**

Load a **personal character data export** (standard ESI dump folder layout) into
a local **EveJS** gameStore for private practice.

This tool does **not** perform EVE SSO or talk to Tranquility. Obtain a character
data export separately, then point this tool at that folder.

| Doc | Description |
|-----|-------------|
| **[GUIDE.md](./GUIDE.md)** | Walkthrough |
| **[NOTICE.md](./NOTICE.md)** | Privacy / trademarks |

## Quick start

```bash
# Build a players-bundle from an export directory
node tools/evejs-character-import/evejs-character-import.js package \
  --export-dir /path/to/export-folder

# Load into EveJS (server STOPPED)
# Native / non-Docker:
node tools/evejs-character-import/evejs-character-import.js import \
  --bundle _local/evejs-character-import/bundles/<id>/players-bundle.json \
  --host-only \
  --on-conflict overwrite
# Docker (or omit --host-only and pick when prompted):
#   ... import --bundle ... --on-conflict overwrite

# Faces for character select
node tools/evejs-character-import/evejs-character-import.js restore-portraits
```

## Docker layouts

| Layout | Volume | Image |
|--------|--------|-------|
| Stock EveJS | `evejs-data` | `evejs-local` |
| DML / evejs-xeve | `evejs-xeve-data` | `evejs-xeve-local` |

Auto-detected; prompt if several match. Override with `--volume` / `--image`.

## Install from GitHub

```bash
git clone https://github.com/IM0001GT/evejs-character-import.git tools/evejs-character-import
```

## Commands

```text
package | import | portraits | restore-portraits | import-appearance | help
```

(`convert` / `--dump` remain as aliases; so are `appearance` / `import-doll`.)

## Appearance (paper doll)

`portraits` gives a character its face as a 2D JPEG. `import-appearance` gives it
the underlying doll — sculpts, modifiers, colors, hair — so re-customisation and
the in-station avatar match too.

No web API serves doll data. The source is the EVE client's own method-call
cache: every `paperDollServer.GetPaperDollData` reply it receives is kept under
`<client cache>/MachoNet/<address>/<version>/CachedMethodCalls/`, and this
command decodes those files and rewrites them into `characters.appearanceInfo`.

```bash
# See which dolls the local client has cached (writes nothing)
node tools/evejs-character-import/evejs-character-import.js import-appearance --list

# Import for characters already imported (server STOPPED)
docker compose stop server
node tools/evejs-character-import/evejs-character-import.js import-appearance
docker compose start server
```

Pairing follows the same order as portraits: `tqImport.sourceCharacterID` on the
local record, then `--dump` / `--bundle` name matching, then explicit
`--map <localCharacterID>=<sourceCharacterID>`.

Caveats:

- Only characters the client has actually rendered are in its cache. Log the
  character in once on the source client if it is missing from `--list`.
- `paperdollResourceID` refers to client resources. A doll cached from a newer
  client than this server targets can reference a hairstyle or garment the local
  client has no resource for.
- Re-customising in the creator makes the client upload its own rendered
  portrait, overwriting imported JPEGs. Re-run
  `restore-portraits --force-download` afterwards.
