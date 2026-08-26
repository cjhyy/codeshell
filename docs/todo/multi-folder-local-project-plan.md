# CodeShell 一个项目多文件夹技术方案

> 状态：Revised v6（2026-08-26 五轮独立评审后修订，待最终门禁）
>
> 日期：2026-08-26
>
> 范围：Desktop + Core/Protocol 的本地项目；TUI、`code-shell-serve`、Remote Project、外部 Agent Runtime、
> cc-room 保持单目录，本期非目标
>
> 评审基线：`main` 工作树（另有未提交的 0.8.19 改动，见 §9）。实施基线 `BASE_SHA` 在开工时按 §9.2 记录，不在此硬编码。

## 1. 结论

采用“一个项目包含多个 workspace root，并指定一个 primary root”的模型，不创建虚合并目录，
也不把多个目录的项目配置混合加载。

- `primary root`：新 Session 默认 `cwd`、Git、worktree、项目设置、指令、Skills、path approvals、
  Sources binding 和本地环境的唯一自动发现入口。
- `secondary roots`：进入文件搜索、文件面板、Read/Write/Edit/Glob/Grep 和 shell sandbox 的授权范围；
  相对路径仍相对 primary。
- 一个 Session 创建时固定自己的 main root（`mainRootId`）。项目以后切换 primary 只影响新 Session。
- 项目当前挂载的 roots 对项目内所有 Session 生效；移除目录后，下一 turn 立即失去访问权。
- Git/worktree 只操作 Session main root 所在仓库；Review 聚合项目内全部 Git 仓库并按仓库标注。
- Desktop Main 持有项目集合、root 授权、Session→项目绑定的权威数据。renderer/mobile 只能提交
  `projectId`，不能自行声明可访问目录。
- 进入 worker 的每一条 `agent/run` 都带 Main 调用方指定的可信 `origin` 元数据，并按 §6 裁决表处理；
  不经 worker 的自动化独立运行按 §6.3 在进程内解析。

## 2. 为什么不能只加一个 `paths: string[]`

单目录假设贯穿完整链路（均已对代码核验）：

1. `RecentProject.path` 同时是项目身份、显示、cwd 和授权根（`packages/desktop/src/main/recents-store.ts:9-17`）；
   存储与 picker 都把 Git 子目录折叠到仓库根（`recents-store.ts:207`、`packages/desktop/src/main/index.ts:5436`）。
2. renderer 用 localStorage 生成随机 project id，磁盘列表与缓存靠 path 对账
   （`packages/desktop/src/renderer/repos.ts:206-229`）。
3. Session→项目归属是**规范化后精确相等**，未命中则**自动新建项目**
   （`packages/desktop/src/renderer/automation/pathMatch.ts:66-76`，
   `rebuildFromDisk.ts:41-45`、`importRuns.ts:67-70`、`liveSession.ts:53-56`）。
4. `agent/run` 的 `cwd` 在 Main 不做任何校验，只用于查 trust
   （`packages/desktop/src/main/agent-run-metadata.ts:28,38`）；`prepareInbound(line)` 只有一行文本，
   无法知道帧来自谁（`packages/server/src/worker-bridge-core.ts:97,326-339,388-390`）。
5. `RunParams`、`EngineConfig`、`EngineRunOptions`、`ToolContext`、`ToolVisibilityContext` 都只有一个 `cwd`
   （`packages/core/src/protocol/types.ts:135`、`engine/types.ts:43`、`engine/run-types.ts:125`、
   `tool-system/context.ts:202,242`）。
6. `ClassifyOptions.workspaceRoot` 是单个字符串（`packages/core/src/tool-system/path-policy.ts:66-71`）；
   路径策略由 `ToolExecutor.enforceDeclaredPathPolicy` 按工具声明集中执行
   （`packages/core/src/tool-system/executor.ts:625-659`）。
7. sandbox 配置在每次 run 由 `RunEnvironmentResolver.resolveSandboxConfig(cwd)` 解析
   （`packages/core/src/engine/run-environment.ts:33-53`，调用点 `engine.ts:2108`），`${workspace}` 只展开为
   单个 cwd（`tool-system/sandbox/index.ts:100-106`）。
8. `SettingsManager(cwd, scope, projectTrusted, userDir)`、指令扫描、Skills 扫描、runtime header 都从单个
   cwd 发现（`settings/manager.ts:208-233`、`prompt/instruction-scanner.ts:59,84-86`、
   `skills/scanner.ts:403`、`prompt/composer.ts:261-276`）。
9. 文件搜索、文件面板、Git、Review、worktree、Automation、Sources 全部以 cwd/path 为键
   （`file-search-service.ts:202`、`index.ts:4499,6348-6361`、`desktop-services.ts:117-405`、
   `automation-host.ts:103`、`sources-service.ts:102-107`）。

## 3. 目标与非目标

### 3.1 目标

- 一个本地项目可以挂载 1..N 个互不重叠的目录，用户可添加、移除、设置 primary。
- 文件工具、文件面板、搜索和 shell sandbox 识别全部 roots。
- primary-only 的配置、path approvals、Sources、Git 语义明确、稳定、可测试。
- 旧项目、旧 Session、旧 RPC、no-repo、Mobile、Automation、Pet、Panel App、Quick Chat 无需一次性迁移即可运行。
- Main/worker/renderer/mobile 之间不能通过伪造路径、project id 或 origin 扩大文件访问范围。

### 3.2 非目标（本期）

- 不做 overlay、union filesystem 或 symlink farm。
- 不自动合并 secondary 内的 `.code-shell/settings*.json`、`CODESHELL.md`/`CLAUDE.md`/`AGENTS.md`、Skills、
  Hooks、MCP、path approvals、Sources binding。
- TUI / `code-shell-serve`（`packages/server/src/serve/cli.ts:68` 单 `--cwd`）不加项目管理。
- Remote Project 不支持多目录。
- **外部 Agent Runtime**（`packages/desktop/src/main/external-runtime-service.ts:13,77`：其 turn 不经
  `agent/run`）保持单 root，不注入 `workspaceContext`，不进入 §6 裁决表。
- **cc-room**（Claude Code rooms）不经 `agent/run`，不在范围内。
- 自动化的 `buildDesktopRunManager` 降级路径（`automation-host.ts:13-14,43-53`，无生产消费者）不改。
- 同一 canonical folder 不允许同时属于多个项目（跨项目祖先/子孙关系允许，见 §4.2）。
- 不把“无项目对话”改造成空 roots 项目；no-repo 语义保持不变。
- 不为 secondary 自动创建 worktree。
- 本方案不改版本号、不重生成 `tests/fixtures/composition-golden.json`（方案不新增 builtin tool，
  golden 不应变化；变化即回归）。

## 4. 领域模型

### 4.1 持久化项目模型（Main 磁盘存储）

```ts
export type ProjectId = string; // Main 用 randomUUID 生成
export type ProjectRootId = string; // Main 用 randomUUID 生成

export interface LocalProjectRoot {
  id: ProjectRootId;
  /** realpath 后的绝对路径拼写（显示、新 Session cwd）。比较一律用 canonicalKey(path)，见 §4.2。 */
  path: string;
  name: string;
  addedAt: number;
}

export interface LocalProject {
  id: ProjectId;
  name: string;
  displayName?: string;
  roots: LocalProjectRoot[];
  primaryRootId: ProjectRootId;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  deletedAt?: number;
  /** roots/primary 每次变更单调 +1。 */
  revision: number;
}

export interface LocalProjectRegistryV2 {
  version: 2;
  projects: LocalProject[];
}
```

文件：`~/.code-shell/desktop/projects.json`。写入复用 `recents-store.ts`/`trust-store.ts` 的安全约束：
普通文件禁跟随 symlink、4 MiB/条目数/字段长度上限、进程内 mutation queue、`acquireFileLock` 跨进程锁
（`trust-store.ts:149`）、`0600`、唯一临时文件 + atomic rename、坏条目隔离、顶层损坏时拒绝覆盖。

### 4.2 路径规范化口径（比较 vs 持久化）

| 用途 | 规则 |
| --- | --- |
| **canonicalKey(p)**（一切“同一目录/在目录内”比较） | `realpath`（不存在时取最近存在祖先再拼回，同 `path-policy.ts:398-421` `safeRealpath`）→ `path.resolve` → 去尾分隔符 → win32/darwin 大小写折叠 |
| `LocalProjectRoot.path` | 添加时 `realpath` 后的拼写；**先 `resolveProjectRoot` 折叠到 Git toplevel**（与今天一致），非 Git 目录原样；primary/secondary 同规则 |
| `SessionState.cwd`、`SessionWorkspace.root` | **保留已持久化拼写，不重写**（`session-workspace-service.ts:98-100` 的既有约束）。绑定靠 `mainRootId` |
| 重叠检测（项目内） | `canonicalKey` 相等、祖先或子孙 → 拒绝 |
| 重复检测（跨项目） | `canonicalKey` 相等 → 拒绝；祖先/子孙允许 |
| 引擎校验 cwd 与 primary 一致 | 取 `resolveRunWorkspace` 的**输出** cwd：若 Session 的 `SessionWorkspace.kind === "worktree"`，要求 `canonicalKey(cwd) === canonicalKey(workspace.root)` 且 `workspace.root` 属于 main root 仓库的 worktree（由 `SessionWorkspace.worktree` 元数据判定，不做路径猜测）；否则要求 `canonicalKey(cwd) === canonicalKey(primary.path)` |

`canonicalKey` 放 `packages/core/src/workspace/canonical-key.ts`，从 `.` 与 `/internal` 导出，
Desktop Main、Engine、PathPolicy 共用；禁止再写各自的 normalize。

### 4.3 运行时 WorkspaceContext

```ts
export interface ProjectRootContext {
  id: ProjectRootId;
  path: string; // 运行期拼写；primary 在 worktree 中时为 worktree path
  role: "primary" | "secondary";
}

export interface WorkspaceContext {
  version: 1;
  projectId: ProjectId;
  projectRevision: number;
  /** Session 固定的 main root，对应 LocalProject.roots 中的 id；不一定等于项目此刻的 primaryRootId。 */
  sessionMainRootId: ProjectRootId;
  roots: ProjectRootContext[];
  /** 排序后 roots canonicalKey 的 sha256。 */
  rootsDigest: string;
}
```

约束：恰好一个 `primary` 且 `id === sessionMainRootId`；roots 存在且两两不重叠；只由 Desktop Main 注入，
其他来源提交的一律删除。命名避开已有 `WorkspaceProfile`（数字人 persona，`packages/core/src/index.ts:147-159`）
与 `SessionWorkspace`。类型与校验放 `packages/core/src/workspace/workspace-context.ts`，从 `.`、`/extension`、
`/internal` 导出。

### 4.4 Session 持久化

`SessionState`（`packages/core/src/types.ts:275`）增加可选字段。已核验持久化为浅拷贝仅删三个 goal 别名、
加载为裸 cast（`packages/core/src/session/session-manager.ts:177-183,1201`），旧版本读写不会丢该字段：

```ts
interface SessionProjectBinding {
  projectId: ProjectId;
  /** 创建 Session 时的 primary。项目以后 Make primary 不改变它。 */
  mainRootId: ProjectRootId;
}

interface SessionState {
  project?: SessionProjectBinding; // 新增
  cwd: string; // 兼容：main root 的持久化拼写
  workspace?: SessionWorkspace; // 现有 main/worktree 执行指针
}
```

- 不把 roots 列表复制进 Session；每个 turn 由 Main 按 `projectId` 注入当前挂载集合。
- `project` 由 Engine 在收到带 `workspaceContext` 的 run 且当前无 binding 时写入（新 Session 与旧 Session 补写
  都走这一条）。
- 恢复时若 Host 注入的 `sessionMainRootId` 与已有 `project.mainRootId` 不一致 → 拒绝该 run。

### 4.5 Session→项目归属优先级（Main 权威，renderer 消费）

按顺序取第一个命中：

1. `state.project.projectId` 存在且项目 live → 该项目。
2. `canonicalKey(state.cwd)` **精确等于**某 live 项目任一 root 的 `canonicalKey` → 该项目（跨项目 key 唯一）。
3. `state.cwd` 是 no-repo 目录 → 无项目 bucket。
4. 都未命中 → 保持现有行为：不在 removed 拒绝列表则新建单 root 项目。新建由 **Main** 完成，且仅当
   `cwd` 出现在 §4.6 的 Session cwd 索引中（即确实是某已持久化 Session 的 `state.cwd`）。

### 4.6 Session cwd 索引（避免全量磁盘扫描）

现状：`hasPersistedSessionRoot` 每次调用都遍历最多 20 000 个 Session 目录（`renderer-project-path.ts:53-75`），
mobile `lookupDiskSessionCwd` 分页扫 10×100（`mobile-remote-orchestrator.ts:265-286`）。多 root 后归属查询会
更频繁，必须改为一次构建的索引：

- 新文件 `packages/desktop/src/main/session-cwd-index.ts`：`SessionCwdIndex`，进程内单例。首次访问时
  **只扫描一次** `sessionsRoot()` 下的 `state.json`，建 `Map<canonicalKey(cwd), Set<sessionId>>` 与
  `Map<sessionId, { cwd; workspaceRoot?; projectId?; mainRootId?; status: "confirmed" | "tentative" }>`；
  `workspaceRoot` 取 `state.workspace.root`（`SessionWorkspace`，worktree Session 时与 `cwd` 不同），
  供 §6.2 规则 7 匹配。**正常路径零 I/O**：命中索引即裁决，不读磁盘；只有失配时才做一次单点回读自愈（见规则 7）。
- **workspace 变更即时更新**（不等失配自愈）：`SessionCwdIndex.setWorkspaceRoot(sessionId, root)` 在以下落盘点
  成功后调用——`switchSessionWorkspaceForUi`（`session-workspace-service.ts:259-260` `setLiveWorkspace`/
  `sm.setSessionWorkspace` 之后）、`releaseSessionWorkspaceForUi`（`:288`）、`cleanupSessionWorktreeForUi` 回
  main（`:355-356`）；`agent-bridge.ts` 的 `setWorkspace`（`Methods.SetWorkspace` 成功响应，`agent-bridge.ts:1428-1442`）
  用响应中的 `result.workspace.root` 更新。
- **索引 miss 不等于“新 Session”**：`lookup(sessionId)` 未命中时做一次单点 `stat/readFile`
  `sessionsRoot()/<sessionId>/state.json`（不重扫目录）；存在则 lazy `upsert(confirmed)`。这覆盖 worker、
  自动化进程内 Engine、其他外部进程创建、以及**普通 renderer fork**（`agent/forkSession` 不带
  `quickChatClaimId`/非 `qchat-*` 目标时 `quickChatForkRequest` 返回 null，`agent-bridge-fallback.ts:68-84`，
  不经 Quick Chat router，Main 没有结算钩子）——这些 Session 在首次 run 时靠本条回读被识别为“已存在”。
- **tentative/confirmed 生命周期**：`agent/run` 裁决通过且 Session 不存在时写 `tentative` 条目（带 TTL）；
  `agent/run` 的 RPC 成功响应（`runAccepted`）**只延长 TTL，不 confirm**；仅 worker 流上的
  `session_started(sessionId)` 事件 → `confirm`；RPC result 已到达但直到 run 结束仍未见 `session_started` →
  `evict`；run 被拒绝、`sendFailed`/`workerExit`/超时、`forgetSession` → `evict`。tentative 条目不参与
  §4.5 规则 4 的新建判断，也不出现在 batch 结果中。
- Quick Chat：`agent/forkSession`（`Methods.ForkSession`，`protocol/types.ts:555`）成功响应经
  `quickChatForkRouter.routeWorkerResponse`（`agent-bridge.ts:384`）结算时，用 `ForkSessionResult.sessionId` 与
  源 Session 的 cwd/binding 及结果自带的 `workspace`（`types.ts:262-280`）`upsert(confirmed)`。
- 其余失效/更新点：`projectRegistry.migrateSessionMainRoot`、`closeSession`、Session 删除 IPC；不在 turn 结束时重扫。
- `ProjectStore.resolveProjectForCwd(cwd)` 与 `resolveProjectForCwdBatch(cwds[])` 只读索引；
  `renderer-project-path.ts` 的 `hasPersistedSessionRoot` 与 mobile `lookupDiskSessionCwd` 改为查索引。
- `rebuildFromDisk`/`importAutomationRuns` 用 batch 接口，并带 `source: "disk-rebuild" | "automation-import" | "live"`
  供日志/审计。
- 测试（`session-cwd-index.test.ts`）用注入的假 fs（5 000 个 Session）断言 `readdir` 只调用一轮、batch 二次解析
  零 I/O；命中路径零 `readFile`；miss 后单点回读只读一个文件并带回 `workspaceRoot`；switch/release/cleanup/
  `SetWorkspace` 四个更新点各自把 `workspaceRoot` 改到新值且不触发 I/O；失配自愈回读只读该 Session 一个文件；
  tentative：`runAccepted` 仅延长 TTL、
  `session_started` confirm、result-无-`session_started` evict、`sendFailed`/`workerExit`/forget evict；
  Quick Chat fork 结算 upsert；普通 renderer fork 与外部进程新建 Session 的单点回读。不用时间阈值。

## 5. 行为语义

### 5.1 创建与编辑项目

新增项目（`projectRegistry.createFromPicker`）：

1. Main 调用新的内部 `pickProjectDirectory()`（只弹 picker + `resolveProjectRoot` 折叠，**不再 `pushRecent`**）；
   现有 `dialog:pickDir`（`index.ts:5422-5442`）删除其 `pushRecent` 副作用并保留给非项目用途。
2. Main 按 §4.2 规范化并校验目录存在。
3. 与其他项目 `canonicalKey` 相同 → 返回已存在项目（UI 直接激活）。
4. 生成 project/root id，首个目录为 primary，`revision = 1`，写 V2 并按 §8.1 步骤 7 投影到 recents。
5. 读取 trust 状态并展示风险（`summarizeProjectTrustRisks`，`trust-store.ts:203`）；保存不等于信任。

添加目录（`projectRegistry.addRootFromPicker(projectId)`）：renderer 只传 `projectId`；Main picker →
规范化 → §4.2 重叠/重复检查 → 原子更新、`revision + 1` → 广播 V2 snapshot（窗口 + 手机）→ 失效文件索引、
Review 缓存、workspace context cache。若 picker 选中的是 Git 子目录，Main 返回 `{ project, folded: { picked, root } }`，
UI 提示“已按仓库根目录 <root> 挂载”；折叠后与已有 root 重复时按第 3 步处理。`project-store.test.ts` 覆盖两例：
子目录折叠成新 secondary、子目录折叠后等于已有 primary 被拒绝。

设为 primary（`projectRegistry.setPrimary`）：只改新 Session 默认 root，`revision + 1`；新 primary 为
`untrusted`/`unknown` 时必须重新走 TrustGate。

移除 secondary（`projectRegistry.removeRoot`）：`revision + 1`；下一 turn 不再包含该 root；文件面板/搜索缓存、
前缀落在该 root 下的**会话级** path grant、sandbox backend 缓存同步失效；正在执行的 turn 用启动时的不可变
context 跑完。

移除某 Session 的 main root：若该 root 仍是任何 live Session 的 `mainRootId`，Phase 0–2 **拒绝**并列出受影响
Session；Phase 3 引入 §5.6 迁移后放开。

### 5.2 Make primary 后旧 Session 的行为

- `mainRootId`、`cwd`、`SessionWorkspace` 不变；settings/指令/Skills/path approvals/Sources 仍从自己的 main root
  加载；trust 取自己 main root 的 trust。
- 仍归属该项目（§4.5 规则 1/2），sidebar 显示 main root 标签（与项目 primary 不同时高亮）。
- 新 Session 用新 primary。Git/worktree UI 对每个 Session 显示它自己的 main repo。

### 5.3 相对路径与命令

- `cwd` 永远等于 Session main root（或其 worktree）。
- 对 secondary 用绝对路径；Glob/Grep 的 `path` 参数已可接受绝对路径（`builtin/grep.ts:126-129`），不新增 `rootId`。
- runtime header（`prompt/composer.ts:261-276`）多 roots 时列出目录及角色，并注明“相对路径相对 primary”。
- `Bash` 从 primary 启动，可显式 `cd` 到 secondary。

### 5.4 primary-only：配置、指令、Skills、path approvals、Sources

仅从 Session main root 自动加载/写入：`.code-shell/settings.json`/`settings.local.json`（含 `pathApprovals`，
`path-policy.ts:244-250`）、`CODESHELL.md`/`CLAUDE.md`/`AGENTS.md` 与 rules、`.code-shell/skills`/`.agents/skills`、
hooks/MCP/credentials/localEnvironment/profile、Workspace Sources binding（存于项目自身 settings，
`sources-service.ts:102-107`，**无数据迁移**；IPC 从 `cwd` 改为 `projectId`）。

若基线含未提交的 `SettingsManager.mutateSettingsForScope(scope, cwd, …)` 与 `ConfigureModelConnection`
（用 `ctx.cwd` 做 project-scope 写入），多 root 后 `ctx.cwd` 仍为 primary，天然满足；Phase 2 加断言测试（§9）。

secondary 中这些文件可被文件工具读取或编辑，但不自动执行、连接或注入 prompt。

path approvals：会话级 grant 结构不变（`Map<sessionId, Set<{prefix, op}>>`，`path-policy.ts:179-186`），
root 被移除时清掉前缀落在该 root 下的会话级 grant；项目级 grant 继续写 main root 的 `settings.local.json`；
secondary 内路径因 `insideWorkspace` 直接 allow，不产生 grant。

### 5.5 Git、Review 与 worktree

- Top bar branch/commit/switch/PR/worktree：只针对 Session main repo（`desktop-services.ts` 各函数首参 cwd 不变）。
- Review：遍历 `workspaceContext.roots`，每个 root 解析 Git toplevel，按 `canonicalKey(repoRoot)` 去重后聚合；
  结果携带 `rootId` 与 `repoRoot`，同名相对路径不合并（现有结果以仓库相对路径为键，`desktop-services.ts:114,178`）。
- primary 创建 worktree 后，运行时 roots 把 primary path 替换为 `SessionWorkspace.root`（`id` 不变）；secondary 原样。

### 5.6 `workspace_missing` 的范围

- **不持久化**新状态。Main 派生 `SessionRootStatus = "ok" | "root_removed" | "dir_missing"`。
- Phase 0–2：非 `ok` 的 Session，run 被 §6 拒绝（`-32602`，消息含状态），UI 只展示徽标与归档入口；不 mkdir。
- Phase 3：`projectRegistry.migrateSessionMainRoot(sessionId, rootId)`：写新的 `project.mainRootId`、`cwd`、
  `workspace`，记录 `session_meta` handoff（复用 `sm.recordWorkspaceHandoff`，`session-workspace-service.ts:261`），
  更新 §4.6 索引。仅此时放开 §5.1 的“移除 main root”限制。

## 6. 运行授权

### 6.1 可信 origin 元数据透传（不读帧内容）

现状 `prepareInbound(line)` 只能看到文本，且同一个辅助函数被不同来源复用（`injectAndAwaitResult` 同时服务
mobile `chat.send` 与自动化“继续对话”，`handle-client-event.ts:109`、`index.ts:3093`；
`injectMobileRunAndAwaitAcceptance` 被 Pet 委派复用，`pet/pet-work-delegation-host.ts:3,86`），因此 origin
必须由 Main 的调用方在类型上显式给出：

```ts
// packages/server/src/worker-bridge-core.ts
export interface WorkerFrameMeta {
  origin: "renderer" | "mobile" | "host" | "serve";
  /** 审计/日志用生产者标签，不参与授权。 */
  producer: string;
}
prepareInbound?: (line: string, meta: WorkerFrameMeta) => { line: string; method?: string };
injectWorkerMessage(rawLine: string, meta: WorkerFrameMeta): void;
request(method, params, options: WorkerRequestOptions & { meta: WorkerFrameMeta }): Promise<WorkerRpcOutcome>;

// packages/desktop/src/main/agent-bridge.ts
injectWorkerMessage(line: string, meta: WorkerFrameMeta): void;
requestWorker(method, params, timeoutMs?, options?: { settleOnExit?; failFast?; meta: WorkerFrameMeta });
```

`origin` 枚举增加 `"serve"`：`packages/server/src/serve/headless-server.ts:307` 的 WebSocket 转发是
`WorkerBridgeCore.injectWorkerMessage` 的另一个消费者，固定传 `{ origin: "serve", producer: "serve-ws" }`。
serve 自建的 `WorkerBridgeCore`（`headless-server.ts:159`）**不挂 `prepareInbound`**，因此 §6.2 裁决表不对
serve 生效；这里只补审计 meta，不加项目管理（§3.2）。

`meta` 为必填（TS 强制所有调用方补齐）。仓库中 `injectWorkerMessage`/`requestWorker`/`core.request` 约 25 个
调用点（含 `agent/query`、`agent/cancel`、`SetWorkspace`、pet long-task 等非 run 方法），Phase 0 用
`bun run typecheck:workspaces` + `cd packages/desktop && bun run typecheck` 机械收口；非 `agent/run` 方法的
meta 仅用于日志，不参与授权。renderer IPC 处理器（`agent-bridge.ts:488`）固定传
`{ origin: "renderer", producer: "agent:msg" }`。同时给以下辅助入口增加 `meta` 参数：
`packages/server/src/mobile-remote/mobile-run-dispatch.ts` 的 `MobileRunBridge` 接口与
`injectMobileRunAndAwaitAcceptance`、`packages/server/src/mobile-remote/mobile-chat-turn.ts` 的
`dispatchMobileChatTurn`、`packages/desktop/src/main/mobile-remote/handle-client-event.ts:109` 的
`injectAndAwaitResult`。

生产者清单（按代码确认）：

| origin | 生产者 | 入口 | cwd 来源 |
| --- | --- | --- | --- |
| renderer | 聊天、Quick Chat fork（`quickChatForkRouter.start`，`agent-bridge.ts:518-525`） | `ipcMain.on("agent:msg")` | renderer 传 `projectId`/no-repo cwd |
| mobile | `chat.send`、`approval.respond`、`run.stop` | `handle-client-event.ts:148,316,332` | 设备 `selectedCwd`（§6.4） |
| host | Pet dispatch / IM 网关（IM 入站经 `dispatcher.dispatch`，`index.ts:2858`） | `pet-dispatch-service.ts:787,1080,1454` `requestWorker` | `hostCwd = resolveNoRepoCwd()`（`index.ts:1765`） |
| host | Pet 工作委派 | `pet-work-delegation-host.ts:85-86` | `delegation.workspacePath ?? noWorkspaceCwd`，先 `reserveHostSession` |
| host | Panel App agent task / submitPrompt | `panel-app-bridge.ts:379-409,1691-1701` | `owner.cwd` / binding cwd，先 `reserveHostSession` |
| host | 自动化“继续对话”resume turn | `index.ts:3093` | 无 cwd，仅 `sessionId` |
| serve | `code-shell-serve` 浏览器客户端 | `headless-server.ts:307` | 单 `--cwd`，不经裁决表 |
| （不经 worker） | 自动化独立运行 | `automation-host.ts:140` 进程内 `new Engine` | §6.3 |
| （非目标） | 外部 Agent Runtime、cc-room | — | 保持现状 |

`AgentBridge` 的两张表职责分离：

- `sessionCwd: Map<sessionId, cwd>`（现有）：凭据/浏览器分区/`hasKnownSession` 用的最近 cwd。
  renderer/mobile/host 的 run 通过后都写；**`reserveHostSession(sessionId, cwd)` 继续写它**，保持
  `hasKnownSession` 与 `cwdForSessionOrThrow`（`agent-bridge.ts:476-482`）语义不变。
- `hostReservations: Map<sessionId, { cwd; producer; reservedAt }>`（新增）：**只用于 §6.2 规则 10 授权**。
  只有 `reserveHostSession` 写入；普通 renderer/mobile run 通过后**绝不**写入。
- `forgetSession` 同时清两张表。`agent-bridge.nochild.test.ts` 断言：renderer run 后 `hostReservations` 为空；
  `reserveHostSession` 后两表都有；`forgetSession` 后两表都空。

### 6.2 `agent/run` 裁决表（Main，`prepareAgentRunMetadata(line, meta, deps)`）

第一步对所有 origin：删除来者提交的 `workspaceContext` 与 `projectTrusted`；`bucket`/`browserPartition`
按现状剥离并由 Main 用于 `registerSessionBucket`（`agent-bridge.ts:449-451`），它们是路由提示而非授权字段。

“Session 已存在”统一指 §4.6 索引命中（含 miss 后的单点回读），下文简称“已存在”。

| # | 条件 | 裁决 | 注入 |
| --- | --- | --- | --- |
| 1 | `projectId` 存在，项目 live；Session 不存在 | 通过；索引写 `tentative` | context（main root = primary）、`cwd` = primary.path、`projectTrusted` = primary trust |
| 2 | `projectId` 存在；已存在且有 binding，`mainRootId ∈ roots`、目录存在 | 通过 | context（main root = binding）、`cwd` = 持久化拼写 |
| 3 | `projectId` 存在；已存在但**无 binding**，`canonicalKey(state.cwd)` 精确等于该项目任一 root | 通过 | context（main root = 命中 root）；Engine 补写 binding（§4.4） |
| 4 | `projectId` 存在，但项目不存在/已删除/`mainRootId` 不在 roots/目录缺失/规则 3 未命中 | 拒绝 `-32602` | — |
| 5 | `projectId` 缺失，`canonicalKey(cwd)` = no-repo 目录 | 通过（legacy 单 root） | `projectTrusted=false`，无 context |
| 6 | `projectId` 缺失，`cwd` 缺失，已存在 | 通过（legacy 单 root，引擎用持久化 cwd） | `projectTrusted` = 持久化 cwd 的 trust |
| 7 | `projectId` 缺失，`origin ∈ {renderer, mobile}`，已存在且 `canonicalKey(cwd) ∈ { canonicalKey(cwd₀), canonicalKey(workspaceRoot₀) }`（索引缓存值）；双值均未命中时，对该 Session 的 `state.json` 做**一次**单点回读刷新 `cwd/workspaceRoot` 后重比 | 命中（含回读后命中）→ 通过（legacy 单 root，引擎仍按 `SessionWorkspace` 决定实际 cwd）；回读后仍不匹配 → 拒绝 `-32602` | 同 6 |
| 7h | `projectId` 缺失，`origin === "host"`，已存在 | 通过；**忽略来者 `cwd`**，按持久化 cwd/binding 解析（有 binding → 同 2，无 → 同 6） | 同 2 或 6 |
| 8 | `projectId` 缺失，Session 不存在，`canonicalKey(cwd)` 精确等于某项目的 primary | 通过，视作规则 1 | 同 1 |
| 9 | `projectId` 缺失，Session 不存在，`canonicalKey(cwd)` 精确等于某项目的 secondary | 通过（legacy 单 root，只含该目录） | 该目录 trust；无 context |
| 10 | `origin === "host"`，Session 不存在，`hostReservations` 中有 `sessionId` 且 `canonicalKey(cwd)` 相等 | 通过（legacy 单 root）；索引写 `tentative` | 该目录 trust |
| 11 | 其余 | 拒绝 `-32602` | — |

说明：

- 规则 8 对 host 帧同样成立并且是**预期行为**：Pet 委派/Panel App 把 `cwd` 指到某项目 primary 时获得完整项目
  context（与同目录下的 renderer Session 授权一致）；`agent-run-metadata.test.ts` 有正向用例。若要让 host
  保持单 root，应改 `workspacePath`，不改此规则。
- 规则 7 同时接受 main root 与 worktree root：worktree Session 的 `state.cwd` 是 main root，而 mobile 续聊时
  `resolveWorkspace` 返回的是 `workspace.root`（`handle-client-event.ts:265-268`），只比较 `state.cwd` 会把
  worktree Session 的续聊误拒。索引条目的 `workspaceRoot` 即为此服务。
- 规则 7 的失配自愈：索引值可能因外部进程（自动化进程内 Engine、`code-shell-serve`、TUI）切换 worktree 而过期，
  因此双值未命中时先回读该 Session 的 `state.json`（单文件，不重扫目录）再重比；这与 §4.6 的“正常命中零 I/O”
  不冲突——回读只发生在即将拒绝的路径上。
- 规则 7h 覆盖 Pet 复用已存在 Work Session 且 `delegation.workspacePath` 与该 Session 持久化 cwd 不同的情形
  （`pet-work-delegation-host.ts:79-85` 已刻意不覆盖 cwd）：以 Session 为准，不信来者 cwd。其 `targetSessionId`
  只能来自 Main 侧解析的 `reusableSession`（`pet-dispatch-service.ts:1516-1550`：模型返回的
  `reusableSessionId` 必须命中 host 提供的可复用集且 workspace 一致，否则整批拒绝，`:1576` 才写入
  `targetSessionId`）；模型或外部 payload 不能直传 `targetSessionId`。`pet-dispatch-service.test.ts` 断言
  “模型返回集外 sessionId → 拒绝、不产生委派”。renderer/mobile 仍走规则 7，要求 cwd 命中。
- 各生产者落位：renderer → 1/2/3/5；Quick Chat fork 后的运行 → 2/3/6（fork 结算已 upsert 新 id）；
  mobile → 5/7/8/9（§6.4）；Pet dispatch/IM → 5；Pet 委派、Panel App → 7h/8/10；自动化 resume turn → 6。
  规则 7h/10 只对 `origin: "host"` 生效，renderer/mobile 帧即使伪造 `sessionId` 也走不到。

### 6.3 自动化独立运行（进程内 Engine，不经 worker）

`buildDesktopAutomationRunner`（`automation-host.ts:97-170`）当前 `resolveProjectRoot(req.job.cwd ?? process.cwd())`
且**未传 `projectTrusted`**（Engine 默认 trusted）。既有 job 的 `cwd` 可能是 Git 子目录、已移除项目或只存在于
旧 Session 的目录，改为：

1. `job.cwd` 缺失 → `jobCwd = resolveNoRepoCwd()`，legacy 单 root，`projectTrusted: false`。
2. `job.cwd` 存在 → 先 `jobCwd = resolveProjectRoot(job.cwd)` 折叠（与今天一致），再
   `ProjectStore.resolveProjectForCwd(canonicalKey(jobCwd))`：命中某项目 root → 构造 `workspaceContext`
   （main root = 命中 root），`projectTrusted = trust(main root)`；等于 no-repo → 同 1。
3. 未命中项目，但 `canonicalKey(jobCwd)` 出现在 §4.6 索引中（某持久化 Session 的 cwd）→ legacy 单 root，
   `projectTrusted = trust(jobCwd)`。
4. 其余（目录不存在、项目已移除且无 Session 引用等**永久**无法解析）→ 不启动 Engine，返回
   `CronRunResult { text: "", reason: "workspace-unresolved", stop: { reason: "workspace-unresolved" } }`
   （`packages/core/src/automation/runner.ts:63-73` 已支持 `stop` 让 scheduler 自动停用），避免每 tick 重跑。
5. 显式 `sandbox: defaultSandboxConfig(req.sandboxMode)` 保留；roots 由 §7.6 在 Engine 内追加。
6. 删除 `automation-host.ts:44,53,103` 三处 `process.cwd()`（`buildDesktopRunManager` 除外，见 §3.2）。

`automation-host.workspace.test.ts` 覆盖：Git 子目录折叠后命中项目；持久化 Session cwd 走 legacy；项目移除后
返回 `stop`；`stop` 后 scheduler 不再重跑（复用 `automation-host.resume.test.ts` 的 stub 方式）。
Phase 4 为 job 增加 `projectId/rootId` 后，第 2 步优先用它们。

### 6.4 Mobile `session.create` 当场校验

- `session.create` 带 `cwd`：`ProjectStore.resolveProjectForCwd` 命中 root 或等于 no-repo → 接受；否则回复
  `{ type: "error" }` 且不改 `selectedCwd`。不带 `cwd` → `selectedCwd = null`（no-repo）。
- `chat.send` 续聊已存在 Session：`dispatchMobileChatTurn` 经 `resolveWorkspace` 拿到的是 `SessionWorkspace.root`
  （`handle-client-event.ts:265-268`，`getSessionWorkspaceForUi` 定义于 `session-workspace-service.ts:165`），
  worktree Session 时不等于 `state.cwd`；由 §6.2 规则 7 的双值匹配放行——正常路径只查索引不读磁盘，索引过期时
  由规则 7 的单点回读自愈。`handle-client-event.test.ts` 加用例：worktree Session 经 mobile 续聊通过；
  索引缓存旧 root、磁盘已是新 worktree root → 回读后通过；磁盘也不匹配 → 拒绝。
- 删除 `handle-client-event.ts:230` 的 `runContext.cwd ?? process.cwd()`；`effectiveMobileRunCwd`
  （`mobile-remote-orchestrator.ts:288-291`）改为 `st.selectedCwd ?? resolveNoRepoCwd()`，去掉 `ctxCwd` 参数。
- `agent-bridge.ts:828-830` workspace 动作的 `this.sessionCwd.get(...) ?? this.lastRunContext.cwd ?? process.cwd()`
  改为复用现有 `cwdForSessionOrThrow(sessionId)`（`agent-bridge.ts:476-482`，内含持久化 main root 回读）；
  查不到即报错，不再回退到 `process.cwd()`。
- Phase 4 增加 `session.create.projectId`。

## 7. 分层改造

### 7.1 Desktop Main：项目与授权事实源

新增 `packages/desktop/src/main/project-store.ts`（V2 store + legacy 迁移 + `resolveProjectForCwd[Batch]`），
`packages/desktop/src/main/session-cwd-index.ts`（§4.6）。`recents-store.ts` 降为只读 legacy 输入与降级投影。

IPC 用新命名空间，避免与现有 `projects:*`（legacy 形状，`index.ts:5215-5233`）重名：

```ts
window.codeshell.projectRegistry = {
  list(): LocalProject[];
  createFromPicker(): LocalProject | null;
  addRootFromPicker(projectId): LocalProject | null;
  removeRoot(projectId, rootId): LocalProject;
  setPrimary(projectId, rootId): LocalProject;
  rename(projectId, name): LocalProject;
  setPinned(projectId, pinned): LocalProject;
  remove(projectId): void;
  resolveForCwd(cwd, source): { projectId; rootId; created } | { noRepo: true } | null;
  resolveForCwdBatch(cwds[], source): Array<…>;
  migrateLegacyPath(path): LocalProject | null; // 仅 V2 首启一次性，§8.1
  onChanged(cb): () => void; // 频道 "projectRegistry:changed"
};
```

`renderer-project-path.ts` 新增（保留旧函数给 legacy IPC）：`requireRendererProject(projectId)`、
`requireRendererProjectRoot(projectId, rootId)`、`requireRendererProjectRootEntry(projectId, path) → { entry, rootId }`
（与现有 `requireRendererProjectEntryPath(input, projectPath)` 区分）。旧 `requireRendererProjectPath` 的持久化
Session 回退改查 §4.6 索引，仅供 legacy IPC 与 `migrateLegacyPath`；Phase 4 删除。

`agent-bridge.ts`：`hostReservations`（§6.1）、`sessionProject: Map<sessionId, { projectId; mainRootId }>`；
`prepareInboundLine(line, meta)`；三处入口补 `meta`。

Trust 继续按 canonical folder 保存（`trust-store.ts`）。只有 Session main root 的 trust 传给
`SettingsManager(projectTrusted)`。

### 7.2 Renderer

```ts
interface TrackedProject {
  id: ProjectId; // Main 的 UUID
  name: string;
  displayName?: string;
  roots: LocalProjectRoot[];
  primaryRootId: ProjectRootId;
  pinned?: boolean;
  addedAt: number;
}
projectPrimary(project): LocalProjectRoot
projectPath(project): string // primary.path，迁移期用
```

- Sidebar“编辑项目”：folders 列表、Add folder、Make primary、Remove folder、Finder/Open、primary 徽标、
  缺失目录状态、Session main root 标签。
- bucket 仍按 `bucketKey(projectId, sessionId)`（`transcripts.ts:199`，输出格式不变）。
- 删除 `makeRepoId`/`makeCreateRepoForCwd` 的使用；`pathMatch.ts`/`rebuildFromDisk.ts`/`importRuns.ts`/`liveSession.ts`
  改为消费 `projectRegistry.resolveForCwdBatch`；removed 拒绝列表（`codeshell.removedRepoPaths`）由 renderer 在
  调用前过滤，语义不变。
- 聊天 `agent/run` 传 `projectId`（旧 Session 也传其 bucket 的 `projectId`，由 §6.2 规则 3 补写 binding）。
- 修改后在 `packages/desktop` 运行 `bun run typecheck`。

### 7.3 Protocol 与 Desktop Agent Bridge

additive migration，无握手：Desktop 的 renderer、Main、worker 随同一 Electron 包发布；需要兼容的是手机端
（§7.8）与 `code-shell-serve`（不读 `projectId`）。

```ts
interface RunParams {
  projectId?: string; // renderer/mobile 可传
  workspaceContext?: WorkspaceContext; // 仅 Main→worker；来者提交的一律删除
  cwd?: string; // 兼容；Main 注入时保证与 context primary 一致
}
```

### 7.4 Core Engine

- `EngineConfig`/`EngineRunOptions` 增加可选 `workspaceContext`；未提供 → legacy 单 root，不写 binding。
- `resolveRunWorkspace`（`engine/run-workspace.ts:44`）在得出 cwd 后按 §4.2 校验，返回 `{ cwd, workspaceContext }`；
  不一致 → `EngineResult` 错误。
- 无 binding 且收到真实 context → 写 `state.project`；有 binding → 校验 `sessionMainRootId`。
- sub-agent 继承父 run 的不可变 context（child 无 cwd 参数，`engine/subagent-spawner.ts:322`；
  `SubAgentSpawnRequest` 无 cwd，`tool-system/context.ts:95-159`）。
- 跨 Session 消息授权（`engine.ts:1854`）：有 binding 比较 `projectId`；否则比较 `canonicalKey(workspaceRoot)`。
- `ToolContext`、`ToolVisibilityContext`、dynamic context provider（`composer.ts:163`）、extension seam
  增加 `workspace: WorkspaceContext`，保留 `cwd`。

### 7.5 PathPolicy、ToolExecutor、附件

- `ClassifyOptions` 增加 `workspaceRoots?: readonly string[]`（`workspaceRoot` 仍为 primary）；`insideWorkspace` =
  任一 root 内；结果增加 `matchedRoot?`。`isInsideDir`（`path-policy.ts:503-508`）保持不变。
- 敏感路径规则对所有 roots 一致。
- `ToolExecutor.enforceDeclaredPathPolicy` 与 `enforcePathPolicyWithApproval(…, ctx)`（`path-policy.ts:847-860`）
  从 `ctx.workspace.roots` 取 roots；`packages/coding/src/index.capability.ts:150-161` 的 ApplyPatch `pathResolver`、
  NotebookEdit、LSP 经同一执行器生效，补跨 root 测试。
- `FinalWritePathSnapshot`（`path-policy.ts:73-77`）增加 `matchedRoot` 与 `rootsDigest`。
- 附件 materialize（`engine/input-attachments.ts:164`）、image read、文件面板 open/reveal、undo、
  external file changes 按 root-set 校验。

### 7.6 Shell sandbox（Engine 每 turn 解析点追加 roots）

- `RunEnvironmentResolver.resolveSandboxConfig(cwd)`（`run-environment.ts:33-53`）改为
  `resolveSandboxConfig(run: { cwd; workspaceContext })`，参数为**必填**的 run-scoped 对象，不是可选尾参：
  在 `resolveSandboxConfig(config.sandbox, project, global, headless)`（`sandbox-config.ts:33`）分层结果之后，
  把全部 roots 的 canonical 路径**追加**进 `writableRoots`（按 `canonicalKey` 去重，幂等）；
  **显式 `EngineConfig.sandbox`（如自动化的 `defaultSandboxConfig(req.sandboxMode)`）同样追加**。
  `${workspace}` 仍只代表 primary（`sandbox/index.ts:100-106` 语义不变）。
- run-scoped context 的传递链路（不允许在回调中丢失）：`resolveRunWorkspace` 返回的 `RunWorkspaceResolution`
  增加 `workspaceContext`（legacy 时为单 root 合成值）→ `engine.ts:2108/2145` 用该对象调用
  `resolveSandboxConfig/resolveSandbox` → 得到的 backend 经 `buildRunToolContext`（`run-tooling.ts:39,63`）
  成为 `ToolContext.sandbox` → Bash 与 background shell 都只从 `ctx.sandbox` 取 backend（`builtin/bash.ts:96`），
  因此后台 shell 天然继承本 run 的多 root sandbox，无需额外参数。
- 子代理：`resolveChildSandbox(request.sandboxMode, deps.parentSandbox)`（`subagent-spawner.ts:344`）的
  `parentSandbox` 已含追加后的 roots；子 Engine 再走一次 `resolveSandboxConfig` 时因去重幂等不会重复追加。
  `subagent-spawner.test.ts` 断言子 `writableRoots` 与父相同且无重复。
- 能力包入口 `CapabilityToolServiceHost.resolveSandbox(cwd)`（`packages/core/src/capabilities/index.ts:40`，
  由 `engine.ts:4108` 绑定到 `runEnvironmentResolver.resolveSandbox`）保留单 `cwd` 签名；Engine 侧实现为
  `resolveSandbox({ cwd, workspaceContext: legacySingleRoot(cwd) })`——**约定：能力包按任意 cwd 请求的 sandbox
  只含该 cwd 一个 root**。因此 coding 的 worktree setup（`packages/coding/src/tools/worktree.ts:475`
  `resolveWorktreeSetupSandbox(worktreePath)`）只能写 worktree 目录，**不获得项目 secondary roots**；
  需要多 root 的能力必须走 run 的 `ToolContext.sandbox`。`run-environment.test.ts` 加用例：
  `CapabilityToolServiceHost.resolveSandbox(otherDir)` 的 `writableRoots` 不含当前 run 的 secondary。
- 因 roots 已进入 `writableRoots`，现有 `sandboxCacheKey(config, cwd)`（`engine/sandbox-cache-key.ts:11-19`）
  自然区分不同 roots 集合；`EngineRuntime.resolveSandbox(config, cwd)`（`engine/runtime.ts:80`）与
  `RunEnvironmentResolver` 自身缓存（`run-environment.ts:55-67`）两条路径都覆盖。
- Seatbelt/bwrap 已支持任意多个 writable roots（`sandbox/seatbelt.ts:62`、`sandbox/bwrap.ts:26-28`），只补测试。
- roots 编辑不影响已启动的 Bash 子进程；下一条命令用新 config 创建/选择 backend。

### 7.7 文件搜索与文件面板

- 新 IPC `files:searchProject(projectId, query)`：Main 内对每个 root 调用 `searchFiles(cwd, query)` 后合并、
  去重、按分数排序、截断到 `MAX_HITS`（`file-search-service.ts:38`），结果增加 `rootId`。现有 `searchFiles`
  无取消能力，Phase 1 不新增；串行逐 root。
- 文件面板 `fs:readDir/readFile/exists`（`index.ts:6348-6361`）增加 `(projectId, rootId, path)` 版本
  `fsRoot:readDir/readFile/exists`，经 `requireRendererProjectRoot` 授权；legacy 版本保留到 Phase 4。

### 7.8 Mobile remote 兼容

- `MobileProjectMeta`（`packages/core/src/protocol/mobile-remote-types.ts:72-77`）**只增字段**：
  `id?`, `roots?: Array<{ id; path; name; role }>`, `primaryRootId?`；`path/name/addedAt/pinned` 继续填 primary。
- `broadcastProjects`（`mobile-remote-orchestrator.ts:144-148`）同时向窗口与手机推送 V2 形状（含 legacy 字段）。
- `session.create` 按 §6.4 校验；Phase 4 增加 `projectId?`。
- 无协议握手。

### 7.9 Settings、Automations 与 headless

- Settings/Skills/Agents/Plugin Commands/Capabilities/Profile IPC：参数改为 `projectId`，Main 解析为 Session
  main root cwd；legacy cwd 版本保留到 Phase 4。
- Automation job（`packages/core/src/automation/store.ts:83-86` 仅有 `cwd`）Phase 4 新增可选 `projectId`/`rootId`。
- Headless server 继续固定单 server workspace root。

## 8. 数据迁移与兼容

### 8.1 项目存储迁移（V2 首启）

1. `projects.json` 存在 → 读 V2。
2. 否则读 `recents.json`（live 与 tombstone 都读），每个 entry 生成单 root 项目：`name/pinned/lastOpenedAt/deletedAt`
   保留，`createdAt = lastOpenedAt`，`revision = 1`，id 新生成。
3. 原子写 `projects.json`；`recents.json` 不删除。
4. renderer 收到首个 V2 snapshot 后：按 `canonicalKey(primary.path)` 与 localStorage `codeshell.repos` 对账；
   旧 `r-…` id → 新 UUID 用现有 `migrateProjectSessionBucket`（`transcripts.ts:617`）与
   `migrateProjectBucketOverrides`（`App.tsx:767-790` 已有流程）迁移 buckets/overrides/active id。
5. **localStorage-only 项目**（缓存中有、磁盘上没有；今天靠 `App.tsx:733-766` 回填 `projects.add`）：
   renderer 对每个此类路径调用一次 `projectRegistry.migrateLegacyPath(path)`，Main 用旧 `requireRendererProjectPath`
   三重校验（已注册 / picker 记录 / §4.6 索引中的 Session cwd）后创建单 root 项目；该 IPC 只在“V2 首启迁移未完成”
   标记期间可用，完成后拒绝。Phase 4 删除。
6. 迁移完成后 renderer 只保留 active project id、折叠状态等 UI 状态，删除 `codeshell.repos`。
7. 降级投影：一个发布周期内每次 V2 写入后把各项目 primary 投影回 `recents.json`，旧版本可继续打开。

### 8.2 RPC 兼容

- `workspaceContext` 缺失 → 引擎单 cwd 行为；`projectId` 缺失 → §6.2 规则 5–11。不引入握手。

### 8.3 Session 兼容

- 旧 Session：无 `project`，按 §4.5 规则 2/3 归属；运行按 §6.2 规则 3/6/7。
- 新 Session：binding + Host context。根目录缺失：§5.6。

## 9. 与当前未提交变更的关系与实现起点

### 9.1 未提交变更（不入本方案分支）

| 未提交改动 | 与方案关系 | 实现约束 |
| --- | --- | --- |
| `ConfigureModelConnection` 工具：`core/src/tool-system/builtin/configure-model-connection.ts`、`settings-changed.ts`、`settings/manager.ts:477-509` 新增 `mutateSettingsForScope` | Phase 2 语义依赖：project-scope 写入用 `ctx.cwd`，多 root 后必须仍是 main root | 不修改这些文件；若基线含 `mutateSettingsForScope`，Phase 2 加测试断言 project scope 写入落在 primary；若不含，**不移植、不重写**，跳过该测试 |
| 全局无 payload 的 `settings-changed` sink（`agent-server-stdio.ts:376-382`） | 方案的 roots 失效不复用它；用 `projectRegistry:changed` + `workspaceContext.projectRevision` | 不改动 |
| openai/anthropic provider 截断处理、`turn-loop.ts`、renderer `types.ts`、pet 模型键校验 | 无关 | 不改动 |
| 版本号 0.8.18→0.8.19、`tests/fixtures/composition-golden.json` | 与方案无关 | 本分支不改任何 `package.json` 版本、不改 golden |

### 9.2 安全可执行的交接（隔离 worktree，从 HEAD 起步）

本方案文件当前未跟踪，`git worktree add` 不会携带它。开工步骤：

```bash
cd "$(git rev-parse --show-toplevel)"
BASE_SHA=$(git rev-parse HEAD)                       # 记录到下方“实施基线”行
git worktree add ../codeshell-multi-root -b feat/multi-root-project "$BASE_SHA"
cp docs/todo/multi-folder-local-project-plan.md ../codeshell-multi-root/docs/todo/
cd ../codeshell-multi-root
git add docs/todo/multi-folder-local-project-plan.md
git commit -m "docs: multi-folder local project plan (base $BASE_SHA)"   # 只在 feature worktree 提交，不在 main 提交
grep -n "mutateSettingsForScope" packages/core/src/settings/manager.ts || echo "基线不含 mutateSettingsForScope"
```

- 实施基线：`BASE_SHA = 36a087a2dc319ced6c7c0a08520d65064da16e60`。
- 基线**不含** §9.1 的未提交依赖；Phase 0/1 与它们零文件重叠。
- 若开工前这些改动已合并到 main：`git rebase origin/main` 后按 §9.1 重判 Phase 2 断言测试是否启用。
- 改动 core 后跑 desktop 测试前先重建 core（desktop 测试消费 core dist）：
  `bun run --filter '@cjhyy/code-shell-core' build`。
- 只对改过的文件跑 prettier；不要跑 `bun run format`。

## 10. 分阶段实施（每阶段先写失败测试，再实现，可单独提交）

### Phase 0：ProjectStore、Session cwd 索引、稳定 id、origin 透传骨架

任务（顺序即提交顺序）：

1. `packages/core/src/workspace/canonical-key.ts` + `canonical-key.test.ts`（realpath 回退、尾分隔符、平台大小写、
   `/var` vs `/private/var`、不存在路径）；导出到 `.`/`/internal`。
2. `packages/desktop/src/main/session-cwd-index.ts` + `session-cwd-index.test.ts`（§4.6：注入假 fs，5 000 个
   Session 只扫描一轮；upsert/forget 后无重扫；batch 零 I/O）；`renderer-project-path.ts` 的 `hasPersistedSessionRoot`
   与 `mobile-remote-orchestrator.ts` 的 `lookupDiskSessionCwd` 改查索引（`renderer-project-path.test.ts` 补断言）。
3. `packages/desktop/src/main/project-store.ts` + `project-store.test.ts`：V2 读写、锁、坏数据隔离、recents 迁移、
   tombstone、`revision` 单调、重叠/重复校验、`resolveProjectForCwd[Batch]`（§4.5 规则 2/3/4）、降级投影。
4. `packages/server/src/worker-bridge-core.ts`：`WorkerFrameMeta`、`prepareInbound(line, meta)`、
   `injectWorkerMessage(line, meta)`、`request(..., { meta })`；`packages/server/src/mobile-remote/mobile-run-dispatch.ts`
   （`MobileRunBridge`、`injectMobileRunAndAwaitAcceptance`）、`mobile-chat-turn.ts`（`dispatchMobileChatTurn`）与
   `packages/desktop/src/main/mobile-remote/handle-client-event.ts`（`injectAndAwaitResult`）增加 `meta`；
   `packages/server/src/serve/headless-server.ts:307` 固定传 `{ origin: "serve", producer: "serve-ws" }`；
   `agent-bridge.ts` 三处入口、`hostReservations` 与 `reserveHostSession/forgetSession` 双表写清（§6.1）。
   所有约 25 个调用方（renderer IPC、mobile、Pet dispatch、Pet 委派、Pet long-task、Panel App、自动化 resume、
   `agent/query`/`SetWorkspace` 等非 run 调用）靠 typecheck 机械补齐 `meta`。此阶段 `prepareAgentRunMetadata`
   只记录 `meta`，不改裁决。
5. `index.ts` / `preload/index.ts` / `preload/types.d.ts`：`projectRegistry:*` IPC；`pickProjectDirectory()`；
   `dialog:pickDir` 去掉 `pushRecent`；legacy `projects:add/remove/setPinned` 委托 store。
6. `mobile-remote-orchestrator.projectList()` 输出 V2 形状（含 legacy 字段）；新增
   `packages/desktop/src/main/mobile-remote-orchestrator.test.ts`（目前无测试）。
7. renderer：`projects.ts` 新模型与 selector；`App.tsx` 首启对账与 §8.1 步骤 4/5；`useSessionNavigation.ts` 的
   addProject 改为 `createFromPicker`；`pathMatch/rebuildFromDisk/importRuns/liveSession` 改为消费
   `resolveForCwdBatch`。
8. `prepareAgentRunMetadata(line, meta, deps)`：实现 §6.2 规则 1–4（`projectId` 存在时解析/拒绝，注入 `cwd` 与
   `projectTrusted`），**暂不注入 `workspaceContext`**；`projectId` 缺失时保持现状直通（规则 5–11 在 Phase 2 收口）。
   renderer 聊天开始传 `projectId`。

新增/扩展测试：`canonical-key.test.ts`、`session-cwd-index.test.ts`（含 tentative/confirm/evict、miss 单点回读、
fork 结算 upsert）、`project-store.test.ts`（含 Git 子目录折叠两例）、
`packages/server/src/worker-bridge-core.test.ts`（meta 透传到 `prepareInbound`；request 与 inject 两条路径）、
`packages/server/src/serve/headless-server.test.ts`（serve 帧携带 `origin: "serve"`）、
`packages/server/src/mobile-remote/mobile-run-dispatch.test.ts`、`mobile-chat-turn.test.ts`（helper 携带 meta）、
`agent-run-metadata.test.ts`、
`agent-bridge.nochild.test.ts`（hostReservations 与 forgetSession）、`panel-app-agent-task-service.test.ts`
（`requestWorker` 收到 `origin: "host"`）、`pet/pet-work-delegation-host.test.ts`、`pet/pet-dispatch-service.test.ts`
（meta 断言）、`mobile-remote-orchestrator.test.ts`、`renderer/automation/*.test.ts`、`repos.test.ts`、
`AppDraftOverrides.test.tsx`、`preload/ipc-contract.test.ts`。

验收/测试：

```bash
bun test packages/core/src/workspace
bun run --filter '@cjhyy/code-shell-core' build
bun test packages/server/src/worker-bridge-core.test.ts packages/server/src/mobile-remote packages/server/src/serve
bun run typecheck:workspaces   # meta 必填的机械收口：所有 injectWorkerMessage/requestWorker/core.request 调用点
bun test packages/desktop/src/main/project-store.test.ts packages/desktop/src/main/session-cwd-index.test.ts \
  packages/desktop/src/main/recents-store.test.ts packages/desktop/src/main/renderer-project-path.test.ts \
  packages/desktop/src/main/agent-run-metadata.test.ts packages/desktop/src/main/agent-bridge.nochild.test.ts \
  packages/desktop/src/main/panel-app-agent-task-service.test.ts packages/desktop/src/main/pet \
  packages/desktop/src/main/mobile-remote-orchestrator.test.ts
bun test packages/desktop/src/renderer/automation packages/desktop/src/renderer/repos.test.ts \
  packages/desktop/src/renderer/AppDraftOverrides.test.tsx packages/desktop/src/preload/ipc-contract.test.ts
cd packages/desktop && bun run typecheck
```

- 迁移/降级、并发写、坏数据、symlink alias、删除目录、稳定 id、localStorage-only 回填测试通过。
- 伪造/未知 `projectId` 被拒绝；`projectId` 缺失的运行行为与基线一致。
- 所有现有行为保持单 root；golden 无变化。

### Phase 1：编辑项目 UI 与 Main 侧只读多 root

1. `addRootFromPicker/removeRoot/setPrimary/rename` + 测试（含 §5.1 移除 main root 的拒绝）。
2. Sidebar“编辑项目”面板（shadcn 组件）。
3. `files:searchProject` 与 `fsRoot:*` IPC + 测试（跨 root 合并、去重、`rootId`、越界拒绝）。
4. TrustGate：untrusted secondary 被设为 primary 时重新弹出。

验收：新增 root 后 agent 文件工具仍 primary-only；文件面板/搜索可见 secondary；不加载 secondary 的
settings/instructions/skills。

```bash
bun test packages/desktop/src/main/project-store.test.ts packages/desktop/src/main/file-search-service.test.ts \
  packages/desktop/src/main/fs-service.test.ts packages/desktop/src/main/trust-store.test.ts
bun test packages/desktop/src/renderer/Sidebar.test.ts
cd packages/desktop && bun run typecheck
```

### Phase 2：WorkspaceContext、PathPolicy、sandbox 追加、裁决表全量生效

1. `packages/core/src/workspace/workspace-context.ts` + 测试（形状、重叠、primary 唯一、digest）。
2. `RunParams`/`EngineConfig`/`EngineRunOptions`/`ToolContext`/`ToolVisibilityContext` 增加字段；
   `resolveRunWorkspace` 校验（含 worktree 分支按 `SessionWorkspace`）；`state.project` 写入与恢复校验
   （扩展 `engine.resolve-cwd.test.ts`、`session-manager.workspace.test.ts`）。
3. `ClassifyOptions.workspaceRoots` + `ToolExecutor` 接入（新增 `path-policy-multi-root.test.ts`：Read/Write/Edit/
   Glob/Grep 与 coding 包 ApplyPatch 跨 root、兄弟目录 ask、`root-evil`、symlink 逃逸、敏感文件一致）。
4. 会话级 grant 按 root 移除清理（`path-policy-approval.test.ts`）。
5. 跨 Session 消息按 `projectId`/`canonicalKey` 授权（`engine.session-message.test.ts`）。
6. runtime header 与 dynamic provider 输出 roots。
7. **sandbox**：`resolveSandboxConfig({ cwd, workspaceContext })` 必填 run 对象、追加 roots 并去重（显式
   `config.sandbox` 也追加）；`RunWorkspaceResolution.workspaceContext` 贯通到 `ToolContext.sandbox`；
   测试 `run-environment.test.ts`、`sandbox-config.test.ts`、`sandbox-cache-key.test.ts`、`runtime.sandbox-cache.test.ts`
   （roots 变化换 backend；`CapabilityToolServiceHost.resolveSandbox(otherDir)` 只含单 root）、
   `subagent-spawner.test.ts`（子 roots 无重复）、`executor-plan-bash.test.ts` 或新增
   `bash.multi-root-sandbox.test.ts`（background shell 使用同一 backend）。
8. Main：`prepareAgentRunMetadata` 实现 §6.2 全表，注入 `workspaceContext`；`hostReservations` 参与规则 10；
   索引 tentative（`runAccepted` 延 TTL / `session_started` confirm / 其余 evict）接到 run 结果与流事件。
   `agent-run-metadata.test.ts` 补：host 帧 cwd 命中 primary 获得完整 context（规则 8 正向）；host 复用已存在
   Session 且 `workspacePath` 不同时按持久化 cwd（规则 7h）；renderer/mobile 同情形被规则 7 拒绝；
   **renderer/mobile 以 `SessionWorkspace.root` 续聊 worktree Session 通过（规则 7 双值）**；索引缓存旧值、磁盘为新
   worktree 值 → 单点回读后通过，且只读一个文件；磁盘也不匹配 → 拒绝；Quick Chat fork 与普通 renderer fork 后
   新 id 的运行命中规则 2/3/6（后者经 miss 单点回读）。
9. Mobile §6.4：`session.create` 校验、删除三处 `process.cwd()`/`lastRunContext.cwd` 回退；新增
   `packages/desktop/src/main/mobile-remote/handle-client-event.test.ts`（含 worktree Session 续聊通过、索引过期
   回读通过、磁盘不匹配拒绝）。`session-workspace-service.ts` 的 switch/release/cleanup 与 `agent-bridge.setWorkspace`
   接入 `SessionCwdIndex.setWorkspaceRoot`（`session-workspace-service.test.ts` 与 `session-cwd-index.test.ts` 断言）。
   `pet-dispatch-service.test.ts` 补“集外 `reusableSessionId` 被拒”断言（规则 7h 前提）。
10. 自动化 §6.3：`buildDesktopAutomationRunner` 折叠 → 项目命中 → 索引 legacy → `stop` 四分支、`projectTrusted`；
    新增 `packages/desktop/src/main/automation-host.workspace.test.ts`（Git 子目录、持久 Session cwd、项目移除、
    `stop` 回归）。
11. 若基线含 `mutateSettingsForScope`：加测试断言 `ConfigureModelConnection` 的 project scope 写入落在 primary。

验收：normal permission 下 secondary 编辑无“项目外”提示；未知目录 fail closed；伪造
`workspaceContext/projectTrusted/cwd/origin` 被覆盖或拒绝；旧 Session 单 cwd 无回归；Pet/Panel App/IM/自动化 resume
经规则 5/6/10 通过；自动化独立运行在项目 root 下拿到 context。

```bash
bun test packages/core/src/workspace packages/core/src/tool-system/path-policy-*.test.ts \
  packages/core/src/engine/engine.resolve-cwd.test.ts packages/core/src/engine/engine.session-message.test.ts \
  packages/core/src/engine/subagent-spawner.test.ts packages/core/src/session/session-manager.workspace.test.ts \
  packages/core/src/engine/input-attachments.test.ts packages/core/src/engine/run-environment.test.ts \
  packages/core/src/engine/sandbox-config.test.ts packages/core/src/engine/sandbox-cache-key.test.ts \
  packages/core/src/engine/runtime.sandbox-cache.test.ts
bun run --filter '@cjhyy/code-shell-core' build
bun test packages/desktop/src/main/agent-run-metadata.test.ts packages/desktop/src/main/agent-bridge.nochild.test.ts \
  packages/desktop/src/main/automation-host.workspace.test.ts packages/desktop/src/main/automation-host.resume.test.ts \
  packages/desktop/src/main/mobile-remote/handle-client-event.test.ts packages/desktop/src/main/mobile-remote-orchestrator.test.ts \
  packages/desktop/src/main/panel-app-agent-task-service.test.ts packages/desktop/src/main/pet
bun run lint && bun run lint:engine-bypass
```

### Phase 3：Git/Review、worktree、`workspace_missing` 迁移、Seatbelt 真机

1. Review 多 repo fan-out/fan-in + 测试（多独立 repo、两个 root 同一 repo、非 Git root 混合、同名文件）。
2. primary worktree 时 roots 替换 + 测试（`session-workspace-service.test.ts`）。
3. `projectRegistry.migrateSessionMainRoot` 与 `SessionRootStatus` 派生 + UI；放开 §5.1 移除 main root；
   更新 §4.6 索引。
4. `sandbox/sandbox.test.ts` 每个 root 可写、未挂载目录拒绝；macOS Seatbelt 端到端一次真机验证。

```bash
bun test packages/core/src/tool-system/sandbox
bun run --filter '@cjhyy/code-shell-core' build
bun test packages/desktop/src/main/session-workspace-service.test.ts \
  packages/desktop/src/main/desktop-services.worktree-cleanup.test.ts packages/desktop/src/main/project-store.test.ts
```

### Phase 4：Mobile、Automation 绑定与清理 legacy

1. `session.create.projectId`、手机端项目 V2 UI。
2. Automation `projectId/rootId`；§6.3 第 2 步优先使用。
3. 删除 legacy cwd IPC、`migrateLegacyPath`、`requireRendererProjectPath` 的 Session 回退、renderer 项目集合 localStorage、
   `projects:*` legacy IPC。
4. 根据回滚窗口决定停止 recents 降级投影。

```bash
bun test packages/desktop/src/main/mobile-remote-orchestrator.test.ts packages/desktop/src/main/mobile-remote \
  packages/desktop/src/main/automation-service.test.ts packages/desktop/src/main/renderer-project-path.test.ts
bun run typecheck
```

## 11. 测试矩阵（补充说明，命令见 §10）

- Store/索引：单 root v1→V2；tombstone；相同路径、symlink alias、父子重叠、大小写 alias、跨项目重复；并发
  add/remove/setPrimary 不丢更新；revision 单调；目录消失；索引只扫描一次、失效点正确。
- origin 透传：`worker-bridge-core` inject 与 request 两路 meta 到达 `prepareInbound`；每个生产者（含 serve）的
  单元测试断言其 origin；renderer/mobile 帧无法命中规则 7h/10；`reserveHostSession` 双表写入、renderer run 不写
  `hostReservations`、`forgetSession` 双清。
- 索引：只扫描一轮；命中零 I/O；miss 单点回读（含 `workspaceRoot`）；switch/release/cleanup/`SetWorkspace` 即时
  更新 `workspaceRoot`；规则 7 失配自愈回读只读一个文件；tentative 的 `runAccepted` 延 TTL、`session_started`
  confirm、result-无-`session_started` evict、失败/forget evict；Quick Chat fork 结算 upsert；普通 renderer fork
  与外部进程新建 Session 回读。
- 裁决表：§6.2 每一行至少一正一负用例（含规则 8 的 host 正向、规则 7h 的 workspacePath 不同与集外
  `reusableSessionId` 被拒、规则 7 的 worktree root 续聊通过、索引过期回读通过、磁盘不匹配拒绝）；§6.3 四分支与
  `stop` 回归；§6.4 接受/拒绝/缺省 no-repo/worktree 续聊。
- 能力包 sandbox：`CapabilityToolServiceHost.resolveSandbox(cwd)` 单 root 约定；coding worktree setup 不含 secondary。
- 归属：§4.5 四条规则各一用例；Make primary 后旧 Session 仍归属原项目且不新建项目；规则 3 补写 binding。
- PathPolicy/sandbox：见 Phase 2/3；显式 `config.sandbox` 与 settings 分层两种来源都追加 roots；追加幂等去重；
  background shell 与子代理共享同一 run 的 roots。
- 配置发现：primary 的 settings/AGENTS/Skills/pathApprovals/Sources 生效；secondary 同名不生效；Make primary 后旧
  Session 不漂移；untrusted secondary 成为 primary 后危险字段继续被剥离。
- Git/worktree/Review：见 Phase 3。

## 12. Definition of Done

- 项目可挂载、移除、切换 primary，重启后保持；Main 是 project id、roots、Session 绑定与授权的唯一事实源。
- secondary 可被文件工具与 shell sandbox 读写，不被判成项目外路径；secondary 配置不被自动发现或执行。
- §6 全部生效：no-repo、Mobile、Pet、IM 网关、Panel App、Quick Chat、自动化（resume 与独立运行）、旧 Session
  无回归；伪造 renderer/mobile payload 或 origin 不能扩权；移除 root 后新 turn 无法访问。
- 外部 Agent Runtime、cc-room、TUI、`code-shell-serve` 行为不变（非目标，仅回归验证）。
- Review 可区分并聚合多个 repo；Git/worktree 仍只操作 Session main repo。
- 单元、Main IPC、renderer 交互测试与一次 macOS Seatbelt 端到端验证通过；golden 与版本号未变。

## 13. 首批代码落点（Phase 0，按序）

1. `packages/core/src/workspace/canonical-key.ts`（新）
2. `packages/desktop/src/main/session-cwd-index.ts`（新）
3. `packages/desktop/src/main/project-store.ts`（新）
4. `packages/server/src/worker-bridge-core.ts`、`packages/server/src/mobile-remote/mobile-run-dispatch.ts`、
   `packages/server/src/mobile-remote/mobile-chat-turn.ts`、`packages/server/src/serve/headless-server.ts`、
   `packages/desktop/src/main/agent-bridge.ts`、`packages/desktop/src/main/mobile-remote/handle-client-event.ts`
5. `packages/desktop/src/main/index.ts`、`packages/desktop/src/preload/index.ts`、`packages/desktop/src/preload/types.d.ts`
6. `packages/desktop/src/main/mobile-remote-orchestrator.ts`
7. `packages/desktop/src/renderer/projects.ts`、`repos.ts`、`App.tsx`、`app/useSessionNavigation.ts`、
   `automation/pathMatch.ts`、`automation/rebuildFromDisk.ts`、`automation/importRuns.ts`、`automation/liveSession.ts`
8. `packages/desktop/src/main/agent-run-metadata.ts`

完成后项目身份与路径解耦、origin 元数据到位、裁决表骨架就位，后续 WorkspaceContext、PathPolicy、sandbox 才能渐进接入。
