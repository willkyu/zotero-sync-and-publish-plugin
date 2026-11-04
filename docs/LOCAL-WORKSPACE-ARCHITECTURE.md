# Local Workspace architecture

## Data ownership

| Representation | Shared? | Role |
|---|---:|---|
| Zotero live SQLite | no | Zotero runtime source; never placed in Git |
| `zotero/**` deterministic JSON | yes | structured mirror and cross-machine restore input |
| `content/papers/**.md` | yes | publishable/editable reading-note representation |
| `content/assets/**` | yes | publishable note-image bytes |
| `zotero/.zotero-sync/bindings.json` | yes | stable library/parent/note/path/image identities and last coordinated hashes |
| Zotero profile `zotero-quartz-workspace/state-*.json` | no | machine-local Zotero↔workspace mirror baseline |
| Zotero profile `zotero-quartz-workspace/api-*.json` | no | machine-local workspace↔GitHub API baseline |

The shared binding contains logical identities only. Better Notes' numeric item ID and absolute sync directory are reconstructed on each computer.

## Coordination state machine

For a bound note, `md5` and `noteMd5` in the shared binding are the last coordinated pair.

| Markdown vs base | Native note vs base | Action |
|---|---|---|
| same | same | no-op |
| changed | same | Better Notes import, then export metadata and verify both hashes |
| same | changed | Better Notes export, preserving cached YAML, then verify both hashes |
| changed | changed | retain both; pending conflict |

Deleting either member of a bound child-note/Markdown pair deletes the other member and removes the binding without confirmation. If the parent bibliographic item is deleted, the binding is removed but the Markdown is retained as an ordinary research document.

A visible Zotero note pane is saved before coordination; visibility alone does not defer synchronization because Zotero's item notification refreshes the live editor after an external note update. If both the saved editor content and Markdown changed, the ordinary two-sided conflict rule still applies. Because `onSyncing()` has no result contract and also compares machine-local Zotero version numbers, the adapter chooses direction from shared content hashes, invokes Better Notes' public `$import.fromMD` / `convert.note2md` APIs, and then re-reads Markdown content and note HTML. Project-managed notes are removed from Better Notes' machine-local periodic-sync list so two background schedulers cannot rewrite the same file; conversion remains entirely Better Notes-owned. Export uses `skipSavingImages` so Better Notes does not create a second global-attachment-folder copy; image bytes are handled by the project-scoped image coordinator. Unsupported lossy Markdown remains pending.

Image mappings add an attachment key, repository-relative path and byte SHA-256. Missing bytes are restored even if the attachment row exists. Same-name changes compare both sides to this hash. A dual change remains pending.

## Mirror and transport transaction

The mirror uses upstream `Exporter`, `Planner` and `Importer`. Local files are exposed to Importer through a filesystem blob client; stable Zotero keys remain the only cross-machine item identity. Writes use a sibling temporary path and atomic replace. `files.json` lists only plugin-managed output.

Local and cloud scheduling are separate. Zotero notifications and a five-second managed-path poll always queue local coordination with a short debounce. GitHub startup, interval, after-change and after-Zotero-sync preferences queue a cloud transaction, whose first phase is the same local coordination. Pausing GitHub automation never disables the local scheduler or its delete-wins rules. The local baseline identity depends only on workspace path and mirror folder, not on transport or remote repository.

A fresh GitHub API configuration has an explicit bootstrap barrier. Until the machine-local API state exists, background local coordination returns `awaiting-cloud-bootstrap`; the first cloud transaction must successfully read/download the remote tree before Zotero export/import begins. This makes an empty folder safe for one-click setup and prevents a new computer's empty library from racing the initial remote restore.

System Git uses Firefox `Subprocess.sys.mjs` with argument arrays and `git -C`; it never invokes a shell. Fetch is observational. Fast-forward happens only with a clean worktree. A normal non-force push provides the final remote compare-and-swap. Existing index entries or repository operations stop the Git phase.

GitHub API transport scans every configured managed workspace path and compares Git blob hashes against the remote tree and a machine-local base. If an API baseline lacks a path but the workspace is also a checkout of the configured repository, the transport may read the Git index SHA to establish that path's ancestry; this is read-only and optional, so API transport still works without Git. Remote-only changes are downloaded atomically before Zotero/Better Notes coordination. A remote deletion removes a local file only when its hash still equals the shared base. Local-only changes are written as blobs and one tree/commit; the branch ref update is non-force and fails if another computer moved it. Dual changes remain untouched on both sides and pending. Ordinary API blobs are capped at 95 MB; repositories requiring Git LFS use System Git transport.

All generated JSON uses stable key ordering, two-space indentation and a final newline. The bytes are deterministic and match Prettier's JSON output, allowing Quartz repositories to run `prettier . --check` over the mirror.

`content/` is staged as ordinary knowledge-base data, but only bound paper notes enter the Better Notes state machine. Other pages are opaque Git content.

## Source/API findings

- Better Notes 3.3.3 `hooks.onSyncing()` returns no per-note result and catches internal errors.
- `skipActive` uses visible Zotero note editors and silently skips them.
- `syncMDBatch()` preserves cached YAML and updates Better Notes' local hashes.
- image export skips an existing target filename; image import skips an existing attachment key. The adapter therefore checks and repairs bytes independently.
- Better Notes `$itemKey` names the note item. The parent bibliographic key is stored separately in the shared binding.
