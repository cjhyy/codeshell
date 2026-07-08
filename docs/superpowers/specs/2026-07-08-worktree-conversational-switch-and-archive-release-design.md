# Worktree: 对话切换 (bridge 工具) + 归档释放占用

日期：2026-07-08
分支：`test/worktree-demo`
状态：设计已确认（路线 2），待实现

## 背景（经实机复现验证）

桌面端"对话进入 worktree"实际上是坏的。复现脚本（core dist + 真实 git repo）证明：

1. `EnterWorktree`/`ExitWorktree` 在 `terminal-coding` preset 里（`preset/index.ts:130-131`），是 desktop 默认 preset（`settings/schema.ts:56`），**模型看得到**。
2. 工具切换 workspace **能落盘**（`SessionManager` 写 `~/.code-shell/sessions/<id>/state.json`，`session-manager.ts:134,242`），一个全新 `SessionManager` 实例（模拟 main/UI 独立读盘）**能读到切换后的 worktree** —— 所以"worker 直连 main 读不到"的旧理论是错的。
3. **真正的三个 bug**：
   - a) 工具依赖 `ctx.engine.readWorktreeSetupScripts` / `readWorktreeBranchPrefix` / `resolveWorktreeSetupSandbox` 等方法；desktop worker 的 engine 未实现全 → 工具**中途抛错**（复现中报 `ctx?.engine?.readWorktreeSetupScripts is not a function`），切一半、setup 不跑。
   - b) workspace 切了但 `readCwd` 仍是旧路径 —— **cwd 当轮不跟随**（同轮 cwd 固定 `engine.ts:1300`，下轮才 follow `engine.ts:945,972`）。
   - c) 切换是**静默的** —— 无事件通知 desktop main/UI 刷新 `WorkspaceIndicator`，UI 看起来没反应。

三者叠加 = 用户"用了像没用"。此外一个相关缺陷：归档 session 仍占用 worktree（archive 是 renderer-only localStorage 概念，引擎侧 workspace 绑定不释放）。

## 决策（路线 2）

**不修补旧 EnterWorktree**（会留两套切换逻辑，且要给 worker 补齐一堆 engine.* 方法）。改为：让模型的 worktree 切换走**与 UI 手动切换完全相同的一条路径**——桌面 bridge。这一次性消除 a/b/c 三个 bug（同路径天然刷新 UI、天然 cwd-follow、天然一致）。归档释放占用（B）共用同一条 bridge/IPC + service，并入本 spec 一起做。

## 参考：现成的 bridge 模式（照抄）

`__browser_action__`（浏览器自动化）和 `__credential_action__`（InjectCredential）已经用了完全相同的跨进程套路：
- core `AgentServer` 把某个隐藏工具动作路由成一个跨进程请求（`protocol/server.ts:464,1975` BrowserBridge 构建）。
- desktop `AgentBridge` 拦截该请求行、在 main 进程执行、回填结果（`agent-bridge.ts:173-176,364,403` + `browser-driver/intercept.ts`）。

新工具照这个模板加一条 `__workspace_action__` 通道。

## Part A — 对话切换 worktree（bridge 工具）

### 模型可见工具契约
- 名称：`SwitchSessionWorkspace`
- 入参：`{ target: string }` —— `"main"` | 新 slug | 已存在 worktree 的 path | 分支名。
- 结果：返回切换后的当前 workspace（root/kind/branch）+ 一句"下一轮起 cwd 生效"的说明。
- 权限：`permissionDefault: "ask"`，串行（不并发切换）。
- 描述要写出**使用动机**（解决复现里"模型没 salience 用它"的问题）：明确"当需要在隔离分支/worktree 里并行开发、或结束后切回 main 时使用；这是让当前对话会话进入/离开 worktree 的唯一正确方式"。

### 数据流（desktop）
```
model → SwitchSessionWorkspace tool (core)
  → AgentServer 发出隐藏 __workspace_action__（跨进程，带 sessionId + target）
  → AgentBridge 拦截（agent-bridge.ts，参照 __browser_action__ 分支）
  → 调用 switchSessionWorkspaceForUi(sessionId, cwd, target)   ← 与 UI 手动切换同一函数
  → 结果回填给工具；main 广播 workspace-changed → 渲染层刷新 WorkspaceIndicator
```

### 关键实现点
- core：在 `ToolContext` / engine 上加一个**窄接口** `switchWorkspace(target)`（类似 BrowserBridge），只在 desktop 注入实现；TUI/其它 preset 无此 bridge 时工具不可用或回退到旧 core 实现（见下"preset 处置"）。
- desktop worker（`agent-server-stdio.ts`）：为 `AgentServer` 提供 workspace bridge，emit `__workspace_action__`。
- desktop main（`AgentBridge`）：拦截并调 `switchSessionWorkspaceForUi`（`session-workspace-service.ts:118`），复用其 `setSessionWorkspace` + `recordWorkspaceHandoff`（`:161-162`）。
- **UI 刷新**：切换成功后，main 通过既有的 renderer 通知通道（参照 workspace list 的推送/或发一个 `workspace:changed` 事件）让 `WorkspaceIndicator` re-fetch。
- **cwd-follow**：确认切换后写入的 workspace 会被下一轮 `Engine.run` 的 cwd-follow 读到（`engine.ts:945,972`）——bridge 走 service 持久化到同一 state.json，故自动成立；加测试固化。

### preset 处置（与旧工具的关系）
- 在 **desktop 上下文**用新的 `SwitchSessionWorkspace` 取代旧 `EnterWorktree`/`ExitWorktree`：desktop worker 显式隐藏/不注册旧的两个（避免双份、避免旧的 `ctx.engine.*` 抛错路径）。
- 非 desktop（TUI 等）保持旧工具不变（它们的 engine 实现全，旧路径可用）。
- 这样也让 spec `2026-07-07-...:95` 那条"desktop 不要旧 EnterWorktree"的非目标得到真正落地（用更好的替代，而非留空）。

## Part B — 归档释放 worktree 占用

### 现状链（已确认）
- 占用：`listSessionWorktreesForUi → workspaceOwners(sm) → SessionManager.list(10_000) → ownersForWorktree`（`session-workspace-service.ts:39,111,122`；`query.ts` owners 比对 workspace.root）。`list()` 扫全部磁盘 session，**无 archive 概念**（`session-manager.ts:544`）。
- 归档：renderer-only，`archiveSession`/`archiveAllSessions` 翻 `archived:true`（`transcripts.ts:620-653`），**不碰引擎侧 state.json / workspace 绑定**。

### 设计：归档时释放引擎侧 workspace 绑定
- 新增 IPC：`workspace:release` / `workspace:releaseMany`（sessionId(s)）。main 侧对每个 session 复用 `mainRootFor` 求主根，`setSessionWorkspace({root: mainRoot, kind:"main"})` + `recordWorkspaceHandoff`。
- renderer：在触发归档处（单个 archive、archive-all、删项目 archive）先解析引擎 id（`engineSessionId ?? id`），调 release，再本地标 `archived`。
- **活跃 session**：若被归档的是当前在 worktree 里活跃跑的 session，仅写盘可能被内存 engine 态覆盖（同 goals 的 stale-write，`engine.ts:412,2790`）→ 加一条 worker RPC（参照 `agent-bridge.ts:573` closeSession 模式）让活跃 engine 内存态也重置回 main。
- **多 owner**：一个 worktree 被多个 session 绑定时，只释放被归档的那个；其余仍占用（测试固化）。

## 测试（TDD，先写后实现）

Part A：
- bridge 请求解析 + 回填（`__workspace_action__` round-trip）。
- 切换走 `switchSessionWorkspaceForUi` 同一路径（断言 setSessionWorkspace + handoff 被调）。
- 切换后下一轮 cwd 跟随到 worktree。
- 切换成功发出 UI 刷新事件。
- desktop worker 不再暴露旧 `EnterWorktree`/`ExitWorktree`；非 desktop 仍有。
- 目标为 `"main"` 时切回主仓。

Part B：
- release 后该 owner 从占用列表消失。
- 多 owner：只释放被归档者，其余仍占用。
- 归档当前活跃 worktree session → 引擎态回到 main（不被覆盖）。
- archive-all / 删项目 → releaseMany 被调。
- 对已在 main 的 session release 幂等（无副作用）。

## 非目标 / 约束
- 不给核心加 `archived` 概念（archive 是 UI 概念）；只加"释放绑定"IPC。
- 不改 worktree 的 3 态清理、per-session 绑定语义。
- renderer 不 runtime-import core（走 window.codeshell.* / IPC）。
- core 不 import tui。
- 不 push、不合并 main；改动留在 `test/worktree-demo`。

## 验证门槛（DoD）
- `bun run build` / `bun run typecheck`（不新增错误）/ 改动文件 `bun run lint` 干净。
- `bun test` 零新增失败（基线：1 fail + 1 error 是既有并发 flake）。
- 实机（可选）：desktop dev 里对话调用 `SwitchSessionWorkspace`，UI 切换器实时反映；归档一个占用 worktree 的 session 后，切换器该 worktree 不再"占用中"。
