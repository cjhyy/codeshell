# PIPELINE SUMMARY — QUICK CHAT `/side` ALIGNMENT

## Outcome

Confirmed the reported root cause: `Engine.run()` persists the current user message before model work, and the old tail fork copied that message into the quick-chat target; renderer hydration then displayed it as an inherited but ownerless user bubble.

Quick chat now uses an explicit `forkKind: "side"`: a busy/queued parent is allowed, but core copies only through the last naturally completed conversation-turn cursor. The child Engine retains that copied history as model context while the quick-chat renderer starts from an empty visual transcript. Normal forks still reject busy/queued sources.

## Commits

- `da4a5f9e` — `docs(quickchat): design codex side alignment`
- `7d0ef9b3` — `fix(session): fork side chats at completed turns`
- `ed7b6c97` — `feat(quickchat): hide inherited side history`

No merge, push, or branch switch was performed.

## Design points

- `SessionState.completedThroughEventId` advances only when `Engine.run()` ends with `reason="completed"` and transcript persistence has not failed.
- `SessionManager`'s `snapshotMode: "completed"` cuts the fork at that cursor. Missing/duplicate cursors fail closed; a session with no completed turn copies zero parent events.
- Upgrade compatibility: a legacy session without the new cursor may use its tail only when its persisted status is explicitly `completed`; active/error/aborted legacy tails remain excluded.
- Side forks cannot combine `forkKind: "side"` with a caller-supplied `throughEventId`.
- `buildForkState` remains a whitelist projection, so active goals are not inherited. Approval state and steer queues remain per live Engine/ChatSession and are not copied.
- Desktop does not read/hydrate the fork target's inherited transcript. Existing quick-chat claim/creation nonce, unique child session ID, route-table deletion, coalescer discard, and bucket eviction continue fencing late fork/stream work.

## Changed files

### Design

- `docs/todo/small-features-2026-07-10/quickchat-align-side.md`

### Core session/fork path

- `packages/core/src/types.ts`
- `packages/core/src/session/session-manager.ts`
- `packages/core/src/session/session-manager.side-fork.test.ts`
- `packages/core/src/engine/engine.ts`
- `packages/core/src/engine/engine.session-fork-history.test.ts`
- `packages/core/src/protocol/types.ts`
- `packages/core/src/protocol/server.ts`
- `packages/core/src/protocol/server.fork.test.ts`

### Desktop quick-chat path

- `packages/desktop/src/main/agent-bridge-fallback.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/AppQuickChat.test.tsx`

## TDD evidence

Initial red run produced four expected failures:

- session snapshot copied `"parent request still running"` into the child;
- protocol returned `Overloaded` for a busy side fork;
- renderer request omitted `forkKind: "side"`;
- renderer hydrated the inherited parent user bubble.

Added coverage for:

- busy parent in-flight user tail exclusion;
- paired assistant/tool tail exclusion;
- no-completed-turn empty snapshot;
- legacy completed-session fallback;
- invalid completed cursor fail-closed behavior;
- active-goal/control-state non-inheritance;
- normal busy/queued fork guard preservation;
- busy side fork acceptance;
- inherited model context with empty visual transcript;
- independent parent/child stream, busy, approval, AskUser, stop, claim, nonce, and late-event routing.

## Verification

- Directed quick-chat/session suite: `29 pass, 0 fail` across 6 files.
- Core TypeScript: `bunx tsc -p packages/core/tsconfig.json --noEmit` — passed.
- Desktop TypeScript: `bun run typecheck` — passed after building the ignored core/CDP dependency outputs.
- Touched-file ESLint: 0 errors; two pre-existing warnings in `engine.ts:1857` and `server.ts:710`.
- Full required command (`bun test 2>&1 | tail -5`, with full output tee'd for inspection):

```text
5773 pass
6 skip
0 fail
14194 expect() calls
Ran 5779 tests across 809 files. [69.58s]
```

The two noted baseline failure families (`server.fork` busy-source concurrency and `ExternalAgentSessionStore`) did not fail in this run; there were no new failures.

## Deviations and open points

- The implementation deliberately uses an Engine-persisted conversation-turn cursor instead of scanning `turn_boundary`, because CodeShell's `turn_boundary` marks model/tool-loop steps, not one whole user conversation turn.
- `/side` is modeled as an explicit fork behavior, but quick-chat persistence/picker visibility and a future “save side as normal session” action remain out of scope.
- Cross-process filesystem locking/CAS remains existing architecture debt. Within the desktop host, ChatSession ownership plus distinct quick-chat session IDs preserve the requested single-writer invariant.

## 复审补修

复审 HOLD 后按严格 TDD 补修，单独提交：

- `575a7034` — `fix(quickchat): fence late approvals and degraded snapshots`

### 修法

- approval/AskUser 先按 session route 和当前 live quick-chat ref 解析。无法解析的 `qchat-*` 表示原 claim/generation 已关闭或被替换：不再回退 active bucket，不创建父聊/新快聊气泡或审批项，并 best-effort 向原 child session 发送 deny，释放仍 pending 的 core 请求。
- `SessionState.completedSnapshotVersion = 1` 显式区分现代 completed-snapshot 写入者与 legacy session。现代 completed run 即使 transcript flush degraded 也会写 schema version；没有完成 cursor 时 side snapshot 复制空历史，不再误用 legacy completed tail。已有旧的稳定 cursor 时仍可安全保留上一完成轮。
- 将原 UI 测试改名为 `starts the full quick-chat UI empty without reading the inherited target transcript`，使名称只描述其实际验证的 renderer 投影范围。模型继承与 in-flight 截断继续由 Engine/SessionManager 集成测试覆盖。

### 新增红绿测试

- 关闭 quick chat 后迟到 tool approval 与 AskUser：红测确认旧实现串入父 bucket；修复后两者均不渲染并自动 deny，同时父 approval 仍只进入父 bucket。
- 替换 quick chat 后旧 child 的迟到 tool approval 与 AskUser：红测确认旧实现串入父 bucket；修复后不进入父聊或 replacement，replacement 自己的 approval/AskUser 仍正常路由。
- 注入现代 completed run 的 transcript flush degradation：红测确认旧实现按 legacy tail 复制 3 个事件；修复后 schema version 为 1、无完成 cursor、side copied event count 为 0。

### 补修验证

- 定向 quick-chat/session/flush/protocol suite：`37 pass, 0 fail`（7 files）。
- Core TypeScript 与 Desktop TypeScript：通过。
- touched-file ESLint：0 errors；仅 `engine.ts:1857` 的既有 warning。
- 全量 `bun test 2>&1 | tail -5`：

```text
5776 pass
6 skip
0 fail
14209 expect() calls
Ran 5782 tests across 809 files. [68.17s]
```

本轮未出现给定的预存并发失败，也无新增失败；未 merge、未 push、未切分支。
