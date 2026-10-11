# Web / paired Desktop review — baseline 84740d56

Worktree: `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`.
All reproduction files live in `/tmp/codeshell-review-20261012-web-flow/`; no product source edits, no commits. Guarded runner creates isolated HOME and clears operator credentials. Browser fixtures reject all fetch requests and use fake sockets. Engine fixture installs a rejecting global fetch before Engine imports and registers a fake provider.

Production entry verified: `packages/desktop/src/mobile/main.tsx:4,14` renders shared `DesktopApp`; old `packages/desktop/src/mobile/App.tsx` is unused and excluded from findings.

## W1 [P2] ACK uncertainty is converted into a fresh submit, repeating completed work

Primary locations: `packages/web/src/hooks/useRemoteApp.ts:1278-1280` (fresh UUID every call), `:1339-1347` (sent request without ACK becomes false), `packages/web/app/DesktopApp.tsx:362-370` (restores resendable draft), `:478` (`uncertain: false`).

Trigger: paired Desktop browser submits a native task that the worker has accepted; the connection closes before `chat.accepted` reaches the browser. The task continues and completes while offline. Reconnect restores the original clientMessageId and complete answer from the modern output journal, but the failure-restored ordinary draft is not reconciled with that durable receipt. Retrying it generates a different clientMessageId and is admitted as a new intent after the prior run ends. This is the production-relevant ordering; withholding only one ACK while continuing an otherwise ordered live WebSocket is the older fixture simplification, not the sole reachability argument.

Evidence: `flow-review.test.tsx` test “lost ACK after completed work…” delivers real stream_request_start/text_delta/turn_complete through `useRemoteApp`, withholds chat.accepted, waits 15,030 ms, verifies controller draft restored, uncertain=false, second send admitted, and two distinct UUIDs. `intent-id-review.test.ts` runs the real Engine with a fake provider: same message + same UUID replays the first result (1 provider call), same message + a new UUID completes again (2 provider calls). 1 test / 4 assertions / 0 failures in 659 ms.

Modern recovery evidence: 第十轮使用真实 Main MobileOutputRecovery、SessionOutputJournal 和 completed 持久状态，在 ACK 前断线、离线完成、outputJournal=1 重连后恢复原输入ID及答案，草稿仍可用新ID发送。正常 ACK 后重连保持空稿。两基线各2测试23断言通过，见 [web-quality-round10.md](web-quality-round10.md)。

Impact: the same user intent can execute as a new task and repeat its effects; the tests do not claim every retry repeats a particular Bash/file side effect. Suggested fix: retain intent ID with pending submitted draft; reconcile durable receipt/history before enabling retry, like `useHubController` already does. Room receipt/deduplication is outside this evidence; this finding applies to native paired sends.

Confidence: high; client retry and real Engine behavior separately reproduced, no paid requests.

## W2 [P2] CC-open replies navigate tabs that never requested them and override later navigation

Primary locations: `packages/desktop/src/main/mobile-remote/handle-cc-room-event.ts:29-32,61-74`, `packages/web/src/hooks/useRemoteApp.ts:962-981,996-1006`.

Trigger A: two tabs in one browser share deviceStore credentials. Tab A opens a CLI conversation. `ccRoom.opened` is sent to all sockets for the device, and every tab unconditionally applies it. Tab B, which never called openCcSession and was viewing a native task, switches its active room, resets its feed, clears its approvals and starts room history recovery.

Trigger B: open CLI A, then explicitly select a different native session while `resolveRoomPermissionMode()` awaits settings. The late `ccRoom.opened` still changes the selected conversation back to CLI A. Unlike session.create's clientRequestId/conversationRevision checks, this response has no correlation guard.

Evidence: two hook tests in `flow-review.test.tsx`, with two fake sockets sharing deviceId or a late response after selectSession("newer-native"), both verify activeRoom becomes cc-room; the unintended second tab sends room.history. The server already has authenticated viewer IDs and sendToViewer, but this handler uses sendToDevice.

Impact: cross-tab navigation interference; typed followups can target an unexpected CLI conversation and the original pending native approval disappears from the viewed surface. Suggested fix: reply only to requesting viewer and echo a request ID tied to conversation revision; reject late/unrequested open acknowledgements before changing any state.

Confidence: high; both variants deterministically reproduced.

## W3 [P2] Stop in a running CLI room never stops that room

Primary locations: `packages/web/src/hooks/useRemoteApp.ts:1364-1366`, `packages/web/app/DesktopApp.tsx:505`, `packages/web/app/Workbench.tsx:816-824`.

Production UI path verified: shared Workbench always maps its Stop button to controller.stop; DesktopController always maps stop to app.stopRun, with no room-specific replacement or room hide condition. A room tool_use_start or assistant_text sets shared chat.run=running, so the button is visible.

Trigger: select native task, open a resident CLI room, send/observe a running CLI tool, click Stop. `ccRoom.opened` clears boundSessionRef, and Stop sends only `{type:"run.stop"}`. It carries neither roomId nor CLI-session identity. Server resolves this to the prior native selectedSessionId; with the production MobileExternalRuntimeCommands guard, opening a CC room revoked that native selection, so the command is rejected as “External cancel authority unavailable”. No RoomManager close/stop is called. Without that guard, it would cancel the old native task instead; production finding is failure to stop the current room.

Evidence: `room-controls-review.test.tsx` drives actual shared hooks/controller with a room tool message, verifies controller.running=true and Stop frame has no room ID, then routes the frame through the actual handleClientEvent plus actual MobileExternalRuntimeCommands. Verifies no room stop, no native cancel, and the exact rejection above.

Impact: user cannot stop long or unwanted remote CLI tool execution from the provided Stop button. Suggested fix: explicit room cancel/stop protocol routed to its resident producer and owner; do not reuse the native session cancellation action.

Confidence: high; UI callback chain and guarded server routing both reproduced.

## W4 [P2] CLI permission UI can display “逐次确认” while its process still bypasses permissions

Primary locations: `packages/web/app/DesktopControls.tsx:32-56`, `packages/web/app/DesktopApp.tsx:529`, `packages/web/src/hooks/useRemoteApp.ts:1587-1591`.

Production UI path verified: Workbench renders controller.chatControls at `Workbench.tsx:606`; DesktopController always provides `<DesktopChatControls app={actions}>`, and that component always renders its permission select before the room branch. The selector reads app.permissionMode (native session state), ignoring activeRoom.permissionMode.

Trigger: open CLI with bypassPermissions in an already trusted cwd, so the production room resolver actually retains bypassPermissions. An untrusted cwd is downgraded to default and is outside this trigger. Its room metadata says bypassPermissions but app.permissionMode remains default; displayed selector therefore says “逐次确认”. Choosing a safer mode also sends the native `{type:"permission.setMode", mode:"default"}` with no bound session, not any room operation. The server never changes the CLI process mode; RoomManager explicitly documents this is a spawn-time CLI argument and requires restart (`room-manager.ts:804-811`). A host rejection sets a notice but does not roll back/correct the select.

Evidence: `room-controls-review.test.tsx` opens bypass room, verifies activeRoom.permissionMode=bypassPermissions and app.permissionMode=default; selecting default emits native permission.setMode without roomId and the state mismatch survives the server error.

Impact: misleading authority state; user can believe they restored per-action confirmation before submitting more work while the CLI remains in bypass mode. Suggested fix: display active room's actual mode; implement explicit, acknowledged room reopen/restart for mode changes, or hide/disable native-only controls in room views.

Confidence: high; shared production UI and actual hook state/frame reproduced. Rated P2 because entering bypass was initially explicit; root may elevate if policy considers failed visible permission downgrade a P1.

## W5 [P2] Optional asynchronous questions block all independent followup tasks after completion

Primary locations: `packages/web/app/DesktopApp.tsx:332-338`, `packages/web/app/useHubController.tsx:522-528,663`, `packages/web/app/Workbench.tsx:816-826`.

Trigger: agent uses AskUserQuestionAsync for an optional preference and completes its work without an answer. This is explicitly supported by Core; `server.askuser-async.test.ts:160-177` verifies the session is idle while the question remains pending, and the tool tells the model/user the answer may arrive later. Both browser controllers nevertheless count every pending approval as `running`; native Desktop's send returns false and Hub's send independently rejects any approval. The composer keeps showing Stop/“等待你的确认” instead of allowing an unrelated followup.

Evidence: `room-controls-review.test.tsx` drives actual useRemoteApp and DesktopController, sends asynchronous approval + turn_complete, verifies app.chat.run=completed and pending approval.asynchronous=true, then sets an independent draft and confirms controller.running=true and send=false, with no chat.send sent. Standalone Hub is also reproduced in `hub-async-review.test.tsx`: actual useHubController stays running=true with chat.run=completed and an asynchronous pending question, rejects a next independent send, and emits no agent/run. 1 test / 5 assertions / 0 failures.

Impact: a nonblocking/optional question turns into a conversation-wide blocking gate until answered or rejected, defeating the asynchronous feature and also blocking Panel prompts (`Workbench.tsx:28-35`). Suggested fix: classify blocking approvals separately from asynchronously answerable questions; preserve the question card but permit unrelated sends while the actual run is idle.

Confidence: high; Desktop shared-controller failure reproduced, Core idle contract verified in existing test.

## W6 [P3] A failed synchronous approval delivery has no immediate card recovery while the same request is still pending

Primary location: `packages/web/src/hooks/useRemoteApp.ts:1574–1583` consumes an ordinary Core approval after send=true; `:911–915` handles an approvalId error without restoring it. Main `mobile-remote/handle-client-event.ts:140–185,467–477` waits up to ten seconds for control delivery.

Narrow trigger: the same worker/session still owns the pending request, but has not processed approve before delivery fails or the control budget expires. Normal tool execution being busy is insufficient: Core's approve handler immediately consumes the matched pending request and returns success, without waiting for the tool or turn to finish. No-pending, closed-session, dead-worker and already-successful late-approve errors must not be described as a still-blocked original request.

New evidence uses real Core pending state and the real Main helper, holds incoming approve at a controlled processing seam, and substitutes 20ms for the production ten-second test budget. The correlated error leaves a pending resolver with no card. This proves the conditional implementation gap; it is not an observed real worker ten-second stall. The old flow-review error-only injection did not by itself prove pending state.

Recovery: the error itself only shows a transient notice. The next valid resync can replay the pending card; not just manual reselection/reconnection, but also focus/pageshow/visible/online events with a usable connection. The new control dispatches focus, observes matching session.sync, replays the real cache and restores the card. The outputJournal branch sends authorized session.select and has the same replay route (source checked). Core tool approvals also have a five-minute bound. Hub and Desktop CC retain their cards until successful response and are normal counterexamples.

Suggested direction: preserve a submitting synchronous approval until matching resolution, release submitting state on delivery failure and request immediate authenticated pending resync. Independent review downgraded this conditional, recoverable gap to P3; see [approval-quality-round10.md](approval-quality-round10.md).

## Completed guarded reproductions

`node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-flow/flow-review.test.tsx` — 4 passed, 16 assertions, 15.46 s.

`node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-flow/intent-id-review.test.ts` — 1 passed, 4 assertions, 659 ms.

`node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-flow/room-controls-review.test.tsx` — 3 passed, 16 assertions, 916 ms.

Negative explorations excluded: draft loss in old mobile/App (unused); speculative WebSocket half-open recovery; legacy cwd session.create async ordering race (actual current UI mostly sends synchronous project-id targets, not strong enough without end-to-end proof).

Final guarded rerun logs are adjacent `*.test.ts[x].log` files. Exact aggregate: **9 passing tests, 41 assertions, 0 failures, 0 skipped** across four isolated runner invocations.
