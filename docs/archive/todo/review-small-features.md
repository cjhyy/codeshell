# 小 feature 批次代码审查报告

审查范围：`2dc55764..17e186a9` 共 9 个 commit。审查依据为 `docs/archive/todo/plan-overall-small-features.md`、`plan-group-a-core.md`、`plan-group-b-compaction-ui.md`、`plan-group-c-worktree-panels.md`。

## 1. 总体结论

当前不建议直接合入/推送：有 2 个 🔴 阻塞项，均为本批测试代码引入的 TypeScript 编译错误。C-5 worktree 自动清理的数据安全护栏未发现会静默删除 dirty/unmerged 数据的漏洞。

阻塞项数：2 个 🔴。建议项：4 个 🟡。可选项：2 个 🟢。

## 2. Commit 审查

### 2dc55764 fix(desktop): guard stale worktree cleanup against dirty/unmerged deletion

结论：数据安全目标基本落实。删除前有 dirty/status 检查、base ref 解析、`rev-list <base>..<branch>` 未合并提交检查；`fs.rm(force)` fallback 已删除；`worktree remove` 失败会记录 `remove_failed` 并保留目录；branch 删除改为安全的 `branch -d`。

发现：

- 🟡 `packages/desktop/src/main/desktop-services.ts:482`：`git branch -d` 失败被静默吞掉，调用方只看到 worktree 已 removed，无法知道残留了一个托管分支。修法：对 branch 删除失败增加日志，或扩展 result 加 `branch_delete_failed`/`branchKept` 之类的非破坏性记录；不要升级为 `-D`。
- 🟢 测试覆盖了 clean merged、dirty、untracked、ahead、base_unknown、remove_failed、external/detached；还可补一个 `branch -d` 失败只保留分支的用例，以及 preload/renderer skip toast 的轻量测试。

### fcecac75 test(core): cover TodoWrite resume snapshot restore

结论：功能测试覆盖点符合方案：latest snapshot、invalid filtering、all completed、engine resume replay 都有覆盖。

发现：

- 🔴 `packages/core/src/engine/engine.todo-resume.test.ts:73`、`:105`、`:132`：`onStream: (event) => events.push(event)` 返回 `number`，不符合 `StreamCallback` 的 `void | Promise<void>`，导致 `bun run typecheck` 失败。修法：改成 block body：`onStream: (event) => { events.push(event); }`。

### 294ef31a feat(core): scan .agents/skills as project skill base

结论：实现符合方案。base 顺序为 `.code-shell/skills` -> `.agents/skills` -> user `.code-shell/skills`，source 保持 `"project"`，mtime cache 自动覆盖新 base。测试覆盖发现、shadow 和 memoize invalidation。

发现：未发现需要修改的问题。

### f781b07c feat(core): annotate prompt-token estimate source/confidence

结论：实现符合方案。`StreamEvent` 新字段为 optional，`checkLimits()` 增加 source/confidence 但未改阈值默认值或压缩 gate 数值；engine 首帧复用 `ContextManager` 估算；turn-loop 区分 provider/high、heuristic/low、calibrated/medium。

发现：

- 🔴 `packages/core/src/engine/turn-loop-usage-cache.test.ts:173`、`:192`：新增测试同样使用 `onStream: (e) => events.push(e)`，返回 `number`，导致 `bun run typecheck` 失败。修法同上，改为 block body。

### 25990f12 feat(desktop): compact in-flight UI + fix context ring baseline

结论：B-1/B-2 关键语义正确。`compactingBuckets` 没合并进 `busyKeys`；重复 `/compact` 由 ref 拦截；`.finally()` 清理 bucket；no-op 只 toast，不降 ring；baseline helper 计算为 `after + max(0, currentPromptTokens - before)` 并有单测。

发现：

- 🟡 `packages/desktop/src/renderer/App.tsx:2489`、`packages/desktop/src/renderer/ChatView.tsx:471`：核心 UI 状态和重复 RPC guard 没有组件/集成测试，当前只测了 token baseline helper。修法：补一个 renderer 测试，mock `compactSession`，断言 compacting 时 composer disabled、重复触发不二次调用 RPC、失败也清理状态。

### 69966c89 style(desktop): redesign context-compacted boundary banner

结论：实现符合方案。横幅改成结构化系统事件条，复用组件覆盖 MessageStream/TurnProcessGroupCard；中英文文案和 `compactFeedback` 测试已更新。

发现：未发现需要修改的问题。

### 5c53b0da feat(desktop): show source-session badge in background work panel

结论：实现基本符合方案。core UI entry 加 `sourceSession`，`listRunningBackgroundWork()` 未被改变；UI 使用 `scope:"all"`；shell output/kill 已改用 row 的 owner sessionId；shell selected key 已改为 `sessionId:shellId`。

发现：

- 🟢 `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:17`：组件注释仍写 “current session's background work”，但现在实际是 all-scope 面板。修法：更新注释，避免后续维护者误以为列表仍只限当前 session。

### 1bcb907e fix(desktop): stable clientMessageId for automation/mobile announce bubbles

结论：新 main 路径基本正确。automation 采用 `automation:<cronJobId>:<hash(prompt)>` 的偏离是可接受的，因为当前 isolated automation 每次 fire 是 fresh headless session；mobile 主路径使用 `mobile:<sessionId>:<runId>:<hash(text)>`，满足 per-turn 要求。

发现：

- 🟡 `packages/desktop/src/renderer/App.tsx:1772`：mobile 兼容 fallback 仍是 `mobile:<sessionId>:<hash(prompt)>`，旧 main/preload 未传 `clientMessageId` 时，同 session 连续相同文本仍可能被 hydrate 保护逻辑误判为同一 intent。修法：fallback 也生成本地 per-turn id，例如加 `Date.now()`/本地 monotonic id；新 main 仍以 main-generated id 为准。
- 🟢 `packages/desktop/src/main/index.ts:1608`：`announceAutomationSession` 本地参数类型未声明 `clientMessageId?: string`，运行时会透传但类型面不完整。修法：补上 optional 字段，避免后续重构时被误删。

### 17e186a9 feat(desktop): real HEAD branch label + grouped worktree switcher

结论：C-3/C-4 主路径符合方案。main label 使用 `getGitBranches().current`，detached 归一为 null；BranchPicker 切换后派发刷新事件；switcher 分 main/managed/external，active row 有 `aria-current` 和当前 badge，本会话占用 badge 也已实现。

发现：

- 🟡 `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:397`：分组逻辑用 `row.isManaged` 判断 external，和 `workspaceIsExternal()` 的语义不一致。一个 `isManaged: true` 但无 branch 的 detached worktree 会显示 external badge，却被放在 “CodeShell worktrees” 组。修法：复用 helper：`externalRows = rows.filter((r) => workspaceIsExternal(r))`，`managedRows = rows.filter((r) => !r.isMain && !workspaceIsExternal(r))`，并补 managed-detached 分组测试。

## 3. 跨 commit 共性问题

- 新增/修改测试里多处 `events.push(...)` 被直接作为 `onStream` 表达式返回，破坏 `StreamCallback` 类型。这个模式应统一改成 block body。
- desktop UI 相关 feature 的纯 helper 测试较充分，但 App/ChatView、automation/mobile announce 的集成级测试不足；这不阻塞当前修复，但后续容易回归。
- 未发现 core runtime import tui、desktop renderer runtime import codeshell 包的新增违规；renderer 仍通过 preload/window API 通信。

## 4. 测试运行结果汇总

- `bun test packages/desktop/src/main/desktop-services.worktree-cleanup.test.ts`：通过，5 pass。
- `bun test packages/core/src/tool-system/builtin/task.test.ts packages/core/src/engine/engine.todo-resume.test.ts`：通过，7 pass。
- `bun test tests/skills-scanner.test.ts packages/core/src/skills/scanner.allowlist.test.ts packages/core/src/tool-system/builtin/skill.allowlist.test.ts`：通过，45 pass。
- `bun test packages/core/src/context/manager-hybrid.test.ts packages/core/src/engine/engine.context-anchor.test.ts packages/core/src/engine/turn-loop-usage-cache.test.ts`：通过，14 pass。
- `bun test packages/desktop/src/renderer/chat/compactFeedback.test.ts packages/core/src/protocol/server.backgroundwork.test.ts packages/desktop/src/renderer/topbar/WorkspaceIndicator.test.tsx packages/core/src/engine/engine-client-message-id.test.ts`：通过，32 pass。
- `bun run typecheck`：失败。失败均在本批新增/修改测试代码，见上方两个 🔴。
- `bun run lint`：退出码 0；当前为 128 warnings、0 errors。输出中的 `packages/core/src/context/manager.ts` unused `LLMResponse` warning 在本批前已存在，不判定为本批新增 lint 阻塞。
- `git diff --check HEAD~9..HEAD`：通过，无 whitespace error。

## 5. 必修项 checklist

- [ ] 修复 `packages/core/src/engine/engine.todo-resume.test.ts:73`、`:105`、`:132` 的 `onStream` 回调返回值。
- [ ] 修复 `packages/core/src/engine/turn-loop-usage-cache.test.ts:173`、`:192` 的 `onStream` 回调返回值。
- [ ] 修复后重跑 `bun run typecheck` 和上述受影响测试。
