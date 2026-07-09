# Naming Consolidation Plan: repo / workspace / project / cwd

日期：2026-07-10
范围：仅调研与迁移方案，不做代码改名。

## 一句话目标模型

用户可见统一使用 **Project** 表示用户加入侧栏的根目录；core/工具执行继续使用 **cwd** 表示当前执行目录；每个 session 的 main/worktree 切换指针继续叫 **Workspace**。renderer 现有 `Repo`/`repoId` 是历史命名和持久化兼容层，不应继续作为产品概念扩散。

## 概念现状表

| 术语 | 当前出现层 | 现在实际指代 | 冲突/重叠 | 证据 |
| --- | --- | --- | --- | --- |
| `project` | renderer 文案、settings、desktop main IPC/存储、core settings scope | 用户加入侧栏的根目录；settings 的项目级配置；磁盘 project registry | 与 renderer 内部 `Repo` 表示同一组目录；settings 里有时通过 `cwd` 参数落盘 | 侧栏文案用 Projects：`packages/desktop/src/renderer/Sidebar.tsx:242`; project picker 文案与行为：`packages/desktop/src/renderer/chat/ProjectPicker.tsx:17`; disk recents 是 project source of truth：`packages/desktop/src/main/index.ts:2605`; `RecentProject` 存 path/name/pinned/deletedAt：`packages/desktop/src/main/recents-store.ts:7`; settings UI 展示 `${activeRepoPath}/.code-shell/settings.json`：`packages/desktop/src/renderer/settings/SettingsView.tsx:102`; core project scope 读 `${cwd}/.code-shell`：`packages/core/src/settings/manager.ts:182`; desktop settings path 为 `<cwd>/.code-shell/settings.json`：`packages/desktop/src/main/settings-service.ts:4` |
| `repo` / `repos` / `repoId` | renderer state、localStorage、sidebar session bucket、automation import/rebuild | 现在大多不是 Git repository，而是 project 的 renderer 投影：有稳定 id、displayName、本地 cache | 用户看到 Project，代码叫 Repo；`Repo.path` 注释为 project path；`repoId` 同时也是 localStorage bucket key，不能直接改 | `Repo` 注释“Persisted repo list - sidebar 项目 section”：`packages/desktop/src/renderer/repos.ts:1`; `Repo.path` 是 “Absolute project path”：`packages/desktop/src/renderer/repos.ts:14`; localStorage key `codeshell.repos`/`codeshell.activeRepoId`：`packages/desktop/src/renderer/repos.ts:27`; disk project list 与 localStorage repo cache reconcile：`packages/desktop/src/renderer/repos.ts:183`; App 从 disk projects re-project 为 repos：`packages/desktop/src/renderer/App.tsx:634`; `repo.added`/`repo.removed` 日志仍用 repo：`packages/desktop/src/renderer/App.tsx:1051` |
| `repository` / Git repo | core git utils、desktop project boundary | Git top-level repository；若选中 git 子目录，归并到 git root | “repo” 在 Git 语义和 renderer project-cache 语义之间冲突；应只在 Git 场景显式写 `gitRepository` 或 `gitRoot` | `resolveProjectRoot` 注释说 enclosing git repository top-level otherwise cwd：`packages/core/src/git/utils.ts:46`; desktop pick dir 会 snap 到 repo root，避免每个 subdir 一个 project：`packages/desktop/src/main/index.ts:2731` |
| `cwd` | core EngineConfig/run/tool context/session state、desktop IPC、automation、settings/memory/capabilities 参数 | 当前执行目录或路径上下文；可能是 project root、session worktree root、no-project sandbox、外部路径 | 经常被拿来表示 project path；但 session workspace 切换后运行 cwd 可不同于原 project root；settings 的 project scope 也通过 cwd 落盘 | `EngineConfig.cwd?: string`：`packages/core/src/engine/types.ts:32`; `resolveRunCwd` 优先级 `options.cwd > state.cwd > config.cwd > process.cwd()`：`packages/core/src/engine/engine.ts:220`; run 解析 workspace 后得到 cwd：`packages/core/src/engine/engine.ts:977`; `ToolContext.cwd` 是 active working directory：`packages/core/src/tool-system/context.ts:189`; `SessionState.cwd` 持久化在 state.json：`packages/core/src/types.ts:225`; desktop preload 大量 IPC 以 cwd 为参数，如 git/workspace/settings：`packages/desktop/src/preload/index.ts:618`; settings IPC 仍是 `(scope, cwd?)`：`packages/desktop/src/preload/index.ts:738` |
| `workspace` / `SessionWorkspace` | core session state、desktop workspace IPC/topbar、tool context bridge | 单个 session 当前工作区指针：`main` 或 Git worktree；`root` 是本次运行应进入的目录 | 不等同于用户 tracked project；也不是 VS Code 那种全局 workspace。settings 注释偶尔把 project settings 叫 per-workspace，容易混淆 | `SessionWorkspace { root, kind: main/worktree }`：`packages/core/src/types.ts:205`; `SessionState.workspace` 是 state.json 的 current session workspace pointer：`packages/core/src/types.ts:227`; `SessionManager.create` 初始 workspace 为 `{ root: cwd, kind: "main" }`：`packages/core/src/session/session-manager.ts:168`; `setSessionWorkspace` 不改变 legacy `cwd`：`packages/core/src/session/session-manager.ts:276`; resume 从 workspace pointer 决定 cwd：`packages/core/src/session/session-manager.ts:325`; topbar `WorkspaceIndicator` 用 repoPath/sessionId 管理 worktree：`packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:124`; featureFlags 注释写 project settings can flip per-workspace：`packages/core/src/settings/schema.ts:367` |
| `worktree` | session workspace、desktop workspace UI、git worktree service | Git worktree，是 `SessionWorkspace.kind === "worktree"` 的一种工作区 | 与 workspace 边界清晰，但 `cwd` 会切到 worktree root，容易让 `state.cwd` 旧字段看起来像当前目录 | `SessionWorkspace.worktree` 字段：`packages/core/src/types.ts:208`; switch workspace 可创建 worktree 并保存到 state.workspace：`packages/desktop/src/main/session-workspace-service.ts:205`; cleanup main workspace 被禁止：`packages/desktop/src/main/session-workspace-service.ts:319` |
| `root` / `project root` / `mainRoot` | core git utils、desktop project add、session workspace service | project/main workspace 的规范根目录；Git 内部目录会归并到 git top-level，非 Git 目录保持原路径 | `root` 在不同上下文可能是 project root、workspace root 或 main worktree root，需加限定词 | `resolveProjectRoot(cwd)` 定义 PROJECT ROOT：`packages/core/src/git/utils.ts:46`; project add 用 `resolveProjectRoot(project.path)`：`packages/desktop/src/main/index.ts:2611`; `mainRootFor` 从 session cwd 或传入 cwd 找 main worktree root：`packages/desktop/src/main/session-workspace-service.ts:90`; `SessionWorkspace.root` 是当前 workspace root：`packages/core/src/types.ts:205` |
| `project scope` | core settings schema/manager、desktop settings-service、permission persistence | settings/capability/permission 层，物理位置在 `<projectPath>/.code-shell/*` | 字符串 `"project"` 是配置/权限语义，不能和 renderer `projectId` 或 session workspace 混为一谈 | `ApprovalScope "project"` 持久化到 `<cwd>/.code-shell/settings.local.json`：`packages/core/src/types.ts:362`; `capabilityOverrides` 是 project-scoped overlay：`packages/core/src/settings/schema.ts:361`; SettingsManager default scope `"project"` 只读 `${cwd}/.code-shell`：`packages/core/src/settings/manager.ts:182`; `saveProjectSetting` 写 `${cwd}/.code-shell/settings.json`：`packages/core/src/settings/manager.ts:423`; permission rule 写 `<cwd>/.code-shell/settings.local.json`：`packages/core/src/tool-system/permission.ts:557`; desktop `resolveSettingsPath("project", cwd)`：`packages/desktop/src/main/settings-service.ts:25` |
| `no project` / `no-repo` | renderer active selection、localStorage buckets、main sandbox cwd、automation | 用户未选择 project 的对话；renderer 是 `activeRepoId === null`/`NO_REPO_KEY`，main/core 用稳定 sandbox cwd `~/.code-shell/no-repo` 或空 cwd 表示 | 名字仍叫 no-repo，但产品文案应是 No project；不能把 sandbox cwd 自动创建为 project | `Repo` 注释 active repo null means no project and no cwd：`packages/desktop/src/renderer/repos.ts:7`; `NO_REPO_KEY = "__no_repo__"`：`packages/desktop/src/renderer/transcripts.ts:27`; no-repo sessions 在 sidebar bottom 对话 section：`packages/desktop/src/renderer/Sidebar.tsx:111`; main `resolveNoRepoCwd()` 创建 `~/.code-shell/no-repo`：`packages/desktop/src/main/agent-bridge.ts:64`; preload 明确 renderer 必须问 main 的 no-repo cwd：`packages/desktop/src/preload/index.ts:735`; `isNoRepoCwd` 把 sandbox/空 cwd 路由到 no-project bucket：`packages/desktop/src/renderer/automation/pathMatch.ts:32` |
| `bucket` / `repoKey` | renderer transcript、stream routing、override maps、panel state、browser anchors | renderer runtime/persistence 路由 key：`${repoId ?? NO_REPO_KEY}::${sessionId ?? "_none_"}`；旧 repoId 是 key segment | 这是持久化/运行态协议，不是用户概念。改名可以改函数名，不能改字节形状 | `bucketKey` 注释要求 byte-identical：`packages/desktop/src/renderer/transcripts.ts:98`; sessionIndex/transcript localStorage key 使用 repoKey：`packages/desktop/src/renderer/transcripts.ts:10`; override maps keyed by bucketKey：`packages/desktop/src/renderer/transcripts.ts:174`; panel state keyed by bucket：`packages/desktop/src/renderer/transcripts.ts:237`; browser anchors 用同一 bucketKey：`packages/desktop/src/renderer/chat/anchorBuckets.ts:1`; stream routing 使用 bucket：`packages/desktop/src/renderer/streamRouting.ts:5` |

## 目标概念模型

| 目标概念 | 推荐命名 | 边界 | 旧名映射 |
| --- | --- | --- | --- |
| 用户加入的根目录 | `Project` / `TrackedProject` | 用户可见、sidebar、settings picker、automation picker、mobile project list。`path` 是 canonical project root。 | renderer `Repo`、`repoList`、`activeRepoId` 迁到 `Project`/`projects`/`activeProjectId`；旧 localStorage key 先保留兼容。 |
| Project 的稳定 id | `projectId` | renderer/session bucket 的稳定 id，不保证等于路径；用于 local UI 持久化。 | 旧 `repoId`。迁移代码可在函数参数层改名，但 bucket 字符串保持旧值。 |
| Git 仓库 | `gitRepository` / `gitRoot` / `repository` | 只在 Git 操作、worktree、resolveProjectRoot 里使用。不要用 `repo` 泛指用户 project。 | 旧 `repo` 在 Git utils 之外逐步移除。 |
| 执行目录 | `cwd`，必要时局部变量用 `executionCwd` | core Engine/run/tool/IPC 运行目录。可为 project root、worktree root、no-project sandbox 或临时路径。 | 不建议把 core 的 `cwd` 全量改成 project/workspace；它语义更底层。 |
| session 工作区 | `SessionWorkspace` / `workspace` | 单个 session 当前指向的 main/worktree；`root` 是当前 workspace root。 | 保留。文案中可显示 “Workspace” 作为 worktree switcher，不用于 project 列表。 |
| project 设置层 | `project scope` / `projectPath` | settings/capability/permission/memory 的 `<projectPath>/.code-shell/*` 层。API 可继续 `"project"`。 | 参数名从 `cwd` 逐步收窄到 `projectPath`，但 wire shape 兼容。 |
| 无项目对话 | `No project` | 用户文案；内部 `NO_REPO_KEY`/sandbox cwd 是兼容实现细节。 | `no-repo` 只留在 legacy key/函数名或 sandbox helper。 |
| renderer 路由桶 | `conversationBucket` / `bucketKey` | runtime/localStorage 路由协议。保留字节格式。 | `repoKey` 可改为 `projectKey` 或隐藏在 adapter 内；不要改 key 内容。 |

## 迁移边界与风险

### 必须读写兼容或避免改动的持久化

1. renderer project cache：`codeshell.repos`、`codeshell.activeRepoId`、`codeshell.removedRepoPaths`。它们保存 stable id、path、displayName、removed denylist；直接改 key 会丢 active selection 和 project rename。证据：`packages/desktop/src/renderer/repos.ts:4`、`packages/desktop/src/renderer/repos.ts:27`。
2. renderer conversation buckets：`codeshell.sessionIndex.<repoKey>`、`codeshell.transcript.<repoKey>.<sessionId>`。key segment 是旧 repo id；直接改会让本地会话“消失”。证据：`packages/desktop/src/renderer/transcripts.ts:10`、`packages/desktop/src/renderer/transcripts.ts:361`、`packages/desktop/src/renderer/transcripts.ts:428`。
3. per-bucket overrides/panels/history：`codeshell.overrides.permission|model|goal`、`codeshell.panelState.<bucket>`、`codeshell.promptHistory.<repoId>`。这些都嵌入旧 bucket/repoId。证据：`packages/desktop/src/renderer/transcripts.ts:185`、`packages/desktop/src/renderer/transcripts.ts:253`、`packages/desktop/src/renderer/promptHistory.ts:1`。
4. disk project registry：`~/.code-shell/desktop/recents.json`。字段已经是 project shape，不需要为了本任务改；renderer 应继续把它当 source of truth。证据：`packages/desktop/src/main/recents-store.ts:17`、`packages/desktop/src/main/recents-store.ts:105`。
5. core session state：`state.json` 里的 `cwd` 和可选 `workspace`，以及 transcript `session_meta.cwd/workspace`。`cwd` 是 legacy fallback 和 main root 依据；`workspace` 缺失时要从 `state.cwd` 兼容。证据：`packages/core/src/types.ts:225`、`packages/core/src/session/session-manager.ts:252`、`packages/core/src/session/session-manager.ts:302`。
6. settings/permissions scope string：`"project"`、路径 `<cwd>/.code-shell/settings.json` 和 `<cwd>/.code-shell/settings.local.json`。这是配置语义和外部文件布局，不能机械替换成 workspace。证据：`packages/core/src/settings/manager.ts:182`、`packages/core/src/settings/manager.ts:423`、`packages/core/src/tool-system/permission.ts:557`。
7. no-project sandbox：`~/.code-shell/no-repo` 与 `NO_REPO_KEY`。若改名或 auto-create project，会造成无项目对话进入侧栏 project 列表。证据：`packages/desktop/src/main/agent-bridge.ts:64`、`packages/desktop/src/renderer/automation/pathMatch.ts:32`。

### 可安全批量改的范围

1. 用户可见文案和组件/prop 名：优先从 `repoName/repoPath` 改为 `projectName/projectPath`，只要不改 localStorage key 和 IPC wire payload。
2. renderer 纯类型和局部变量：可以引入 `TrackedProject` 并让 `Repo` 成为 deprecated alias，或先在 boundary adapter 中从 `Repo` 映射到 `Project`。
3. settings UI 内参数名：`activeRepoPath` 可改为 `activeProjectPath`；`getSettings("project", cwd)` 调用可把局部变量命名为 `projectPath`。
4. 注释与日志：`repo.added`/`repo.removed` 可以后续改为 `project.*`，但若日志被外部消费，先双写或接受断点。

### 需要兼容策略的改名

1. `repoId` -> `projectId`：不要一开始迁移 bucket 字符串。先改 TypeScript 参数名和 UI 状态名，保留 `bucketKey(projectId, sessionId)` 输出格式。若后续决定改 localStorage key，做 one-shot migration：读旧 key、写新 key、保留旧读 fallback 至少一个版本。
2. `Repo` object fields：`path/name/displayName/pinned` 可保持；`id` 可在类型层解释为 `projectId`。不要在 JSON 里从 `id` 改字段，除非有 parser 同时读 `id` 和 `projectId`。
3. `state.cwd`：保留字段名。若需要更清晰，可新增只读 helper `sessionMainRoot(state)` 或注释“legacy main project root”，不要直接把字段改成 `projectRoot`。
4. `SessionWorkspace.root`：保留字段名。若要更清楚，可在 API/文档称 `workspaceRoot`，但 JSON 兼容仍读 `root`。
5. IPC 参数名 `cwd`：Electron main/preload/renderer 可同步改类型名，但跨版本 preload/main 组合、mobile/room/cdp 相关接口要谨慎。优先只改 TypeScript 局部命名，不改 channel 名或 payload key。

## 分步落地建议

1. **冻结术语与 lint/search 清单**
   将本表作为后续改名准则：用户文案 Project，Git 场景 Git repository，core 执行 cwd，session worktree 指针 Workspace。新增 TODO 清单时把禁止扩散的词列出来：renderer 新 UI 不再新增 `repo` 命名。

2. **renderer 引入兼容类型层**
   新增 `TrackedProject` 类型或在 `repos.ts` 旁建立 adapter：`Repo` deprecated，`Project`/`projectId` 为新代码入口。`loadRepos/saveRepos` 暂不改 key，只在导出层说明这是 legacy storage。

3. **rename UI/state 局部变量，不动持久化 key**
   `repos` React state、`activeRepoId`、`repoName/repoPath` props 分批改成 `projects`、`activeProjectId`、`projectName/projectPath`。验证点：sidebar、composer ProjectPicker、SettingsView、AutomationView、TopBar/WorkspaceIndicator。

4. **收口 bucket 术语**
   保留 `bucketKey()` 输出和 `NO_REPO_KEY` 值，内部注释改成 “conversation bucket”。把 `repoKey` helper 隐藏或改名为 `projectBucketSegment`，同时加测试确保 key 字节不变。

5. **settings 边界改名**
   在 renderer/main settings-service 中把局部 `cwd` 改成 `projectPath`，但保留 IPC `(scope, cwd?)` 或提供 alias。core `SettingsManager` 仍接受 `cwd`，因为它是库层路径参数；文档注释明确 project scope 不等于 session workspace。

6. **core session 注释与 helper 收口**
   不改 `state.json` 字段。新增 helper/注释表达：`state.cwd` 是 legacy main/root fallback，`state.workspace.root` 是当前 resume execution cwd。优先补测试覆盖：legacy state without workspace、worktree resume、missing worktree fallback。

7. **可选 localStorage key 迁移**
   只有在产品明确要求 storage key 也收口时再做。计划为：启动时读 `codeshell.projects`，缺失则读 `codeshell.repos`；写新 key 后保留旧 key fallback；对 sessionIndex/transcript/overrides/panelState/promptHistory 做 repoId -> projectId 只改命名不改值，避免大规模 key rename。

8. **最后清理旧名**
   当所有调用点都经 adapter 后，逐步删除新代码中的 `Repo` import。保留极少数 legacy function/key 名，并用注释说明“legacy storage name, project semantics”。

## 后续验证建议

1. renderer 单测：`repos.test.ts`、`transcripts.test.ts`、`permissionOverrides.test.ts`、`automation/rebuildFromDisk.test.ts`、`automation/projectOptions.test.ts`。
2. core 单测：`session-manager.workspace-resume.test.ts`、`engine.workspace-cwd.test.ts`、`settings/manager.test.ts`。
3. 手工 smoke：添加 project、删除后恢复、无项目对话、已有 localStorage reload、worktree switch/resume、project settings 写入、automation disk rebuild。
