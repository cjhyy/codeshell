# Round 24 candidate: old paired-native image history displays model path hints as prose

Author stage completed at Singapore 2026-10-12 08:22. This is a **P3 candidate pending root portable reproduction/quality review**, not a newly assigned R-number or product fix. Product changes, build/install, paid models, external services and real CLI/worker execution: 0.

## Narrow trigger and result

A user reopens a valid native Session originally sent through paired `chat.send` before durable output journals were introduced. The Session never published a journal; it still contains a canonical saved image message and the staged image bytes. Current paired Web negotiates `outputJournal:1` and takes the deliberately supported journal-unavailable compatibility path.

The actual restored user text becomes:

```
Describe the saved image

<attached-image-paths>
.code-shell/attachments/legacy-image-round24/431ced6916a2a21a-historical-shot.png
</attached-image-paths>
(上面附带的图片在工作区的真实路径，如需把它们作为工具输入（例如 GenerateImage 的 referenceImages、图生图参考图），直接使用这些路径。)
```

There is no user `attachments` summary. The actual Workbench server-rendered markup visibly contains the escaped wrapper, plain prose and recorded assistant answer. This is an old-history display/projection defect only. No original image bytes, upload data, historical thumbnail, accepted task or provider input was lost. Original/staged PNG remains exactly 68 bytes with SHA-256 `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460` before and after both recovery paths.

Proposed minimal code-review location: `packages/server/src/mobile-remote/mobile-history.ts:34-35`, where every FoldItem user becomes `{type:"user_message",text:item.text}`. The upstream reader at `packages/desktop/src/main/transcript-reader.ts:255-262` chooses displayText or raw text ContentBlocks and carries no attachment summary. The shared browser projection does not repair this envelope: `projectOutputUserEvent` accepts only `session_user_message`/`steer_injected`, so this synthesized `user_message` enters the reducer unchanged. `Workbench.tsx:620-622` renders its text directly.

Suggested direction: give legacy native history the existing safe user-message display projection, preserving ordinary user-written XML and respecting clean displayText. Do not add required historical thumbnails/download APIs, discard authorization checks, or treat a missing previously-published journal as legacy success.

## Why this is a real old producer format

The journal file was introduced by `8dc1cfe870a3ab90dee103f69975ac47dba51be8` at 2026-10-09 05:16:26 +08:00. Its parent is `c9b1d95979a0ca12faedeba9fadf81e8ddda680f`. Before that introduction and at 84740d56, the actual producer modules have identical Git blobs:

- `run-image-input.ts`: `4a28a57c65b7748820c207b3ece2c7031687865f`.
- `input-attachments.ts`: `c49f0dd6e9db2876111bd0473b9812af9af4478b`.

The actual producer is Engine input preparation → `buildInputAttachmentContext` → `buildRunUserMessageContent` → `openRunSession` → `Transcript.appendMessage`. The fixture invoked the actual preparation/content helpers and real SessionManager/Transcript writer, with a valid staged PNG. It did not hand-author XML, start Engine/model inference, or delete a modern journal to manufacture legacy fallback.

The omitted clean `displayText` is also a producer fact. Current `mobile-chat-turn.ts:95-106` and the pre-journal parent's corresponding request omit displayText and injected. Current/pre-journal AgentServer reads only `params.displayText`, normalizes its absence to undefined, and enqueues `injected:false`; ChatSession forwards those fields; `openRunSession` passes them to appendMessage. The fixture explicitly used `{injected:false,clientMessageId:"prejournal-image-input",displayText:undefined}`. This report does **not** generalize wrapper prose to Desktop or Panel producers that supply clean displayText.

## Supported fallback and TODO/retention limits

- `mobileOutputRecovery.ts:49-89` returns null for a never-published unavailable native journal; `mobileOutputClient.ts:190-193` invokes legacy; `useRemoteApp.ts:538-541` requests `session.history`. The fixture observed that actual sequence and consumed the real response from `handleClientEvent` → `getSessionTranscript` → `buildSessionHistory`.
- `docs/todo/mobile-output-journal-delivery.md` retains conservative old-peer/output degradation. It does not state that existing native old user inputs should show internal path wrappers; arbitrary historical imports are separately deferred and were not used here.
- The existing first-version image delivery contract at `docs/todo/small-features-2026-07-10/mobile-remote-send-image.md:211-217` calls for hiding the path block and at least indicating an image attachment when historical summaries are unavailable. It explicitly does not require historical download APIs. Browser object URLs and temporary thumbnails therefore are not part of the finding.
- Sent staged files have a 30-day retention policy (`attachment-service.ts:123,448-457`); the five-minute Mobile upload-ticket TTL is separate. This experiment did not rely on expired upload tickets, browser URLs or cleanup, and verified that the exact original staged bytes remained present.
- Static authority review supports a healthy native/no-repo Session with no journal and no pin. The dynamic fixture **did not invoke** real `mobileOutputRecoveryAuthority`, which would probe local Git. Authentication/authority were explicit controlled synthetic device/viewer/Session seams; the service's own Session/selection/viewer consistency checks remained production code. Do not claim real mounted-root authority acceptance was dynamically measured.

## Normal controls and measured scope

The recorded ordinary prose and assistant answer survive the legacy replay. After that first read, a real `SessionOutputJournal` was created for the same Session using the exact legacy transcript cutover, with matching real snapshot cursors. Reselecting through the actual hook then restored clean user prose plus `historical-shot.png`, 68-byte size, MIME, path and clientMessageId, without wrapper text. This is a natural first-publication control; no published journal was unlinked, truncated or unpinned.

The modern control measured actual hook **projection**. Only the legacy state was rendered with actual Workbench SSR; there was no second modern markup render or real browser/Electron/physical-phone interaction. Actual Core run/LLM, native WebSocket, Git, worker and OS authorization behavior were not executed. The hook used an in-memory exact synthetic WebSocket adapter; its authentication/authority and the Bridge snapshot facade are declared controlled seams, not production-account/transport acceptance.

This root cause is independent of R54's missing Quick Chat drag callback, R39's archive navigation guard, R58's current-worktree image authority, R65's directory permission feedback and R09/R17/R20/R34 upload admission/lifetime. Existing fourth/twelfth/fourteenth file/history evidence did not test journal-unavailable attachment projection. Proposed severity P3: a compatibility display regression with preserved originals and a correct modern projection path; no claim of permanent data loss or blocked task execution.

## Author execution and evidence

Only the latest frozen checkout `a66f4ef291f304ee4df9da8095a90671d9a8f140` was executed by this author, using the maintained guarded runner. Root's later two-checkout portable runs must remain independent receipts; none are claimed here.

1. First authorized source SHA `338c90fd5af72029731105eb5f26bcc8372f862373475b90d9c7da4960ff3ccc` failed in producer preparation: an old Core pure-read test PNG had an invalid IDAT CRC and was correctly rejected by actual image staging. It never reached hook/fallback. **0 pass / 1 fail / 0 Bun expect, no Completed**; this is a fixture-input diagnostic, not a product defect or candidate refutation. `first-authorized.log`, `first-authorized.observed.json`, `first-authorized.source-manifest.json`, and `legacy-native-history.first-authorized.ts.txt` are preserved. Cleanup reported no allocated Session/attachment directory remaining; hook/recovery were not created in this failure.
2. Root independently checked the valid PNG in `attachment-service.test.ts:30`/`mobile-chat-turn.test.ts:11`, then changed only that fixture byte constant and its source comment. `png-fixture-correction.json` preserves the change provenance. Corrected source SHA `dfe9749f86552d7529af7ea9d323d43ce95904ee82d5654201b17c3f62d221e3` was separately authorized and executed once. **1 pass / 0 fail / 0 skip / 17 Bun expect**, with `Completed Bun shard: 1 tests, 0 skipped; 0 failures.` Node assert checks and guard assertions are not added to Bun expect counts.

Final receipts: `second-authorized.log`, `second-authorized.observed.json`, `second-authorized.source-manifest.json`, `legacy-native-history.second-authorized.ts.txt`. The active fixture remains frozen at that corrected SHA. Original prepared source/plan and their pre-execution diff are retained under non-active diagnostic filenames.

The first import is an unchanged full copy of the previously-audited round23 guard, SHA `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`. It verifies maintained private HOME, installs exact-origin confinement before product imports, then denies even the dummy origin, plus fetch/http(s)/net/tls/dgram/real WebSocket/listeners, child_process/worker_threads/Worker and Bun network/spawn APIs. The later synthetic WebSocket opens no socket and is not a guard negative probe. Both attempts recorded `attempts:[]`; this is an in-process guard, not a universal OS/native network sandbox.

AfterAll records completion/phase/failure, private HOME/owned paths, source SHA manifest and resolution-only package addresses, PNG byte/hash observations and cleanup. Final successful cleanup explicitly revoked the owned viewer, unmounted the hook, settled owned dispatcher promises, and removed owned Session/attachment directories, with no cleanup errors. Source provenance is source-audited, not an import-graph/module-cache probe. SessionManager construction explicitly uses Core dist; other production package resolution addresses are recorded without pretending to inspect the entire transitive graph.

Command for the author run, from the latest frozen checkout:

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-legacy-history-round24/legacy-native-history.test.ts
```

No additional test repetition or broader suite was run. Formal report numbering and integration remain with root after independent portable validation and quality review.
