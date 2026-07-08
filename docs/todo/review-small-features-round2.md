# 小 feature 批次 Round 2 代码审查报告

审查范围：上一轮报告 `docs/todo/review-small-features.md` 之后的 6 个修复 commit：

- `bb7e99f9` `test(core): fix onStream callback return type in new tests`
- `9374e3c5` `fix(desktop): report cleanup branch delete failures`
- `adade780` `test(desktop): cover compact in-flight UI`
- `689e3376` `fix(desktop): make mobile announce fallback ids unique`
- `bed1df43` `fix(desktop): group detached worktrees as external`
- `a59a86af` `chore(desktop): clarify background work panel scope`

## 1. 总体结论

这 6 个修复可以合入/push。上一轮 2 个 🔴 typecheck、4 个 🟡、2 个 🟢 对应修复方向正确，未发现修复本身引入的新阻塞问题或明显回归。

阻塞项数：0 个 🔴。建议项：0 个 🟡。可选项：0 个 🟢。

## 2. Commit 审查

### `bb7e99f9` test(core): fix onStream callback return type in new tests

结论：修复到位。

- `packages/core/src/engine/engine.todo-resume.test.ts` 中 3 处 `onStream` 已从表达式体 `events.push(...)` 改为 block body，回调不再返回 `number`。
- `packages/core/src/engine/turn-loop-usage-cache.test.ts` 中 2 处同样改为 block body。
- 受影响测试通过，`bun run typecheck` 也已恢复 0 error。

发现：无。

### `9374e3c5` fix(desktop): report cleanup branch delete failures

结论：修复到位，符合上一轮 C-5 的非破坏性建议。

- `packages/desktop/src/main/desktop-services.ts` 新增 `branch_delete_failed` skip reason。
- branch 删除路径仍使用 `git branch -d`，没有升级为 `-D`；失败只 `console.warn` 并追加 `result.skipped`，不会强删分支。
- `packages/desktop/src/main/index.ts` 既有 `broadcastWorktreeCleanupSkipped()` 会把 skipped 事件发给 renderer，新增 reason 能被同一路径上报。
- `packages/desktop/src/preload/index.ts` 与 `packages/desktop/src/preload/types.d.ts` 的 `WorktreeCleanupSkippedEvent` reason union 已同步。
- 新增测试用真实 `branch -d` “not fully merged” 失败覆盖：worktree 被移除、分支保留、结果包含 `branch_delete_failed`。

发现：无。

### `adade780` test(desktop): cover compact in-flight UI

结论：新增测试有效，覆盖上一轮 B-1/B-2 建议的核心断言。

- `packages/desktop/src/renderer/AppCompactSession.test.tsx` mock 掉重型子组件，但保留 `App` 的真实 compact 状态逻辑，并通过 mocked `ChatView` 捕获 `compacting` 与 `onCompactCommand`。
- 测试断言了初始 composer 未 disabled、触发 `/compact` 后 composer disabled、连续触发不会二次调用 `compactSession`、失败 reject 后 `compacting` 清理且 composer 恢复可用。
- `compactSession` mock 会记录 sessionId 并返回 pending promise，断言 `compactCalls` 为 `["engine-a"]`，不是空跑。

发现：无。

### `689e3376` fix(desktop): make mobile announce fallback ids unique

结论：修复到位，符合上一轮 C-2。

- `packages/desktop/src/main/index.ts` 的 mobile 主路径仍优先生成并传递 `clientMessageId = mobile:<sessionId>:<runId>:<hash>`，`runId` 每次发送生成，满足 per-turn 唯一。
- `packages/desktop/src/renderer/App.tsx` 在 `meta.clientMessageId` 存在时优先使用 main-generated id。
- 仅旧 main/preload 未传 `clientMessageId` 时走 fallback；fallback 现在包含 `Date.now().toString(36)` 与 `mobileAnnounceSeqRef` 单调计数，再加 prompt hash，同一 App 生命周期内同 session 连发相同文本不会再撞 id。
- 同 commit 补齐了 automation announce 局部类型里的 `clientMessageId?: string`，覆盖上一轮 C-2 的类型面可选项。

发现：无。

### `bed1df43` fix(desktop): group detached worktrees as external

结论：修复到位，符合上一轮 C-4 的建议修法。

- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx` 分组已改为复用 `workspaceIsExternal(row)`：`externalRows = rows.filter((row) => !row.isMain && workspaceIsExternal(row))`，`managedRows = rows.filter((row) => !row.isMain && !workspaceIsExternal(row))`。
- `workspaceIsExternal()` 的语义是非 main 且 `isManaged === false` 或缺少 branch，因此 `isManaged: true` 但 `branch: ""` 的 detached managed worktree 会进入 external 分组。
- 新增测试在 switcher 数据里加入 detached managed row，并断言 “游离 HEAD/Detached HEAD” 出现在 “外部 worktrees/External worktrees” 分组标题之后；同时既有 helper 测试也覆盖 detached row 被判定为 external。

发现：无。

### `a59a86af` chore(desktop): clarify background work panel scope

结论：修复到位。

- `packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx` 注释已从 “current session's background work” 改为 “ALL background work”，不再误导维护者以为面板只列当前 session。
- 该 commit 仅改注释，无运行时行为变化。

发现：无。

## 3. 验证运行结果

- `bun run typecheck`：通过，退出码 0。
- `bun run lint`：通过，退出码 0；输出仍有 128 warnings、0 errors，均非本轮阻塞。
- `bun test packages/desktop/src/main/desktop-services.worktree-cleanup.test.ts packages/desktop/src/renderer/topbar/WorkspaceIndicator.test.tsx packages/desktop/src/renderer/AppCompactSession.test.tsx packages/core/src/engine/engine.todo-resume.test.ts packages/core/src/engine/turn-loop-usage-cache.test.ts`：通过，36 pass、0 fail、169 expect。

## 4. 必修项 checklist

无。
