# 审查面板未暂存内容取错 session workspace

## 1. 问题与现状

当前右侧 dock 按“repo + UI session”建立 bucket，但给面板下发 cwd 时只解析了 repo，没有解析该 session 实际绑定的 workspace。

- `packages/desktop/src/renderer/App.tsx:248-255` 的 `parsePanelBucket()` 本来同时返回 `repoId` 和 `sessionId`。
- 渲染每个 bucket 时，`App.tsx:4123` 只解构 `repoId`，随后 `:4138` 固定传 `cwd={panelRepo?.path ?? null}`。因此 session 已切到 git worktree 时，dock 仍拿项目登记的主仓库路径。
- 同一处却在 `App.tsx:4161` 已正确计算 `resolveEngineSessionIdForBucket(panelBucket)`，说明获取 workspace 所需的 engine session ID 并不缺失，只是没有参与 cwd 解析。
- `PanelArea.tsx:452-469` 将这个 cwd 原样交给 PanelRegistry；`PanelRegistry.ts:106-112` 再传给 `ReviewPanel`。
- `ReviewPanel.tsx:47-95` 的 branch base/commit 查询以及 `:226-257` 的所有 diff scope 都依赖 cwd。
- `UnifiedDiffViewer.tsx:49-73` 最终执行 `window.codeshell.getGitDiff(cwd, ...)` 或 `getGitRangeDiff(cwd, ...)`，所以“未暂存/已暂存/全部未提交”实际在主仓库执行。
- main 的 git service 并不知道 session：`packages/desktop/src/main/index.ts:3233-3238` 的 `git:diff` 只收 cwd，`packages/desktop/src/main/desktop-services.ts:81-87` 的 `gitRun()` 直接把该 cwd 交给 git 子进程。这里不是 git diff 计算错误，而是调用方给错根目录。

正确的 workspace 解析链已经存在：

- core `packages/core/src/session/session-manager.ts:253-271` 的 `getSessionWorkspace(sessionId)` 从 session state 读取 `{ root, kind }`，并兼容旧 session 的 `state.cwd`。
- desktop `packages/desktop/src/main/session-workspace-service.ts:163-170` 的 `getSessionWorkspaceForUi(sessionId, cwd)` 在 main 侧解析 main root 并提供 fallback。
- preload `packages/desktop/src/preload/index.ts:652-653` / `types.d.ts:679` 暴露 `window.codeshell.getSessionWorkspace()`。
- `WorkspaceIndicator.tsx:176-195` 已按 `sessionId + repoPath` 获取 current workspace；`:325-333` 监听 `workspace:changed` 并只刷新匹配 session。该实现是本功能应复用的行为基准。
- workspace change 可能来自 worker bridge（`packages/desktop/src/main/agent-bridge.ts:641-657`）或 desktop workspace IPC；main 的广播函数位于 `main/index.ts:318-325`。

同一错误 cwd 还影响另外两个面板：

- Files：`PanelRegistry.ts:64-76` 把同一个 cwd 交给 `FilesPanel`；`FilesPanel.tsx:181-190` 以它作为树根，`:218-219` 也以它解析预览。
- Terminal：`PanelRegistry.ts:114-121` 把同一个 cwd 交给 `TerminalPanel`；`TerminalPanel.tsx:77-80` 用它启动 PTY。不过 Terminal 明确只在首次 spawn 捕获 cwd，effect 只依赖 sessionId（`:31-37`、`:119-123`），所以 workspace 运行中切换不能简单靠 prop 更新迁移已有 shell。

## 2. 目标

- Review 的所有 git-backed scope 都使用当前 panel bucket 对应 engine session 的 `SessionWorkspace.root`。
- session workspace 发生切换、detach、discard 或 worker 发出 `workspace:changed` 后，只有匹配 session 的 panel bucket 更新并重新拉取 diff。
- main repo fallback、旧 session、无 repo draft 和 workspace 解析失败均有明确降级，不让面板卡死或使用另一个 session 的 workspace。
- 同一 bucket 下 Files 使用相同解析后的 root；Terminal 首次创建时使用解析后的 root，并明确处理“已有 PTY 不可无损迁移”的语义。
- turn snapshot (`reviewDiff`) 仍保持快照语义，不因 workspace 更新重新生成；只更新文件打开/评论所依赖的 cwd。

## 3. 详细修改方案

### 3.1 选择的总体方案：每个 PanelArea 统一解析 workspace

采用“renderer 请求、main 解析”的现有 `workspace:current` 路径，而不是让 Review 自己拼路径，也不为每种 git 查询新增 session-aware IPC：

1. App 将 `repoPath` 和该 bucket 的 `engineSessionId` 明确传给 PanelArea；
2. 每个 PanelArea 通过新 hook 请求 main 的 `getSessionWorkspaceForUi()`；
3. PanelArea 将返回的 `workspace.root` 作为唯一 `cwd` 交给所有 panel body；
4. hook 监听 `workspace:changed`，匹配 session 后重新向 main 读取。

解析仍发生在 main，保留 SessionManager 的 fallback 和路径规范；renderer 只缓存结果。这比只修 ReviewPanel 多覆盖了 Files，同时保持现有 git IPC 简单。若未来要抵御 renderer 到 git 执行之间极短的 workspace 切换竞态，可再把 `{sessionId, fallbackRepoPath}` 下沉到 git IPC，但不是本 S 级修复的必要条件。

### 3.2 App：不再丢失 bucket session

修改 `packages/desktop/src/renderer/App.tsx:4120-4162`：

- 解构完整 bucket 信息：

  ```ts
  const { repoId: panelRepoId, sessionId: panelUiSessionId } = parsePanelBucket(panelBucket);
  const engineSessionId = resolveEngineSessionIdForBucket(panelBucket) ?? null;
  ```

- 将原 `cwd` prop 重命名为语义清楚的 `repoPath`，同时把 `engineSessionId` 只计算一次后传入 PanelArea。
- `panelUiSessionId` 主要用于测试/诊断；workspace 查询必须使用 `engineSessionId`，因为 main SessionManager 以 engine session state 为准。不能假设 UI session ID 永远等于 engine ID。
- no-repo bucket 继续传 null；其 panel availability 不应伪造一个项目 workspace。

避免在 `panelBuckets.map()` 内直接调用 hook（会违反 hooks 调用顺序）。workspace hook 放进每个稳定挂载的 `PanelArea`，或抽出一个 `PanelBucketHost` 组件再在其中调用。

### 3.3 新增 usePanelWorkspaceRoot hook

建议新增 `packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts`：

```ts
interface PanelWorkspaceState {
  root: string | null;
  kind: "main" | "worktree" | null;
  ready: boolean;
  error?: string;
}

usePanelWorkspaceRoot(engineSessionId: string | null, repoPath: string | null): PanelWorkspaceState
```

行为要求：

- 无 repo：立即返回 `{ root: null, kind: null, ready: true }`。
- repo 但无 engine session（尚未发送的 draft）：立即以 repoPath 作为 main workspace，`ready: true`。
- 两者都有：先标记 `ready: false`，调用 `window.codeshell.getSessionWorkspace(engineSessionId, repoPath)`；成功后采用返回的 root/kind。
- 请求失败：记录错误并降级 `{ root: repoPath, kind: "main", ready: true }`。不要沿用上一个 session 的 root。
- 使用 request sequence/target key 防止异步串台。`WorkspaceIndicator.tsx:148-159`、`:176-195` 已展示可复用的 stale-response guard 模式。
- 订阅 `window.codeshell.onWorkspaceChanged()`；仅当 `event.sessionId === engineSessionId` 时刷新。即使 event 带 workspace，也建议重新调用 current IPC，让 main 统一做旧 session/fallback/规范化。
- unmount 或 target key 变化时使旧请求失效并退订 listener。

`ready` 很重要：如果先用 repoPath 乐观渲染 Terminal，它会在 workspace 查询返回前启动一个永久绑定主仓库的 PTY；Review 也会先闪现错误仓库的 diff。已有真实 session 时应显示短暂 loading，而不是执行错误动作。

### 3.4 PanelArea / PanelRegistry：统一使用 resolved root

修改 `packages/desktop/src/renderer/panels/PanelArea.tsx`：

- Props 的 `cwd` 改为 `repoPath`；组件顶部调用 `usePanelWorkspaceRoot(engineSessionId, repoPath)`。
- `PanelAvailabilityContext` 和传给 `PanelBody` 的 cwd 使用 `workspace.root`。
- 在 `ready === false` 时，Files/Review/Terminal/CCRoom 等 cwd-sensitive body 渲染轻量 loading；Browser 和 BackgroundShell 可继续挂载，但为了保持 registry 合同简单，首版可统一等待。
- 将 workspace kind/ready 也放入 `PanelRenderContext`，方便 Terminal 呈现切换提示；不需要暴露 SessionWorkspace 的其他数据。

修改 `packages/desktop/src/renderer/panels/PanelRegistry.ts`：

- Review、Files、CCRoom 获得 resolved cwd。
- Terminal 仅在 workspace ready 后创建，避免错误首启。
- Browser 的 `cwd` 当前只是预留字段（`BrowserPanel.tsx:44-46`），改用 resolved root 不改变行为。
- QuickChat 当前从 PanelArea cwd 派生运行目录，也应使用 resolved root；否则 dock 修复后 quick chat 仍会在主仓库运行。

### 3.5 ReviewPanel / UnifiedDiffViewer：workspace 变化后的状态重置

`UnifiedDiffViewer.tsx:49-73` 的 effect 已把 cwd 放在依赖中，resolved root 变化后会自动重新查询，不必改变 IPC shape。需要补两点状态卫生：

- 发新请求前 `setError(null)`、`setDiff(null)`，避免 workspace 切换期间继续展示旧 worktree diff。
- 保留 cancelled guard，旧 cwd 响应不得覆盖新 cwd。

`ReviewPanel.tsx` 还缓存了 cwd 相关状态：

- `commits` 在 `:71-72` 只首次加载，cwd 改变后不会自动清空；增加 `[cwd]` effect 重置 `commits`、`selectedCommit`、`range`、`stats`。
- scope 可保持用户选择；若旧 selected commit 不属于新 worktree，清空后会回到该 scope 默认 `HEAD~1..HEAD`。
- `turnDiff` 是来源 turn 的权威快照（`:29-35`），不重新调用 git。cwd 更新只影响 diff 内“打开文件”动作所使用的根目录（`UnifiedDiffViewer.tsx:120-125`）。
- `getGitBranchBase`、recent commits、range diff 全部自然接收新 root。

### 3.6 Files 面板审计与修正

Files 使用统一 resolved root 后，目录树查询会切到 worktree。但组件可能仍持有旧根下的绝对 `selected`：

- 在 `FilesPanel` 增加 root change effect；当 `selected` 不在新 root 下时清空 `selected` 和 `revealDirs`，并递增 reload nonce。
- `revealFile` 的路径继续相对 resolved cwd 解析（当前 `FilesPanel.tsx:138-150`），这样 session worktree 内的聊天路径链接会打开正确文件。
- 不复用 `revealFile.cwd` 作为树根；它是事件来源提示，不应覆盖 session workspace 的唯一真值。

### 3.7 Terminal 面板审计与明确语义

Terminal 的错误分两种：

1. **在 worktree session 中首次打开却从主仓库启动**：由 `ready` gate + resolved root 修复。
2. **PTY 已启动后 session 切换 workspace**：当前组件有意不因 cwd prop 变化重建（`TerminalPanel.tsx:31-37`、`:119-123`），强行自动迁移会杀进程并丢 scrollback。

建议首版采用透明、无破坏的行为：

- Terminal 捕获并展示实际 `spawnCwd`，不要在 prop 更新后把 header 改成新 root 而让用户误以为 shell 已迁移。
- 当 `workspace.root !== spawnCwd` 时显示提示：“workspace 已切换；此终端仍在旧目录。新建终端以使用新 workspace。”
- PanelArea 的 `+ Terminal` 会产生新 tabId（`PanelArea.tsx:168-172`），新 tab 使用新 resolved root 启动，旧 PTY 保持可用。
- 若产品必须提供一键迁移，可另加“在新 workspace 重启”按钮：显式 `ptyKill(oldSessionId)`，递增 terminal generation 并创建新 PTY；不得在后台静默执行。

这既修正错误 cwd，又尊重现有“PTY/scrollback 跨面板切换存活”的设计。

### 3.8 Main / IPC

首版无需新增 IPC：

- `workspace:current`（`main/index.ts:3125-3132`）已经完成输入验证和 main-side 解析；
- `workspace:changed` 已有订阅；
- git diff/range/commits/branch base 继续收 resolved root。

可选防御性增强：为所有 git handler 增加 cwd 存在且为目录的统一校验/日志，并在日志中记录 engine session ID（由 renderer 单独传 diagnostic 字段），但不要同时保留两个相互冲突的 cwd 来源。

## 4. 分步骤实施顺序

1. 新增并单测 `usePanelWorkspaceRoot`，覆盖 main/worktree/fallback、stale response 和 workspace event。
2. App 改为传 `repoPath + engineSessionId`，PanelArea 接入 hook 和 ready gate。
3. PanelRegistry 全面改用 resolved root，先确认 Review/Files/QuickChat/CCRoom 的 prop 链。
4. 修正 UnifiedDiffViewer 和 ReviewPanel 在 cwd 变化时的 loading/error/cache 状态。
5. 修正 FilesPanel 的旧绝对 selection 清理。
6. 为 Terminal 增加实际 spawn cwd 与 workspace-changed 提示，确认新 tab 从新 root 启动。
7. 添加回归测试，最后进行两个 worktree 各自有不同未暂存内容的手工验证。

## 5. 测试策略

### Hook / 组件单测

- `usePanelWorkspaceRoot.test.tsx`：
  - engine session + repoPath 调用参数准确；
  - 返回 worktree root；
  - repo draft 不发 IPC并使用 main root；
  - A 请求晚于 B 返回时不能覆盖 B；
  - 只响应匹配 session 的 `workspace:changed`；
  - IPC reject 回退 repoPath且不保留旧 session root；
  - unmount 正确退订。
- PanelArea/PanelRegistry 测试：workspace 未 ready 时不创建 Terminal/Review；ready 后所有 cwd-sensitive panel 获得同一 root。
- ReviewPanel 测试：cwd 改变会清空 commits/selected commit 并触发新 diff；旧 promise 晚返回不覆盖新 diff；turnDiff 不触发 git 查询。
- FilesPanel 测试：root 从主仓库切到 worktree 后清理旧绝对 selection，新的 reveal 在 worktree 下解析。
- TerminalPanel 测试：首次 `ptyStart` cwd 为 worktree；prop root 改变不杀旧 PTY、header 仍显示 spawn cwd并出现提示；新 tab 使用新 root。

### Main/service 测试

- 复用并扩展 `session-workspace-service.test.ts`：legacy session fallback、worktree state、未知/损坏 session 的行为保持稳定。
- IPC contract 测试确认 `workspace:current` 输入验证与 `workspace:changed` payload 的 sessionId 不变。

### 端到端回归场景

1. 主仓库和 session worktree 分别制造不同的 unstaged/staged 文件。
2. 打开该 session 的 Review，逐个切换“未暂存/已暂存/全部未提交”，确认只显示 worktree 内容。
3. 在 WorkspaceIndicator 切回 main，保持 Review 打开，确认 loading 后 diff 切换且旧结果不闪回。
4. 切到另一个 session，确认隐藏 bucket 仍绑定自己的 workspace，不响应当前 session 的 change event。
5. Files 树、文件预览和 review 中“打开文件”均落在同一 root。
6. worktree session 首次新建 Terminal，执行 `pwd` 应是 worktree；再切 workspace，旧终端显示提示，新 terminal 的 `pwd` 是新 root。
7. 旧 session（无 workspace 字段）仍使用 state.cwd/main repo。

## 6. 风险与兼容性注意

- **React hook 位置**：不能在动态 `panelBuckets.map()` 中直接调用 hook；必须放进 PanelArea 或独立 child component。
- **首次异步解析竞态**：不能先用 repoPath 启动 Terminal 再更新 prop；已有 session 要等待 current workspace 返回。
- **UI session 与 engine session 不一定相同**：workspace IPC 使用 `resolveEngineSessionIdForBucket()` 的结果，bucket parse 的 sessionId仅用于 UI 路由/诊断。
- **隐藏面板仍挂载**：PanelArea 为保活 webview/PTY会一直挂载。每个 bucket 的 listener 必须按 session 过滤并在卸载时清理，避免所有 hidden panel 对一次 event 发起错误刷新风暴。
- **Review 快照与 live git 的区别**：`turnDiff` 不应被 workspace change 改写；live scopes 才重新查询。两者的 cwd 都要用于正确打开文件。
- **Terminal 不可假装迁移**：更新 header cwd 而不重启 PTY会制造更隐蔽的问题。显示实际 spawn cwd，迁移必须由用户显式触发。
- **路径大小写/符号链接**：workspace root 采用 main 返回值，不在 renderer 手工 realpath。Files 的“是否仍在 root 下”应复用现有安全路径 helper，兼顾 Windows 分隔符/大小写。
- **错误降级**：workspace IPC 失败时回退该 bucket 自己的 repoPath；绝不能回退全局 activeRepo，也不能沿用前一个 bucket root。
