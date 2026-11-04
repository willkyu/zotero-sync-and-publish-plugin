# Local Workspace 中文使用手册

## 兼容性与安装

本扩展名为 **Zotero Quartz Workspace Sync 1.2.0**，沿用上游插件 ID，因此安装后会替换原版 Zotero GitHub Sync，避免两个插件同时写同一仓库。更新源已改为本 fork，上游自动更新不会覆盖本扩展。

- 插件只保留统一 Workspace 功能；远端传输可选择 System Git 或 GitHub API，两者同步相同的管理路径。
- Workspace + Better Notes：按 Better Notes 3.3.3 的实际 API 开发；该版本要求 Zotero 8.0-beta.21–10.99.99。
- 首版运行边界：Windows、macOS 桌面版；只有 Zotero 正在运行时才监听和自动同步。
- 安装：Zotero → 工具 → 插件 → 齿轮 → 从文件安装，选择 `build/zotero-github-sync-1.2.0.xpi`。

本次核查基线：

| 项目 | 提交/版本 | 许可证 |
|---|---|---|
| zotero-github-plugin | `5cf667da765845c9a9a9ba577e4d78a211c2f3e1` / 0.3.3 | MIT |
| zotero-better-notes | `4215a882e9f3528ddd4820c20b2c29e732c14e7e` / 3.3.3 | AGPL-3.0-or-later |

扩展只调用 Better Notes 的公开运行时 API，没有复制其转换器源码。

## Windows 首次配置

1. “Research repository root”选择工作区根目录，例如 `C:\Users\willkyu\Documents\.Papers\research`。
2. 选择 **System Git** 时，先正常克隆仓库并确认 `git pull`/`git push` 可用。Git executable 通常填 `git`；插件还会自动探测常见安装目录。Remote 为 `origin`；Branch 为 `main`。
3. 选择 **GitHub API** 时，本地目录可以不含 `.git`。填写 Owner、Repository、Branch，保存具有 Contents: Read and write 权限的 Token，并执行 Test connection。API 同步整个 `Managed workspace paths`，不是旧版 Zotero-only 模式。
4. 默认管理路径为 `content,zotero`；Zotero mirror folder 为 `zotero`。
5. 阅读笔记填 `content/papers`，图片填 `content/assets`。
6. Obsidian Vault path 选择实际 Vault。当前常用结构应选择 `research/content`，Vault 名可以留空自动取目录名。
7. 可选择 `content/templates/` 下的 Markdown 作为新阅读笔记模板。
8. 点击“Validate workspace”和“Test open”。本地协调会自动开始；需要立即测试 GitHub 时再点击“Sync now”。

仓库当前已有 `content/.obsidian`、`content/assets`、`content/papers`，与默认配置一致。检查时发现研究仓库已有未提交的论文笔记修改；开发和测试没有改写这些文件。

## macOS 首次配置

配置逻辑相同，但每台电脑分别选择本机的绝对路径，例如 `/Users/name/research` 和 `/Users/name/research/content`。共享到 Git 的只有相对路径与 Zotero key；绝对路径、基线、Git 凭据均留在本机 Zotero profile。

若自动探测仍找不到 Git，可把 Git executable 填成 `which git` 返回的绝对路径（Apple Silicon 常见 `/opt/homebrew/bin/git`）。Windows 可在 PowerShell 运行 `(Get-Command git).Source` 获取绝对路径。

## 从旧版 Zotero-only 模式迁移

1. 先在旧模式完成最后一次同步并确认仓库无待处理变化。
2. System Git 传输需要克隆/更新 research 仓库；GitHub API 传输只需准备一个本地工作区目录。确认现有镜像位于 `zotero/`。
3. 选择所需 Workspace transport。GitHub API 现在同步 `content,zotero` 等全部管理路径，不再运行旧的单独 Zotero 导出事务。
4. 第一次运行会先读取仓库 JSON：空库会按稳定 key 恢复；已有库会合并缺失项，不做本地删除。
5. 如果同一 key 在本机和仓库均不同，没有可信本机基线时会显示待处理，不会选时间较新的版本静默覆盖。
6. 确认运行正常后，不要同时安装另一个使用原插件 ID 的副本。

## 第二台电脑初始化

1. System Git 传输先克隆同一仓库；GitHub API 传输建立空工作区目录。安装相同版本的 Better Notes 与本插件。
2. 配置该电脑自己的仓库和 Vault 绝对路径。
3. 保持 Zotero 库为空时执行同步：流程先导入 `zotero/` 中的父条目、子笔记、附件身份，再恢复 `.zotero-sync/bindings.json`，不会把空库解释为远端删除。
4. 阅读笔记绑定通过逻辑库、父条目 key、笔记 key 和相对路径恢复。原始 PDF 关闭时会显示为未恢复；图片仍独立恢复。

## 日常自动同步

同步分为两层：

- **本地协调**始终启用，不受 GitHub 设置和“Pause GitHub automation”影响。Zotero 数据变化约 2 秒后处理；工作区管理路径中保存后的文件变化每 5 秒检测一次。它负责 Zotero 数据库 ↔ `zotero/` 镜像，以及 Zotero 子笔记 ↔ Obsidian Markdown/图片，不需要点击“Sync now”。
- **GitHub 云端同步**才受“启动时、定时、变更后、Zotero Sync 后”和暂停开关控制。“Sync now”表示立即执行一次 GitHub 同步；它会先完成本地协调，再通过所选 System Git 或 GitHub API 传输管理路径。

云端流程顺序：远端三方协调 → 本地 JSON/绑定/Better Notes 协调 → 重新稳定导出 JSON → 提交管理路径。System Git 执行安全 fetch/快进、限定路径 commit 和普通 push；GitHub API 读取远端 tree、原子下载单边变化，再用非强制 branch ref 更新提交。同步期间发生的新事件会排入下一轮。纳入本项目绑定的笔记由本插件统一调度，并从 Better Notes 自己基于本机数字 ID 的周期同步列表中移除，以避免两个后台任务同时改写同一文件；Markdown/HTML 转换仍完全调用 Better Notes。

可在 Zotero 文献、PDF 附件或原生笔记上右键选择 **Open Reading Note in Obsidian**，或按 `Ctrl+Alt+O`（macOS 为 `Cmd+Option+O`）：

- 仅在 Zotero 右侧面板中显示该笔记不会阻止打开。插件会先保存尚未落盘的编辑，再交给 Obsidian。
- 无需、也不建议全局禁用 Zotero 的笔记编辑器。右侧笔记面板没有关闭按钮时，插件会先保存其中的输入，再协调 Markdown；Zotero 的条目通知会刷新仍显示的编辑器。只有双方确实都修改时才进入冲突状态。

- 已绑定时复用文件；
- 只有一个原生子笔记时导出并绑定；
- Markdown frontmatter 的 `$itemKey` 能唯一指向子笔记时恢复绑定；
- 两边都没有时创建子笔记、应用所选模板、导出、绑定后再打开；
- 多笔记/多文件歧义会停止，不按标题猜测；
- 手动打开和后台协调都会先保存当前 Zotero 编辑内容；编辑器仅仅可见不会阻止 Obsidian 修改导入。

新阅读笔记文件名使用 `父文献标题-noteKey.md`；Windows 不允许的路径字符替换为空格并合并连续空白，note key 用于避免同名冲突。绑定建立后不会因父文献改名而反复重命名。旧版本产生的 `-NOTEKEY.md` 或 `NOTEKEY.md` 占位文件会在下次手动打开时改成可读名称；若目标名称已经存在则停止并提示，不覆盖文件。

### 阅读笔记模板与创建入口

模板用于**新建**主阅读笔记，也会修复原生笔记和绑定 Markdown 正文均完全为空的旧失败记录。请选中文献或其 PDF，然后使用插件菜单 **Open Reading Note in Obsidian**；当该文献没有子笔记和既有绑定时，插件会创建 Zotero 子笔记、渲染模板、建立绑定并打开 Obsidian。已有非空笔记始终保留原文，不会被模板覆盖。

模板是普通 Markdown 文件，可使用以下变量：

| 变量 | 内容 |
|---|---|
| `{{title}}`、`{{shortTitle}}` | 标题、短标题；对应的 `titleYaml`、`shortTitleYaml` 是 YAML 安全字符串 |
| `{{authors}}`、`{{firstAuthor}}` | 作者列表（分号分隔）、第一作者 |
| `{{creators}}` | 所有 creator（分号分隔） |
| `{{authorsYaml}}`、`{{creatorsYaml}}` | 可直接放入 YAML 的 JSON 数组 |
| `{{date}}`、`{{year}}` | 文献日期、从文献日期提取的年份；另有 `dateYaml` |
| `{{today}}`、`{{now}}` | 创建当天 `YYYY-MM-DD`、ISO 时间；也支持 Obsidian 风格的 `{{date:YYYY-MM-DD}}`，可用 `YYYY YY MM DD HH mm ss` |
| `{{tags}}`、`{{collections}}` | 标签、分类列表的文本形式 |
| `{{tagsYaml}}`、`{{collectionsYaml}}` | 可直接放入 YAML 的 JSON 数组 |
| `{{itemType}}`、`{{itemKey}}`、`{{noteKey}}` | Zotero 类型、父文献 key、新子笔记 key |
| `{{citationKey}}`、`{{zoteroURI}}` | Better BibTeX citation key（若存在）、Zotero URI；另有 `citationKeyYaml` |
| 任意有效 Zotero 字段名 | 例如 `{{DOI}}`、`{{url}}`、`{{abstractNote}}`、`{{publicationTitle}}`、`{{volume}}`、`{{issue}}`、`{{pages}}` |

变量值按 Markdown 原文插入；在 YAML 中建议给普通文本加引号，数组使用 `*Yaml` 变量。未知变量会停止创建并明确报错，不会原样写入笔记。示例：

```markdown
---
title: {{titleYaml}}
authors: {{authorsYaml}}
year: "{{year}}"
tags: {{tagsYaml}}
zotero-key: "{{itemKey}}"
---

# {{title}}

## 文献摘要

{{abstractNote}}

## 阅读笔记
```

初次创建时，插件保留模板的 Markdown 正文原文。任务复选框可以保留在 Obsidian/Quartz 文件中，但 Zotero 富文本没有对应的 checkbox 元素；只要文件仍含任务框，插件会阻止 Zotero→Markdown 覆盖并报告 `unsupported-markdown`，以免复选框被静默降级。

在 Zotero 8+ 中，非空 YAML 字段 `citation-key` 是该绑定文献的显式固定 citation key。Markdown 同步时，插件会检查同一文库内的重复键，然后写入父文献的 Zotero 原生 `citationKey` 字段；当前 Better BibTeX 版本从该字段导出 cite key。空值不会清除现有键，包含空白、逗号或花括号的值会被拒绝。若需要清除或重新自动生成，请在 Zotero/Better BibTeX 中操作，而不要把 YAML 留空当作删除命令。`citekey` 等其他自定义字段仅作为 Quartz 元数据保留，不会更改 Zotero citation key。

## 图片与 PDF

“Sync note images”和“Sync original PDFs”是独立开关。图片以附件 key 命名并记录内容 SHA-256；即使附件行已经恢复但 storage 文件缺失，也会从 `content/assets` 补齐。文件名不变而内容改变时会按基线判断方向；两边都改则待处理。

当前 research `.gitignore` 包含 `*.pdf`。若以后开启 PDF 同步，还需要显式调整该规则，否则 Git 会忽略新 PDF；默认关闭 PDF 不受影响。

删除父文献不会顺带删除研究 Markdown。删除 `zotero/` 中某个受管父条目 JSON 会把对应 Zotero 条目移入回收站；删除其他派生镜像文件会在下次协调时重新生成，不会据此猜测或批量清空文库。已绑定阅读笔记采用下述单独规则。

删除一个已绑定的 Zotero 阅读笔记或其 Markdown 后，采用自动“删除优先”策略：删除会传播到另一端并移除绑定，无需确认；即使另一端在上次协调后又有修改，删除仍然获胜。Zotero 端进入回收站；已经进入 Git 历史的 Markdown 可从历史恢复。删除父文献时只移除 Zotero 镜像和绑定，研究 Markdown 保留为普通 Vault 文档。GitHub 暂停开关不会暂停这些本地删除规则。

## 冲突、离线和远端状态

- 同一绑定的 Zotero note 与 Markdown 都偏离共享哈希：保留双方，状态为 conflict。
- task checkbox 或 Obsidian embed 从 Markdown 导入会有损：保留 Markdown，状态为 unsupported-markdown。
- 已有 staged 文件、merge/rebase/cherry-pick、unmerged 文件：保留本地成果，暂停 Git 阶段。
- fetch 失败：继续保存本地内容，可以提交；push 失败保留本地 commit，稍后重试。
- 远端领先且工作树有修改，或双方分叉：不 stash、不 reset、不强推，等待人工处理。
- Git push 成功只表示源仓库收到提交，不代表 Quartz Actions 已部署成功。
- GitHub API 使用每台机器独立的工作区基线：远端单边修改会下载，远端单边删除只删除未在本机修改的文件；两端都改时保留双方并报告 pending。提交前分支若被其他电脑推进，本轮不会强推。
- GitHub API 暂时不可用时仍完成本地 Zotero/Better Notes 协调并保留文件，远端阶段标记为 pending；恢复网络后再次同步。
- GitHub API 的普通 blob 单文件上限设为 95 MB；使用 Git LFS 的仓库请选择 System Git。

本地冲突解决并保存后会自动再次协调；若要立即与 GitHub 交换结果，再点击“Sync now”。“Pause GitHub automation”只停止自动云端传输，手动 GitHub 同步和本地协调仍可运行。

## Markdown 兼容边界

Better Notes 3.3.3 已验证支持标题、段落、列表、表格、行内/块公式、普通链接、代码、图片、YAML。它会缓存并保留 YAML 自定义字段。`$libraryID`、`$itemKey`、`$version` 是转换/身份字段，不能删除；其中 `$itemKey` 是**笔记 key**，不是父文献 key。

根据 Better Notes 官方兼容说明：wiki link、callout 可通过其 `[ExportMDFileContent]` 模板保持；本插件不会无提示修改全局模板。任务复选框和 Obsidian embed 没有无损 Zotero 表示：Obsidian 修改仍会导入一个简化的 Zotero 副本，但 Markdown 原文保持权威且不会被回写覆盖；若随后从 Zotero 反向修改，状态会变为 `unsupported-markdown`，等待先处理这些外部语法。概念笔记、首页、索引等普通 Markdown 从不进入 Zotero 富文本转换。

## 构建与测试

```powershell
npm test
npm run build
```

`npm test` 包含纯逻辑风险测试、真实 bare remote + 三工作区的系统 Git 测试，以及内存 GitHub 远端的 Workspace API 双向/冲突集成测试；临时目录测试后删除，不触碰 research 仓库。
