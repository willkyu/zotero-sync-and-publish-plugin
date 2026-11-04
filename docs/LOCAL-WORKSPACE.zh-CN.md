# Local Workspace 中文使用手册

## 兼容性与安装

本扩展名为 **Zotero Quartz Workspace Sync 1.0.0**，沿用上游插件 ID，因此安装后会替换原版 Zotero GitHub Sync，避免两个插件同时写同一仓库。更新源已改为本 fork，上游自动更新不会覆盖本扩展。

- 原 GitHub API 模式：保持上游 Zotero 7–10 的兼容范围。
- Local Workspace + Better Notes：按 Better Notes 3.3.3 的实际 API 开发；该版本要求 Zotero 8.0-beta.21–10.99.99。
- 首版运行边界：Windows、macOS 桌面版；只有 Zotero 正在运行时才监听和自动同步。
- 安装：Zotero → 工具 → 插件 → 齿轮 → 从文件安装，选择 `build/zotero-github-sync-1.0.0.xpi`。

本次核查基线：

| 项目 | 提交/版本 | 许可证 |
|---|---|---|
| zotero-github-plugin | `5cf667da765845c9a9a9ba577e4d78a211c2f3e1` / 0.3.3 | MIT |
| zotero-better-notes | `4215a882e9f3528ddd4820c20b2c29e732c14e7e` / 3.3.3 | AGPL-3.0-or-later |

扩展只调用 Better Notes 的公开运行时 API，没有复制其转换器源码。

## Windows 首次配置

1. 先在命令行正常克隆 `willkyu/research`，确认 `git pull` 和 `git push` 使用现有凭据可以工作。
2. 在插件设置把模式改为 **Local Workspace**。
3. “Research repository root”选择仓库根目录，例如 `C:\Users\willkyu\Documents\.Papers\research`。
4. Git executable 通常填 `git`；插件会先搜索 Zotero 继承的 `PATH`，再自动探测 Windows、Homebrew、MacPorts 和常见 Unix 安装位置。若仍找不到，可填写 `git.exe` 的绝对路径。Remote 为 `origin`；Branch 为 `main`。
5. 阅读笔记填 `content/papers`，图片填 `content/assets`。
6. Obsidian Vault path 选择实际 Vault。当前常用结构应选择 `research/content`，Vault 名可以留空自动取目录名。
7. 可选择 `content/templates/` 下的 Markdown 作为新阅读笔记模板。
8. 点击“Validate workspace”和“Test open”，再手动执行一次“Sync now”。

仓库当前已有 `content/.obsidian`、`content/assets`、`content/papers`，与默认配置一致。检查时发现研究仓库已有未提交的论文笔记修改；开发和测试没有改写这些文件。

## macOS 首次配置

配置逻辑相同，但每台电脑分别选择本机的绝对路径，例如 `/Users/name/research` 和 `/Users/name/research/content`。共享到 Git 的只有相对路径与 Zotero key；绝对路径、基线、Git 凭据均留在本机 Zotero profile。

若自动探测仍找不到 Git，可把 Git executable 填成 `which git` 返回的绝对路径（Apple Silicon 常见 `/opt/homebrew/bin/git`）。Windows 可在 PowerShell 运行 `(Get-Command git).Source` 获取绝对路径。

## 从 GitHub API 模式迁移

1. 先在旧模式完成最后一次同步并确认仓库无待处理变化。
2. 本地克隆/更新 research 仓库，确认现有镜像位于 `zotero/`。
3. 切换为 Local Workspace。模式切换后，同一插件不再调用 GitHub REST 自动提交。
4. 第一次运行会先读取仓库 JSON：空库会按稳定 key 恢复；已有库会合并缺失项，不做本地删除。
5. 如果同一 key 在本机和仓库均不同，没有可信本机基线时会显示待处理，不会选时间较新的版本静默覆盖。
6. 确认运行正常后，不要同时安装另一个使用原插件 ID 的副本。

## 第二台电脑初始化

1. 克隆同一仓库并安装相同版本的 Better Notes 与本插件。
2. 配置该电脑自己的仓库和 Vault 绝对路径。
3. 保持 Zotero 库为空时执行同步：流程先导入 `zotero/` 中的父条目、子笔记、附件身份，再恢复 `.zotero-sync/bindings.json`，不会把空库解释为远端删除。
4. 阅读笔记绑定通过逻辑库、父条目 key、笔记 key 和相对路径恢复。原始 PDF 关闭时会显示为未恢复；图片仍独立恢复。

## 日常自动同步

默认在 Zotero 启动后检查；Zotero 数据变化或 `content/` 文件变化后等待约 2 分钟；每 60 分钟补充检查。所有入口调用同一协调流程。`content/` 监听是 Zotero 运行期间每 30 秒轻量扫描一次保存后的大小/mtime，再进入防抖队列。

流程顺序：安全检查 Git → fetch/可安全时快进 → 导入 JSON → 恢复绑定 → 协调 Better Notes 与图片 → 重新稳定导出 JSON → 只暂存管理路径 → commit → 普通 push。同步期间发生的新 Zotero/文件事件会排入下一轮。纳入本项目绑定的笔记由本插件统一调度，并从 Better Notes 自己基于本机数字 ID 的周期同步列表中移除，以避免两个后台任务同时改写同一文件；Markdown/HTML 转换仍完全调用 Better Notes。

可在 Zotero 文献、PDF 附件或原生笔记上右键选择 **Open Reading Note in Obsidian**，或按 `Ctrl+Alt+O`（macOS 为 `Cmd+Option+O`）：

- 已绑定时复用文件；
- 只有一个原生子笔记时导出并绑定；
- Markdown frontmatter 的 `$itemKey` 能唯一指向子笔记时恢复绑定；
- 两边都没有时创建子笔记、应用所选模板、导出、绑定后再打开；
- 多笔记/多文件歧义会停止，不按标题猜测；
- 正在 Zotero 编辑器中打开的笔记会延期，不强制关闭。

## 图片与 PDF

“Sync note images”和“Sync original PDFs”是独立开关。图片以附件 key 命名并记录内容 SHA-256；即使附件行已经恢复但 storage 文件缺失，也会从 `content/assets` 补齐。文件名不变而内容改变时会按基线判断方向；两边都改则待处理。

当前 research `.gitignore` 包含 `*.pdf`。若以后开启 PDF 同步，还需要显式调整该规则，否则 Git 会忽略新 PDF；默认关闭 PDF 不受影响。

删除笔记或文献不会自动删除 Markdown/共享图片。删除镜像文件也只会进入待确认；实现不会清空 `zotero/`，也不会删除不在插件管理清单中的文件。

## 冲突、离线和 Git 状态

- 同一绑定的 Zotero note 与 Markdown 都偏离共享哈希：保留双方，状态为 conflict。
- task checkbox 或 Obsidian embed 从 Markdown 导入会有损：保留 Markdown，状态为 unsupported-markdown。
- 已有 staged 文件、merge/rebase/cherry-pick、unmerged 文件：保留本地成果，暂停 Git 阶段。
- fetch 失败：继续保存本地内容，可以提交；push 失败保留本地 commit，稍后重试。
- 远端领先且工作树有修改，或双方分叉：不 stash、不 reset、不强推，等待人工处理。
- Git push 成功只表示源仓库收到提交，不代表 Quartz Actions 已部署成功。

解决冲突后再次“Sync now”。需要停止自动化时点击设置中的“Pause automation”；手动同步仍可运行。恢复后点击“Resume automation”。

## Markdown 兼容边界

Better Notes 3.3.3 已验证支持标题、段落、列表、表格、行内/块公式、普通链接、代码、图片、YAML。它会缓存并保留 YAML 自定义字段。`$libraryID`、`$itemKey`、`$version` 是转换/身份字段，不能删除；其中 `$itemKey` 是**笔记 key**，不是父文献 key。

根据 Better Notes 官方兼容说明：wiki link、callout 可通过其 `[ExportMDFileContent]` 模板保持；本插件不会无提示修改全局模板。任务复选框会丢状态，Obsidian embed 会转成普通图片，所以这两类外部更改不会自动导入 Zotero。概念笔记、首页、索引等普通 Markdown 从不进入 Zotero 富文本转换。

## 构建与测试

```powershell
npm test
npm run build
```

`npm test` 包含纯逻辑风险测试，以及一个真实 bare remote + 三工作区的系统 Git 测试；临时目录测试后删除，不触碰 research 仓库。
