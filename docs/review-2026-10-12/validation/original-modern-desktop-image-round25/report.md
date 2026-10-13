# Round 25 author evidence — modern Desktop image summary

Author latest-only run completed at clock UTC2026-10-12 00:52:56 / Singapore08:52:56. Product code, builds and installed dependencies were not changed. This report proposes one narrow P3; it does not assign R85 or change the formal R84/84-findings/84files248tests checkpoint. Parent independent frozen-baseline reproduction and quality review remain required.

## Observed user-flow defect

An accepted current paired-native `chat.send` containing text+image or image only has a valid modern durable journal. On cold recovery into the ordinary Desktop conversation, the actual recovery and hydration reducer preserve clean user text plus one structured image attachment with originalName=modern-shot.png, mime=image/png, size=68. Actual MessageStream SSR renders the text but no attachment name in the text+image case. For the pure image case it omits the entire user bubble. The saved assistant answer remains visible in both cases. Original input bytes and the canonical journal remain intact.

Root cause: `packages/desktop/src/renderer/MessageStream.tsx:441–446` decodes only legacy inline codeshell-image from m.text, and returns null if decoded text/annotations/inline images are empty. The ordinary MessageStream never consumes m.attachments. The modern canonical projection deliberately has no repeated base64: `types.ts:858–906` correctly stores safe metadata in attachments. App:2443 and ChatView:1504–1505 pass the recovered messages to this ordinary renderer. PetChatHost is a separate route and is excluded.

Narrow trigger: an existing paired-native Session is selected in Desktop with no prior Desktop optimistic inline copy. Real paired producer `mobile-chat-turn.ts:77–106` permits either text or images and sends no displayText. Host protocol forwards the resulting undefined displayText/false injected; real image-input helpers and Transcript writer produce the legal native input. `run-stream.ts:72–92` writes its canonical user anchor only to the durable journal, so the observation is about later recovery, not immediate live-echo removal.

## Normal controls and limits

Both scenarios retained an actual one-image user object, clean prose (or empty prose for pure image), and the actual durable output cursor. The same actual journal page through the Web reducer and Workbench SSR displayed modern-shot.png. The actual Desktop inline encoder and appendUserMessage control rendered the filename and data URL. That control reconstructs the initial optimistic display; it is not an executed send hook. Both staged original files exactly matched the valid68-byte PNG from attachment-service.test.ts:28–33, SHA256431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460.

No historical thumbnail, privileged image read, click-open, download, lost-input or lost-bytes claim. The old archive image design:161–162 deferred historical image parsing/cache; current durable-output-journal-delivery:84–101 and existing useTranscriptBuckets tests provide safe canonical metadata, but their tests assert state rather than MessageStream rendering. The lower bound is absent already recovered names/counts and the missing image-only bubble. Ordinary Desktop native send/reopen expansion, Quick Chat, steer, rooms and external CLI remain static/unclaimed dynamic scope. Modern cursor hydration starts from action.state at transcriptHydration:243–340 and keeps only this hydration's local actions/prior pending drafts, while legacy replayBase merging starts at342. An already hydrated open bucket is not asserted to fail immediately.

Distinct from R84's never-published legacy fallback raw internal prose, R54's drag acceptance and R58's read authority. One renderer root cause covers both tested inputs.

## Executions and provenance

First authorized source8a033c557babcc11bbf1b8b8fe33543324c7e2fea509f5931adf3d02187262c4 failed at Workbench:105 because MiniDom lacked matchMedia: actual printed0 pass/2 fail/22 Bun expect/no Completed. It reached Desktop omission assertions and Web metadata assertions but not later Workbench/inline/byte controls; no passing result is inferred from this partial run. Full first source/log/receipt remain in first-authorized/.

Root independently preserved that failure and changed only the SSR viewport adapter after ensureMiniDom, with matches=false and empty add/removeEventListener methods. Author verified the exact unique delta before the second run. Active/frozen source SHA256411b12bcb249b6eeb5465fe67f1f30555ecc5fb2232c219c602e0ce1df049ca9; guard SHA2566e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d. Guard and business logic/assertions were unchanged.

Second authorized command from frozen latesta66f:

`node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-modern-desktop-image-round25/modern-desktop-image.test.ts`

Actual print:2 pass/0 fail/32 expect() calls; Completed Bun shard:2 tests,0 skipped;0 failures. This is author latest-only execution, separate from later parent baseline runs. Node guard/control assertions are not added to Bun counts.

Dynamic: actual paired staging/request helper, real Core dist SessionManager/Transcript, actual source image-input helpers, actual Core dist run-stream/journal publisher/writer, real Desktop registrar and preload facade, actual recovery+hydration reducer+MessageStream SSR, actual Web reducer+Workbench SSR, actual inline encoder+append control. Controlled seams: submit acceptance instead of worker, IPC invocation transport, run output events, MiniDom viewport. useTranscriptBuckets/App/physical paired UI wiring is static. No Engine.run, provider, worker, real Electron, authority service, real phone, socket, Git/CLI or paid model executed.

Five Desktop @ UI leaf identities forward the actual leaf exports under both alias and absolute paths. No MessageStream user/image branch or canonical recovery logic is mocked.63 source/dist/contract paths are recorded; both frozen trees have all paths,61 match and Core public src/index.ts/dist/index.js differ only VERSION0.9.32→0.9.33. Resolution-only addresses are logged separately: author /tmp Core public/internal and server storage resolve to existing dist, Web resolves source. This is not a module-cache/import graph probe.

## Exact artifacts and cleanup

Prepared PLAN.md remains the pre-execution plan. Frozen second-authorized/ contains modern-desktop-image.test.ts, network-guard.ts, PLAN.md, root-match-media-correction.json, frozen-inputs.json, second-authorized.log, observed.json, source-manifest.json and result-summary.json. The observed receipt includes both Desktop/Web/optimistic markup, recovered user fields, cursor, PNG hash, producer keys, source hashes, phase and cleanup. All paths are relative to this owned /tmp directory; source evidence remains frozen.

Both executions used maintained private HOME guards before product imports. attempts=[]; no network/listener/child/worker request was made. Each scenario's owned Session and attachment cwd were removed with ownedFilesRemoved=true and errors=[]. For the second run the maintained private HOME and runner root were independently verified absent after runner completion. First failure has its own same cleanup proof. In-process guards are not claimed as an OS sandbox.

Conditional history pagination material remains static-only at /tmp/codeshell-review-20261012-history-pagination-round25/static-preflight.md, not a second executed fixture or formal finding.
