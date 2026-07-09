# Background Wake Rehydrate Implementation Notes

Date: 2026-07-09

## Summary

- `ChatSessionManager.sweepIdle()` now skips sessions that still have running background jobs, using `backgroundJobRegistry.hasRunningForSession(sessionId)`.
- `AgentServer.maybeWakeIdleSession()` can now rehydrate an evicted chat session when a background-completion notification arrives, then drain the notification queue and enqueue the injected wake turn.

## Rehydrate Strategy

- `AgentServer` caches the last `EngineConfigSlice` from a successful `agent/run` per session and keeps it across idle eviction.
- Wake rehydrate prefers that cached slice, preserving `cwd`, `permissionMode`, `projectTrusted`, and `goal` from the last renderer run.
- If the slice cache is cold, wake rehydrate reads persisted session state through `SessionManager.readCwd(sessionId)` and builds a minimal safe slice with `cwd`, `permissionMode: "default"`, and `projectTrusted: false`.
- Cold-cache rehydrate requires a real persisted `cwd` before probing `chatManager.sessionExistsOnDisk()`. This keeps wakeups scoped to disk-backed sessions and avoids stale process-global notification subscribers claiming arbitrary notification buckets.
- `model` and `provider` are not reconstructed into `EngineConfigSlice`; the rebuilt session still resumes transcript/session state at run time, while model selection follows the existing engine factory/runtime behavior.

## Guards And Logging

- Live-session guards remain unchanged: busy, headless, and cancelled-since-last-turn sessions still skip wakeup.
- Missing sessions with no pending notification log `bg_wakeup.rehydrate_skipped_no_pending` at debug level.
- Missing persisted state or `sessionExistsOnDisk() === false` logs `bg_wakeup.rehydrate_skipped_missing_disk_session`.
- Rehydrate exceptions are caught and logged as `bg_wakeup.rehydrate_failed`, so notification bus fan-out cannot crash.

## Tests

- `chat-session-manager.bg-jobs.test.ts`
  - running background job prevents idle eviction
  - no running background job still evicts an expired idle session
- `server.bg-shell-wakeup.test.ts`
  - live idle wake still starts an injected run
  - evicted disk-backed session rehydrates and wakes
  - absent disk session does not rehydrate or drain notifications
  - cold cache rehydrates from persisted `state.json` cwd
