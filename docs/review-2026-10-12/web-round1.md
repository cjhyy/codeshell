# Web / paired Desktop review — baseline 84740d56

Worktree: `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`.
All reproduction files live in `/tmp/codeshell-review-20261012-web-flow/`; no product source edits, no commits. Guarded runner creates isolated HOME and clears operator credentials. Browser fixtures reject all fetch requests and use fake sockets. Engine fixture installs a rejecting global fetch before Engine imports and registers a fake provider.

Production entry verified: `packages/desktop/src/mobile/main.tsx:4,14` renders shared `DesktopApp`; old `packages/desktop/src/mobile/App.tsx` is unused and excluded from findings.

## W1 [P2] ACK uncertainty is converted into a fresh submit, repeating completed work

Primary locations: `packages/web/src/hooks/useRemoteApp.ts:1278-1280` (fresh UUID every call), `:1339-1347` (sent request without ACK becomes false), `packages/web/app/DesktopApp.tsx:362-370` (restores resendable draft), `:478` (`uncertain: false`).

Trigger: paired Desktop browser sends a native task; worker accepts and finishes it, but the `chat.accepted` reply is lost or delayed beyond 15 seconds. The controller restores the original draft and invites retry, with no “uncertain receipt” state or history reconciliation. Retrying the restored task uses a different clientMessageId. It is a new intent to Core, and executes again. Disconnect after acceptance followed by reconnect creates the same class of window; running-state gates only delay retry until the previous run is complete, they do not deduplicate it.

Evidence: `flow-review.test.tsx` test “lost ACK after completed work…” delivers real stream_request_start/text_delta/turn_complete through `useRemoteApp`, withholds chat.accepted, waits 15,030 ms, verifies controller draft restored, uncertain=false, second send admitted, and two distinct UUIDs. `intent-id-review.test.ts` runs the real Engine with a fake provider: same message + same UUID replays the first result (1 provider call), same message + a new UUID completes again (2 provider calls). 1 test / 4 assertions / 0 failures in 659 ms.

Impact: repeated file edits, commands, or other task effects despite one original submit intent. Suggested fix: retain intent ID with pending submitted draft; reconcile durable receipt/history before enabling retry, like `useHubController` already does. Room sends additionally lack server deduplication and need their own receipt contract.

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

## W6 [P2, lower priority] A failed synchronous approval delivery loses its retry card

Primary locations: `packages/web/src/hooks/useRemoteApp.ts:1573-1583` and `:911-915`, server `packages/desktop/src/main/mobile-remote/handle-client-event.ts:474-477`.

Trigger: user approves an ordinary tool request. The client deletes the card immediately after ws.send, before worker acknowledgement. Main times out waiting on the busy/unresponsive worker or returns an approval error; its event carries approvalId. The error handler only clears the async-submission set and shows a temporary notice, and never restores the removed synchronous card. Server pending approvals are replayed on explicit select/resync, not on this error.

Evidence: flow-review.test.tsx shows a pending Bash request, clicks respondApproval, returns `{type:"error",approvalId:"approve-1",message:"worker did not respond"}`, and verifies card remains absent. Async questions already implement the safer “keep until resolved, unlock on failure” behavior.

Impact: if the tool is still waiting, user has no card to retry until manually selecting/reconnecting; view can look idle while backend remains blocked. Suggested fix: use a pending state until approval.resolved, and unlock on approval-specific errors, for synchronous and asynchronous cards alike.

Confidence: high for UI loss; actual timeout leaving the worker pending depends on worker stall. Lower value than W1-W5.

## Completed guarded reproductions

`node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-flow/flow-review.test.tsx` — 4 passed, 16 assertions, 15.46 s.

`node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-flow/intent-id-review.test.ts` — 1 passed, 4 assertions, 659 ms.

`node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-flow/room-controls-review.test.tsx` — 3 passed, 16 assertions, 916 ms.

Negative explorations excluded: draft loss in old mobile/App (unused); speculative WebSocket half-open recovery; legacy cwd session.create async ordering race (actual current UI mostly sends synchronous project-id targets, not strong enough without end-to-end proof).

Final guarded rerun logs are adjacent `*.test.ts[x].log` files. Exact aggregate: **9 passing tests, 41 assertions, 0 failures, 0 skipped** across four isolated runner invocations.
