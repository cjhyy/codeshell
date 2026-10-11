# Desktop review — baseline 84740d56

Snapshot: `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`.
Product files stayed read-only. All repro files are outside the repository in this directory, run via the repository guarded Bun runner. No provider/model calls or real HOME state were used.

## D1 [P2] Native run errors disappear because the controller reads the wrong reply shape

Primary location: `packages/desktop/src/renderer/app/useRunController.ts:486-497`; same issue at `:639-644` for Quick Chat. The native branch calls `window.codeshell.run` but treats the resolved value as a raw RunResult. Real preload `packages/desktop/src/preload/index.ts:263-267` resolves the whole parsed `{jsonrpc,id,result|error}` and `:548` returns `rpc(...)` without `rpcResult`. Thus neither `result.reason` nor root `error.message` is inspected. External runtime returns a bare object and does work.

Trigger: attachment cannot be read / malformed image / an early native model failure, or user sends while configuration updates. The Main gate at `packages/desktop/src/main/agent-bridge.ts:804-824` returns only an error response (`配置正在更新，请稍后重试。`) and returns before forwarding the request, so no stream event can display the error. Core's `packages/core/src/engine/engine.ts:1590-1598` returns `imageInput.result` immediately on image validation failure before session_started; `run-image-input.ts:88-99` supplies an image_error result.

Impact: the user message remains, busy clears, but the explanation and retry guidance are never rendered. The composer already clears its draft. It reads as a successful send with no answer. Ordinary send transport rejections reaching this controller catch are only logged because the catch at `useRunController.ts:523-527` displays an error only when directorySaved is false. This does not describe every lifecycle path: AppShell separately displays worker-crash notifications, and Quick Chat has its own visible catch handling.

Verification: `preload-envelope.test.ts` imports the real preload with an inert Electron bus and proves both result and error responses retain the envelope (2 pass). `run-controller.test.tsx` uses the real hook and asserts JSON-RPC image_error, the exact Chinese Main gate error, and transport rejection each dispatch only `user_message`, no toast; raw error control dispatches `turn_end` and toast (4 relevant pass). Confidence: high.

Suggested correction: establish one explicit result contract for native/external runs and surface error envelopes/rejections; preserve a retryable message/draft. Do not merely unwrap without fixing the send catch, which currently swallows post-persistence rejection.

## D2 [P2] Switching sessions carries local file references into the next conversation

Primary location: `packages/desktop/src/renderer/ChatView.tsx:443-444`, `:1082-1097`. App's main ChatView at `packages/desktop/src/renderer/App.tsx:2442` has no session key. Parent stores text and image drafts per bucket (`App.tsx:372-394`) but ChatView's `inputReferences` and `localFilePaths` live in unkeyed component state and are reset only after submission/compact, not when sendBucket changes.

Trigger: in A drag/select a workspace text file, switch to B without sending, submit B's own prompt.

Impact: B's prompt gains A's literal path and structured attachment with `sessionId: A`; canonical Core rejects it with session mismatch (`packages/core/src/engine/input-attachments.ts:131-143`), so unrelated B work cannot start. With native runs, D1 hides that reason. File paths can also leak into an unrelated project's prompt.

Verification: `composer-session.test.tsx` renders the actual ChatView, drops `/tmp/only-for-A.txt` in A, switches to B, sends `查看 B 的任务`, and confirms bucket B plus attachment sessionId A. The real `buildInputAttachmentContext` reports `session mismatch: expected B, got A` (1 pass / 5 assertions). Confidence: high.

Suggested correction: store all composer reference state by conversation identity, including asynchronous staging identity, and restore it with that conversation's draft.

## D3 [P2] Queued follow-ups stop progressing when the conversation is in the background

Primary location: `packages/desktop/src/renderer/app/useRunController.ts:664-677`, `:767-798`.

The effect only inspects `queuedInputs[activeBucket]` and gates on foreground `busy`; it never drains other buckets when `busyKeys` changes. External runtime queues explicitly cannot steer (`:673-677`) and rely on the later idle-send branch.

Trigger: while Codex/Claude conversation A runs, queue a follow-up, switch to B before A completes.

Impact: A completes but its next task remains unsent indefinitely until the user selects A again. This defeats parallel/background work; the queue UI does not explain that selecting another conversation pauses the pipeline. Attachment-only native queues can be affected similarly.

Verification: `run-controller.test.tsx` starts with A busy and queued, switches to B, then removes A's busy key. The real hook performs zero sends and leaves A's item queued (1 relevant pass). Confidence: high for mechanism; medium-high for intended UX (current code comments promise next serialized turn).

Suggested correction: drive serialized queue progression by each bucket's runtime state, independently of the currently viewed conversation.

## D4 [P2] Approving one of multiple pending tools makes the next card look approved and removes its controls

Primary location: `packages/desktop/src/renderer/ChatView.tsx:1374` and `:1577`; local terminal state in `packages/desktop/src/renderer/approvals/ApprovalCard.tsx:68-72`, `:94-97`, `:139-149`.

Both inline and sticky ApprovalCard instances are rendered without a request identity key. `decided` initializes only once. When the queue still has another request, deciding the first replaces props in the same component; React retains `decided` for the second request. `MessageStream` trailingKey is a scroll trigger (`MessageStream.tsx:199`), not a React identity key.

Trigger: the model requests two GenerateImage operations in one response in default permission mode; approve the first once. Real builtin metadata marks GenerateImage concurrency-safe (`packages/core/src/tool-system/builtin/index.ts:333-343`), while default PermissionClassifier returns ask (`permission.ts:1573-1584`). `StreamingToolQueue.enqueue` immediately starts each safe call (`streaming-tool-queue.ts:46-53`). A separate real Core queue/executor/permission test reaches two simultaneous pending approvals before answering either; both are denied in the test so no provider is contacted. Bash is serial and is not needed for this production trigger.

Impact: second request's tool content appears with `已批准` and no allow/deny controls, though no decision was sent for it. The agent remains blocked until another surface is opened or the card remounts. This can also occur across conversations if switching directly between pending cards.

Verification: `approval-queue.test.tsx` renders actual ChatView with req-A and req-B, approves req-A, then checks req-B's `second image` description is visible, `仅本次批准` has disappeared, `已批准` appears, and decision call count remains 1 (1 pass / 5 assertions). Confidence: high.

Suggested correction: key ApprovalCard by sessionId/requestId or explicitly reset all local request state when that identity changes, in both rendering sites.

## D5 [P2] A delayed plugin command overwrites the next conversation's unsent draft

Primary location: `packages/desktop/src/renderer/ChatView.tsx:981-987`; destination selection at `packages/desktop/src/renderer/App.tsx:376-383`.

Trigger: run `/demo:review src/A.ts` in conversation A; while command expansion IPC is pending, switch to B, which already contains an unsent draft. ChatView remains mounted and only checks mountedRef after the await. Parent's draft setter chooses activeBucketRef.current when the promise completes.

Impact: A's expansion replaces B's entire unsent draft; A retains the original command. This is actual user draft loss, separate from D2's stale synchronous attachment state. Similar identity handling is worth checking for transcription and image staging.

Verification: second case in `composer-session.test.tsx` renders actual ChatView and uses the same dynamic-ref parent setter as App. Expander starts with `{sessionId:"A"}`; after switching, B's `B 已经写好的重要草稿` becomes `A 的 review 命令展开内容`, while A stays `/demo:review src/A.ts` (1 relevant pass / 5 assertions). Confidence: high.

Suggested correction: capture the source bucket and draft revision at invocation, write results to that source draft, and preserve text edited during expansion.

## D6 [P2] Sticky AskUser state crosses request boundaries and can crash the next question

Primary location: `packages/desktop/src/renderer/ChatView.tsx:1573`; unsafe retained-index dereference at `packages/desktop/src/renderer/messages/AskUserMessageView.tsx:108`.

Trigger: A has a pending multi-select question with three options and the user selects option 3. Switch directly to B with a pending multi-select question containing one option. The unkeyed sticky AskUserMessageView reuses local picked={2} (`AskUserMessageView.tsx:33`) for B.

Impact: B's submit button is enabled with no visible selection; clicking it attempts `message.options[2].label` and throws TypeError. The unseen stale index remains, so clicking B's visible option does not clear the invalid pick; the user must remount the surface to recover.

Verification: second case in `approval-queue.test.tsx` renders actual ChatView, selects the third A option, switches to shorter B question, and asserts B submit is enabled and clicking throws (1 relevant pass / 3 assertions). Confidence: high. This shares D4's missing request identity pattern but affects a distinct component and user interaction.

Suggested correction: key the sticky question by request identity (as MessageStream already does for historical questions) and defensively validate picked indexes.

## D7 [P2] A Core worker exit hides controls for a still-running external runtime

Primary location: `packages/desktop/src/renderer/app/useHostSubscriptions.ts:1026-1036`; common route insertion at `packages/desktop/src/renderer/app/useRunController.ts:268` (same route map is used before either native or external dispatch).

Trigger: a native Core session and a Codex/Claude external session run concurrently; the Core worker exits/crashes while the external provider process keeps running. Main broadcasts exited via `packages/desktop/src/main/agent-bridge.ts:395-409`. The renderer blindly removes all buckets in engineToBucketRef from busyKeys, including external sessions.

Impact: the external session falsely becomes idle and its Stop button disappears while it can still stream or execute tools. An external queued follow-up can also start its renderer send path prematurely. The worker lifecycle already distinguishes native/external approvals, but not busy state.

Verification: `worker-external.test.tsx` uses the real useHostSubscriptions hook with native and external bucket routes and two busy flags. Delivering `{type:"exited",code:1}` clears both, although no external runtime termination occurred (1 pass / 3 assertions). Confidence: high for logic and the crash trigger; no claim that clean exits occur after every production run (the source comment says that, but worker residency should be checked separately).

Suggested correction: retain runtime origin per run/bucket and clear only Core-owned activity when the Core process exits.

## Reproduction commands

From the snapshot root, each passed separately:

```
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-desktop/preload-envelope.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-desktop/run-controller.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-desktop/composer-session.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-desktop/approval-queue.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-desktop/concurrent-approvals.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-desktop/worker-external.test.tsx
```

Total: 13 passing reproducibility checks (including assertions of the buggy behavior), zero final failures. Per-file counts: preload 2, controller 5, composer 2, approval/question 2, production concurrency 1, worker lifecycle 1. Early harness errors (missing React DOM path, missing IntersectionObserver, localized button label mismatch) were corrected in /tmp; they were fixture issues, not counted as product findings.

Saved runner output: corresponding `*.log` files in this directory. `validation-summary.txt` records test counts.
