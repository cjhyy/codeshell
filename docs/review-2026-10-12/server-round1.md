# CodeShell server review — baseline 84740d56

Snapshot: `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`.
Product sources read-only. Reproductions use guarded runner, isolated HOME, fake CLI or pure in-memory/file fixtures; no paid model requests. Networked duplicate-start fixture installs deny-all fetch before dynamic Core/host import, then permits only its ephemeral loopback origin.

## S1 [P2] Failed duplicate Hub startup deletes live instance uploads

- Primary: `packages/server/src/hub/uploads.ts:66-68`; lifecycle: `packages/server/src/serve/headless-server.ts:204-205` and `1279-1284`.
- `HubUploads.ready()` assumes every existing `*.upload` is orphaned and deletes it. No exclusive data directory lock distinguishes a live first server. Cleanup runs before the second server binds.
- Trigger: first Hub is running; user uploads an attachment. Launch the same command again with the same default `~/.code-shell/serve` and same port. The second boot fails with EADDRINUSE, while the original healthy server has already lost its upload bytes.
- Impact: first instance still returns healthy and displays the uploaded draft; sending it fails during staging with ENOENT. Same issue occurs across two intentionally separate ports using default dataDir.
- Reproduced: server1 → setup 200 → PUT 201 → one spool → server2 same options/port rejects → server1 /health 200 and zero spools.
- Evidence: `/tmp/codeshell-review-20261012-server-double-start.test.ts`, guarded runner: 1 pass, 6 expects.
- Gap: no duplicate host ownership / failed-boot preservation test. Existing instance shutdown/restart tests do not cover a rejected simultaneous boot.
- Suggested direction: acquire an exclusive installation lease before cleanup/other mutations, or isolate instance spools and reclaim only provably orphaned files.
- Confidence: high.

## S2 [P2] CC AskUserQuestion permanently consumes multi-question prompt after one answer

- Primary: `packages/server/src/mobile-remote/room-manager.ts:982-983`; projection `195-213`, pending consumption `955-967`.
- `askUserPrompt` projects only questions[0]. The pending original request is removed before response, then `respondApproval` builds an answers record containing only the first question while passing all original questions through.
- Trigger: one Claude Code AskUserQuestion tool request contains two or more questions. Desktop CC conversation and mobile surfaces both receive the single-question askUser shape.
- Impact: only the first question can be answered; subsequent questions disappear. A second answer for the same requestId is rejected, so the user cannot finish the original clarification workflow.
- Evidence: `/tmp/codeshell-review-20261012-server-questions.test.ts`, guarded runner: 1 pass, 7 expects. It asserts two original questions, only first answer returned, and second answer rejected.
- Gap: `room-manager.test.ts:27-46` explicitly checks first-question parsing; `849-911` controls only a single question. No whole multi-question interaction test.
- Suggested direction: carry the complete questions array to clients, collect all answers, settle the control request once all required answers are provided.
- Confidence: high.

## S3 [P2] Removed Hub draft attachments retain quota and leave an empty composer blocked

- Primary: `packages/web/app/useHubController.tsx:734-736` (removeFile is local only); backend cap `packages/server/src/hub/uploads.ts:87-92` and TTL `14`.
- Uploads reserve one of 16 owner slots. Removing a composer attachment only updates SessionDrafts; no corresponding server DELETE/cancel operation exists. The server releases only after accepted run completion or 15-minute expiry.
- Trigger: select 16 files and then remove all of them, or add/remove a single file 16 times. Try to select the replacement attachment.
- Impact: composer shows zero attachments, but the next PUT returns 429 “send the current attachments first”. There are no visible attachments to send, so normal editing cannot recover until TTL/sweep or service restart. A new login only conditionally bypasses the owner limit: discarded files still occupy global 32-slot / 128 MiB quota, so re-login is not a generally reliable recovery.
- Evidence: `/tmp/codeshell-review-20261012-server-uploads.test.ts`, first case; 16 PUT 201, draft files length 0, 16 spools still present, replacement PUT 429.
- Gap: existing upload ownership/release tests cover worker failures and successful use, not explicit draft removal.
- Suggested direction: add an owner-bound discard endpoint and call it when removing/replacing a draft attachment.
- Confidence: high.

## S4 [P2] Claude room spawn failure leaves a stale “running” handle that blocks same-mode retry

- Primary: `packages/server/src/mobile-remote/resident-agent.ts:207-215`; `isRunning` at `236-238`; room registration guard `packages/server/src/mobile-remote/room-manager.ts:1009`.
- Node failed spawn emits child `error` without `exit`. This handler publishes only the error, while cleanup is exclusively in `exit`; the failed ChildProcess remains assigned.
- Trigger: room creation/open hits ENOENT, EACCES, missing/moved cwd, or spawn resource failure. Repair/install CLI and reopen the same room.
- Trigger scope: a stale/successful probe followed by executable, permission or cwd change, or another asynchronous spawn failure. Fresh missing-CLI sidebar probes normally hide session choices. Synchronous start throws and actual exit events already clean up correctly.
- Impact: isOpen/open continue to claim running, RoomManager never constructs a replacement agent, and every later send returns false. Installing/fixing the CLI and reopening with the same mode cannot work; explicitly closing the room or selecting a different mode causes replacement spawn and can recover. The error text recommends installing CLI without explaining that same-mode retry remains blocked.
- Evidence: `/tmp/codeshell-review-20261012-server-room-spawn.test.ts`, guarded runner: 1 pass, 6 expects. Missing fake CLI → error → create executable at same path → reopening still has created=1, isOpen=true, send=false.
- Gap: resident-agent tests cover parsing/control wire shape only, not actual failed ChildProcess lifecycle.
- Suggested direction: retire the exact failed child and publish a terminal lifecycle event so RoomManager releases that agent and allows retry.
- Confidence: high.

## S5 [P3] Hub accepts images above its staging limit and fails only on Send

- Primary: `packages/server/src/hub/uploads.ts:94-97`, image routing `212-214`; actual image limit `packages/server/src/attachment-service.ts:244-245` (10 MiB).
- PUT accepts up to 20 MiB regardless of MIME; the inconsistent image interval is (10 MiB, 20 MiB], excluding exactly 10 MiB; browser uploadFile has no image-size precheck. Image staging enforces 10 MiB only when sending.
- Trigger: upload a PNG/JPEG between 10 and 20 MiB.
- Impact: upload returns 201 and appears successful, then Send fails. The original same attachment draft is restored and repeated sends cannot succeed. Unsupported image MIME types have an analogous late failure.
- Evidence: `/tmp/codeshell-review-20261012-server-uploads.test.ts`, second case: image/png 11 MiB PUT 201, prepare throws image size limit.
- Gap: no upload admission/staging-limit consistency coverage.
- Suggested direction: validate the same MIME/size constraints at admission and show actionable upload errors.
- Confidence: high for size inconsistency; user priority lower than S1–S4.

## S6 [P2] CC room pending approvals cannot recover after switching or reconnecting

- Primary client loss: `packages/web/src/hooks/useRemoteApp.ts:1004` (ccRoom.opened clears approvals) and `1065-1067` (drops non-current-room requests). Server gap: `packages/desktop/src/main/cc-room/approval-bridge.ts:17-20` only retains resolver/timer; no pending payload snapshot/replay API. Recovery only requests room history/transcript (`useRemoteApp.ts:1195-1220`), whose approval records lack requestId and input (`packages/server/src/mobile-remote/room-manager.ts:1120-1125`).
- Trigger: CC room is waiting for approval; user selects another conversation and returns, or the prompt is pushed while the phone is offline or viewing another room.
- Impact: the server still waits for that exact control request, but the approval card is absent and cannot be reconstructed; after five minutes ApprovalBridge auto-denies. The user cannot continue an ordinary navigation/reconnect workflow.
- Evidence: `/tmp/codeshell-review-20261012-server-cc-approval-recovery.test.tsx`, real useRemoteApp + ApprovalBridge, fake WebSocket, deny-all network guard. Case 1: card present → select another session → reopen original room + replay approval history → no card while server promise remains unsettled and `respond` still succeeds. Entire file: 2 pass, 14 expects.
- Desktop nuance: inactive PanelArea tabs stay mounted and their lightweight listeners are retained, so merely switching a mounted panel tab is covered. Unmounting a CC conversation (back to session list / renderer reload) still lacks a pending snapshot, but mobile switching is independently reproduced.
- Gap: reconnect/session-replay tests preserve Core approvals, while CC approvals have no pending-state recovery coverage.
- Suggested direction: retain pending payloads in ApprovalBridge and expose an authenticated per-room snapshot/replay; merge it on room activation and reconnect.
- Confidence: high.

## S7 [P2] Offline CC approval click clears the card even when no response was sent

- Primary: `packages/web/src/hooks/useRemoteApp.ts:1450-1452`.
- `respondCcApproval` ignores `socket.send`'s false return and immediately removes the request from both the synchronous ref and visible state. The neighboring Core `respondApproval` path correctly checks `if (!sent) return`.
- Trigger: a CC approval card is visible; phone loses WebSocket connectivity; user taps allow/deny.
- Impact: nothing is sent, yet the card disappears. Reconnect requests room history without pending approvals, so the still-blocked tool cannot be approved afterward and eventually auto-denies.
- Evidence: `/tmp/codeshell-review-20261012-server-cc-approval-recovery.test.tsx`, case 2: close socket → respond → no new frame and zero cards → reconnect + history replay → zero cards.
- Gap: Core async approval delivery failures are tested; CC response transport failure is not.
- Suggested direction: retain card when send fails, and preferably clear only after the host acknowledges/resolves the exact request.
- Confidence: high.
