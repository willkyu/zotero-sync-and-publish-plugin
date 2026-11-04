# Local Workspace architecture

## Data ownership

| Representation | Shared? | Role |
|---|---:|---|
| Zotero live SQLite | no | Zotero runtime source; never placed in Git |
| `zotero/**` deterministic JSON | yes | structured mirror and cross-machine restore input |
| `content/papers/**.md` | yes | publishable/editable reading-note representation |
| `content/assets/**` | yes | publishable note-image bytes |
| `zotero/.zotero-sync/bindings.json` | yes | stable library/parent/note/path/image identities and last coordinated hashes |
| Zotero profile `zotero-quartz-workspace/state-*.json` | no | machine-local three-way mirror baseline |

The shared binding contains logical identities only. Better Notes' numeric item ID and absolute sync directory are reconstructed on each computer.

## Coordination state machine

For a bound note, `md5` and `noteMd5` in the shared binding are the last coordinated pair.

| Markdown vs base | Native note vs base | Action |
|---|---|---|
| same | same | no-op |
| changed | same | Better Notes import, then export metadata and verify both hashes |
| same | changed | Better Notes export, preserving cached YAML, then verify both hashes |
| changed | changed | retain both; pending conflict |

An active Zotero note editor changes the result to `editing` and queues another run. Because `onSyncing()` has no result contract and also compares machine-local Zotero version numbers, the adapter chooses direction from shared content hashes, invokes Better Notes' public `$import.fromMD` / `convert.note2md` APIs, and then re-reads Markdown content and note HTML. Project-managed notes are removed from Better Notes' machine-local periodic-sync list so two background schedulers cannot rewrite the same file; conversion remains entirely Better Notes-owned. Export uses `skipSavingImages` so Better Notes does not create a second global-attachment-folder copy; image bytes are handled by the project-scoped image coordinator. Unsupported lossy Markdown remains pending.

Image mappings add an attachment key, repository-relative path and byte SHA-256. Missing bytes are restored even if the attachment row exists. Same-name changes compare both sides to this hash. A dual change remains pending.

## Mirror and Git transaction

The mirror uses upstream `Exporter`, `Planner` and `Importer`. Local files are exposed to Importer through a filesystem blob client; stable Zotero keys remain the only cross-machine item identity. Writes use a sibling temporary path and atomic replace. `files.json` lists only plugin-managed output.

Git uses Firefox `Subprocess.sys.mjs` with argument arrays and `git -C`; it never invokes a shell. Fetch is observational. Fast-forward happens only with a clean worktree. A normal non-force push provides the final remote compare-and-swap. Existing index entries or repository operations stop the Git phase. Deletions never execute automatically in this release.

`content/` is staged as ordinary knowledge-base data, but only bound paper notes enter the Better Notes state machine. Other pages are opaque Git content.

## Source/API findings

- Better Notes 3.3.3 `hooks.onSyncing()` returns no per-note result and catches internal errors.
- `skipActive` uses visible Zotero note editors and silently skips them.
- `syncMDBatch()` preserves cached YAML and updates Better Notes' local hashes.
- image export skips an existing target filename; image import skips an existing attachment key. The adapter therefore checks and repairs bytes independently.
- Better Notes `$itemKey` names the note item. The parent bibliographic key is stored separately in the shared binding.
