# Background completion no-wake root cause

Date: 2026-07-09

## Phenomenon

Target session: `s-mrd153fe-2a631a42`.

The session dispatched a background `DriveAgent` job `cc-cvx5ocpkm4` at `2026-07-09T06:40:51Z`, then the main turn completed at `2026-07-09T06:41:04Z` and went idle. The completion event arrived at the renderer at `2026-07-09T07:13:55Z`:

- `~/.code-shell/logs/desktop/sessions/session-s-mrd153fe-2a631a42.jsonl:838`
- event: `background_agent_completed`
- agentId: `cc-cvx5ocpkm4`

In the bug window there was no immediate follow-up `session_started`, `text_delta`, `tool_use`, or `assistant_message` after line 838. The current log now has later lines because the user manually sent `继续` at `2026-07-09T07:36:28Z`; that later manual run does not change the original no-wake window.

Two earlier completions in the same session did wake correctly:

- line 469, `cc-cv8aipsib0`, `2026-07-09T06:17:48Z` -> line 470 `session_started`
- line 574, `cc-cvhoxqsh4g`, `2026-07-09T06:34:30Z` -> line 575 `session_started`

`~/.code-shell/logs/engine-2026-07-09.log` has no `bg_wakeup.turn_failed` for `s-mrd153fe-2a631a42`; the matching records are unrelated test sessions (`A`, `sess-1`, etc.). So this was not "wakeup turn started, then failed"; it was blocked before `enqueueTurn`.

## Code Path Verification

### Producer: DriveAgent completion enqueue

`packages/core/src/tool-system/builtin/drive-claude-code.ts:219-285` wires the detached DriveAgent promise:

- `run.then(...)` records the external session.
- It calls `notificationQueue.enqueue(..., sessionId)` at `drive-claude-code.ts:235-256`.
- Only after enqueue does it call `backgroundJobRegistry.finish(...)` at `drive-claude-code.ts:263-268`.

So `cc-cvx5ocpkm4` reaching renderer means the DriveAgent completion path did enqueue.

### Queue and bus

`packages/core/src/tool-system/builtin/agent-notifications.ts:75-93` is synchronous:

1. validate session id
2. push item into `buckets`
3. `this.notify()`
4. `agentNotificationBus.publish(sessionId, notificationItemToStreamEvent(item))`

`agent-notifications.ts:165-181` publishes to bus subscribers synchronously. Listener errors are swallowed, but the server subscriber did run because the renderer saw the event.

`agent-notifications.ts:108-115` shows `drainAll(sessionId)` is the only queue-clearing primitive in the production wake path: it returns all items for that session and deletes the bucket.

### Server forwarding and wake

`packages/core/src/protocol/server.ts:219-232` subscribes to `agentNotificationBus`. The order is important:

1. `this.notify(Methods.StreamEvent, { sessionId, event })`
2. `this.maybeWakeIdleSession(sessionId)`

The renderer seeing `background_agent_completed` proves step 1 happened. Step 2 then ran synchronously in the same bus fan-out.

`server.ts:268-284` is the guard chain:

1. `if (!this.chatManager) return`
2. `const session = this.chatManager.get(sessionId)`
3. `if (!session || session.isBusy()) return`
4. `if (session.engine.isHeadless()) return`
5. `if (session.wasCancelledSinceLastTurn()) return`
6. `const pending = notificationQueue.drainAll(sessionId)`
7. `if (pending.length === 0) return`
8. build `<system-reminder>...` and `session.enqueueTurn(...)`

Because no `bg_wakeup.turn_failed` exists, execution did not reach an attempted wake turn that rejected. It returned at one of the guards before or at `pending.length === 0`.

## Guard-by-Guard Analysis

### `!this.chatManager`

Excluded.

Desktop stdio worker constructs a `ChatSessionManager` in `packages/core/src/cli/agent-server-stdio.ts:202-289` and passes it to `AgentServer`. The same server path handled the earlier successful completions for this session.

### `!session || session.isBusy()`

This is the matching guard; specifically `!session` is the likely return.

Relevant code:

- `ChatSession.isBusy()` is `active !== null` only (`packages/core/src/protocol/chat-session.ts:135-137`).
- `enqueueTurn` sets `active` during `pump()` and clears it in `finally` after `engine.run` returns (`chat-session.ts:211-262`).
- The DriveAgent background job itself is not represented as `ChatSession.active`; it is tracked in `backgroundJobRegistry`.
- `ChatSessionManager.sweepIdle()` closes any non-busy session older than `idleTtlMs` (`packages/core/src/protocol/chat-session-manager.ts:154-158`).
- The desktop worker enables the sweeper with `idleTtlMs: 30 * 60 * 1000` and default interval `60_000` (`agent-server-stdio.ts:287-290`).
- `ChatSessionManager.close()` removes the session from the in-memory map (`chat-session-manager.ts:110-120`), but does not cancel or drop DriveAgent jobs. That is consistent with the job still completing later and publishing the bus event.

Timeline:

- `06:41:04.231Z`: main turn completed (`session...jsonl:837`).
- `07:11:04Z` plus the next sweeper tick: session became eligible for idle eviction.
- `07:13:55.359Z`: DriveAgent completion arrived (`session...jsonl:838`), about 32m51s after the last turn completed.

That exceeds the configured 30m TTL. A live idle session would have been closed by the sweeper before the completion. When the bus handler later called `maybeWakeIdleSession`, `chatManager.get(sessionId)` returned `undefined`, so `server.ts:271` returned before `drainAll` and before `enqueueTurn`.

There is no direct log line for `sweepIdle()` or the `!session` guard. That logging gap prevents a literal line-by-line proof from logs alone, but this is the only guard that fits all observed facts: event forwarded, no wake turn started, no wake failure, completion after TTL, and earlier under-TTL completions waking normally.

### `session.engine.isHeadless()`

Excluded for the observed desktop chat session.

The session state records `origin: "desktop"`, and earlier wakeups in the same session successfully ran interactive continuation turns. The headless-only drain path is inside `Engine.run` (`packages/core/src/engine/engine.ts:2234-2293`) and is explicitly for one-shot automation/SDK runs, not this desktop interactive path.

### `session.wasCancelledSinceLastTurn()`

Unlikely and not supported by logs.

`cancel()` sets `cancelledSinceLastTurn = true` (`chat-session.ts:121-127`); `enqueueTurn()` clears it immediately (`chat-session.ts:91-99`). The per-session desktop log has no `renderer->worker agent/cancel` or `agent/closeSession` between the `06:41:04Z` turn completion and the `07:13:55Z` background completion. If this guard had been the blocker, the session would still have existed in `chatManager`, which does not explain why the event landed after the 30m idle eviction window with no wake attempt.

### `pending.length === 0`

Very unlikely.

The renderer-visible event comes from the same `NotificationQueue.enqueue` call that first pushes into the per-session bucket (`agent-notifications.ts:84-92`). Renderer code does not drain this queue. Production drains found in the searched code are:

- `AgentServer.maybeWakeIdleSession` (`server.ts:282`)
- headless `Engine.run` background sub-agent summarization (`engine.ts:2260`, `engine.ts:2275`)

This was not a headless run, and if `maybeWakeIdleSession` had reached `drainAll`, it should have received the item that was just enqueued. The `!session` guard also occurs before `drainAll`, so the queue item would remain process-local but unwoken.

### Session unload/eviction

Confirmed as the operational root cause.

`ChatSessionManager` has an explicit idle eviction mechanism:

- default `idleTtlMs` is 30m (`chat-session-manager.ts:54`)
- production desktop passes 30m (`agent-server-stdio.ts:287-289`)
- sweeper closes idle, non-busy sessions (`chat-session-manager.ts:154-158`)
- existing test `tests/chat-session-manager.test.ts:75-86` asserts sessions older than `idleTtlMs` are evicted

The bug job ran longer than the idle TTL. The session was idle from `06:41:04Z` until completion at `07:13:55Z`. Since running DriveAgent jobs are not part of `ChatSession.isBusy()`, the sweeper can remove the session while the DriveAgent remains running.

### Process / listener loss

Excluded.

If the worker process or server bus listener had been gone, the renderer would not have received the `background_agent_completed` event through `worker->renderer agent/streamEvent`. The event did arrive. Therefore the worker and the server bus subscriber were alive; what was missing was the live `ChatSession` object inside `chatManager`.

## Root Cause

The wakeup path requires a live in-memory `ChatSession`, but the desktop worker evicts idle, non-busy sessions after 30 minutes. `DriveAgent` background jobs can run longer than 30 minutes and do not make `ChatSession.isBusy()` true. In this case the main session became idle at `06:41:04Z`, was eligible for `ChatSessionManager.sweepIdle()` around `07:11Z`, and the DriveAgent completed at `07:13:55Z`.

When `NotificationQueue.enqueue` published the completion:

1. `AgentServer` forwarded the event to renderer successfully.
2. `maybeWakeIdleSession(sessionId)` then called `chatManager.get(sessionId)`.
3. The manager no longer had the session.
4. `server.ts:271` returned at `!session`.
5. No `drainAll`, no injected system-reminder turn, no `enqueueTurn`, no `bg_wakeup.turn_failed`.

This explains why the first two completions worked: both completed while the session was still within the 30m idle TTL. The third completed after the TTL.

## Fix Plan

### Minimal fix

Do not idle-evict sessions that still own running background work.

In `ChatSessionManager.sweepIdle()`, before `this.close(id)`, check at least:

- `backgroundJobRegistry.hasRunningForSession(id)` for DriveAgent and video jobs
- `asyncAgentRegistry.hasRunningForSession(id)` for background Agent tool calls

For the broader background-shell case, also consider `backgroundShellManager.listForSession(id).some(s => s.status === "starting" || s.status === "running")`. This preserves finite background shell wakeups too, but it means long-lived dev-server sessions stay resident. If that memory tradeoff is too broad, split shell handling later; the DriveAgent bug is fixed by guarding `backgroundJobRegistry` immediately.

Sketch:

```ts
private hasRunningBackgroundWork(sessionId: string): boolean {
  return (
    backgroundJobRegistry.hasRunningForSession(sessionId) ||
    asyncAgentRegistry.hasRunningForSession(sessionId)
  );
}

sweepIdle(): void {
  const cutoff = Date.now() - this.idleTtlMs;
  for (const [id, s] of [...this.sessions]) {
    if (s.lastActivityAt >= cutoff) continue;
    if (s.isBusy()) continue;
    if (this.hasRunningBackgroundWork(id)) continue;
    this.close(id);
  }
}
```

Expected regression test:

1. Create `ChatSessionManager` with tiny `idleTtlMs`.
2. Create session `sess-1`.
3. Start `backgroundJobRegistry.start("job-1", "sess-1", ...)`.
4. Set `lastActivityAt` in the past and call `sweepIdle()`.
5. Assert `chatManager.get("sess-1")` still exists.
6. Finish the job via `notificationQueue.enqueue(...)`.
7. Assert `AgentServer` wakes and `notificationQueue` drains.

### Additional hardening

Add diagnostic logging to `maybeWakeIdleSession` guard returns. Today the critical guard is silent. A low-volume debug/info log for `no_chat_manager`, `session_missing`, `busy`, `headless`, `cancelled_since_last_turn`, and `pending_empty` would make future production diagnosis direct.

For stronger resilience, add a recovery path when a completion arrives for a missing but disk-backed desktop session:

1. Read the session's persisted `state.json` to recover `cwd`, `origin`, and other safe config needed for `engineFactory`.
2. Recreate the `ChatSession`.
3. Reinstall the interactive bridges that `handleRunMulti` currently wires before `enqueueTurn` (`askUser`, browser bridge, credential injection, workspace bridge).
4. Drain and inject the notification as usual.

This is more invasive than the sweeper guard because wakeup currently only has `sessionId`, not the per-run slice or bridge setup. It is a good belt-and-braces follow-up, but the minimal fix should be to keep sessions with running background work resident until their completion has had a chance to wake.

### Queue persistence follow-up

`notificationQueue` and `agentNotificationBus` are process-local. The observed bug is not a process restart, but process-local completion queues still mean a worker crash/restart can lose wakeup payloads. If long-running background work becomes durable across worker restarts, completion notifications should be persisted or reconstructible from `backgroundJobRegistry` / external CLI session metadata.

## Conclusion

The failed wake was caused by idle-session eviction, not by renderer delivery, not by a failed wake turn, and not by DriveAgent keeping the main session busy. The wakeup event arrived after the 30-minute `ChatSessionManager` TTL had removed the idle session from memory; `maybeWakeIdleSession` hit the silent `!session` guard and returned before draining the queued completion or enqueueing the injected turn.
