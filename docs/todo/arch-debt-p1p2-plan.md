# 架构债 P1/P2 调研与实施拆解（含 Goal 持久化）

> 文档状态：实施前调研与 PR 拆解；本轮只写本文，不含实现代码。
>
> 源码快照：`429867b1`（2026-07-12）。行号均以该快照为准；题面中的
> `packages/desktop/src/renderer/App.tsx` 4286 行、`packages/core/src/index.ts` 约 843 行是较早
> 基线，当前实测分别为 **4520 行**和 **894 行**。
>
> 决策来源：`docs/todo/architecture-debt.md:24-79`、
> `docs/todo/core-harness-and-plugin-panels.md:42-117`、
> `docs/refactor/goal-persistence-final-design.md:1-729`，以及当前源码。若本文出现尚未由代码证明的
> 判断，会显式标记为“**推测**”。

## 0. 执行摘要

四块工作不是一条必须串行的长链：

```text
已完成：extractJSON -> utils/json.ts
                         |
public/internal 分层 -> CapabilityModule/arena 可选注册 -> packages/arena 移包

App.tsx 拆分 ------------------------------------------------------ 独立

Goal 纯模型 -> legacy decoder -> state 领域更新 -> Engine/host 切换 -> 删除双字段
  |                                                                  |
  +---------------- cron 边界测试、架构文档措辞校准（独立伴随项） ----+
```

- Arena 的 `(a) extractJSON` 前置已经完成：通用实现位于
  `packages/core/src/utils/json.ts:1-86`，`memory-orchestrator.ts:29` 直接依赖该工具，Arena 仅在
  `arena/strategies/utils.ts:43-49` 做兼容 re-export。下一步从 `(b) 可选 builtin` 开始。
- `index.ts` 分层应早于 Arena 移包：先建立稳定 public extension contract 和不稳定 internal
  subpath，移包时才不会让 `packages/arena` 反向依赖 core 私有深路径。
- Arena 可选注册必须早于移包：当前 core 的静态 builtin 表、protocol query、settings schema、
  onboarding 都直接认识 Arena，直接搬目录会形成 `core -> arena -> core` 包环。
- `App.tsx` 拆分与 core 三块没有语义依赖，可单独排期；但内部应先抽 hook，再抽 JSX 壳，避免同时
  改 bucket/stream 状态机与组件层级。
- Goal 持久化与 Arena/App 无语义依赖；与 `index.ts` 只有 `SessionState` 类型出口的文件冲突，排期上
  建议错开修改 `packages/core/src/index.ts` / `types.ts`，不构成架构前置。

## 1. 基线与证据口径

### 1.1 已确认的架构不变量

- core 是 UI 无关的通用 agent harness；交互式 TUI/desktop 主路径通常经
  `AgentClient -> AgentServer -> ChatSession -> Engine`，但 SDK、子 Agent、测试和专用 runner 可以
  直接构造 Engine。证据见 `docs/architecture/00-overview.md:41-75`、
  `docs/core-deep-dive/v2-01-core-as-agent-harness.md:201-218`、
  `docs/core-deep-dive/v2-05-protocol-hosts-orchestration-deep-dive.md:94-121`。
- 工具注册目前是“静态总表 + preset 白名单”两层：`ToolRegistry` 静态导入
  `BUILTIN_TOOLS` 并按名称过滤（`tool-system/registry.ts:12-59`），Engine 在构造时用
  `resolveBuiltinToolNames` 产生名单（`engine/engine.ts:519-547`）。
- Desktop renderer 不能 runtime-import core，只能通过 `window.codeshell.*` 与 main/worker 通信；
  `App.tsx:2` 对 `StreamEvent` 是 type-only import，符合 `CODESHELL.md:38-44` 的 lint 边界。
- session 的 durable snapshot 是 `state.json`，transcript 是 JSONL；tmp + rename 只提供完整 snapshot
  的原子可见性，不是跨进程事务。当前实现见 `session/session-manager.ts:631-681`。
- `core -> tool-system -> engine` 的旧类型环已经通过 `ToolRuntimeHost` 和
  `engine/types.ts` 化解；`engine.ts` 当前 3207 行，拆 Engine 仍应先于进一步扩大其职责。本文不把
  Goal 领域 API 塞回一个更大的 Engine 私有协议，而把持久化责任放在 SessionManager。

### 1.2 本文不做的事

- 不修改任何 `.ts/.tsx/package.json`，不 commit、不 push。
- 不在 Goal 层引入 revision、CAS、watermark、lockfile、sidecar 或 journal。
- 不借 Arena 移包顺手改产品交互；兼容窗口和明确的 breaking change 分开处理。
- 不在 App 拆分 PR 中改变 reducer 事件语义、bucket key、panel 持久化格式或 IPC shape。

## 2. 块一：拆 public/internal export

### 2.1 现状盘点

| 证据 | 当前事实 | 债务/影响 |
|---|---|---|
| `packages/core/src/index.ts:1-7` | 文件自称 `Public API exports`，当前 894 行。 | 文件名与真实稳定性不符；所有 re-export 都可被外部用户视作 semver 契约。 |
| `index.ts:11-542` | Engine、provider client、ToolRegistry、`BUILTIN_TOOLS`、protocol server、SessionManager、插件安装器、Arena、run、settings、credential internals 全在根入口。 | SDK 基础面、宿主装配面、产品能力面混在一起；内部重构容易被放大成 breaking change。 |
| `index.ts:311-411` | Arena/IterativeArena、三类 Strategy、ledger/transitions 和大量 `Arena*`/iterate types 是裸公开导出，没有 `@internal`。 | Arena 移包前无法判断哪些是稳定 SDK；core tarball 和 `.d.ts` 继续暴露整个产品子系统。 |
| `index.ts:545-564,630,689-695,794-805,829-849` | state singleton、TUI utils、logging hooks、扩展 tool/protocol/Arena/LLM/type 面仅靠八处 `@internal` 注释分区。 | 注释不阻止外部 import；同一根入口没有编译期边界。这里的“八处”指八个注释分区，不代表只有八个 symbol。 |
| `packages/core/package.json:8-15` | exports map 只有 `"."` 和 `./bin/agent-server-stdio`。 | 尚无 `./internal` / `./experimental` 合法 subpath。 |
| 根 `tsconfig.json:11-15` | workspace path alias 把 `@cjhyy/code-shell-core` 映到 `src/index.ts`，通配符还能直达 `src/*`。 | 仓内消费者可绕过 package exports；测试必须同时覆盖 source alias 与打包后 exports。 |
| TUI/desktop import 扫描 | TUI 大量从根入口取宿主工具；desktop main 也取 core 宿主 API；renderer 只取 type。 | 机械迁移面较广，但行为风险低；漏迁移主要表现为 typecheck/build 失败。 |

为什么是债：public barrel 既是稳定 SDK，又承担仓内 service locator。结果是“可发布”与“可重构”
没有边界；尤其 Arena 裸公开块让 P2 移包必须同时处理包边界和兼容语义。

### 2.2 目标边界

建议形成三个入口：

```text
@cjhyy/code-shell-core               稳定 SDK：Engine/factories/types/extension contracts
@cjhyy/code-shell-core/internal      仓内宿主：TUI/desktop service glue，不承诺 semver
@cjhyy/code-shell-core/experimental  可选：尚未稳定且可能跨包迁移的能力（过渡期 Arena）
```

`./internal` 不是安全隔离，只是可执行的兼容边界；仓外仍能 import，但 package 文档明确不承诺稳定。
`./experimental` 是否保留取决于发布策略。若不希望增加第三入口，可把 Arena 暂放 `./internal`；不要在
同一个 PR 中删除根 Arena export。

### 2.3 PR 序列

| PR | 一句话目标 | 主要影响文件 | 可独立合并 | 回归风险 | 必需测试/验证 |
|---|---|---|---|---|---|
| I1 | 建立 `index.internal.ts` 与 package subpath，但先保留根入口兼容 re-export。 | `core/src/index.internal.ts`、`core/package.json`、根 `tsconfig.json`、build/exports smoke | 是 | 低；只有模块解析/声明文件遗漏 | source 与 `dist` 两套 import smoke；`bun run build`；`bun run typecheck` 无新增相关错误 |
| I2 | 将八个已有 `@internal` 分区的仓内消费者机械改到 `/internal`。 | `core/src/index.ts`、TUI imports、desktop main imports、测试 imports | 是，依赖 I1 | 低到中；type-only/value import 混淆和 Electron externalization | TUI/desktop build；`bun test`；`bun run lint:engine-bypass`；renderer runtime-import lint 保持绿 |
| I3 | 把 Arena 根导出标记 deprecated，并镜像到 `/experimental`（不做目录迁移）。 | `core/src/index.ts`、`index.experimental.ts`、`core/package.json`、API 文档 | 是，依赖 I1 | 低；对现有用户零运行时变化，但声明面增加 | Arena root 与 experimental 两条 import 相同 symbol identity；tarball exports smoke |
| I4 | 在明确 major/兼容窗口后，从稳定根入口删除 internal 与 Arena 兼容 aliases。 | `core/src/index.ts`、release notes、API snapshot | 否；依赖仓内迁移完成和 Arena 移包兼容策略 | 中到高；这是实际 breaking change | public API snapshot；下游 fixture 编译；semver/release-note gate |

纪律：I1/I2 只做出口和 import 路径变化，不顺手移动实现文件、改 symbol 名或设计 CapabilityModule。

## 3. 块二：Arena 可选注册与移包

### 3.1 现状盘点

| 证据 | 当前事实 | 债务/影响 |
|---|---|---|
| `tool-system/builtin/index.ts:90`、`:759-769` | Arena adapter 被静态 import，并无条件进入 `BUILTIN_IMPLEMENTATIONS`；`BUILTIN_TOOLS` 在 `:926-930` 由整表生成。 | `new ToolRegistry()` 默认包含 Arena；core 加载 builtin 表就把 Arena 模块拉入依赖图。 |
| `tool-system/registry.ts:12-59` | Registry 只能从静态 `BUILTIN_TOOLS` 选名字，不能注入 capability tool catalog。 | “可选”目前只是白名单不可见，不是模块未装配。 |
| `preset/index.ts:140-147` | `Arena` 在 `TERMINAL_CODING_EXTRA_TOOLS` 中。 | terminal-coding Engine 默认选择它；general preset 虽不选它，core 静态依赖仍存在。 |
| `tool-system/builtin/arena.ts:12-20` | adapter 直接依赖 `core/src/arena`、ModelPool、ToolContext、SettingsManager。 | adapter 与实现、core runtime、settings 混层。 |
| `protocol/server.ts:47,1857-1860`、`protocol/types.ts:280-298` | core protocol 静态认识 `arena_status`。 | 即便不装 Arena，generic server 仍带产品 RPC。全仓搜索未发现 TUI/desktop 对该 query 的实际调用。 |
| `settings/schema.ts:404-423` | core schema 固定包含 `arena.participants`。 | core settings contract 被产品模块占据。 |
| `onboarding.ts:402-419`、`index.ts:640-649` | core onboarding 直接写 Arena settings，并从根导出 helper。 | 通用模型 onboarding 与 Arena 产品 onboarding 绑定。 |
| `tui/src/cli/commands/arena.ts:14-33,68-125` | TUI `/arena`/headless command 直接从 core 根构造 Arena并渲染。 | 移包会影响 TUI 依赖与 CLI，但该入口可保留为产品能力。 |
| `tui/src/ui/App.tsx:943,1942` | 模型管理器通过通用 `config_get/config_set` 读写 `arena.participants`。 | 设置 UI 需要随 schema ownership 迁移。 |
| `core/src/arena/**` 的跨目录 imports | Arena 依赖 core 的 LLM factory/types、logger、session usage、web search/fetch 等。 | `packages/arena` 合理方向是依赖 core 的稳定 extension API；core 不能再反向静态依赖 arena。 |

### 3.2 已满足前置与推荐产品语义

已满足的三步提取 `(a)`：`extractJSON` / `extractJSONArray` 已在 `utils/json.ts`，且有
`utils/json.test.ts` 与 Arena array regression test；移包不得把它们搬回 Arena。

为使 P2 可执行，本文建议把待决语义定为：

1. `Arena` **不是 core 默认 builtin**；由可信的进程内 `CapabilityModule` 显式装配。CodeShell 产品
   宿主可默认装 Arena，纯 core SDK、cron/headless harness 默认不装。
2. TUI 的 `code-shell arena` 和 `/arena` 保留，但依赖 `packages/arena`；这属于 CodeShell 产品面，
   不是 core SDK 面。
3. desktop 当前没有独立 `/arena` UI，但 terminal-coding 会得到 Arena tool；移包后由 desktop-owned
   worker composition entry 装模块，renderer 不增加 core runtime import。
4. `arena_status` 不再是 core 固定 query。由于当前没有调用方，可在兼容窗口后删除；如果未来 UI
   需要，由 Arena module 通过 `rpcMethods` 贡献。
5. 新设置归 Arena module 的命名空间 schema（建议 `capabilities.arena.participants`）；兼容读取旧
   `arena.participants` 一次，保存时只写新位置。不要让 core 永久保留两份权威字段。
6. 原 core 根 Arena API 先 deprecated 并指向新包，下一 major 删除。`@cjhyy/code-shell-arena` 的 public
   面只承诺 `Arena`、`IterativeArena`、必要 config/result types 与 module factory；phases/ledger/parser
   留 internal。

第 3 点的具体 worker 文件位置要在实现 PR 里根据 desktop 打包入口复核；这里关于“desktop-owned
composition entry”的文件名是**推测**，架构约束（core 不反向依赖 arena、renderer 不 runtime import）
则有源码和 lint 证据。

### 3.3 PR 序列

| PR | 一句话目标 | 主要影响文件 | 可独立合并 | 回归风险 | 必需测试/验证 |
|---|---|---|---|---|---|
| A0（已完成） | 把通用 JSON 提取从 Arena 移到 core utils。 | `utils/json.ts`、`memory-orchestrator.ts`、Arena compat re-export | 已合入 | 已验证 | 保留现有 JSON/array tests |
| A1 | 为 ToolRegistry/Engine 增加可信 `CapabilityModule` 注入点，不迁移任何现有能力。 | `engine/types.ts`、`tool-system/registry.ts`、protocol/settings extension types、public index | 是 | 中；装配顺序、重复工具名、guard 合并 | 空 modules 行为快照不变；重复名 fail loud；tools/hooks/RPC/settings contribution 单测；全 core tests |
| A2 | 把 Arena adapter 从静态 builtin 表改成 `createArenaCapability()`，纯 core 默认不注册。 | `builtin/index.ts`、`builtin/arena.ts`、preset、Engine/host composition、registry tests | 是，依赖 A1 | 中；工具可能在宿主中静默消失 | `new ToolRegistry()` 无 Arena；显式 module 有 Arena；TUI/desktop host profile 有 Arena；cron/headless 无；permission/timeout metadata 不变 |
| A3 | 将 `arena_status` 和 Arena settings/onboarding ownership 移入 capability，保留 legacy settings read。 | `protocol/server.ts/types.ts`、`settings/schema.ts`、`onboarding.ts`、TUI model manager、Arena module | 是，依赖 A2 | 中；配置丢失或 query shape 漂移 | old/new settings fixtures；valid module RPC present/absent；secret redaction；TUI settings save/reload |
| A4 | 创建 `packages/arena`，先搬纯实现和测试，使其只依赖 core 的稳定 public extension API。 | 新 package、workspace/build config、`core/src/arena/**`、TUI package/imports | 否，建议 stacked 后整体合并 | 高；跨包路径、循环依赖、资源/声明文件遗漏 | 包依赖图无环；Arena/IterativeArena tests；TUI arena CLI smoke；`bun run build` |
| A5 | 切 desktop/TUI 产品 composition 到新包，并在 core 留一个发布周期的 deprecated compatibility re-export。 | product worker entry、TUI commands、core experimental/root compat、package manifests | 是，依赖 A4 | 中到高；打包后模块缺失、worker 启动失败 | packaged worker smoke；TUI `/arena`；desktop terminal-coding tools query；npm tarball import fixtures |
| A6 | 在下一 major 删除 core Arena 目录、根 re-export、固定 RPC/schema 残留。 | core index/package/protocol/settings/onboarding、release notes | 否；breaking release | 高（API）但低（运行时逻辑） | `rg` guard：core 无 `src/arena` 和静态 Arena import；public API snapshot；全仓 build/test |

### 3.4 不应采用的捷径

- 仅从 `TERMINAL_CODING_EXTRA_TOOLS` 删除 `Arena`：它会变得不可见，但仍被静态 import，不算可选
  注册。
- 让 core 以普通 dependency/optionalDependency 依赖 `packages/arena`：Arena 本身需要 core 的 LLM/tool
  contracts，会制造包环或运行时动态探测。
- 搬目录后让 TUI/desktop 继续 import `@cjhyy/code-shell-core/src/*`：绕过 exports 会把 P1 public/internal
  工作抵消。

## 4. 块三：拆 Desktop renderer `App.tsx`

### 4.1 现状盘点与真实边界

`App.tsx` 当前 4520 行。它不是单纯“渲染太长”，而是把多个状态所有者、IPC subscription 和
command handler 放在一个 React component 中：

| 边界 | 代码锚点 | 可抽目标 | 主要风险 |
|---|---|---|---|
| 顶层纯 helper 与 QuickChat host | `App.tsx:176-357` | `app/appUtils.ts`、`quick-chat/QuickChatPanelHost.tsx` | 低；props 搬运 |
| 根状态与 bucket 派生 | `:359-729` | `useAppBuckets` / `useComposerDrafts` / `useApprovalState` | 中；闭包和 ref 镜像 |
| project/settings/localStorage 同步 | `:730-970` | `useProjectSync`、`useBucketOverrides` | 中；mount-only effect 与跨窗口 echo |
| transcript hydrate/persist/fallback | `:971-1124` | `useTranscriptBuckets` | 中；首帧 welcome flash、automation disk merge、snapshot seq 去重 |
| repo/session CRUD 与 automation backfill | `:1140-1671` | `useSessionNavigation`、`useAutomationSessionImport` | 中；localStorage/disk 双投影 |
| stream、approval、mobile、automation IPC 路由 | `:1672-2242` | `useStreamRouter` + `useHostSubscriptions` | **高**；多 session 路由、coalescer seq、late event、cleanup |
| send/quick chat/queued steer/stop/compact | `:2255-3045` | `useRunController`、`useQueuedSteering`、`useApprovals` | **高**；cancel/relay/steer 竞态 |
| panel/quick-chat/anchor/dock | `:3057-3805` | `usePanelBuckets`、`useAnchors`、`useAppShortcuts` | 中；必须保持 hidden-but-mounted webview/PTY 语义 |
| settings、TopBar derived state、goal clear | `:3807-4099` | `useRuntimeSettings`、selectors | 中；worker hot reload、optimistic goal clear |
| 根 JSX shell | `:4101-4507` | `AppShell`、`AppMainView`、`SessionPanelDock` | 中；巨大 props 面，但逻辑应已先移出 |

现有可复用地基已经不少：`transcriptsReducer.ts`、`streamRouting.ts`、`snapshotReplay.ts`、
`queuedInput.ts`、`stopRouting.ts`、`chat/anchorBuckets.ts`、`panels/PanelArea.tsx` 都已有纯逻辑和测试。
因此拆分应围绕这些模块建立 hook，不重写第二套 reducer。

为什么是债：任何无关 UI 改动都重新创建数十个 handler/effect 的闭包环境；stream/approval/panel/session
状态互相可见，所有权不清。影响面包括多 session 并发、automation backfill、mobile remote、quick chat、
panel webview/PTY 生命周期和 persistent goal 的 optimistic UI。

### 4.2 PR 序列

| PR | 一句话目标 | 主要影响文件 | 可独立合并 | 回归风险 | 必需测试/验证 |
|---|---|---|---|---|---|
| D1 | 先搬顶层纯 helpers 与 `QuickChatPanelHost`，建立无行为变化的拆分模板。 | `App.tsx:176-357`、新 app/quick-chat 文件 | 是 | 低 | `AppQuickChat.test.tsx`、renderer typecheck/build |
| D2 | 抽 `useBucketOverrides` 与 `useTranscriptBuckets`，保持现有 reducer 和 storage keys。 | `App.tsx:403-425,730-1124`、新 hooks | 是 | 中 | `overridePersistence`、`snapshotReplay`、`transcriptsReducer`、App draft/compact tests |
| D3 | 抽 `useSessionNavigation` / automation disk import，收口 repo/session 双投影。 | `App.tsx:1140-1671`、automation/transcript helpers | 是，依赖 D2 更稳妥 | 中 | repo/session deletion/archive tests、automation import/rebuild tests、startup smoke |
| D4 | 抽 `useStreamRouter`，只搬 routing/coalescing/subscription，不改任何 event reducer。 | `App.tsx:599-610,1672-2242`、新 hook | 是 | 高；本块最敏感 | `streamRouting`、`streamCoalescer`、`snapshotReplay`、`AppQuickChat` 的 late/multi-session cases；listener cleanup 测试 |
| D5 | 抽 `useRunController` 与 `useQueuedSteering`，收口 send/stop/relay/compact。 | `App.tsx:2255-2963`、新 hooks | 是，建议依赖 D4 | 高 | `queuedInput`、`stopRouting`、App draft/quick-chat/compact；并发 session stop/steer smoke |
| D6 | 抽 `usePanelBuckets` / `useAnchors`，保持每 bucket dock 挂载语义。 | `App.tsx:3057-3764`、panel/chat hooks | 是 | 中到高；webview/PTY 被误卸载 | PanelArea/Files/Terminal/Browser workspace tests、anchor tests；切 session/关开 dock 冒烟 |
| D7 | 最后抽 `AppShell`、`AppMainView`、`SessionPanelDock`，让 `App` 只做 hook 装配。 | `App.tsx:4101-4507`、新 components | 是，依赖 D1-D6 | 中；props wiring | `App*.test.tsx` 全集、narrow layout smoke、desktop renderer build、人工 chat/panel/settings 冒烟 |

每个 PR 都应以 `git diff --stat App.tsx` 明显净减行为为验收，但“行数下降”不是唯一 gate；更重要的是
每个 hook 只有一个状态域，且 subscription cleanup 可单测。不要先抽一个携带 50 个参数的
`useEverything()`，那只是换文件保存上帝组件。

## 5. 块四：用 versioned `goalLifecycle` 收口 Goal 持久化

### 5.1 当前 HEAD 盘点

设计基线文档固定在旧 commit `2082ebcd`；当前 `429867b1` 有少量后续修复，实施必须按当前事实：

| 证据 | 当前事实 | 债务/影响 |
|---|---|---|
| `types.ts:243-335` | `SessionState` 仍分别保存 `activeGoal?: GoalConfig` 与 `goalTerminal?: GoalTerminal`。 | active/terminal 是两个可冲突真相；waiting 没有持久化 phase。 |
| `engine/goal.ts:40-83` | `setAtMs` 同时做 deadline anchor；`GoalTerminal` 用 `objective + setAtMs` 当 identity。 | 同 objective restart、同毫秒替换和延迟回调都依赖脆弱复合 identity。 |
| `session-manager.ts:512-527` | `readActiveGoal` 通过 active 是否匹配 terminal 决定是否 armable。 | 读取语义需要跨字段拼装。 |
| `session-manager.ts:546-563` | disk-only clear 删除 active 后调用 whole-state `saveState`。 | clear 没有统一 terminal reason，也可能携带其他旧字段。 |
| `session-manager.ts:609-629` | 已有通用浅合并 `updateSessionState(partial)`。 | 比旧设计快照前进了一步，但 API 仍允许任意 `Partial<SessionState>`，不是领域边界。 |
| `session-manager.ts:631-681,1044-1053` | `saveState` 读磁盘，特殊合并 title/tombstone，保留较新 replacement goal，再 tmp + rename。 | 通用 writer 承担 goal 专属一致性协议；注释也承认跨 Engine/进程仍未解决。 |
| `engine.ts` 的运行时代码 | 非测试源码仍有 14 处 `sessionManager.saveState(...)` 调用；goal set/clear/forced terminal 多处直接改 state。 | detached/旧 snapshot 仍可能覆盖不属于该调用方的领域。 |
| `engine.ts:1693-1715,2243-2276` | late usage 与 first-turn title 已改用 `updateSessionState`。 | `goal-persistence-final-design.md:3.3` 对 title 的旧描述已部分过时；实现时应保留该修复，不重复返工。 |
| `engine.ts:2280-2314` | final run 仍整份写 status/turn/usage/cost。 | Goal cutover前必须拆成 run-owned update，避免 final save 携带旧 goal。 |
| `protocol/server.ts`、desktop fallback | GoalGet/Clear 保持外部 RPC，desktop main fallback 调 SessionManager。 | 外部 shape 可不变；内部需要统一 lifecycle predicate。 |

### 5.2 目标 schema 草案

采用设计文档的单字段、判别联合；`version` 放在持久对象上，未知版本 fail-closed：

```ts
type GoalTerminalReason =
  | "judge_met"
  | "complete_goal"
  | "cancel_goal"
  | "user_cleared"
  | "stop_blocks_exhausted"
  | "token_budget_exhausted"
  | "time_budget_exhausted"
  | "max_turns_exhausted";

type GoalLifecycleV1 =
  | {
      version: 1;
      goalId: string;          // 每次 explicit set/restart 都新建，建议沿用 nanoid seam
      phase: "active";
      config: GoalConfig;
      updatedAtMs: number;
    }
  | {
      version: 1;
      goalId: string;
      phase: "waiting";
      config: GoalConfig;
      updatedAtMs: number;
      waitingSinceMs: number;
      waitingFor: "finite_background_work";
    }
  | {
      version: 1;
      goalId: string;
      phase: "terminal";
      config: GoalConfig;
      updatedAtMs: number;
      terminal: { reason: GoalTerminalReason; atMs: number };
    };

interface SessionState {
  // ...existing fields
  goalLifecycle?: GoalLifecycleV1;
  // activeGoal / goalTerminal 只允许 legacy decoder 读取；新 writer 不输出。
}
```

不变量：

- `goalLifecycle` 是唯一权威；active/waiting armable，terminal 永不由 bare send/resume/wake 自动 arm。
- `goalId` 才是实例 identity；`setAtMs` 只保留相对 deadline anchor 语义。
- `SessionState.status` 与 goal phase 正交；manual Stop / `aborted_streaming` 不自动 terminal。
- waiting 不保存 task ID；background registry/notification queue 仍是短生命周期任务真相。
- terminal 保存完整 config/reason/time；下一个 explicit set 整体替换它，不保存无限历史。
- lifecycle 的未知 version、非法 phase/字段 fail-closed：不 arm、不 fallback 到 legacy、不自动覆写文件，并
  给出可诊断错误。

### 5.3 兼容读取与一次性迁移

读取优先级：

1. 合法 `goalLifecycle.version === 1` 唯一权威，忽略残留 legacy aliases；下一次领域写删除 aliases。
2. 没有 lifecycle 时，纯读取可派生 legacy view；最终切换后，真正 arm、clear 或任意 state domain
   write 前做一次同文件迁移。G3 的过渡 writer 在 G4-G6 尚未整体切换时只保留原样 legacy 字段，
   不提前删除旧 Engine 仍要读取的 `activeGoal`。
3. lifecycle version 未知或 schema 非法时 fail-closed；绝不回退到 `activeGoal`。
4. 三个字段都没有时为 no goal。

迁移矩阵：

| 旧 state | 新 lifecycle |
|---|---|
| 无 active、无 terminal | 不写 lifecycle |
| 只有 active | 新随机 ID，`active`，config 归一化 |
| active 与 terminal 的 `objective + setAtMs` 匹配 | 新随机 ID，`terminal`；config 来自 active，reason/time 来自 terminal |
| active 与 terminal 不匹配 | 新随机 ID，`active`；terminal 视作上一实例残留，不迁入当前 lifecycle |
| 只有 terminal | 新随机 ID，`terminal`；用 objective/setAtMs 构造最小合法 config |

迁移一次 tmp + rename 同时写 lifecycle并删除两个 legacy 字段。rename 前仍是完整旧 state，rename 后是
完整新 state；不双写 compatibility aliases。明确不支持旧 binary 与新 binary 同时写同一 sid，也不
支持同 sid 多进程 writer。

### 5.4 领域更新 API 形状

SessionManager 内部只保留一个 private 同步原语：

```ts
updateState<T>(sessionId: string, mutate: (latest: SessionState) => T): T
// validate sid -> read/decode/migrate latest -> 只改本领域 -> unique same-dir tmp -> rename
```

建议 public/internal 业务 API：

```ts
setGoal(sessionId, config): GoalLifecycleActiveV1
readArmableGoal(sessionId): ArmableGoalView | undefined
markGoalWaiting(sessionId, expectedGoalId): GoalTransitionResult
armGoal(sessionId, expectedGoalId): GoalTransitionResult
terminateGoal(sessionId, expectedGoalId, reason): GoalTransitionResult
clearCurrentGoal(sessionId): { changed: boolean; lifecycle?: GoalLifecycleV1 }

updateRunProgress(sessionId, patch: RunProgressPatch): SessionRunFields
completeRun(sessionId, patch: CompleteRunPatch): SessionRunFields
setTitle(sessionId, title): void
setSummary(sessionId, summary): void
setWorkspace(sessionId, workspace, cwd): void
resetUsage(sessionId, ...): void
recordCompactUsage(sessionId, ...): void
```

`expectedGoalId` 防的是同进程旧 run/延迟 callback 误伤新 goal，不宣称跨进程 CAS。每次 transition
返回 committed lifecycle，Engine 用它同步 live view；ID 不匹配即 no-op，旧 run 不得把 B 改回 A。
`updateSessionState(Partial<SessionState>)` 在过渡期可留作 deprecated internal adapter，最终业务源码
不能再调用任意 partial/whole-state writer。

### 5.5 Goal PR 序列

| PR | 一句话目标 | 主要影响文件 | 可独立合并 | 回归风险 | 必需测试/验证 |
|---|---|---|---|---|---|
| G1 | 先加入 lifecycle 纯类型、predicate、ID factory seam，不接运行路径。 | `engine/goal.ts`、`types.ts`、`goal.test.ts` | 是 | 低 | active/waiting armable；terminal 不 arm；reason 枚举；same objective 新 ID；setAtMs 非 identity |
| G2 | 加 strict decoder、legacy view 与显式 migration API，默认运行路径暂不切换。 | `session-manager.ts`、新 lifecycle test | 是 | 中；坏 state 被误覆写 | 五种 legacy fixture、valid wins、unknown/invalid fail-closed、迁移原子性、legacy 缺字段 |
| G3 | 建 private `updateState` 和非 Goal 领域 API，迁完剩余 run/title/usage/workspace whole-state call sites；过渡期原样保留 legacy goal 字段。 | `session-manager.ts`、`engine.ts`、workspace/usage/title tests | 是 | 中；计数或 workspace 字段漏写 | domain update permutations；late title/usage 不覆盖 goal；rename fault seam；14 处 saveState 清单逐项减少 |
| G4 | 把 set/replace/bare/resume 的 goal resolution 切到 `setGoal/armGoal` 与 immutable ID。 | `engine.ts`、goal/session manager、persistent goal tests | 否，建议与 G5/G6 stacked；过渡 adapter 必须保持旧路径绿 | 高 | explicit set、same/new objective replace、waiting resume、terminal pre-hook guard、A callback 不改 B |
| G5 | 统一四类 forced termination 为 `terminateGoal(expectedGoalId, reason)` 并 commit-before-event。 | `engine.ts`、`turn-loop.ts`、lifecycle tests | 否，依赖 G4 | 高 | stop/token/time/max-turn reason；terminal 后不重启 round 1；commit failure 不发成功事件 |
| G6 | 接 waiting、judge met、complete、confirmed cancel、user clear，Engine 成为唯一持久化责任方。 | `goal-stop-hook.ts`、`turn-loop.ts`、`engine.ts`、cancel/clear tests | 否，依赖 G4/G5 | 高 | 真后台 work -> waiting；假 waiting 继续；四种非 forced reason；manual/unconfirmed 保 active；clear 顺序 |
| G7 | 保持 RPC shape，切 GoalGet/Clear、notification wake、worker restart 和 desktop fallback。 | `protocol/server.ts`、`chat-session.ts`、desktop main fallback、host tests | 是，依赖 G4-G6 | 中到高 | disk/live get/clear 幂等；wake 一次；terminal notification 不 arm；三 phase restart |
| G8 | 删除 legacy writer/tombstone merge/direct mutations，并加静态守卫与文档更新。 | `types.ts`、`goal.ts`、`session-manager.ts`、`engine.ts`、architecture docs | 是，依赖前序 | 中；漏掉隐藏 writer | 新 state 无 legacy 字段；runtime 无 public whole-state save；无 CAS/lock/sidecar；core goal suite + full core test |

G4-G6 是同一次行为切换的 stacked PR：每个分支可 review，但不应把“部分事件已写 lifecycle、其余仍直改
legacy 字段”的中间态发布。若团队只接受每个 PR 单独发布，则把 G4-G6 合成一个 PR，在 PR 内按测试
commit 顺序完成。

### 5.6 TDD 清单（落到具体测试文件）

Goal 核心：

- `engine/goal.test.ts`：phase predicate、完整 terminal reason、随机 ID seam、anchor/identity 解耦。
- 新 `session/session-manager.goal-lifecycle.test.ts`：迁移矩阵、合法 lifecycle 优先、unknown version、
  非法 phase、corrupt JSON、rename 前/后 fault。
- 新 `session/session-manager.state-domain-update.test.ts`：title、heartbeat/final run、usage reset、compact、
  workspace、goal transition 的排列组合互不覆盖。
- 反转 `session-manager.cleargoal-stale-writeback.test.ts` 的 BUG 断言：旧 snapshot 永不复活 goal。
- `turn-loop-goal-lifecycle.test.ts`：set/arm/四类 forced/waiting/commit-before-event/A-B identity。
- `hooks/goal-stop-hook.test.ts`：真实 finite background work 才允许 waiting；judge 失败继续并受预算兜底。
- `server.goalget.test.ts` / `server.goalclear.test.ts`：active/waiting/terminal、live/disk-only、幂等。
- `engine-goal-cancel` / persistent/background integration：judge met、complete、confirmed/unconfirmed cancel、
  manual Stop、notification wake、worker restart。
- 静态 guard：运行期业务不直接 `saveState`；新 writer 无 legacy aliases；不存在 revision/CAS/watermark/
  goal lock/sidecar/journal。

P2 邻接边界（与 Goal schema 无逻辑耦合，但列入本轮完成矩阵）：

- `automation/cron-expr.test.ts` 当前只覆盖 UTC/上海、weekday 和 DOM/DOW OR
  （`:55-130`），未覆盖 DST/闰日。补固定时区用例：
  - `America/New_York` 2026 春季跳时：`30 2 * * *` 从切换前返回
    `2026-03-09T06:30:00Z`，明确“不存在的本地分钟跳过”；
  - 2026 秋季回拨：`30 1 * * *` 先返回 `05:30Z`，从第一次命中后再算返回 `06:30Z`，把当前
    “重复 wall-clock 分钟触发两次”行为锁成 characterization；若产品要求 at-most-once，应另开语义 PR；
  - `0 0 29 2 *` 从 2027-03-01 返回 2028-02-29；`0 0 30 2 *` 在搜索窗口内返回 `null`；
  - 月末 31 日跨短月、恰好命中时仍严格返回未来分钟。
  这些期望已在当前 HEAD 用只读 `bun -e` 调用核实，不是推测。
- 文档措辞：`docs/architecture/00-overview.md:59-75` 与 v2 文档已经明确 protocol 例外；
  `docs/architecture/04-protocol-and-sessions.md:7-11` 虽已限定“interactive hosts”，仍应补一句 SDK/
  `asyncAgentRegistry`/测试可直接 Engine，避免再次被概括成硬不变量。Goal 切换后同步把该文档
  `:91` 的“single persistent activeGoal”改成 versioned `goalLifecycle`，并更新 long-running 图文。

## 6. 跨块依赖与并行策略

### 6.1 硬依赖

1. `extractJSON -> utils/json.ts` **已完成**，它是 Arena 移包的已满足前置。
2. I1 public/internal subpath 应先于 A4 Arena 移包；`packages/arena` 只能依赖 core 稳定入口或明确
   extension contract。
3. A1/A2 可选注册应先于 A4；否则 core 仍需静态 import 新 Arena 包，形成反向依赖。
4. A3 必须在删除 core Arena schema/RPC 前完成 legacy settings 与 query ownership 迁移。
5. Goal 内部顺序必须是 model/decode -> domain writer -> Engine transitions -> host -> cleanup。

### 6.2 可并行但应避开文件冲突

- App D* 与所有 core 工作完全独立，可并行。
- Goal G1-G8 与 Arena 在语义上独立；A1 与 G1 都可能改 `engine/types.ts`/public index，建议串行落地或
  提前约定 export 区域。
- I2 的 TUI import 机械迁移与 A4 的 TUI Arena import 搬包会冲突；先 I2，后 A4。
- Cron test 和 protocol 文档措辞是独立小 PR；文档里的 `activeGoal -> goalLifecycle` 更新必须等 G8。

### 6.3 建议合并车道

```text
车道 1（低风险边界）：I1 -> I2 -> I3
车道 2（Arena）：      A1 -> A2 -> A3 -> A4/A5 -> A6(next major)
车道 3（Goal）：       G1 -> G2 -> G3 -> G4/G5/G6 -> G7 -> G8
车道 4（Desktop）：    D1 -> D2 -> D3 -> D4 -> D5 -> D6 -> D7
独立伴随：             cron DST/闰测试；protocol 文档措辞
```

Core PR 的共同 gate：定向测试、`bun test`、`bun run typecheck` 无新增相关错误、
`bun run lint:engine-bypass`、`bun run build`。Desktop PR 额外跑 renderer tests/build，并对 chat、并发
session、Stop/steer、panel close/reopen、settings 做人工 smoke；不能用旧 bundle 验收。

## 7. 风险排序与下一轮优先级

| 块 | 收益 | 主要风险 | 建议顺序 |
|---|---|---|---|
| public/internal export | 立即把稳定 SDK 与宿主实现分开，为 Arena 移包铺路 | import/exports 漏项，易由编译发现 | **第 1** |
| Arena 可选/移包 | core harness 纯度和包边界收益大 | 产品 composition、settings/RPC 兼容、跨包循环 | 第 2（先 A1/A2，移包后置） |
| Goal lifecycle | 消除真实 stale-write/复活风险，领域模型收益最高 | 持久化迁移、事件顺序、恢复链路，风险高 | 第 2/3，单独 worktree 严格 TDD |
| App.tsx 拆分 | 长期 UI 可维护性明显提升 | stream/steer/panel 竞态，行为测试不完全 | 可独立并行；先 D1/D2，D4/D5 慢走 |

下一轮最适合先做 **I1：增加 `/internal` subpath 与兼容 re-export**。理由：它不改变运行时行为，失败
大多能被声明生成、typecheck 和 build 直接发现；收益是立即建立后续 Arena/宿主迁移需要的包边界，
且不必碰 Goal 持久化或 renderer 竞态。完成 I1 后再做 I2 的仓内 import 迁移；不要在第一个 PR 就删除
根入口 aliases。

**一句话结论：下一轮 codex 应先实现 public/internal export 分层的 I1（新增 `/internal` 且保留兼容 re-export），因为它风险最低、验证最确定，并直接解除 Arena 后续可选注册与移包的入口阻塞。**
