# Sync & Publish

Coordinate Zotero, Better Notes, Obsidian and Quartz in one local workspace. Local coordination is always active while Zotero is running; GitHub synchronization is a separate, configurable layer. Choose how the workspace reaches GitHub:

- **System Git** — uses a checked-out repository, the installed `git` executable and the user's existing Git credentials.
- **GitHub API** — synchronizes the complete configured workspace paths through GitHub's Git Database API; no `git.exe` or `.git` directory is required.

中文安装、配置、迁移和冲突说明见 [Local Workspace 中文使用手册](docs/LOCAL-WORKSPACE.zh-CN.md)。Implementation details are in [Local Workspace architecture](docs/LOCAL-WORKSPACE-ARCHITECTURE.md).

The interface follows Zotero's language. Simplified Chinese localizes the settings pane, menus, toolbar, progress feedback and change review; unsupported locales fall back to English.

## Workspace model

The default managed paths are `content,zotero`:

```text
research/
├── content/
│   ├── papers/             Better Notes reading notes
│   ├── assets/             note images
│   └── ...                 ordinary Obsidian/Quartz content
└── zotero/
    ├── <library>/          deterministic Zotero JSON and optional attachments
    └── .zotero-sync/       shared bindings and managed-file metadata
```

Zotero's live SQLite database remains in the Zotero profile and is never placed in the repository. Only bound reading notes enter the Better Notes conversion state machine; other Markdown and Quartz files are transferred as opaque workspace content.

## Safety properties

- Each computer keeps its own three-way synchronization base outside the repository.
- Remote-only changes are applied before Zotero/Better Notes export.
- Files changed on both sides are preserved on both sides and reported as pending.
- System Git never stashes, resets or force-pushes, and refuses to include pre-existing staged files.
- GitHub API updates the branch ref without force and stops if another computer moved the branch.
- Remote deletion removes a local workspace file only when the local hash still equals the last shared base.
- Managed paths are explicit; API transport does not touch repository files outside them.
- Deleting a bound Zotero child note or its Markdown deletes the other copy automatically. Deleting the parent paper removes its Zotero mirror but retains the research Markdown.

## Install

1. Download `sync-and-publish-<version>.xpi` from this fork's [Releases](https://github.com/willkyu/zotero-sync-and-publish-plugin/releases/latest), or build it locally.
2. In Zotero, open **Tools → Plugins → gear icon → Install Plugin From File…**.
3. Select the XPI and restart Zotero.

The fork retains the upstream extension ID, so installing it replaces the upstream plugin and prevents two writers from targeting the same branch.

## Configure

Open **Zotero Settings → Sync & Publish** and choose a workspace directory, managed paths, Zotero mirror folder, reading-note folder, asset folder and Obsidian Vault.

### New-computer quick setup

For GitHub API transport, the top **Set up a new computer** panel only needs:

1. An existing empty or previously downloaded local folder.
2. The GitHub repository URL.
3. A token with **Contents: Read and write** permission.

Click **Set up and open Obsidian**. The plugin detects the default branch, configures the standard `content,zotero` layout, downloads GitHub before allowing any local export, restores Zotero and Better Notes identities, and opens `<workspace>/content` as the Vault. Git, Node.js and a local Quartz checkout are not required for this flow.

### System Git transport

1. Clone the research repository normally.
2. Select its root as the workspace.
3. Choose **System Git**.
4. Set the executable (`git` normally), remote (`origin`) and branch (`main`).
5. Click **Validate workspace**.

If a GUI-launched Zotero does not inherit the terminal `PATH`, the plugin checks common Windows, Homebrew, MacPorts and Unix Git locations. An absolute executable path remains available as an override.

### GitHub API transport

1. Create or choose a local directory. It does not need to be a Git checkout.
2. Choose **GitHub API** and enter owner, repository and branch.
3. Save a fine-grained token with **Contents: Read and write** access to that repository.
4. Run **Test connection**, then **Validate workspace**.

API transport uses ordinary Git blobs and skips individual files over 95 MB. Choose System Git when the repository uses Git LFS.

## Local coordination and GitHub sync

While Zotero is running, local changes are coordinated automatically without **Sync now**, Git, a GitHub token, or network access:

1. Coordinate Zotero's live database with the `zotero/` mirror.
2. Coordinate bound native notes, Obsidian Markdown and note images through Better Notes.
3. Re-export deterministic Zotero JSON and update the local baseline.

The plugin reacts to Zotero notifications after a short debounce and polls saved managed-path changes every five seconds. Deletions use an automatic delete-wins policy and do not ask for confirmation.

The settings named startup, interval, after-change, after-Zotero-sync and pause apply only to GitHub. A GitHub run first performs the local coordination above, then reconciles and publishes managed paths through System Git or the GitHub API. **Sync now** starts this cloud transaction. Pausing GitHub automation never pauses local coordination.

## Build and test

```powershell
npm test
npm run build
```

The test suite includes pure three-way planning tests, a real temporary bare Git remote with three independent worktrees, and an in-memory GitHub remote that exercises initial two-way transfer, independent edits and same-file conflict preservation.

The XPI is written to `build/sync-and-publish-<version>.xpi`.

## License

MIT. Better Notes remains a separate dependency; this project calls its public runtime APIs and does not copy its converter source.
