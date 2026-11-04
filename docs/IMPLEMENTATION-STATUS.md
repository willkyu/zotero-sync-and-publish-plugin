# Implementation and verification status

Updated: 2026-11-04

## Implemented

- One unified Local Workspace with selectable System Git or GitHub API transport.
- Configurable repository, Git executable, remote, branch, commit scope, papers/assets/Vault/template paths.
- Local deterministic JSON export, atomic writes, safe managed-file list and conservative three-way import.
- Empty-library bootstrap by stable keys; no local delete import and no automatic cross-computer delete.
- Better Notes 3.3.3 adapter, shared bindings, hash-based direction choice, active-editor deferral and post-call completion checks.
- Separate image/PDF policy, image byte hashes, missing-storage repair and same-name update detection.
- Standard Obsidian `open` URI from context menu and keyboard shortcut; reuse/recover/create behavior.
- Zotero-change, content-change, startup, interval and manual triggers with queued events during a running sync.
- System Git fetch/fast-forward/add/commit/push with staged/index/operation safeguards and no force push.
- Whole-workspace GitHub API tree synchronization with a machine-local three-way base, atomic downloads, safe deletion rules, conflict preservation and non-force ref updates.
- Fork update identity/version strategy, Chinese manual and architecture record.

## Actually tested in this environment

- JavaScript syntax checks for all runtime modules.
- Pure tests for planner behavior, stable serialization, path traversal, binding uniqueness, unsafe Markdown detection, Obsidian-relative image paths and Git porcelain parsing.
- Real Git CLI test with temporary bare remote and three clones: fast-forward receive, dirty-tree protection, existing staged-content refusal, scoped commit, non-managed file exclusion and push.
- In-memory GitHub remote integration test: initial two-way transfer, independent local/remote edits, commit, and same-file conflict preservation.
- Existing upstream pure tests continue to pass.
- XPI build and archive contents/version checks (see final build output/CI).
- Read-only inspection of `C:\Users\willkyu\Documents\.Papers\research`: expected content directories, `main`, `origin`, Vault, assets and current dirty state were detected; no production data was changed.

## Not yet verified on a real GUI/profile

- Zotero 8/9/10 window rendering and preference binding on both Windows and macOS.
- Live Better Notes converter round trips, editor-visible detection, diff window behavior and template import in an isolated profile.
- Real Zotero storage restoration for an attachment row whose image file is missing.
- End-to-end A/B Zotero profiles with actual item IDs differing across machines.
- macOS process lookup/path behavior and filesystem watcher timing.
- Quartz rendering and GitHub Actions deployment (push success is deliberately not reported as deployment success).

## Known limitations

- Zotero mirror item deletions remain pending and require manual Zotero reconciliation; Markdown is never deleted merely because a literature item disappeared. API transport may apply an ordinary workspace-file deletion only when the unchanged opposite side still matches the machine-local base.
- Dual edits do not attempt an automatic textual merge.
- Task checkboxes and Obsidian embeds are deliberately blocked from native-note import because Better Notes 3.3.3 cannot preserve them losslessly.
- Better Notes Local Workspace integration requires Better Notes 3.3.3-compatible API and therefore its Zotero 8+ compatibility range.
- Filesystem automation runs only while Zotero is open and polls saved `content/` state every 30 seconds.
- GitHub API transport uses ordinary Git blobs and skips individual files over 95 MB; Git LFS repositories require System Git transport.
- The optional “open reading note whenever a PDF opens” and managed-note double-click override were not enabled; the explicit context menu/shortcut is implemented and avoids changing Zotero's default double-click behavior.
