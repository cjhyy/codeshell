# Release UI operation audit — 2026-10-16

Status: in progress. A passing row covers its stated fixture and boundary; this
is not a claim that every platform, external account, or packaged release works.
Continue the loop: operate the current interface, retain the failure, fix the
cause, repeat the operation, then check the combined build.
The release target is macOS, Windows, Linux Desktop and Web. Authorized native CI
has now executed; its passing and incomplete boundaries are recorded below.
Cross-platform fixture tests alone are not native acceptance.

The latest completed run, CI20, failed overall. Web passes its job. macOS and
Linux each complete the original 18-operation/four-Main subset and two new draft
operations, then the third draft operation stops on an ambiguous panel locator.
Windows stops earlier in thirteen platform-dependent pure tests; no Windows
native suite or installer runs. Later native suites and installer acceptance
remain incomplete. See the
[CI20 failure record](#ci20--panel-locator-and-windows-test-portability-failures).

CI14 remains the latest fully passing matrix. The
[CI17 record](#ci17--windows-nsis-failure-without-an-artifact), CI16 fixture failure
and earlier CI15 native failures remain separate source-bound evidence. CI17's
Windows installer phase/cause and missing Windows receipts remain unverified;
CI18 skips NSIS after the earlier failure. The
[CI18 preparation record](#ci18--frozen-candidate-awaiting-native-execution)
retains its original local-only scope and does not assert native success.

## Reproduced and repaired

| Area                                       | Real trigger and failure                                                                                                                                                                                                                                           | Repair and regression                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop browser                            | Switching internal tabs destroyed the guest, page draft and navigation history. Changing the guest set also replaced unsubmitted address drafts.                                                                                                                   | Retain each guest with its own navigation listeners, activate only the selected automation target, discard after idle, preserve unsubmitted addresses. `e2e-panel-operation-cycles.mjs`: guest identity, draft, history, background navigation, close, idle reconstruction, load failure/retry. Idle time is advanced in the owned fixture; it is not a five-minute wall-clock soak.                                                                                                                                                                           |
| Desktop panel sizing                       | A 390px viewport kept a 479px dock and clipped actions.                                                                                                                                                                                                            | Constrain the dock to its parent and wrap browser actions. Native screenshots at 390/768/1280px.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Review                                     | Selecting a repository's initial commit showed “no changes”; invalid Git ranges also appeared empty.                                                                                                                                                               | Read a commit with `git show --root --first-parent`; propagate real Git errors. Real repositories cover root, ordinary and merge commits, bad index/recovery, working and staged changes.                                                                                                                                                                                                                                                                                                                                                                      |
| Credentials                                | Pending saves could be repeated; rejected writes escaped to an unhandled renderer error; old project completion cleared another project's form.                                                                                                                    | Lock before dialog/IPC, disable pending controls, present a generic error, preserve failed drafts, remount forms at the project boundary. Native create/grant/environment/cookie/rename/delete/restart and A→B pending completion cycles.                                                                                                                                                                                                                                                                                                                      |
| Static plugin export                       | Long review content and action labels overflowed narrow dialogs.                                                                                                                                                                                                   | Bound grid content and wrap actions; real export picker cancel, existing-target rejection, duplicate click and successful file output.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| MCP settings                               | Pending mutations stayed clickable and long commands pushed actions outside the viewport.                                                                                                                                                                          | Serialize mutations and constrain cards/actions. Native stdio initialize/tool discovery, settings rejection/retry, atomic rename, missing-executable recovery, deletion and cold recovery passed twice on the combined build; retain the earlier unclassified failure.                                                                                                                                                                                                                                                                                         |
| Automation                                 | A delayed failure from task A appeared in task B after selection changed.                                                                                                                                                                                          | Store action errors by job. Native schedule save/retry/reload, prompt cancel/failure/retry, resume failure/retry/pause, delete failure/retry; successful mutations reach the real Cron store. No run-now/model turn.                                                                                                                                                                                                                                                                                                                                           |
| Desktop cold start                         | The renderer called `pet:set-active-session` before Main registered its handler.                                                                                                                                                                                   | Register the Pet APIs before loading the renderer while hydration continues behind their ready promise. Three cold launches, renderer reloads and a second main window verify the native load boundary and actual Pet IPC.                                                                                                                                                                                                                                                                                                                                     |
| Concurrent project migration               | Two fresh renderer windows each obtained an empty migration token; the second completion threw after the first wrote the durable marker. This appeared in actual packaged Main stderr.                                                                             | Permit completion-only replay for a token issued by the current service whose pending paths are empty. Invalid, pending and restarted-service tokens remain rejected; authorization still closes after completion. Real ProjectStore/parallel renderer regressions verify one marker write and unchanged bytes/inode/mtime on replay. Three actual cold launches/reloads plus a second window then completed with zero migration errors in captured Main stderr.                                                                                               |
| Web transcript recovery                    | A pending restore accepted a send and later replaced it; live text received during durable recovery could be dropped.                                                                                                                                              | Block send until restore finishes, fold the final notification buffer, scope cursor/error commits to the current load.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Web repeated stop                          | Repeated clicks sent duplicate cancellation requests.                                                                                                                                                                                                              | A synchronous per-session cancellation guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Web mobile composer                        | Resize immediately before Enter could submit using stale wide-layout state.                                                                                                                                                                                        | Read the current media query at the key event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Web questions                              | Choice labels/descriptions and options-only constraints were not rendered; optional asynchronous questions blocked subsequent tasks.                                                                                                                               | Render single/multi choice controls and preserve synchronous approval blocking. Optional questions remain answerable while work continues.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Web late errors                            | Failed run/cancel/approval/upload responses appeared in another selected session.                                                                                                                                                                                  | Keep errors with the initiating session; preserve global authentication expiry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Web delayed conversation title             | Actual Worker completed B, the user switched to A, then B's auxiliary title finished. The durable title and event were correct, but the shared sidebar retained B's old title.                                                                                     | Refresh the shared session list/history on title events. A request revision prevents an older list success or failure from replacing newer results; authentication expiry remains global. Actual Host/Worker/SSE regression preserves A's draft while B's late title updates, with separate unit races for old 200/500/401 responses.                                                                                                                                                                                                                          |
| Web question drafts                        | Switching sessions while an answer was pending unmounted its form and lost the answer on failure.                                                                                                                                                                  | Keep unresolved forms by request and hide other sessions accessibly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Ordinary-session write recovery            | Background filtering hid the only uncertain-write review entry for a normal conversation.                                                                                                                                                                          | Add the existing review UI to conversation management, loaded only on request. Native cancellation, read-only reconciliation, manual uncertainty acceptance and cold Main/Engine recovery preserve the original unknown result and never replay its write.                                                                                                                                                                                                                                                                                                     |
| Execution trace keyboard access            | At 820px the focused final type filter was clipped; retrying a failed detail dropped focus to the page body.                                                                                                                                                       | Scroll the focused filter into view and move retry focus to the stable detail heading. Native geometry, hit testing and focus checks at 1280/820/390px in light/dark themes.                                                                                                                                                                                                                                                                                                                                                                                   |
| Web authentication                         | A real tab status check invalidated an outstanding successful login. An old device-revocation 401 could also expire a newer login.                                                                                                                                 | Suppress status reads during login and bind authentication-loss callbacks to the initiating login identity. Actual cookie HTTP/WebSocket browser sequences cover both races, explicit logout with pending chat work, and a current-login 401 after closing its dialog. Hosted Linux Chromium under Xvfb passes all four, including actual blur followed by a trusted focus event.                                                                                                                                                                              |
| Language and theme preferences             | The selected language card stayed stale, another same-origin window did not follow language changes, and switching a manually booted theme to System missed later media changes.                                                                                   | Use the language provider as the selected-card authority, listen to native storage events, and retain the media listener while checking the current stored mode on every event. Seven focused scenarios, six real-browser sequences, and six actual macOS Electron sequences across three cold Main processes pass. The same native sequences now pass on macOS, Linux and Windows, including the independently audited CI13 matrix.                                                                                                                           |
| Packaged update checks                     | The installed updater emitted an error event and then rejected its promise: a real missing-manifest 404 changed from not-available to error. Filename-only classification also hid 401/403/500/invalid YAML.                                                       | Use one error policy for events and promise rejection; only an actual 404 status denotes a missing manifest. Actual packaged Main/preload/Settings/electron-updater verifies five response classes and five healthy retries, ten exact manifest GETs, no asset/download/install action.                                                                                                                                                                                                                                                                        |
| Review diff paths and lines                | Hunk body lines beginning with `+++`/`---` were mistaken for headers; rename and Git-quoted Unicode paths could target the wrong file.                                                                                                                             | Parse headers in their actual section, decode Git quoting and preserve real rename paths. Actual macOS Main/Review/preload/renderer passes four diff checks and four plain-click file previews against owned Git. Three-platform CI now includes this operation family.                                                                                                                                                                                                                                                                                        |
| Host project case policy                   | A Web client lowercased POSIX paths and could create a session in the wrong case-distinct Linux project.                                                                                                                                                           | Project metadata carries the Host's case policy; grouping and session creation share that policy and prefer stable project IDs. Actual React handler and owned path-policy tests pass. This is not native Linux Host registration acceptance.                                                                                                                                                                                                                                                                                                                  |
| Context forwarding after truncated history | Selecting RECENT from the actual 512 KiB history tail could forward OLD because visible groups used raw-history ordinals.                                                                                                                                          | Preserve durable source event IDs and resolve the exact raw range; reject unknown, ambiguous or discontinuous mappings. Eight actual reader/fold/React-handler scenarios pass without invoking a fork or provider.                                                                                                                                                                                                                                                                                                                                             |
| Multiline annotations                      | Actual CommentBox typing and Save retained the full text, but its wire projection displayed only the first line and interpreted colon/fake-entry text as other fields.                                                                                             | Version only new multiline blocks and consume a bounded explicit line count. Actual CommentBox/codec/AnnotationsBlock passes eight browser sequences at 1000/390px, with whitespace and fake-format text preserved. Ordinary single-line wire stays byte-compatible; ambiguous historical unframed comments are not guessed.                                                                                                                                                                                                                                   |
| Web child-stream lifecycle                 | Background child detail changed a completed parent to running; a child error also cleared the parent's live output. Supported orphan tool results bypassed ordinary display cleanup.                                                                               | Keep child activity in its own bucket, retain the parent's lifecycle and normalize both tool-result orders equally. Combined reducer/replay/controller regression passes 86 tests/242 assertions. Actual Workbench/ProtocolClient browser verification passes eight sequences at 1280/390, with real Send/Stop and expanded tool-result controls.                                                                                                                                                                                                              |
| Native file labels and image previews      | Actual Windows Files/CommentBox displayed the complete native path as its short filename. Real React tests additionally exposed incorrect drive/UNC image IPC paths, root-level Markdown image directories, and a POSIX media fallback losing a literal backslash. | Preload platform selects native separators for display and dirname; complete locators and file authority remain unchanged. Image attachments preserve native absolute paths and join relative paths only once. FilesPanel, Markdown, attachment/media cards, recent references and workspace labels share the display helper. The combined focused shard passes 115 tests/386 assertions, followed by Desktop build and all 14 workspace typechecks. Actual Windows Files/CommentBox and image paths pass in the independently audited CI11 and CI13 matrices. |

## Evidence boundaries

Run Bun units through `node scripts/run-bun-test-shard.mjs`; run native fixtures
through `node scripts/run-isolated-node-smoke.mjs`. Desktop builds must finish
before tests consume their emitted assets. Package release verification owns a
clean dependency rebuild and must finish before other checks read `dist/`.

| Suite / operation family                                | Boundary actually exercised                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke-panels.mjs`                                      | Compiled Electron Main/preload/renderer, actual stdio Engine worker, owned HTTP streaming provider, real synthetic tool actions, usage/cache and 429 recovery. Network and native custody receipts are retained.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `e2e-panel-operation-cycles.mjs`                        | Native Electron guests, real files and multiple roots, Git and PTY. Owned folder picker result and local HTTP page; no external browser account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `e2e-panel-recovery-ui.mjs`, `e2e-panel-app-window.mjs` | Install/update/rollback review, cancellation, duplicate click, two-project isolation, corrupt repair, retained document bytes, actual cold Main restart, window identity and cleanup. Synthetic Panel packages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `e2e-credential-operations.mjs`                         | Real Main encrypted credential stores and owned browser login/cookie flow. Selected requests are held/rejected to exercise failures; other IPC invokes production handlers. OS modal answers are controlled fixture results.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `e2e-automation-operation-cycles.mjs`                   | Real Main Cron store, renderer controls and durable reload. One update/resume/delete failure is injected; successful retries invoke original handlers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `e2e-startup-operation-cycles.mjs`                      | Real cold processes and window lifecycle. Observes native load/handler registration without substituting IPC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `e2e-pet-runtime.mjs`                                   | Actual compiled worker/Pet, local model, synthetic installed stdio MCP discovery, conversation/work continuation, memory cold recovery, native safeStorage. Existing default-Keychain metadata is pinned and verified unchanged; no operator plugin configuration or actual IM delivery is covered.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Local macOS arm64 package                               | Production `afterPack` supplies the locked Node archive and ad-hoc signs/verifies helpers, Node and the app. Builder identity is explicitly null; Developer ID signing, notarization and publishing are disabled. The first actual ASAR Main/preload/renderer/Node-mode-worker launch verified preimport guards and package identity, then failed before any model request: native `isEncryptionAvailable` entered without returning and shutdown timed out. Before/after full-tree hashes and deep strict signature verification matched; the private HOME remains because worker-exit receipts were incomplete. This is not a passing packaged Pet acceptance.                                                 |
| `e2e-ui-packaged.mjs`                                   | A new local ad-hoc app containing the migration repair passed 13 actual UI operations: settings navigation, owned directory-picker result followed by real theme review/install, `cstheme:` image decoding in both modes at actual 1280/768/390px BrowserWindow content widths, and persisted theme/mode after renderer reload. Seven screenshots retained. Main guard, normal-exit spawn count zero, model requests zero, native secret-storage calls zero, unchanged full package inventory/signature and private HOME removal verified. A post-run process-table observation found no command referencing that app or its private userData; this is not a historical all-OS-descendants exit acknowledgement. |
| Web `test-chat-operations-browser.mjs`                  | Actual Chromium/React/controller/ProtocolClient through native loopback HTTP/WebSocket. The Host protocol peer is a fixture; this suite does not invoke the Engine/provider. Covers 17 operation sequences including failures, reconnect, attachments, choices and scope switching.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Web `smoke-web-host-operations.mjs`                     | Actual SPA/AuthGate/Hub, headless Host and stdio Core worker against one owned SSE provider. A real upload 201 is held while switching A→B, then remains staged only in A. An owned WebSocket is dropped during streaming; missed journal events replay after reconnect with exactly one primary request per turn. A separate sequence reproduces and repairs the inactive conversation title. Model and auxiliary-title requests are counted separately after shutdown. Driver/Host/worker origin guards, process birth custody, provider closure and remaining-process receipts pass. Service workers are blocked; this does not test their lifecycle or a live provider/account.                              |
| `e2e-media-playback.mjs`                                | Production media protocol and actual Chromium WAV/MP4 decoding, seeking, coordination, range errors, missing/corrupt/outside-root rejection, narrow layout and session release. Generated local media only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Settings/model/theme/profile suites                     | Native IPC and synthetic local data. Theme surfaces, model configuration, static export output and memory promotion have separate receipts. MCP mutation and cross-project credential cases continue below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Background work/source suites                           | Real authoritative session/delegation/automation/background records and recovery; no model needed for synthetic history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Device relay / optimization lab                         | Owned local relay / feature-flagged fixture; current enrollment controls, cancellation, reconnect and restart. No public relay or live paid evaluation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Current operations / cost history                       | Operations UI uses native preload and a trace IPC shim delegating to compiled `ModelTraceHistory`/`ModelTraceStore`; independent read failures and session/log metadata are synthetic. Cost history uses production usage/trace IPC and compiled receipt stores, plus a fresh guarded driver and new Main PID for cold recovery. No provider/model request.                                                                                                                                                                                                                                                                                                                                                      |

## Three-platform acceptance preparation

An independent `desktop-ui-acceptance.yml` workflow builds native directory
packages on macOS, `windows-2022` and Ubuntu, then runs cold startup and the
packaged UI sequence. It is limited to manual dispatch or a dedicated acceptance
branch push, with read-only repository permissions. It uses no release identity,
notarization, tag or publishing command. Linux gets an owned Xvfb/SecretService
session and explicitly configured sandbox helpers. The later-discovered launcher
default and its correction are recorded below; earlier UI success does not prove
that Chromium sandboxing was enabled.
The user authorized pushing the dedicated acceptance branch and running native CI;
main, tags and publication remain outside that authorization. The branch is
`codex/desktop/release-ui-acceptance-three-platforms-20261017`.

| Remote run                                                                                                         | Actual result and retained failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [38940934896](https://github.com/cjhyy/codeshell/actions/runs/38940934896), source `ab8b03f86`                     | Workflow validation rejected job-level `runner.temp`; no native jobs ran. Owned evidence paths now initialize in a step via `RUNNER_TEMP` and `GITHUB_ENV`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [38941376217](https://github.com/cjhyy/codeshell/actions/runs/38941376217), source `2b3f60185`                     | Web ServiceWorker 11 and the complete macOS native job passed. Ubuntu startup/panels/composer passed, then a metadata `app.evaluate` reported a garbage-collected promise before memory UI operations. Windows failed its initial bounded process query during directory packaging; cleanup remained unproven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [38943220744](https://github.com/cjhyy/codeshell/actions/runs/38943220744), source `68677b058`                     | Web ServiceWorker 11 and complete macOS native job passed again. Ubuntu memory 7 also passed; packaged UI failed before App launch because the expected `code-shell` binary was absent. Windows' 30-second diagnostic returned valid identity rows after 17,743ms, but its immediately following normal five-second query failed. This is not accepted native Windows coverage.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [38982907208](https://github.com/cjhyy/codeshell/actions/runs/38982907208), source `6054fa9b6`                     | Complete macOS native job passed again. Ubuntu startup/panels/composer/memory passed; packaged UI still failed before launch because the first corrected name `code-shell-desktop` also omitted the npm scope. The locked builder actually computes `@cjhyycode-shell-desktop`; the subsequent repair derives its name from that builder and records actual package root entries plus executable hash. Web ServiceWorker and authentication cases 2–4 passed, while case 1 timed out waiting for a trusted native tab focus/visibility event before releasing login. Windows transport/profile timing diagnostics completed, but the original custody query still failed before packaging.                                                                                                                          |
| [39003474715](https://github.com/cjhyy/codeshell/actions/runs/39003474715), source `dac146ed2`                     | Complete macOS job passes, including packaged updater five modes/ten GETs and actual DMG install/replacement 13+13 UI operations. Linux preferences 6 and directory packaged UI 13 pass; updater makes zero requests because this artifact is a directory app without runtime-owned `APPIMAGE`. Windows clean-source build and packaging pass with fixed LF attributes and PowerShell 7 identity queries (472/487ms). Its three cold launches/reloads and second-window operations finish, then one shutdown custody query fails; the overall job fails and no full Windows acceptance is claimed. Headless Web again fails actual blur; other auth cases and ServiceWorker pass.                                                                                                                                   |
| [39004577231](https://github.com/cjhyy/codeshell/actions/runs/39004577231), source `ccaed3142`, manual `suite=web` | Web ServiceWorker 11 and authentication 4 pass in hosted Linux Chromium under Xvfb. The login tab reports `focused=false` before an actual trusted focus event, with no status read during its pending login. Native jobs are intentionally skipped in this diagnostic run; it is not a complete matrix pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [39007288837](https://github.com/cjhyy/codeshell/actions/runs/39007288837), source `34553b747`, manual `suite=web` | The expanded browser job passes: ServiceWorker 11, authentication 4, child-state/send/stop/tool display 8 and multiline CommentBox/save/display 8. New receipts bind clean source `34553b747`, normal browser exits and ten observed incarnations cleaned with zero remaining. Narrow screenshots were independently inspected. Native jobs are skipped while the Windows transport is repaired; this is not a full matrix pass.                                                                                                                                                                                                                                                                                                                                                                                    |
| [39008016212](https://github.com/cjhyy/codeshell/actions/runs/39008016212), source `1b4b3340f`                     | Web passes all 31 operations again. The complete macOS job passes, including updater and DMG, with 78 independent receipt checks. Windows now passes three cold Main launches/reloads/second-window and Review 8, then exposes a real Files UI defect: the comment title displays the full Windows path instead of `alpha.txt`. Main exits normally with zero remaining owned processes and no transport fallback. Linux passes all six source suites, sandbox-requested directory UI and the actual AppImage build; its updater fixture fails after successful extraction because a LICENSE file's mode changes from 0600 to 0644 while bytes match. No AppImage Main or updater request starts. Both first failures are retained, and neither incomplete platform is counted as fully accepted.                   |
| [39009261349](https://github.com/cjhyy/codeshell/actions/runs/39009261349), source `ec17b2054`                     | Web 31 and the complete macOS job pass again. Linux source suites, directory UI and real AppImage build pass; extraction passes the previous LICENSE comparison but now fails its stricter directory check at `locales`. Source mode is 0755; this receipt omitted the extracted mode, so no new directory conversion is assumed. Main/update requests remain zero. Windows fails in its first Main evaluation with “Resulting promise was garbage collected”, before any of the seven startup operations. Its final exit is 1/no signal, observed 32 incarnations settle cleaned/zero remaining with no query/transport/deny/worker failures, and HOME remains. The receipt does not establish whether that exit precedes fixture cleanup. Windows UI repairs and real AppImage runtime acceptance remain pending. |
| [39010572108](https://github.com/cjhyy/codeshell/actions/runs/39010572108), source `9cbd3a34c`                     | Windows completes all eight suites for the first time: 78 recorded checks and 12 actual Main launches, each with exit 0/no signal, observed custody cleaned/zero remaining/no query failure, and all eight suite HOMEs removed. This includes the actual Files short comment title. Web passes 31 behavior checks. Linux passes source suites, directory UI and real AppImage build; its new before-validation inventories prove 73 source directories change from 0755 to private 0700. The strict check stops before AppImage Main/update requests. macOS passes source and directory UI suites, then packaged updater metadata evaluation reports a garbage-collected promise before any updater operation; DMG is skipped. The overall matrix remains failed.                                                   |
| [39012279115](https://github.com/cjhyy/codeshell/actions/runs/39012279115), source `badc2262a`                     | All four jobs complete successfully for the first time. Web passes 31 behavior checks; Linux runs the actual AppImage Main and all ten updater manifest GETs; macOS completes updater and DMG install/replacement. The new complete-path PNG/history/collapse cases pass in all three native panel steps, adding two to the prior 18. Independent receipts from all three native jobs are checked. Linux screenshots still show Chinese glyph boxes, so Chinese visual acceptance remains open despite the green job.                                                                                                                                                                                                                                                                                               |
| [39013381607](https://github.com/cjhyy/codeshell/actions/runs/39013381607), source `3466cad1e`                     | Web's nine image unit regressions and 31 browser behavior checks pass. Linux completes all eight native suites and actual AppImage update checks; before/after font metadata plus five actual screenshots confirm Chinese glyphs in those samples. macOS completes native suites, updater and DMG again. Windows passes startup seven and Review eight with four normal Main exits, then fails the panel driver before its final report is written; the outer driver code is 1, not an observed Main exit. Later suites are skipped. Original panel error/stack, Main exit, custody and HOME outcome are unknown. Overall matrix is failed.                                                                                                                                                                         |
| [39015578143](https://github.com/cjhyy/codeshell/actions/runs/39015578143), source `ed07a8db9`                     | All four jobs and independent artifact audits pass. Each native platform verifies 83 behavior checks and 12 actual Main launches, including Review 11 and Panel 20. New mode-only/binary titles and the actual mode-only Files preview pass; bounded Panel diagnostics agree with the original report and normal Main/controller exits. AppImage updater and both DMG UI copies pass again. Web passes nine image unit regressions plus 31 browser behaviors. Earlier unknown failures remain unresolved historical evidence.                                                                                                                                                                                                                                                                                       |
| [39016494715](https://github.com/cjhyy/codeshell/actions/runs/39016494715), source `67e09d1f6`                     | All four jobs and independent artifact audits pass again. Each native platform verifies 83 real UI operations/12 Main launches and separately 11 Write-card React tests/38 assertions with no failures or skips. Current package integrity, Panel diagnostics, AppImage sandbox/update checks and both DMG UI copies pass. Web verifies nine image regressions, 31 browser behaviors and 88 recorded source hashes. No new blocker is found in this acceptance; earlier unknown failures remain separately preserved.                                                                                                                                                                                                                                                                                               |
| [39020679310](https://github.com/cjhyy/codeshell/actions/runs/39020679310), source `7e5570210`                     | Overall failed. Web passes 31 actual behaviors, nine image/45 assertions, 64 pure Node contracts and a separate expected-negative retention run. Linux passes 83 operations/12 Main and actual AppImage ten GETs. macOS first-cycle Pet IPCs return successfully, then its post-close Keychain identity check refuses; later native suites/DMG are skipped. Windows startup seven/three Main pass, then Review identity RPC rejects with PromiseGC before any Review operation; six later suites/NSIS are skipped. Both native causes remain unknown.                                                                                                                                                                                                                                                               |
| [39022606881](https://github.com/cjhyy/codeshell/actions/runs/39022606881), source `e7543a568`                     | Overall failed in Windows' new Review pure Node fixture (8 pass/four CRLF extraction failures), before native launch; 22 NSIS contracts pass but all Windows runtime/install stages are skipped. Web passes 31 browser behaviors, nine image/45 assertions and 64 lifecycle contracts. Linux and macOS each independently pass 83 native operations/12 Main, separate Write 11/38 and Review 12 pure contracts; AppImage ten GETs and both DMG 13-operation UI rounds pass. The fixture-only CRLF correction is reviewed with 13 passing contracts and awaits a new full run. Earlier native unknowns remain preserved.                                                                                                                                                                                             |
| [39023748382](https://github.com/cjhyy/codeshell/actions/runs/39023748382), source `70d2e3846`                     | Overall failed in actual Windows NSIS, then artifact upload/checkout cleanup fail without detailed errors. Corrected Review13/NSIS22 contracts and Write11/38 pass in retained logs; original eight native steps have API/stdout success but no Windows artifact for complete independent receipt/PNG acceptance. NSIS phase/cause/installed UI count and OS restoration remain unknown. Web31+9/45+64, Linux83/12+AppImage10GET, macOS83/12+DMG two13 UI all pass independent artifact audits. Earlier native causes remain unknown.                                                                                                                                                                                                                                                                               |

The CI12 Windows failure is frozen at
`ci-39013381607-windows-20261017/verified-summary.json` (SHA256
`04e9b8dd0e9b5b86aaf85f7c43609f4d3c16eccc7f7a06156aa7d9767a4fe0a0`).
Artifact `12094391101` retains 40 files, including the new generated-image
screenshot and three browser layout screenshots, but no panel report, failure
screenshot or body. The sole unsuppressed `git add alpha.txt` warning places
execution near the Review staged transition; sequential source order is not a
durable per-case receipt and those earlier panel operations are not counted as
formal passes. The outer isolated runner observes its Node driver close with
code 1/no signal and supplies only its own generic error. It does not observe
Main exit. No original cause, crash or GC classification is established, and
the prior CI11 green result does not replace this failed acceptance.

Independent source review identifies a persistence gap: the panel catch stores
the original exception only in memory before awaiting screenshot/body capture,
and its sole report write follows all cleanup. Missing screenshots do not prove
that catch was skipped, because screenshot failure is swallowed. The follow-up
adds bounded synchronous phase/first-error evidence and Main stream/exit
observations before diagnostic awaits, retaining the original 20 cases, timing,
custody and normal-exit requirements. Fixed commit `d8f9a2fad` has passed
independent review and the combined guarded Node shard (26 tests), syntax,
lint and formatting checks. Known UI, Main, custody, transport or server-close
failure now prevents owned HOME removal; a final report-write failure after
successful HOME removal cannot restore that directory. Diagnostics explicitly
distinguish those outcomes, incomplete case progress and controller/Main exits.
Passing runs still require the original successful cleanup. This is a fixture
evidence repair, not a diagnosis or fix of the CI12 first cause. Its four precise
artifact paths preserve the original report/body/PNG allowlist. The reviewed
changes are integrated and their real success-path artifacts are verified in
CI13 on all three platforms; CI12 is retained intact. Successful diagnostics do
not retroactively recover CI12's missing original failure evidence.

CI12's independently verified summaries remain
`ci-39013381607-web-independent-audit.json` (SHA256
`96a1727596ac98534d8abeb7fd778adea2e970b5ab38109d92c2d5ff2d9cbcb5`),
`ci-39013381607-linux-independent-audit.json` (SHA256
`1065e8d0dcac9f267d9540cc00a67b4d8b64c47bef2f2eda85b9194222499d7d`),
and `ci-39013381607-mac/receipt-audit.json` (SHA256
`a44591fee75dac879c41c623233019690ddb632e32a27741f07c8991cfd35358`).
Mac/Linux's strict source/package/exit/custody/HOME checks pass. Web verifies
its explicitly recorded checks and 88 source hashes, including the repaired attachment helper;
its unit nine/45 assertions are separate from the 31 real-browser checks.
The previously recorded SW/Auth lifecycle gaps remain. Mac's 98 receipt checks
include updater ten GETs and both DMG UI copies; old metadata GC stays unknown.

Linux's before-font receipt matches DejaVu Sans without Chinese coverage; after
installing the CI prerequisite it matches Noto Sans CJK SC with `zh-cn` coverage.
The actual generated-image, 1280px light Settings, 390px dark Settings, updater
404 and malformed-YAML screenshots all show readable Chinese. These five
samples close the previously observed glyph-box gap in this CI environment,
without claiming every glyph or Linux installation. Actual AppImage Main/runtime
identities, sandbox requests, source/cache bytes and full modes remain verified;
all eight suite receipts pass, including panel 20 and updater ten manifest GETs.

The recorded R2-10 header-only diff boundary is repaired in `9d7577249`:
real Git mode-only/binary/empty changes previously lost their paths, showing
unknown-file titles and wrong open targets. The parser now uses unambiguous
`diff --git` paths while preserving explicit header overrides and rejecting
ambiguous names. Actual temporary Git and React regressions reproduce the old
failure. The integrated combination passes 20 tests/65 assertions, Desktop build
and all 14 workspace typechecks. Independently reviewed fixture `a71af2f65`
preserves the original eight native Review operations and adds three: mode-only
and CJK binary cards plus the actual mode-only Files preview. All three now pass
in the actual Windows, macOS and Linux CI13 runs, with original Git fragments,
actual Main responses, renderer titles and exact Files preview bytes verified.
This product fix is separate from the unexplained CI12 Windows failure.

CI13's frozen independent summaries are:

- Windows `ci-39015578143-windows-20261017/verified-summary.json`, SHA256
  `8bd9310948361dcd917c3d7d10fa7257b902b50b057d260d5f8647a4c25a6d39`;
  separate advisory diagnostics summary
  `ca0464750a01210e32cd4e63351d46d9b249ba2f9c322134a59c3c8e3b5f7c51`.
- macOS `ci-39015578143-mac/receipt-audit.json`, SHA256
  `4e4c2c13cc905939aec4093fdcd1c2374e3ac4e148359ad7dd919fae8dfd792c`.
- Linux `ci-39015578143-linux-independent-audit.json`, SHA256
  `2a0cba288b8b9d4df09c5ae58ff400663a8e305906a2e995d2e3c59044f8b1f3`.
- Web `ci-39015578143-web-independent-audit.json`, SHA256
  `2824d1ee4a1774cb0a858df60bbdc4af412ec2790f6fc4004c792cf75ed1bbcb`.

Each native audit retains all original source/package/full-mode/observed-birth
custody/normal-exit/HOME gates. The 83 operation total is separate from receipt
consistency checks and the two additional DMG copies' 13/13 UI operations.
Panel diagnostics on all three platforms have all 20 case-progress names matching
the formal report, final-report-written, null firstError, no recording failure or
truncation and separate controller/Main normal exits. This validates actual
success persistence; the failure-path contract is covered by the pure Node tests,
not by inventing a native failure in this passing run. Web's 88 recorded source
hashes and 25 PNGs verify; Root also directly viewed 390px multiline annotations,
the reauthenticated Workbench and macOS's new mode/binary Review titles. The
previously recorded SW/Auth lifecycle receipt limits remain.

A subsequent independent task fixes the recorded Write-card byte-label candidate
in `656310a7c`. Actual React headings reproduced Chinese `2B` instead of UTF-8
`6B`, emoji `2B` instead of `4B` and live-argument miscounts. Memoized UTF-8
encoding now matches the production Write string encoding without changing paths,
arguments, body or file authority. The task shard passes 42 tests/131 assertions;
the integrated focused shard passes 11/38, followed by Desktop build and all
14 workspace typechecks. The first post-fix shard's unrelated lone-surrogate
preview assertion failure remains preserved; that malformed-input test now
checks only its byte label and unchanged args, while valid text cases still
verify expanded content. This is not a ToolOutputBlock preview repair.

`0fb0d7bd9` adds the 11-test guarded React shard and exact log artifact to every
native CI job after the completed build; it is counted separately from native UI
operations. `f4cf3b625` repairs the workflow path guard's TS-before-TSX prefix
match, which had falsely checked a nonexistent `.test.ts` name for the new
`.test.tsx` file. The actual path guard now verifies 24 paths, and workflow syntax
verifies two jobs, 34 Bash blocks and five inline Node blocks. All three commits
passed independent review. CI14 now verifies these changes on the exact
`67e09d1f6` source: each desktop platform retains an actual 11-test/38-assertion
passing log with zero skips/failures. Those React tests are separate from the
83 actual native UI operations and do not claim a real Write-tool execution.
CI13 success continues to apply only to `ed07a8db9`.

CI14's independently frozen results are:

- Windows `ci-39016494715-windows-20261017/verified-summary.json`, SHA256
  `d8136d63f0fad7d51d58f5a9ab88b6d6816d66c18ddddac37c3123c4dd3616e2`;
  Write unit summary `7361161374bf5571fc4d0f02184e82d1ec2f58b2d2e3084dbed1f9d8770e61bc`.
- macOS `ci-39016494715-mac/receipt-audit.json`, SHA256
  `df6269cde36b3301e168e11acfabc9b47a981de76058e5ed744788f42a445bc3`.
- Linux `ci-39016494715-linux-independent-audit.json`, SHA256
  `db74678baa1a882e11c0ae8c67a839de5117ca9623d129c206b901574e417c7d`.
- Web `ci-39016494715-web-independent-audit.json`, SHA256
  `57b0f52fadf550e3f60e72887d904b1287464b81c36297ff4dde62eb155bbdd7`.

All three native audits independently verify the current source/package identity,
83 operations/12 distinct Main processes, normal exits, observed-birth custody
cleaned with zero remaining/no query failure, and all eight scope HOMEs removed.
Review 11, Panel 20, preferences across three Main launches and updater ten GETs
pass. Panel's four diagnostic files agree with each original report and distinguish
normal controller/Main exits; firstError is null and recording/truncation flags
are false. These passing success paths do not diagnose the old unknown failures.
Mac additionally verifies both DMG copies' 13/13 UI checks and detached mounts.
Linux rechecks actual AppImage/runtime identities, first-JS probes, sandbox helper
identity/full modes, source/cache inventories and the same 75 exact extraction
normalizations. Windows verifies runner integrity receipts; its raw ASAR and
executable are not uploaded or independently rehashed locally, and native
signature remains `not_verified`.

Web's nine image unit regressions/45 assertions remain separate from 31 browser
behavior checks. All 88 recorded source hashes and 25 PNGs verify; Root directly
viewed the new narrow annotation and reauthenticated Workbench images, plus the
Linux 390px dark Settings and Review screenshots. The Linux Review capture
retains a dropdown exit-animation remnant; actual titles, paths and preview bytes
are independently verified through DOM/Main receipts. SW/Auth lifecycle receipt
limits remain as previously recorded. No local native launch, provider request,
real account operation, tag or publication was added for these two matrices.

### CI15 preparation recorded before execution

The following pending statements record preparation before CI15; the actual
completed-run evidence is recorded separately below.

The next operation cycle closes lifecycle and installation coverage gaps; CI14
remains the latest completed matrix and does not cover these subsequent changes.
The existing real child-browser red receipt
`/private/tmp/codeshell-web-subagent-browser-red-verified-20261017/receipt.json`
(SHA256 `ca8e4dd5a81ff9d1daaffc6c7ba190b1d774c41996d98c6b3f1a46a2e89382a2`)
proves six UI assertions can fail while Chrome exits normally, all nine observed
incarnations settle cleaned and the fixture still deletes HOME. The fixed old
reducer is `a3a735643bf6acd1f53d86bb7c13112a6ca8fd18`, SHA256
`3b3245e5be1a4c66fccb5f3494dca9b94bb81d01ebc0bbc9200773a30b02b1a5`;
the two ordinary Send controls pass in that same run. This is an actual old
browser failure receipt, not a new browser launch or reconstructed result.

Independently reviewed `6f8108744` now makes owned HOME deletion require both
the original lifecycle gates and all eight UI cases passing without failures;
its successful-result criteria are unchanged. A guarded pure Node experiment
executes the exact selected cleanup source against actual exclusive directories:
the old source deletes two failed/incomplete scenarios, while the new source
correctly preserves three failed/incomplete scenarios and deletes the successful
control. The frozen summary is
`/private/tmp/codeshell-subagent-home-retention-proof-GbzDYr/verified-summary.json`,
SHA256 `ed3b8940a913979c2e2b5ce0f35aa579c7c8c517009485912c8bf336d4039aea`.
This proves that cleanup segment's filesystem behavior, not full browser execution.
The known final-report-write-after-successful-HOME-removal limitation remains.

Reviewed tasks `fb04bc8d0` and `b34c16cd0` add a separate expected-negative CI run of that fixed
old reducer, retaining the normal current-reducer eight-case run. Its verifier
requires exactly the two passing controls/six known UI failures, normal Chrome
exit, cleaned observed custody with no query/truncation/late ledger failures,
current source fingerprints and a physically retained owned HOME/profile.
The old real report is correctly rejected because its HOME was deleted, with
the original report bytes unchanged. The pipeline now captures both `PIPESTATUS`
values before any other command and requires Node=1 plus tee=0. Six harmless
actual Bash exit combinations accept only 1/0; the former 2/1 false-positive
combination is rejected. The frozen proof SHA256 is
`da49036428a563dfe21ac47ec6784b532b785df2eeab3dda0c90a39a7db038f9`.
This new browser
failure proof is still pending remote execution and is not counted among the
normal 31 passing browser behaviors. Only precise receipts/logs/screenshots are
uploaded; the retained private profile is excluded.

Auth and ServiceWorker lifecycle changes are being prepared separately. They
must preserve all four Auth/eleven SW operations and original time limits,
including real trusted focus and exact-origin SW proxy behavior. The installed
Playwright 1.64 client/dispatcher source confirms that a public persistent owner
context can provide a Browser whose independent `newContext()` calls remain
incognito. This uses [the public persistent-context API](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
without rewriting SDK arguments; its fresh background blank context will not
participate in login, SW operations or focus. The former default headless-shell
binary selection must also be preserved. No new lifecycle fields are treated
as passing before actual CI evidence.

The reviewed implementation is now integrated: shared browser custody
`caec1ce9f`, locked browser selection `b2e73de73`, SW driver `e6029e6eb` and
Auth driver `cda1f797d` (integrated as `8f2859fac`). Original SW eleven-operation
and proxy syntax trees, Auth four callbacks/order/HTTP behavior, incognito
options, trusted native focus sequence and original operation/watch deadlines
remain protected by frozen-source contracts. Root's final combined guarded
Node run passes **64 tests / 0 fail / 0 skip**: 38 custody, nine resolver,
eight Auth and nine SW contracts. Its raw log is
`/private/tmp/codeshell-real-operation-cycles-20261016/ci15-combined-web-lifecycle-node-20261017.log`,
SHA256 `e54e45b0b357dc53bcc2bb896ba095be5c090cd9394877eee54710856b133cba`.
Locked lint/format pass. These are pure fault/path/source-preservation tests,
not 64 additional real browser operations. Actual new lifecycle execution
still awaits CI; the latest verified 31-browser-operation run remains CI14.

Windows installer acceptance is now implemented and reviewed in `8343027c4`:
the current CI14 83/12 evidence
covers a directory package, not production NSIS install/replace/uninstall. The
implementation is restricted to the authorized disposable hosted Windows CI
VM and must reject existing product processes/keys/shortcuts/cache, preserve
the verified baseline while production NSIS adds its expected elevate helper,
then verify two installed-copy UI runs and actual same-version replacement and
uninstall. Product HKCU keys, shortcuts and updater cache are real temporary CI
account side effects, not HOME-isolated data. Production NSIS can invoke
basename-based process termination; our watcher does not turn that installer
into an OS sandbox. The runner uses a real CI-environment gate before any
product observation, then scrubs its children; it must therefore run directly
under Node rather than through the outer environment-scrubbing smoke wrapper.
Additive `2c6819621` records actual existing watchdog signal requests, allowing
each new installed-copy UI receipt to prove no observed Main-root signal request;
that new field cannot be retroactively attributed to CI14.

Root's integrated Windows contract run passes **22 pure Node tests / 0 fail /
0 skip** (12 finite NSIS contracts, two signal diagnostics and eight fake-process/
CLI refusal contracts). Raw log SHA256 is
`f4f9bda4fcbdeae888b115ed133163cd7fea334f1bfd6eaae677800450bda9f3` at
`/private/tmp/codeshell-real-operation-cycles-20261016/ci15-combined-nsis-node-20261017.log`.
No local PowerShell, installer, Electron or browser was run. The first fake
process failures were fixture-only macOS `/var` aliases, preserved in the author's
proof directory; production path refusal was kept strict. Native install,
same-build replacement, uninstall and two additional 13-operation UI runs remain
unverified until their actual hosted Windows CI receipts exist. Both UI runs use
fresh HOME and do not prove user-data migration or signed distribution behavior.

Workflow `b3c7165ba` composes those gates while preserving the original native
83/12 and Web 31 scopes. All 31 literal workflow test paths exist; two jobs,
38 Bash blocks and five inline Node blocks parse, with locked format passing.
The expected-red pipeline contract is also rechecked in that final workflow
(summary SHA256 `63662916a5b60dc6e4ebbdd3598a35e4b1c1e6f1a73001adc4660cee0e9dc7ad`).
Only the new NSIS step gets a 40-minute outer budget, covering its fixed
29-minute process ceilings plus bounded metadata queries; Windows job capacity
is 65 minutes, while macOS/Linux stay 45. Existing UI/operation/watch timeouts
and no-retry policy are unchanged. Uploads enumerate public receipts/logs/PNGs
and exclude profiles, HOME, staging, installers and cache payloads. Nothing from
this new acceptance scope has yet been pushed or executed remotely.

Windows CI11's frozen summary is
`ci-39012279115-windows-20261017/verified-summary.json` (SHA256
`930fec0f5d24624cb582509279fcecb2e6be8c8d2a46c1d44a6e4f7f8d92c234`).
All eight suites pass 80 recorded checks; the original 18 panel cases remain
unchanged beside the two new cases. Twelve Main processes exit 0/no signal,
observed custody settles cleaned/zero remaining without query failure or
truncated evidence, and all eight suite HOMEs are removed. Direct transport
failures/cleanup requests are empty. UI/updater use the same unchanged package
ASAR `902ec65caffb69ffec5696fbd0e50fbc6b8c3b9ff2217652959452a1c1df9389`.
The source-fixture fingerprints match Windows CRLF checkout bytes. Native image
byte equality is asserted during the run; the artifact omits the returned raw
data URL and memory files, so the independent review does not claim to recompute
those bytes locally. The screenshot confirms one complete-path attachment card.
Signature remains `not_verified`; previous GC/query failures remain unexplained.

The supplementary full matrix [39013381607](https://github.com/cjhyy/codeshell/actions/runs/39013381607)
ran from `3466cad1efa044093feef9df4c433a3bdec45c9f`, including the JPEG alias
repair, its separate nine-unit gate and Linux font prerequisite/receipts.
Its final failed-matrix and passing Chinese sample results are recorded above.
Subsequent local edits to this record do not change that frozen CI source or
trigger another docs-only run.

CI11's exact clean source is `badc2262a90966f6f903977b849adf1f22b55e9f`.
Mac's independent receipt audit passes 98 consistency/acceptance checks
(`ci-39012279115-mac/receipt-audit.json`, SHA256
`39c7527924c2f0f65516640868b1f952391103899955fa40adac3ffe276b52e7`).
Its actual image IPC decodes the owned 292,788-byte, 512×512 PNG, with one card,
complete path and collapse/reopen behavior. Actual Main processes close normally,
observed custody settles cleaned/zero remaining, and required HOMEs are removed.
Updater records ten manifest GETs and no download/model/native-secret calls;
both same-build DMG UI copies pass 13 operations and their readonly mounts detach.
This successful metadata read does not explain or replace CI10's GC failure.

Linux's independent summary is `ci-39012279115-linux-independent-audit.json`
(SHA256 `f65614714b1fc916fd44d95ff17218788aa0f82b4baee52c002296f717b3e8f7`).
Its actual AppImage runtime parent and paused Main have separate fresh identities;
APPIMAGE, APPDIR, private HOME and exact executable match. Pre-import guard and
seven negative probes precede startup; Chromium sandbox is requested and Main
reports no `no-sandbox` switch. The reviewed 73 directory conversions and two
file conversions match the preserved inventories. Source/cache bytes and full
07777 modes remain unchanged after execution, including the separately configured
root-owned sandbox identity and bytes. Main and runtime exit 0/no signal; observed
custody settles cleaned/zero remaining and HOME is removed. Updater performs
five error scenarios and five explicit healthy retries, exactly ten manifest
GETs, with no asset download, Engine/Worker or native-secret calls. Directory UI
13 and panel 20 operations also pass. These are owned runtime/update-check
sequences, not a Linux installed update or Wayland acceptance.

Web's independent CI11 summary is `ci-39012279115-web-independent-audit.json`
(SHA256 `f77525a687f1b9af6afa25a73fdf0f33c5c36f9b416b8494ce0aab52c96006c4`).
All 31 behavior checks, 88 recorded source hashes and 25 PNG structural checks
pass. Actual 390px multiline and logout screenshots remain readable. The SW/Auth
lifecycle receipt gaps described for CI10 remain unchanged. Two read-only audit
checker schema/path errors are retained in `ci11-web-audit-schema-diagnostic.txt`;
the checker was corrected against the existing report/source schemas, without
modifying or repeating any browser run or skipping a hash comparison.

Linux's actual CI11 screenshots show Chinese text as boxes while English and
the owned image remain readable. That observation alone does not identify a
product font defect or establish the runner's installed fonts. The next workflow
records bounded `fc-match :lang=zh-cn` metadata before and after installing the
CI prerequisite `fonts-noto-cjk`, then requires Chinese language coverage before
native visual checks. Its exclusive 0600 JSON receipts are limited to 16 KiB;
the query has a ten-second/16 KiB output limit. Product CSS and native gates stay
unchanged. Actual font receipts and new screenshots remain pending; no local
font query, installation or native launch was performed.

WEB-R8-02 is repaired after CI11's frozen source. The `image/jpg` alias now wraps
the same Blob bytes as `image/jpeg` before the existing size/conversion decision,
preserving filename and timestamp without an extra full-buffer copy. Oversized
aliases convert under the ordinary rules; a still-oversized result rejects before
upload. The original red has two failures and three normal controls; nine final
tests/45 assertions pass, including existing inline budgets and upload ordering.
These use synthetic bytes, controlled canvas conversion and upload callbacks,
so they do not establish real JPEG decoding or server upload acceptance. Package
release smoke passes ten tarballs/48 typed entries; Desktop builds and all 14
workspace typechecks pass after the clean package build. The next Web CI retains
this nine-test shard separately from the 31 browser behavior checks.

The final updated workflow parses as two jobs, 33 Bash run blocks and five inline
Node blocks. The first syntax checker treated an existing module heredoc as CJS;
its original extracted scripts and diagnostic remain, and the corrected checker
uses each command's actual input-type flag. These are syntax checks, not Linux
font or native execution. Other audit rounds remain frozen and are not implicitly
repaired by these changes.

The CI10 Windows evidence summary is
`ci-39010572108-windows-20261017/verified-summary.json` under the private operation
root (SHA256 `4b72625153a89dfcc673bb84648c37f64b88508a193f1b4ea8df958a2b7f61ee`).
The startup timeline shows graceful exit before the final custody termination
check, without signals or a first error. This passing timeline does not explain
the prior Windows failure. Native signature status remains `not_verified`; this
run proves neither a signed installer nor a publisher release. Memory's driver
checks owned files while running, but the artifact omits those original files,
so the independent review verifies its recorded invariants rather than
recomputing their bytes. Windows source fingerprints use checkout CRLF bytes,
verified against the corresponding Git blobs with that conversion.

The CI10 Web independent summary is
`ci-39010572108-web-independent-audit.json` (SHA256
`43b5bb1e1e459f0bdad2f337af3f52d1b7c58c04fbe1fb5b8a4f03de68febab1`).
Its 31 behavior checks comprise ServiceWorker 11, authentication four, child
state eight and annotations eight; 88 recorded source hashes match `9cbd3a34c`.
Child and annotation receipts each record normal exit and observed custody
cleaned/zero remaining with HOME removal. ServiceWorker records cleaned/zero
remaining but no exit tuple; authentication records browser close in its code
path without an independent custody/exit/HOME receipt. These missing lifecycle
fields are not inferred from the passing behavior result.

The Linux diagnostic retains 774 source and 792 extracted permission entries,
with SHA256s `10427cc1a5988592eb7a474184f17bdc169146910774cdd0a6006c853f3dfe27`
and `036fee0106bcc2fcbb047cc2e392b136eb8327cc0c945c40100e2017274b1595`.
Read-only disassembly of the official toolset URL used in the build shows its
`runtime-x64` calls `mkdir(..., 0700)`; the downloaded runtime SHA256 is
`24da8e0e149b7211cbfb00a545189a1101cb18d1f27d4cfc1895837d2c30bc30`.
The CI artifact omits the AppImage binary, so its embedded runtime was not
byte-compared. The reviewed follow-up permits only this exact directory
0755-to-0700 conversion, retaining all other byte/type/link and full 07777 mode
checks. It changes no cache permissions to make the comparison pass. Nine
guarded runtime tests and three build-helper tests pass. The first combined
command used an incorrect build-test filename and ran only the nine runtime
tests; its log is retained, and the three build tests ran separately with the
correct path. Actual AppImage Main/sandbox/updater acceptance remains pending.

The latest macOS updater failure is retained at
`ci-39010572108-mac/receipt-audit.json`. Its actual guarded Main starts, then
`packaged-pet-fixture.mjs:265` fails while evaluating synchronous metadata.
Updater operations/feed requests/native-secret calls/workers are all zero.
The recorded SIGTERM follows the fixture's owned termination request; it is
not independent evidence of an earlier crash. Observed processes settle cleaned,
but the suite fails and retains HOME. Installed Playwright source confirms its
CDP call uses `awaitPromise: true` even for this synchronous callback. A separate
owned Node inspector experiment demonstrates that an internal awaited promise
can be collected in a deliberately private microtask queue; this establishes
neither an Electron cause nor a repair. No SDK patch, retry, timeout or sandbox
relaxation is introduced. Previous successful macOS jobs do not replace this red.

The ATT-R9-01 follow-up preserves GenerateImage's complete absolute output path
from its actual formatter, including spaces, CJK, punctuation and native
separators. An ambiguous repeated field delimiter leaves the result as text.
Successful Write metadata stays literal and no longer gains a prose-scraped
suffix attachment. The generic prose scan retains its linear token behavior;
this does not claim to parse all unquoted paths. The original component red
(11 failures/one pass) is retained; 47 combined tests/99 assertions now pass.
Desktop builds and all 14 workspace typechecks pass. Two new native cases seed
production-format history and a bounded owned PNG, then require actual
Main image IPC, decoded byte equality, and collapse/reopen behavior. These add
to the existing 18 panel operations without changing their gates. They have not
yet run in native CI. Unit Windows UNC examples do not establish real share access.

DESKTOP-R12-01 is also repaired: the shared Desktop tool-summary helper retreats
one UTF-16 unit when its existing cutoff would split a valid surrogate pair.
ASCII/BMP budgets and ellipsis behavior stay unchanged, and expanded content and
original message/path/ID values remain intact. Seven original helper/actual
Read/Generic/Agent/Bash card regressions fail before the fix; 11 normal controls
pass. The independent task's final five-file shard passes 32 tests/91 assertions.
The combined image/Unicode shard passes 65 tests/163 assertions across seven
files, and Desktop build plus all 14 workspace typechecks pass again on the
combined source. That command named a nonexistent Shell test; the actual
`ToolCardShell.test.tsx` runs separately and is not counted in its 65. Neither
Unicode unit checks nor the previous CI10 native screenshots are a native
verification of this new summary change. Web and legacy Mobile use separate
renderers and do not import this helper. Original audit rounds remain frozen;
other recorded findings are not included in these repairs.

Artifacts are downloaded as ZIPs under the private operation evidence root,
with individual reports inspected directly. First-failure Main logs missing from
the early Ubuntu memory artifact were a coverage gap; subsequent runs explicitly
retain them. A later successful launch does not classify that earlier GC failure.

Run `39008016212` has finished with a failed overall matrix, separate from its
passing Web/macOS jobs. The Web ZIP's child-state and annotation receipts bind
clean source `1b4b3340f`, both browser exits are 0/no signal, each observed ten
incarnations cleaned with zero remaining and no query failure, and renderer/
driver guard failures are empty. Its actual 390px multiline and 320px offline
screenshots were independently inspected and remain readable without clipped
controls. Linux's failed payload check retains the original AppImage/runtime
receipts and HOME; it is not evidence that sandboxed AppImage execution or update
recovery has run. Windows' first-failure body and screenshot retain the complete
path in the comment heading rather than changing the test's expected short name.

The macOS artifact `12092405047` has ZIP SHA256
`54b7ace41800675b586aa4851fad658f2bcc04730dbdcd7b87905722f48a0b4f`.
Independent receipt checks bind its compiled source fixtures and the same ASAR/
managed-Node manifest across directory UI, updater and both DMG installation
copies. Startup has three normally closed Main processes and seven actual Pet
IPC operations; Review has eight diff/open operations, preferences six across
three Main processes, packaged UI thirteen, updater five response modes and ten
actual manifest GETs, and installed/reinstalled DMG UI thirteen each. Relevant
Main/runner exits are 0/no signal, observed identities settle cleaned with zero
remaining/no query failures, final worker/deny/renderer ledgers are empty, and
both readonly mount attachments detach. An auditor initially expected a boolean
where the declared DMG metadata override is the string `title`; its schema
diagnostic is preserved separately from the passing product receipts. This is
macOS arm64/ad-hoc, controlled nativeTheme and same-build owned replacement
evidence; publisher signing, notarization, Gatekeeper, operator OS appearance,
update downloads/install and real user-data migration remain outside the run.

The Linux payload verifier now permits only three explicit builder conversions:
the public managed-Node LICENSE from 0600 to 0644 with the same type/size/SHA,
directories from 0700 to 0755, and removal of the already-approved sandbox's
setuid bit before its separate owned configuration. Every other file permission,
file byte, type and symlink target remains strict. An additional AppImage-only
inventory records all 07777 permission bits before/after for the source and
runtime cache; foreign setuid, SGID/sticky and group/other-write bits are rejected.
The existing generic inventory's version/format is unchanged. The first owned
disk LICENSE reproduction and the original CI failure stay separate from six
passing focused Node tests. Builder source explains the observed normalization,
but its master source plus installed binary symbols are not claimed to prove
byte-identical provenance for the installed builder. Actual AppImage Main,
sandbox and updater execution still require the next native Linux run.
The combined AppImage/build/process-custody Node shard passes 53 tests. Its first
command also included a Bun-only preload test in Node, which correctly rejected
the `bun:` import before running that file; that command error is retained and
the preload suite is run separately with the guarded Bun runner. This runner
diagnostic is not classified as a product or native Linux failure.
The corrected preload shard passes ten tests/46 assertions. Scoped lint/format
pass; the updated workflow parses as two jobs and all 32 Bash run blocks pass
syntax checks. The system Python lacks PyYAML, so this syntax check uses the
already-installed Bun YAML parser without installing another dependency.

Run `39009261349` is a failed overall matrix. Its Web artifact `12092276562`
has SHA256 `589f65fc3b0fb8120f2b61807221b1e46068c497eaee55df741246a17370e5e4`;
independent inspection binds both new browser families to clean `ec17b2054`,
normal exits, ten observed identities cleaned/zero remaining and empty failure
ledgers, with actual trusted authentication focus preserved. The Windows ZIP and
first-failure logs remain under `ci-39009261349-windows-20261017`; actual guard
and loadFile receipts exist for Main 5784 with no missing Pet handlers. A later
undefined `proof.guard` is a secondary failure after the first evaluation failed
to return, not evidence that the guard was absent. GPU/network-service stderr
and the final exit code alone do not establish the first failure's cause.
The Linux ZIP remains `ci-39009261349-linux.zip`: successful extraction code 0,
observed identity cleaned/zero remaining, no Main/update/native-storage calls,
and retained HOME. The next diagnostic must capture source/extracted modes
before validation and distinguish Windows first-error phase and pre-cleanup
state. No retry, sandbox/normal-exit relaxation or speculative product fix is
justified by the incomplete evidence.
Mac artifact `12092362559` has ZIP SHA256
`e58dc9ed79b93485d8481037360981f16a569933e553f7cf5ff41b6d88791fdc`;
78 independent receipt checks pass for the same startup/Review/preferences/
packaged UI/updater/DMG operation and normal-exit boundaries as the preceding
macOS run. Its actual 390px dark UI and Review screenshots were also inspected.

During local integration another task added only round-nine audit records at
`6966dc0f9`; the expected-head guard refused synchronization before mutation.
After reviewing and retaining those records, local `main` fast-forwarded to
`3f9fcfdaf`, preserving the same five pre-existing paths exactly. Its product
source is identical to remote acceptance commit `ec17b2054`; only audit documents
are added. Those separate audit findings remain recorded and are not claimed
fixed by this UI/native-path wave.

The AppImage follow-up retains complete source and extracted 07777 permission
triples before the current validator runs, with a 20,000-entry/4 MiB limit and
exclusive 0600 evidence files. A rejected normalization records both numeric
and octal modes in the runtime receipt. Privilege/write-bit rejection still
fails under the same policy, with both inventories retained. Eight focused
runtime tests and the three build-contract tests pass together; no new directory
conversion is allowed. The workflow explicitly uploads the extracted inventory.

The Windows follow-up shares one bounded diagnostic timeline between the startup
driver and source harness. It records fixed phases, the first error's owned
stack frames, ChildProcess state before the harness's own termination, cleanup
requests, observed watcher-authorized signal requests and exit/close order.
Recording errors cannot replace the original error or skip custody. Fake
Windows controls separately model an exit observed before evaluation rejection
and exit code 1 appearing only during cleanup; neither is automatically called
a native crash or accepted as a pass. No launch argument, GPU switch, sandbox,
timeout, retry, guard, normal-exit or final transport gate changes. Independent
review passes; the combined source-harness/startup/direct-transport/AppImage
Node shard passes 46 tests, with scoped lint/format and workflow parsing passing.
These are diagnostic contracts; actual Windows failure classification and
AppImage Main/updater execution still require the next CI.

Windows file fixes use Main's explicit platform for basename and dirname, with
POSIX backslashes/filename whitespace preserved. Real React regressions retain
two Windows title failures and three Markdown image-directory failures before
the fix. Additional attachment tests use controlled image/media bridge replies;
they prove the exact requested paths and labels, not a native Windows image
decode. The first attachment fixture used a non-aggregating MiniDOM text getter;
another intermediate fixture's raw Unicode template produced a literal escaped
name. Both diagnostics are retained, and the final literals/collector are
corrected without changing product expectations. The final combined UI shard
passes 115 tests/386 assertions. Desktop builds and all fourteen workspace
typechecks pass; the public package contents are unchanged by this wave, so the
earlier package-release gate is not represented as a new run.

Local integration preserved another task's newly added round-eight audit records.
An overlapping uncommitted workflow draft was separately backed up and its SHA,
mode and size retained. The user explicitly approved adopting the acceptance
version. Only that approved path was restored before the disjoint fast-forward;
the other five pre-existing paths retained identical status, bytes, mode and size
in both resolution and integration receipts. Local `main` is now `6e4b663dc`,
which adds the reviewed Windows fixture transports and audit records; the remote
run remains bound to its original `1b4b3340f` source. Remote `main`, tags and
publication have not been changed by this task.

The Windows diagnostic measured the identical strict CIM identity query through
PS5 at 25,351ms (minimal environment) and 17,721ms (owned profile/temp), versus
PowerShell 7 at 486ms and 467ms. All four returned the controller's actual PID and
parent through the strict full-birth parser. Windows acceptance now requires the
fixed `Program Files/PowerShell/7/pwsh.exe` path on the canonical SystemRoot drive;
missing installation fails closed, without PATH/profile/fallback discovery. The
five-second budget, minimal environment, query fields, full precision and fresh
query before every signal remain unchanged. The combined custody Node shard
passes 44 tests. The next Windows run passed build/package and actual startup UI,
but a later custody query failed; its cause remains unknown. A follow-up avoids
individual queries for incarnations already absent in a fresh cleanup discovery
and records only fixed failure codes plus monotonic elapsed time. Forty-three
snapshot/watchdog/custody tests pass, including a 201-departed-process fixture;
every actual signal still needs a fresh individual identity check and query
failure remains sticky. This does not establish the earlier failure's cause.

Both generated extension artifacts had raw LF bytes identical to their HEAD
blobs in the Windows run. Git nevertheless reported M and warned that its next
touch would produce CRLF. An owned temporary Git reproduction with autocrlf=true
confirmed that exact behavior and its repair: two exact-path `text eol=lf`
attributes preserve committed/generated bytes and leave status clean after a
rebuild. No dirty-source gate was waived. Run `39003474715` confirms a clean native
Windows source/build/package boundary; the subsequent shutdown failure is retained
separately.

The combined source passed 35 auth/preferences tests (144 assertions), 12 package
layout/integrity tests (65 assertions), six actual preference browser sequences,
and four local actual authentication browser sequences. The first two preference
browser attempts failed before launching because no Chromium existed at the
selected cache path; the successful run used the installed Chrome binary with a
new owned profile. Package release verification again passed 10 tarballs and 48
typed entries. Counts describe separate suites, not a deduplicated total.

Updater evidence is frozen separately: the old immutable package reproduced the
404 event/rejection conflict; a second launch then hit a navigation fixture
assumption, so that red run covers only 404 and its healthy retry. The fixed
package passed all five modes and retries in one actual Main before its normal
30-second periodic timer. Receipt:
`/private/tmp/codeshell-updater-packaged-green-final-20261017/receipt.json`.
Its ASAR is `baffabc296b3fede963f5504952dc26b7779f18732b06fdcfdb084137d9603c7`;
the package build source is `f196a4783`, with driver-only follow-up `1945c07fd`.
Main exit 0/no signal, observed custody cleaned with zero remaining, no workers,
native storage or renderer/feed errors, ten GETs, unchanged full inventories,
deep strict signature and original metadata pins are recorded. The first fixed
run's second inspector handshake GC failure remains a separate failed receipt;
switching to a single Main for these feed modes does not explain it.

The native tab test now disables Playwright's implicit focus override for both
tabs and observes an actual blur before bringing the login tab forward, avoiding
coalesced front operations. The local actual Chrome run passes all four cases,
recording `focused=false` followed by a trusted focus event. Headless hosted Linux
never produced that actual blur; its retained receipt reports an empty event list
and `focused=true`. The headed Mac probe also failed and remains separate.
Run `39004577231` verifies the final ordering in headed hosted Linux under Xvfb;
no synthetic focus dispatch or weaker assertion was introduced.

Run `39003474715` artifacts were independently inspected: macOS source
`dac146ed2`, ASAR `e8d98662434af69730d2e8865ccb0337f7d3312878d9921d8eafdb58d4d92d86`,
DMG SHA256 `f2bc462661eb036b886427e545588779b12f3ad9656f84e6106bd078cd188d05`.
Updater and both DMG UI receipts pass with empty failures, no workers, normal
Main exits, cleaned observed custody and removed UI HOMEs. The readonly volume
and ordinary owned image detach receipts pass. This remains local ad-hoc
same-build installation, with no Developer ID, notarization or version migration.
The Linux directory updater receipt fails with zero manifest requests while
closing normally with no worker/native storage calls. The next Linux updater
acceptance must launch a real production AppImage whose runtime owns `APPIMAGE`;
fabricating that environment variable or forcing development updater mode would
not exercise the distributed artifact.

The Review native receipt is
`/private/tmp/codeshell-review-diff-proof-zyPwQ3a9/native-green-retention/receipt.json`:
eight operations, normal Main exit, 29 observed incarnations cleaned, no renderer,
worker or deny-ledger errors, and HOME removed. Context forwarding evidence is
`/private/tmp/codeshell-context-tail-final-receipt.json` (source `0f4566`):
actual persisted reader/fold and React handlers, six valid ranges captured once
each and two refused mappings; actual fork/Engine/provider calls are zero.
Host case-policy validation passes 33 tests/126 assertions, including a guarded
Main projection shard; no native Linux Host registration is inferred.

Combined source `aac455c21` includes these repairs and local main `dee38295a`
(primary-call cache accounting and background tool-continuation preservation).
Package release verification passes ten tarballs/48 typed entries; root build,
Desktop build and all 14 workspace typechecks pass. Combined regression passes
182 UI/history/cache/project tests (578 assertions) with a pre-Core deny guard,
six negative probes and zero runtime network attempts, plus seven guarded Core
cache/tool-continuation tests (79 assertions). The next full native matrix remains
in progress.

Startup fixture commits `a8b6cfe05` and `d1abe3a46` replace the earlier premature
success print with early spawn custody and per-cycle normal-exit/settlement
requirements before another cold Main starts. Four focused Node tests and three
actual evidence-path refusals pass. Its fresh macOS repeat passes seven real
operations: three cold loads, three reloads and one production second window;
all unchanged Pet IPC calls work, three Main exits are 0/no signal, observed
custody is cleaned with zero remaining, and renderer/worker/deny ledgers are
empty. Evidence: `/private/tmp/codeshell-startup-custody-proof-BkkNwKFd/verified-summary.json`.
The first attempt's final Keychain inode mismatch correctly failed and retained
its original HOME/pin. Its cause remains unknown. The passing repeat used one
fresh HOME/pin; fixture-only `d1abe3a46` retained compiled hashes from `a8b6cfe05`.
This is macOS proof and does not classify the Windows query failure.

Annotation source `94aa7ab90` has a clean actual-browser red (four multiline
failures, three controls) and a final eight-case green at
`/private/tmp/codeshell-annotations-browser-final-003/receipt.json`.
Actual typing/Save callbacks and production wire/display preserve blank lines,
indentation, colons and entry-looking text at 1000/390px, while real textarea CRLF
normalization and delimiter sanitation remain verified. Browser exit 0/no signal,
no watchdog signals, nine observed incarnations cleaned, no renderer/network/deny
attempts, and profile removal are recorded. Thirty-four guarded unit tests,
Desktop no-emit types and three prelaunch evidence-path refusals pass. No actual
chat send, Main, Core or provider operation is claimed by this local UI fixture.

Installed Playwright `1.64.0` prepends `--no-sandbox` to Linux Electron launches
unless `chromiumSandbox: true` is explicit. Earlier Linux native receipts prove
their stated UI operations, but cannot prove enabled Chromium sandboxing despite
the configured setuid helpers. Source harness now explicitly requests sandboxing,
refuses an actual Linux `no-sandbox` switch in its pre-Core bootstrap and records
the switch state; nine Node harness tests pass. Packaged directory/AppImage
launchers receive the same requirement. There is no fallback flag or OS-wide
policy change; the next actual Linux run must verify these stricter launches.

Web child-state evidence is
`/private/tmp/codeshell-web-subagent-browser-green-verified-20261017/verified-summary.json`.
The same committed driver runs a frozen parent reducer and the corrected one;
77 actual product inputs and CSS match except for that reducer. The old source
has six product failures plus two ordinary-send controls; the new source passes
eight cases with four actual `agent/run` requests and two actual cancellation
requests, each checked again after shutdown. Both browsers exit 0/no signal,
observed custody is cleaned, and renderer/deny/fixture errors are zero. These are
owned HTTP/WS Host responses, not actual Engine/provider execution or the legacy
paired Mobile adapter. Narrow Hub layout is explicitly the 390px boundary.

Combined source after the multiline/child-state/Panel-Wasm repairs passes ten
package tarballs/48 typed entries, root and Desktop builds, and all 14 workspace
typechecks. Its focused combined comment/reducer/replay/controller shard passes
120 tests/357 assertions with six pre-Core deny probes and zero runtime network
attempts. AppImage/source custody changes combine with the earlier watchdog
performance repair: 53 Node tests and 33 shared barrier/exit/launcher Bun tests
(102 assertions) pass. Native AppImage cache reuse is still unverified locally.

The real AppImage adapter builds from the verified directory payload, checks
image/ASAR/managed-runtime/source identities, prepares only its owned extraction
cache and exact sandbox helper, then lets the image runtime supply `APPIMAGE`
and `APPDIR`. It distinguishes the launcher from its actual Main and binds the
fresh Main incarnation before installing the first-JavaScript guard. An exited
launcher cannot authorize disconnecting a still-paused Main; focused inspector
fixtures cover this failure boundary. Original source/image/cache inventories
and separate normal Main/launcher exits are mandatory. Actual Linux CI remains
required before counting it as acceptance.

Independent installed-Playwright review also found an existing Windows harness
incompatibility: its Electron launcher uses a shell command and returns the shell
PID, whereas early fixture capture expected a direct executable/Main PID. This is
source evidence, not a new Windows runtime result or an explanation of run 5's
shutdown-query failure. A narrow exact-vector direct-spawn transport and actual
Main identity checks are now wired before the next Windows job; no package patch,
arbitrary shell parser or shell fallback is used.

The Windows exact-vector helper `807992bea` is independently reviewed and passes
seven pure Node policy tests. A separate manually transcribed command test plus
unproven/rejected/thrown cleanup tests pass four cases, avoiding a circular
expected-vector assertion. The permanent literal library-taskkill guard records
any forced fallback as failure and redirects only through the same captured
birth-custody monitor; suppression never returns native success or authorizes a
replacement PID. Source/common and packaged wiring pass final checks and still
require actual Windows CI. These local fake-policy tests are not Windows execution.

Final Windows transport chain is `807992bea` → `dad996f6c` plus source integration
`5b1f56ce8`. Common/source and packaged fixtures retain their exact installed
loader/guard ordering, capture the direct Main before handshake, verify actual
PID/parent/executable/HOME and read live transport failures after shutdown.
Forced library cleanup always fails acceptance even if its bounded cleanup
eventually succeeds. Combined Root verification passes 33 guarded Node tests,
33 packaged barrier/exit/launcher Bun tests (102 assertions), syntax and lint.
Independent source review is recorded at
`/private/tmp/codeshell-windows-source-transport-verified-summary-20261017.json`.
No local Windows or additional macOS native launch was used for this transport
change. The full three-platform job must establish its real runtime behavior.

Local integration to `34553b747` preserves all five pre-existing primary checkout
changes with exact content hashes, modes and sizes. Receipt:
`/private/tmp/codeshell-real-operation-cycles-20261016/integration-ui-review-context-multiline-childstream.json`.
Only the dedicated acceptance branch was pushed; no remote main, tag or release
was changed. An initial integration invocation supplied a mistyped expected task
hash and was refused before any mutation; the corrected verified hash completed.

Actual native preference evidence is
`/private/tmp/codeshell-native-preferences-round-006/receipt.json`: one production
New window command, two real preload bridges/default-session windows, a native
storage event, actual Chromium media events from process-local nativeTheme,
renderer reload and three cold Main processes. All six sequences pass with
normal exit, cleaned observed custody, empty post-close deny ledgers, no
network/worker/Core-turn/crypto attempts, and fixture HOME removal. Compiled
product source is `957f2ee7a`; driver `2963c298a`, followed by input-only guard
`b0f369998`. The earlier five fixture-contract failures remain separate records;
none is a product red. The final input guard additionally refuses canonical
checkout paths, symlink aliases into the checkout and the outer isolated HOME
before creating evidence or a native HOME.

Actual local DMG evidence is
`/private/tmp/codeshell-dmg-native-rTbFM7Bi/dmg-install/receipt.json`, source
`b8c4a4569`, ASAR `e28e0f7b99b7f81312a9d57a2cc63e319319783412a64089e3ab3ddf42b811b2`.
The production builder creates a DMG with a unique intermediate volume title,
then readonly-mounts it, preserves bundle bytes/modes/symlinks/xattrs/resource
forks on copy, and performs 13 real UI operations before and after same-build
owned manual replacement. Both Main exits are 0/no signal, workers/model/native
storage and renderer errors are zero, original pins match, observed custody is
cleaned, private UI HOMEs are removed and exact owned images detach normally.
DMG SHA256 is `4bb5f8c48469cb789ce7b3d0dc0bcc8a4c5969747b90ee6f7dbc587baa13a6c8`.
The synthetic marker only proves an owned external file survives replacement;
it is not user-data migration. Earlier Python xattr, Swift timeout and diskutil
field-assumption failures remain retained. Eight guard/metadata tests pass.
This local ad-hoc installation does not establish Developer ID, notarization,
Gatekeeper/quarantine, /Applications installation or a cross-version update.

A passive metadata observation paused owned App/browser launches for 60 seconds:
239 `lstat` samples returned one unchanged default-Keychain file identity. Build
CLI activity was allowed. No items were read or explicit Keychain writes made;
this bounded observation neither identifies the earlier intermittent writer nor
proves that writes did not occur. Receipt: `passive-keychain-observation.json` in
the private operation evidence root.

`smoke-local-package.mjs` retains the three production resource/signing hooks,
records their hashes, and runs the builder from a new private working directory
with an explicit project directory. This avoids automatically loading a checkout's
`electron-builder.env`. The first private-cwd build exposed relative hook
resolution against cwd; it failed and cleaned its observed processes. Absolute
paths to the same production hooks repaired the build. Both receipts are retained
under `/private/tmp/codeshell-ui-ci-local-mac-20261016-{b,c}`.

The native UI launcher requires a clean committed-source build receipt matching
the actual OS/architecture and current HEAD. Before launch it compares the actual
ASAR and managed-Node manifest hashes. Mac signatures are deep/strict verified;
Windows/Linux integrity receipts explicitly say native signatures are unverified.
Package layout, URL encoding, runtime manifest and payload containment checks
cover all supported target layouts.

All three platforms have bounded process metadata queries. Watchdogs bind each
owned process to PID, parent and birth identity, recheck before every signal, and
await settlement. Query failure remains sticky; manual disarm cannot reacquire
termination authority. Startup, inspector failure and forced UI/Pet shutdown use
the same custody API. An initial snapshot failure was reproduced in a pure Node
injection: the old path sent SIGTERM despite missing custody; the final path
starts no preload, sends no signal and retains unproven state. Inspector tests
also prove a missing termination callback neither signals nor resumes the child.
Only `cleaned` settlement permits successful launcher status or fixture HOME
deletion. These receipts cover observed incarnations, not every historical OS
process.

Linux's wrapper records a fresh private bus/keyring reference. The reader verifies
owned private directories, bounded metadata, process start ticks, executables,
ancestry and current D-Bus/SecretService PIDs. It never adopts the operator bus
or reads stored items. The Ubuntu native startup/panel/composer/memory runs now
exercise that owned session; Mac fixture parsing alone did not establish it.
Xvfb alone does not verify window-manager
behavior or Wayland. Windows native window, shortcut, PTY and encryption behavior
also remain separate from the portable parser tests.

The final local macOS arm64 package at source `f90592219bc6228241ecdd71f69533777e70e786`
passed 13 packaged UI operations and seven screenshots, with Main exit 0, no
worker/model/native-secret calls, matching before/after inventory/signature,
unchanged default-Keychain identity and fixture HOME removal. Build, launcher
and native-Main observers all settled `cleaned` with zero remaining recorded
incarnations. Evidence is
`/private/tmp/codeshell-real-operation-cycles-20261016/native-acceptance-verified`.
ASAR SHA256 is `face643744f71bcb97fb95f8d64b2626e27742161b824c2e8e9f30c52cf02e64`.
Three cold launches/reloads and a second source window also passed in
`native-acceptance-final-startup.log`. This is not packaged Pet/native encryption,
installer/update, Developer ID or notarization acceptance.

Retain the preceding `native-acceptance-final/ui` failure: all 13 UI operations
completed, but the OS default-Keychain inode differed at the end, so the overall
receipt correctly failed. Its origin is unclassified. Recorded processes were
confirmed absent and the fixture HOME was removed. The successful repeat used
a new private HOME and freshly captured metadata, never recaptured the old HOME
or relaxed identity checks.

The combined actual Web default and late-title repeats passed with receipts at
`codeshell-web-real-host-IFKdX7/evidence/report.json` and
`codeshell-web-real-host-fmz4QJ/evidence/report.json` in the system temporary
directory. The original late-title red evidence is retained separately. Latest
checks passed: 41 package/environment input tests, 23 inspector/launcher/shutdown
tests, 39 Node process/package contract tests, 18 Web controller tests, production
script lint and Shell syntax. Package verification still passes 10 tarballs and
48 typed entries; all 14 workspace typechecks passed again after the final
package was sealed and development workspace links were restored.

## CI15 — completed with macOS and Windows failures

[Run 39020679310](https://github.com/cjhyy/codeshell/actions/runs/39020679310)
executes source `7e5570210d7e9336cbe9d6a90ed375832e7e3329`. Its overall result is
**failed**, with successful Web/Linux jobs and failed macOS/Windows jobs. CI14's
full matrix success remains evidence only for its own source; it does not cover
this run's unexecuted operations or diagnose these new failures.

Web independently verifies **31 actual browser behaviors**: SW 11, Auth four,
child eight and annotations eight. Nine image tests/45 assertions and **64 pure
Node lifecycle contracts** pass separately, with zero failures/skips. Auth/SW now
retain actual early exact-executable/HOME/profile capture before handshake,
normal Chromium exit 0/no signal, cleaned observed births (Auth 20→0, SW 7→0),
empty late ledgers and private HOME removal. Their blank persistent owner remains
separate from the original incognito operations; original trusted native focus,
HTTP/WS/proxy guards and deadlines remain intact. All 106 recorded source hashes
verify. These are owned browser/Hub fixtures, without Core/Engine/provider or real
accounts, and are not an OS sandbox or all-process proof.

The separate old-reducer retention run returns the expected **two passing Send
controls and six known UI assertion failures**. The pipeline requires Node=1 and
tee=0; its pinned verifier then checks normal Chrome exit, cleaned custody,
source fingerprints and a physically retained owned HOME/profile on the runner.
Those eight expected-negative cases are not added to the 31 passing behaviors.
The private profile is not uploaded; the artifact reader verifies the runner's
receipt, not its current existence after VM disposal. The known final-report
write failure after successful HOME removal still cannot restore that HOME.

Linux independently verifies **83 native operations/12 Main processes**, including
Review 11 (the three header-only title/path/actual-preview cases) and Panel 20.
The four Panel diagnostic files agree with the formal report: all 20 names,
71 journal events, normal Main/controller exits, null firstError, no recording
failure/truncation, and complete 212-byte stdout/16,276-byte stderr. Write-card
React **11 tests/38 assertions** pass separately; no actual Write-tool execution
is claimed. The actual AppImage Main is PID 8112, distinct from launcher 8109,
with runtime-set APPIMAGE/APPDIR, first-JavaScript guard/seven negative probes,
requested sandbox and no `--no-sandbox` switch. Five manifest modes plus five
healthy retries make exactly **ten GETs** to `/latest-linux.yml`, with no asset
download/install, Worker/model/native-storage call. ASAR and managed-Node manifest
hashes remain source-bound and unchanged; complete 07777 source/cache inventories
retain all bytes and only the same 75 exact extraction mode normalizations.
Both new packaged signal ledgers record zero requests and no truncation; this is
not an OS-wide signal audit or proof of delivery. All inner fixture HOMEs are
removed and observed custody is cleaned. The two outer launcher scratch roots
remain retained by the launcher's explicit success/failure policy; their process
settlements are cleaned 19→0 and 20→0, not proof of scratch deletion.

All six inspected Linux PNG samples show readable Chinese glyphs, including the
complete space-containing generated-image path/thumbnail, Review's Chinese/binary
titles, 390px dark Settings and updater failure/retry. Font metadata matches
Noto Sans CJK SC with `zh-cn`; the images, not metadata alone, support that sample
conclusion. Root also directly viewed the generated-image and 390px samples;
`ci-39020679310-linux-root-visual-audit.json` has SHA256
`720754e90f661df99d4bde2725c413458c0b418816110d6fe60aacfa43d750a6`.
The translucent Review menu-closing frame is not classified as a persistent
product bug from one screenshot. Raw AppImage/executable/ASAR bytes are not
uploaded; integrity is runner-observed before/after evidence, not independent
publisher/signature verification.

macOS's first Main returns all **three Pet IPC actions** successfully, then exits
0/no signal; all 13 observed incarnations settle cleaned with zero remaining and
no recorded signal request. The first cycle nevertheless **fails** its post-close
metadata check: `CODESHELL_KEYCHAIN_PREFLIGHT_IDENTITY_CHANGED`, helper stage
`account-before`, `sameInode:false`, while the other reported identity booleans
match. `launchStarted:false` is that helper's field at the post-close check,
not evidence that this Main never launched. Raw before/after inode values are not included in the uploaded evidence;
the artifact cannot establish that the actual default file was
replaced, identify an actor or explain the mismatch. No startup cycle is accepted,
HOME remains retained, and the seven later native suites plus DMG are skipped.
Its independent Write React 11/38 unit pass and successful directory build do not
establish packaged runtime or DMG acceptance.

Windows completes **startup seven/three normally exited Main processes** with
cleaned observed custody and no recorded signal requests. Review then rejects
`verifyElectronMainIdentity` with
`electronApplication.evaluate: Resulting promise was garbage collected.` before
identity returns or any of its 11 operations executes. The captured process
ultimately closes with **code 1/no signal** and observed custody 30→0; its HOME
is retained according to the receipt/failure gate, without uploaded private
HOME bytes. There is no retained Review rejection/cleanup/signal timeline to
order that exit against the RPC failure or cleanup. Network-service restart and
GPU-process exit messages merely coexist in stderr; neither is established as
the cause. Six later native suites and NSIS are skipped. The **22 pure NSIS
contracts** and separate Write React 11/38 pass; actual NSIS build/install/replace/
uninstall and both installed-copy UI runs remain unexecuted.

Frozen independent summaries are under
`/private/tmp/codeshell-real-operation-cycles-20261016`:

- Web `ci-39020679310-web-independent-audit.json`, SHA256
  `3d1711c9b4d7d62110ec09dc4df0dedcd860cf36d32a2debff31a5416482925a`.
- Linux `ci-39020679310-linux-independent-audit.json`, SHA256
  `d3895655d0d581c2fb44cd7e311c752611d07d3e43fd8fdebc5eaf1cdb039364`.
- macOS `ci-39020679310-mac-independent-20261017/verified-failed-summary.json`, SHA256
  `1ec4a2bc0e6e5cdbb8b98afe7dd081ac7f41423ff28b33c51e7d7684e8f588dd`.
- Windows `ci-39020679310-windows-independent-20261017/verified-failed-summary.json`, SHA256
  `85550eed87dd9d22713659e06e9fbb56e1706bc77c3e49423426ebd6e80140a0`.

Post-run diagnostic source changes do not repair or explain either native cause.
`cd991ca96` clarifies the macOS post-close phase and safe metadata wording without
relaxing identity pins. Independently reviewed Review task `c133a6615`, integrated
as `815ef2389`, adds bounded durable first-error/phase/raw-log observations while
preserving all 11 operations/29 assertions, Git/guard syntax trees, deadlines and
HOME criteria. Root's combined source-only proof at `e88ab5c8d` binds six files,
47 startup/fake-Keychain plus 25 Review guarded Node passes, zero failures/skips,
39 Bash/five inline Node syntax checks, six exit-code counterexamples and all
33 literal JS/TS workflow paths. Its receipt is
`ci16-reviewed-diagnostic-gates-proof-20261017.json`, SHA256
`8358f483b60506f8fce34f75b1758cb9ff175404590d01b3049ca69923fde158`.
This is local source/pure Node evidence only. No CI16 push/dispatch or native
result is claimed here; the unchanged 64 Web/22 NSIS groups were not rerun in
that follow-up. Earlier unknown GC/metadata failures remain separate evidence.

## CI16 — Windows fixture portability failure

[Run 39022606881](https://github.com/cjhyy/codeshell/actions/runs/39022606881)
executes source `e7543a56805d992dec936b9c8df07e4ce7e2a709`. Windows fails in the
new Review pure Node contracts before any native application launch; its later
package, Write-card, native UI and NSIS runtime stages are unexecuted. The overall
matrix cannot be accepted from the other platforms' passing evidence.

Web independently passes the same **31 browser behaviors**, nine image tests/45
assertions, 64 pure Node contracts and 106 source hashes. The separate expected
old-reducer failure again gives two passing controls and six known UI failures,
with runner-verified retained HOME/profile after normal Chromium exit and cleaned
observed custody. All 33 PNGs pass structural/CRC checks; Root directly views the
logout/fresh-draft and 390px multiline annotation samples. This Web result does
not supply any Windows native evidence.

Linux independently passes **83 native operations/12 Main**, separate Write-card
React 11/38 and all 12 new Review pure Node contracts. Actual Review diagnostics
agree with its original 11 cases: Main PID 5103 exits 0/no signal, controller exits
0, 56 journal events have no truncation/recording error, firstError is null and
signals are empty. Complete raw stdout 212 bytes/four chunks and stderr 818
bytes/nine chunks match contiguous recorded byte ranges. These order controller
observations, rather than native generation times. Original success and custody
criteria still apply. Actual AppImage checks pass ten GETs, first-JavaScript
seven negative probes, sandbox and separate source/cache byte/07777 inventories;
75 exact extraction mode normalizations remain. Inner fixture HOMEs are removed;
outer launcher scratch remains retained by its existing policy. Six agent-viewed
PNG samples and two Root samples show readable Chinese, complete generated-image
paths and Review titles.

macOS independently passes **83 native operations/12 Main**, plus both actual
DMG copied-app UI rounds (**13 operations/one Main each**). Write React 11/38 and
Review's 12 pure Node contracts pass separately. All three startup cycles record
the post-exit Keychain phase and successful restoration of the final gates.
Review's 11 case names/results agree with the durable journal, raw-byte metadata,
normal Main/controller exits and final report, without recording failure or
truncation. Four packaged watchdog request ledgers are empty/nontruncated.

The DMG has an APFS payload in UDZO format; its owned attached volume is readonly,
both exact attachments are detached, and mounted/copied inventories, production
hooks and local ad-hoc signing checks agree. Same-build manual replacement
preserves the synthetic outside-app marker. Each copied app uses a fresh private
HOME, so this is not a real-user migration or official updater-install result.
Observed Main/custody and inner private HOME gates pass; launcher scratch and
DMG evidence roots remain retained by policy. Six actual PNGs were viewed by the
independent auditor; Root separately views and ZIP-matches the installed/replaced
390px dark Settings samples. Neither this successful job nor the diagnostic-only
phase change explains CI15's inode difference or earlier PromiseGC.

Windows' **12 Review contracts give eight passes and four failures**, all four
inside `actualFinalTail` with `SyntaxError: Unexpected identifier 'console'`.
The test reads the actual driver source, then searches a fixed LF-only closing
marker. With a Windows CRLF checkout the marker index is -1, so the extracted
slice wrongly includes the outer console/final assertion. The original 11-case/
29-assertion/Git-guard AST contract itself passes. The 22 NSIS pure contracts pass
separately. No Main, native PNG, packaged build, actual installer or Write-card
React run is reached. CI15's native PromiseGC cause remains unknown; this is a
separate, established portability defect in the new test.

Root independently reproduces LF syntax success and the same CRLF syntax error
by compiling the actual extracted source without executing it. The frozen proof
`ci16-root-crlf-source-parse-reproduction-20261017.json` has SHA256
`c6f910a3fb059c38e4c682b71ee8d8736eac3a713abb095c95864f4960f1cb36`.
Reviewed test-only fix `7d99da1d4` normalizes only in-memory tail-test input and
adds actual LF/CRLF executions of the same six final-tail scenarios. The original
12 test bodies, driver/helper/product bytes, guards, deadlines and original
operations remain unchanged. The negative control fails only the new CRLF case
(12 pass/one fail); the corrected suite passes all 13, including owned temporary
HOME retention/removal and truthful post-removal final-IO failures. Root reruns
13 guarded Node tests with zero failures/skips; locked lint/format checks pass.
`ci17-root-reviewed-crlf-gate-proof-20261017.json` has SHA256
`6871971a8bfadcb918e998bb77a94b93cb713b7c8ff1feeeed39f60e50ce0c01`.
This is source/pure Node evidence; native acceptance of the correction remains
pending the next authorized full run.

Frozen summaries under `/private/tmp/codeshell-real-operation-cycles-20261016`:

- Web `ci-39022606881-web-independent-audit.json`, SHA256
  `7edd44d8d5417775bb1120ce843ad6018b71a58bf8dd045dd355af621132b0f7`.
- Linux `ci-39022606881-linux-independent-audit.json`, SHA256
  `8a106889c71e954cc162e98a0d880e7a5924230452ec81ba5a831ac270cc62b6`.
- Windows `ci-39022606881-windows-independent-20261017/verified-failed-summary.json`, SHA256
  `3ff48639340ba08f8ff6acf613360647385daf99023c07f5a519da6cf87464e3`.
- macOS `ci-39022606881-mac-independent-20261017/verified-summary.json`, SHA256
  `e52604cb16eb921cb17cd8565c042bfb67410cf8f8ddd7afe58d839aa3bd2c71`.

## CI17 — Windows NSIS failure without an artifact

[Run 39023748382](https://github.com/cjhyy/codeshell/actions/runs/39023748382)
executes source `70d2e3846ea48d0d797e51dbeac7026f563c76bb`, containing the reviewed
CRLF test-only correction and CI16 evidence. Web, Linux and macOS each have new,
independent artifact audits; their prior results are not substituted for this run.
Windows fails in the actual NSIS step, followed by failed artifact upload and
checkout cleanup. Only the other three platforms have complete artifact audits.

Web passes **31 browser behaviors**, nine image tests/45 assertions and 64 pure
Node lifecycle contracts. All 106 recorded source hashes and 33 PNG structures/
CRCs verify. The separate expected-negative reducer run passes two controls and
fails six known UI assertions while preserving its runner-verified owned browser
HOME/profile after normal close and observed custody settlement. Root again
views the actual fresh-login/draft and 390px multiline annotation samples.

Linux passes **83 native operations/12 Main**, separate Write React 11/38 and
all **13 Review pure Node contracts**, including the added LF/CRLF final-tail
regression. Actual Review's 11 cases agree with its report and durable evidence:
Main PID 5160 exits 0/no signal, controller exits 0, 55 journal events, stdout
212 bytes/four chunks and stderr 818 bytes/eight chunks have contiguous complete
ranges, with no first error, signal request or recording/truncation failure.
AppImage verifies ten actual GETs, first-JavaScript seven negative probes,
sandbox and full source/cache bytes/07777 inventory, including only 75 exact mode
normalizations. Inner fixture HOMEs are removed; outer launcher scratch remains
retained. Six agent-viewed and two Root-viewed actual PNG samples show readable
Chinese, complete generated-image paths and contained narrow Settings controls.

macOS passes **83 native operations/12 Main**, plus both DMG UI rounds of
**13 operations/one Main each**. Write React 11/38 and Review's 13 pure contracts
are separate. Three startup post-exit phases restore the final gates; Review's
11 cases, journal/stdout/stderr bounds, normal Main/controller exits and original
report agree. Four packaged watchdog request ledgers are empty/nontruncated.
The source-bound directory, mounted/copied payload and managed Node inventories,
production hooks and local ad-hoc signing checks pass. Both readonly attachments
are detached, and same-build owned replacement preserves its synthetic marker.
Fresh private HOMEs are removed while launcher scratch/DMG evidence roots remain
retained. Six agent-viewed and two Root-viewed samples include both actual DMG
390px dark Settings copies. This remains owned-copy acceptance; earlier inode/
PromiseGC causes remain unknown.

Windows passes 13 Review contracts (including LF/CRLF), 22 NSIS contracts and
Write React 11/38 in the retained job log. API and driver stdout show all eight
native steps succeeded, including Review past the earlier GC point. The actual
NSIS step then fails; its only final console error is the generic assertion
`Windows NSIS acceptance failed; owned state retained`. Neither the job log nor
the check-run annotation contains the internal phase or original NSIS error.

The upload and checkout-post steps also report failure without a detailed error.
The frozen artifact API contains only Web/Linux/macOS artifacts. Thus no Windows
ZIP/PNG, complete 83-operation/12-Main receipts, installed-copy UI reports,
registry/cache snapshots or six-root installer custody can be independently
verified. NSIS may have completed some operations; missing evidence does not
mean zero execution. The generic retention message is source intent, rather than
independent proof of retained state. Do not infer an internal timeout, process
termination, runner/OS cause or installer side effect from step timing.

Independent source review identifies a concrete evidence gap: process and outer
first errors are synchronously written to local receipt/journal, but the final
assertion replaces the console error with the generic message. Existing child
stdio tails are also only local files. Bounded console checkpoint/first-error
mirroring and a Windows public-evidence upload before NSIS are being prepared;
no diagnostic change is claimed to repair the still-unknown NSIS cause.

Frozen summaries under `/private/tmp/codeshell-real-operation-cycles-20261016`:

- Web `ci-39023748382-web-independent-audit.json`, SHA256
  `1260a00237d74f16bf3f6b579c3058ffd2f7a288fb87eca14a67be1b68d31751`.
- Linux `ci-39023748382-linux-independent-audit.json`, SHA256
  `a984ed2753d847cd2f635b17dd6d2ff4ac2c9da19cdf877814c628df8d95e3a3`.
- macOS `ci-39023748382-mac-independent-20261017/verified-summary.json`, SHA256
  `051f3a3bf58f0b278a63edd2f95bf9ca3d309d92ec3b9ffcc28acf2e2abbe65f`.
- Windows `ci-39023748382-windows-independent-20261017/verified-failed-summary.json`, SHA256
  `93fd90f152be6f19185c8d04b9a8d2a2b353a1b70c5985635e4aae0210aab0b3`.
- Windows second NSIS peer `ci-39023748382-windows-nsis-peer-20261017/verified-failed-peer-summary.json`, SHA256
  `969a8b93c8fda5dd945894ef1aaa149401b32517fd25c3b5a6892d179e5940ae`.

## Remaining acceptance work

- Retain the first combined-run MCP failure as unclassified. Two subsequent
  diagnostic runs against the combined build passed (10 attempts, 7 commits,
  all 8 actual stdio probes exited, no network/renderer errors). A later green
  run does not identify the cause of the earlier failure.
- Operations/cost suites now cover the current conversation/trace/diagnostic
  interface. The removed RunsView cross-session summary is not restored;
  production UsageLedger IPC/cold recovery and current request/attempt cost UI
  remain asserted, including unknown prices, missing usage and partial history.
- Continue release-artifact verification after this local integration. The
  local ad-hoc app has been built and launched, but full packaged runtime,
  installed update, Developer ID signing and notarization remain separate
  boundaries. Package-content inspection found no own-project smoke/e2e/test
  output, build metafiles/source maps or private settings/credential files.
- Native OS approval automation, Windows/Linux installer flows, cross-version
  download/install, full packaged runtime, remaining Windows/Linux runtime
  behavior, live external accounts and actual IM delivery remain unverified.

The actual native batch review was requested in an owned, confined Main with no
worker or HTTP request. CUA could not observe it: ScreenCaptureKit returned
`SCStreamErrorDomain -3802` twice using the exact fixture app path. Only that
recorded Main PID was terminated after command identity verification. No native
cancel/readability/default-focus result is accepted from this attempt. Its
private receipt is `native-batch-inspect/evidence/cua-observation.json` under the
operation audit output directory.
The next native attempt requested the real dialog again and hit the same
ScreenCaptureKit error. Only its exact guarded Main command was terminated;
actual cancellation/readability/default focus remain unverified. Its receipt
is `native-batch-inspect-round2/evidence/cua-observation.json`.

The packaged fixture's Chromium guard also used the obsolete
`codeshell-panel:` scheme. It now permits the production-registered local
`cspanel:`, `csmedia:` and `cstheme:` protocols, retaining the same single HTTP
origin and negative checks for lookalikes, wrong ports, HTTPS/WS and malformed
requests. Product protocol authorization is unchanged. The native encryption
timeout above is retained independently; the protocol correction does not
establish its cause.

Keychain preflight diagnostics now expose only locally generated fixed codes,
stage names, `launchStarted: false` and identity-match booleans. They retain
all original pin/no-overwrite checks and never recapture or retry an old HOME.
The first MCP failure remains unclassified.

The first packaged UI run passed navigation/theme installation and all six
width/mode combinations, then its reload driver inspected the page before the
lazy Settings route mounted and incorrectly tried the hidden workbench menu.
The failure screenshot showed Settings already visible. Waiting for the actual
restored Settings control repaired the driver; the repeated full UI run passed
in a new HOME. The first failure and both receipts remain separate.

`predist` intentionally materializes workspace runtime packages for packaging.
A no-emit check immediately afterward saw both those copies and the development
workspace declarations, producing private-class identity errors. After the
package was sealed, `bun install --frozen-lockfile --ignore-scripts` restored the
development symlinks with no lockfile changes; the Desktop/mobile no-emit check
passed. The materialized-state failure is retained and no TypeScript assertion
or production signature was weakened.

The first broad loop's old-menu/authority-fixture failures were retained rather
than counted as passing coverage. Explicit repository grants replaced obsolete
broker fixtures. The harness now binds both storage aliases to each new fixture
HOME; this recovered background-source and media tests without weakening runtime
authority.

An additional verification defect was reproduced in the installed Playwright
1.64.0: an asynchronous predicate that waited 20ms and returned `false` once was
accepted by `waitForFunction` in about 32ms instead of polling to its 150ms
timeout. The synchronous-false control timed out. The native harness now awaits
`evaluate` results in the controller with a finite deadline; its regressions
cover false→true, false timeout, IPC rejection and a never-resolving IPC. All
native-script asynchronous predicates were migrated and affected operations
were repeated. No package patch or weakened assertion is used.

Combined checks passed: 10 published-package tarballs and 48 typed entries, all
14 workspace typechecks, Desktop build, production-file ESLint, engine
construction guard, 67 initial focused tests, 61 additional settings/session
tests, 29 trace interaction tests and the expanded asynchronous-polling shard.
All 14 Web browser suites passed. All 42 Desktop browser suites completed;
history and project-picker selectors were corrected to select the intended
action rather than a newly added neighboring control, then rerun. The native
combined round passed 12 suites; the remaining MCP suite passed in two later
diagnostic rounds. Current operations passed after the final trace focus fix.
Retain first failures alongside these successful receipts.

The first combined cost cold restart was refused before Electron launched:
default Keychain path, device and owner still matched, but the inode changed.
No pinning guard was relaxed and the old fixture was not adopted. A fresh
isolated context is used for the repeated cost acceptance.
That repeated acceptance passed through production usage IPC, renderer reload
and a new guarded Electron Main process, with all six receipts and unknown/
partial accounting intact.

## Recovery wave — 2026-10-17

The concurrent repository audit was preserved and merged as documentation.
Its findings describe the frozen `66ee7737a` baseline, not the repaired state
below. This wave resolves D01/D02/D03 and SWC-05/SWC-06 from that audit; its
other engine, Coding, Chat and release-script findings remain separate work.

| Repair                            | Trigger and current verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git file mentions (D01)           | `git ls-files -z` plus streaming UTF-8 decoding preserves actual filenames, including Unicode and surrounding whitespace. Real Git tests verify returned paths remain readable. Before repair, actual Electron `@报告` showed no candidate despite the owned file existing; the screenshot and failed report remain at `codeshell-panel-operation-evidence-0cxOvA` in the system temporary directory.                                                                                                               |
| Current-root mentions (D02)       | The conversation root ID now reaches the existing Main root-authority check before ranking/capping. Omitted root IDs retain project-wide discovery; invalid, removed and replaced roots cannot fall back. Real Git/two-root, preload/authority and rendered Popover tests pass. Actual Electron selects the primary root's long-path match while the other root contains 30 higher-scoring matches.                                                                                                                 |
| Native JSON-lines Unicode (D03)   | `StringDecoder` retains partial UTF-8 bytes across chunks. Pure production-decoder tests cover every split, byte-at-a-time input, multiline framing and error recovery. Native frame size/error rules remain unchanged. No Chrome/native socket/authentication/shutdown experiment was run for this repair.                                                                                                                                                                                                         |
| Disk session recovery (SWC-05/06) | Invalid non-object records are skipped locally without rewriting healthy data. Sorting and cursor comparison share the same comparator. Actual Core-backed reader/temporary-disk regressions and existing authorization/archive/filter cases pass with pre-Core deny-all HTTP guards. Equal-mtime cases are explicitly constructed; natural production timestamp equality is not claimed.                                                                                                                           |
| Late memory pin UI                | An old pin may complete its originally authorized save but cannot refresh another store visit, reopen a different/closed selection or discard an editor draft. Actual React controls with owned IPC stubs cover late read/save/error/refresh, leaving and returning, both editing orders, another selection and closing details. Normal pin persistence/refresh remains covered. These are component/IPC-stub receipts, not native-store persistence evidence.                                                      |
| Revoked composer mentions         | File/recent selections bind to their selected text ranges. Editing/removing those ranges drops their metadata for ordinary send, queue and force-send; clearing/restoring does not revive it. Still-visible selections and explicit pasted/dropped/uploaded attachments remain. Recent provenance is retained. Real React/Popover tests with owned submission spies and range-helper tests cover Unicode, spaces, duplicate occurrences and suffix edits. No Engine/model was invoked for this metadata regression. |

The new native panel CLI accepts a fresh evidence directory for CI. The matrix
now runs file mentions, Files/Git/browser-guest/PTY operations in addition to cold
startup and packaged Settings/theme UI. Static review found a Windows test defect:
the renderer legitimately combines native root separators with forward-slash
relative hits. The test now normalizes separators for text comparison and still
reads the native file path to verify its bytes. This is a harness repair, not a
claim that Windows has run. Windows/Linux execution is still pending.

On source `8e08d6bd2ca91d820043986b513d91f22479e951`, actual macOS Electron passed
18 panel operations, including both mentions, real Git recovery, retained browser
guests and PTY input/cancel/exit/reopen. Renderer errors were empty; observed
processes settled `cleaned` with zero remaining, and the private HOME was removed.
The report is `recovery-wave-native-panels/report.json` under the operation output
directory. Three cold launches/reloads and a second window also passed again.

A new ad-hoc package from that source passed 13 UI operations in a fresh repeat:
`recovery-wave-package/ui-repeat/{receipt,launcher-receipt}.json`. Main exited 0,
worker/model/native-secret call counts were zero, package inventory/signature and
default-Keychain identity matched, recorded process settlements were `cleaned`,
and the fixture HOME was removed. ASAR SHA256:
`b8dfaa3ef02f09a8fc5c861723073091dd599263cebaeef92dfb48bd5d03f77b`.
The preceding `recovery-wave-package/ui` run completed the same 13 operations but
failed its final default-Keychain inode check. Its source remains unclassified;
the failure is retained independently and never counted as a pass. The successful
repeat neither adopts the old HOME nor relaxes pinning. Packaged Pet/encryption,
OS approval, installer/update and publisher-signing boundaries remain open.

Actual Web Host/Worker default and late-title sequences passed again, with receipts
at `codeshell-web-real-host-nJuVgP/evidence` and
`codeshell-web-real-host-5ZQeZp/evidence` in the system temporary directory.
Latest combined guarded checks passed: 27 file-search/decoder/catalog tests,
50 focused server tests with an external pre-Core guard, 37 memory tests and
22 mention metadata/range tests. These groups overlap; their counts are not a
unique-coverage total. Package release verification again passed 10 tarballs and
48 typed entries. Production lint, workflow formatting and script syntax passed.
All 14 workspace typechecks passed again after sealing the package and restoring
development workspace links.
The tested wave was fast-forwarded into local `main`, with all five pre-existing
modified/untracked paths verified byte-for-byte unchanged. Desktop then built
successfully in the primary checkout. Its additional cold-start attempt was
refused by `CODESHELL_KEYCHAIN_PREFLIGHT_IDENTITY_CHANGED` at `account-before`;
the guard did not start that failing launch. The original log remains
`recovery-wave-primary-startup.log`. A separate fresh-HOME repeat passed three
cold launches/reloads and a second window, recorded in
`recovery-wave-primary-startup-repeat.log`. This repeats the unclassified native
environment issue and does not establish a cause or packaged encryption safety.

## Platform and native follow-up — 2026-10-17

Three concrete cross-platform UI issues are repaired. The Chinese and English
follow-system theme descriptions now refer to the system appearance. Sidebar
session hints use the preload platform's Command/Control modifier. The command
palette's hints now agree with registered handlers: B/F use the platform modifier,
native-menu-only I/new-window hints appear on macOS, and three unregistered
Files/Browser/Terminal hints are removed while their actions remain available.
Actual Windows/Linux shortcut execution is still pending.

New native suites upgrade two earlier component-only boundaries. Their root
operation receipts are under
`/private/tmp/codeshell-real-operation-cycles-20261016`:

| Suite                                   | Actual operation and evidence boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e-memory-pin-operation-cycles.mjs`   | Seven compiled Electron Main/preload/renderer sequences: normal pin, late user→dream completion, pending selection B, both edit/pin orders, closed details, and a late failed save. Successful saves call the original production handler and verify actual A content/pin state; B/dream whole-file hashes remain unchanged. Each successful sequence commits once; the rejected save commits zero times and leaves A's complete hash unchanged. Read/save timing and one error are controlled. `native-memory-pin/receipt.json` records source `a396d1656`, compiled-source hashes, zero worker/network attempts and renderer errors, Main exit 0/no signal, 21 observed process incarnations cleaned/zero remaining, and HOME removal. No Engine, provider or account is used.                                                                                                 |
| `e2e-composer-reference-operations.mjs` | Nine real native keyboard/mouse/clipboard/file-chooser sequences through ChatView/App, preload and Main. Unicode/space mentions retain visible metadata; delete/suffix/paste edits revoke it for ordinary send, queue and force. Explicit picker files and production-staged pasted images remain; actual image bytes match both metadata SHA256s and decode to 8×8. Main captures and answers run/control requests before the Engine; its model catalog and owned chooser selection are controlled. File/root authorization, staging and session persistence remain production handlers. `native-composer-reference-final/report.json` records 11 run, 2 steer, 2 unsteer and 4 cancel requests, zero workers/pending/errors, Main exit 0/no signal, 37 observed incarnations cleaned/zero remaining, and HOME removal. This proves submitted metadata, not Engine consumption. |
| `test-service-worker-browser.mjs`       | Eleven actual Chromium ServiceWorker/CacheStorage sequences exercise production registration, worker and offline UI. Root/mobile cache ownership, scoped legacy cleanup, activated controller replacement, 320px offline layout, reconnect, uncached API/upload/project/POST/public-query responses, and failing private root navigations pass. The HTML shell and HTTP/API replies are owned fixtures; no authenticated account or Host is involved. A local proxy never forwards and rejects external HTTP/CONNECT/upgrade requests; actual page HTTP/HTTPS and SW HTTP negative probes are retained. This is evidence for those channels, not an OS network sandbox. `service-worker-cli/report.json` and two screenshots remain; all eight observed browser incarnations settled cleaned with zero remaining.                                                                |

Independent review strengthened controller-incarnation and private-root-navigation
assertions, image-byte checks, early native process custody, final renderer-error
gates and normal Main exits. Retained fixture failures are not product failures:
Memory's first four attempts used an obsolete filename format, a pin-sensitive
accessible name, an ambiguous hidden textarea and an incorrect discard label.
Their original receipts/screenshots and failure HOMEs remain at
`/private/tmp/codeshell-memory-pin-native-20261017-round-00{1,2,3,4}`.
Composer's initial two attempts assumed unsent staging inspection and an absolute
picker `path`; both failed and settled cleaned before the corrected native runs.
Their reports remain at
`/private/tmp/codeshell-native-composer-reference-20261017-{a,b}`.
The first SW attempt mutated its expected cache array while sorting; its failed
report remains at `codeshell-service-worker-browser-uAKxoB` in the system temp
directory. No production assertion was relaxed to recover these tests.

Desktop built successfully with the platform repairs, and 30 guarded platform/
existing-UI/SW unit tests passed. All 14 workspace typechecks passed both before
packaging and after development workspace links were restored. Targeted lint,
formatting, script syntax and diff checks passed.

A clean local ad-hoc macOS arm64 package from `a396d1656` contains the current
production changes. Its ASAR SHA256 is
`f837807dd88081e4928dd66539f66a6e1bc322b4678247996beb3eb6587d5fbc`.
The first `operations-followup-package/ui` attempt completed all 13 UI operations
but failed its final default-Keychain inode check; the overall result remains
failed. A fresh-HOME repeat of the same artifact passed all 13 operations and
seven screenshots at `operations-followup-package/ui-repeat`. Main exited 0,
worker/model/native-secret calls were zero, package inventory/deep strict
signature and default-Keychain identity matched, observed process settlements
were cleaned with zero remaining, and HOME was removed. The first failure remains
separate; the repeat does not explain the recurring inode changes or establish
packaged Pet/encryption, native approval, installer/update or publisher signing.

The dedicated acceptance workflow now includes both native suites on all three
Desktop runners and an independent Linux Chromium SW/offline job. Static review
caught an installer/isolated-HOME browser-cache mismatch before any remote run.
An explicit owned `PLAYWRIGHT_BROWSERS_PATH` now spans both steps. The isolated
runner and installed Playwright registry resolved that same path locally; this
is not Linux execution. Action tag existence was checked through read-only
GitHub API calls. The acceptance branch remains local pending push authorization;
no remote job, main push, release tag or publication has been performed.

## CI18 — frozen candidate awaiting native execution

The code checkpoint is `814f7921bd6c4f3151c93ee7a07a1c3591858804`, containing
local main `9b667863e8a8eb91db7b1f99eb9876169dcf19ec`, the scoped AI Review
feature and repeated-edit previews. This section records preparation, not a new
passing matrix. CI17's Windows NSIS phase/cause, missing Windows receipts and the
earlier CI15 observations remain unresolved. Later source changes belong to a
subsequent source-bound cycle.

Four additional product repairs are included:

- `6a3c3f299b2044f9f603279903689a22e5dcccfe`: completed CRLF lines retain
  their text while bare carriage returns retain the existing progress-frame
  behavior. Four expected-output failures were reproduced before the fix. This
  leaf repair does not assemble chunks across separate output reads.
- `82ed60fec408f422bac656bb44aab3dd9035f041`: a real reducer sequence showed
  that an earlier agent card could hide its later successful Write behind a
  parent Write. Different writer lanes now retain each successful tool preview
  as independent opaque hunks under one file header. This does not infer a
  global physical final version. Standard built-in writes within one lane remain
  sequential through Core's unsafe queue and retain their existing composition.
- `5296d7ec216501fdc9cd59c096a70af637520ed3`: `/branch feature-cache` and
  `/branch feature--create` no longer create a different, shortened branch.
  Creation flags match complete argument tokens. Actual temporary Git
  repositories reproduced both failures; the normal guarded runner passes
  without a TypeScript path override on the combined built dependencies.
- `e51c88810f45b83e8bf2dd9528ad2917807b571f`: a literal root filename
  `__all__` has a distinct selection from All files. The viewer and AI snapshot
  receive the selected original path; special names and obsolete selections have
  component regressions. These tests use mounted React components and public
  props; the special-filename interaction has not yet run in a native browser.

The original native fixtures retain their 83-operation/12-Main scope. The
original eleven-operation Review fixture and shared launch/custody helpers
remain unchanged. New
`e2e-review-draft-operations.mjs` adds a separate planned three operations/one
Main: staged draft plus focus/prefix preservation, stale scope completion, and
stale Session completion. It observes five actual production prepare IPC results
and three composer events; two responses are delayed only after the original
handler completes. Catalog data and owned Session/Git fixtures are controlled.
No model turn is sent. Its eleven pure contracts pass, including LF/CRLF final
HOME/error gates; the three operations themselves still require native CI.

Windows NSIS diagnostics now mirror bounded synchronous checkpoint metadata and
original first errors to CI stdout, including already-observed stderr tails.
Negative cached spawn exit codes are preserved. Write failure, short write or
caps latch the existing failure gate while leaving original cleanup intact. The
six process labels, sixteen installer phases, two thirteen-operation installed
UI runs, custody/registry/cache gates and budgets are unchanged. This improves
failure evidence and is not a repair claim for CI17's unknown installer cause.

The workflow adds an explicit 90-entry public Windows evidence allowlist
before NSIS; the final always-upload allowlist has 162 entries. The early list
is a strict subset. New entries are owned logs, Git fixtures, receipts and PNGs; no
private HOME/profile/cache or packaged binary is added. Removing the six added
steps, one new NSIS contract argument and 21 added final paths reproduces the
original workflow AST. Original steps, permissions and budgets are preserved.

Root independently verified the frozen combined source:

| Local gate                      | Verified result                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Backend Review/Git/TUI Review   | 75 tests / 301 assertions / 5 files                                                                                                  |
| Renderer/reducer/Review/IPC     | 187 tests / 686 assertions / 12 files                                                                                                |
| Actual owned Git branch command | 15 tests / 50 assertions / 1 file; standard runner                                                                                   |
| CRLF/progress output leaf       | 16 tests / 32 assertions / 1 file                                                                                                    |
| Node diagnostic contracts       | 55 tests: NSIS/signal 31, original Review 13, new draft 11                                                                           |
| Build/type boundaries           | Root build and all 14 workspace typechecks pass                                                                                      |
| Desktop compilation             | Main, preload, renderer and mobile bundles pass                                                                                      |
| Static gates                    | 47 changed product source files lint with zero warnings and pass format; six changed MJS files parse                                 |
| Workflow                        | 44 Bash blocks / 5 inline Node blocks parse; six actual harmless pipeline exit-code combinations pass; 43 literal script paths exist |

All listed test shards report zero failures and zero skips. They are not native
operation counts. Local execution was limited to builds, pure contracts, React
and reducer fixtures, and temporary Git repositories. Complete Desktop/native
builds and browser launches remain CI-only; the general local Desktop build is
not used because it executes the native Cua Driver version check.

The frozen Root gate receipt is
`ci18-frozen-source-gates-proof-20261017.json`, SHA-256
`38fbe5d867cf9079a7fcdd1f3c7ab654a3b051ff16546204e040778254713df0`.
It binds all 47 product source hashes, twelve unchanged native/harness files,
individual check-log hashes, original workflow preservation and author receipts.
No CI18 native result is asserted by this preparation record.

## CI18 — Review draft Session preparation failure

[Run 39028835292](https://github.com/cjhyy/codeshell/actions/runs/39028835292),
attempt 1, is a completed failure from the authorized acceptance-branch push of
`8aebc273d1f044627b112cc3cecf72e563a0b726`. This is the frozen code checkpoint
`814f7921bd6c4f3151c93ee7a07a1c3591858804` plus its preparation documentation;
all 47 product source hashes and workflow bytes were rechecked before the push.
Only the authorized acceptance branch was pushed. No remote main, tag, PR or
release was created.

| Job                    | Conclusion | Actual boundary                                                                                              |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| Web `117385062384`     | success    | 31 browser cases pass independently; 106 source hashes and 33 PNGs verified.                                 |
| Linux `117385062394`   | failure    | Startup 7 operations/3 Main and original Review 11/1 pass; new draft completes 0 of 3, with one failed Main. |
| macOS `117385062157`   | failure    | Same completed original 18/4 subset and new draft 0/3; no packaged UI, updater or DMG acceptance this run.   |
| Windows `117385062416` | failure    | Original 18/4 subset passes; new draft 0/3, one failed Main. Early evidence upload and NSIS are skipped.     |

Linux and macOS first-error journals both locate the timeout in
`review-session-seed`, before any actual Review prepare IPC is recorded. The
failure is `Timed out waiting for an asynchronous UI condition`; its stack points
to the shared async UI wait helper. The final IPC ledger is empty. Each durable
deny ledger contains one `agent:msg` channel record and no RPC method. Therefore
this run does not establish that the denied method was `goalGet`, nor that a
product Review result or scope/session fence is wrong.

The new fixture's source denies every `agent:msg`. Static tracing separately
shows that ordinary Session loading can issue read-only goal/registry requests;
Main has existing no-worker production fallback handlers for them. A subsequent
fixture repair must narrowly validate owned Session identities and exact
read-only parameter shapes, call the original listener, and retain denial of
model turns, configuration, fork/compact and writes. The production
SessionManager may initialize directories and clean its owned staging inside the
isolated HOME; these reads must not be described as zero filesystem mutation.
This is a proposed source correction, not a successful native repeat or proof of
the specific denied RPC in this run.

Cleanup evidence remains separate from the first timeout. Linux Main 5665 and
macOS Main 26196 do not close normally; the existing authorized monitor then
records termination requests and observes `null/SIGKILL`. Their complete observed
custody settles with 15 owned identities, zero remaining, no query failure and no
truncation. Both failed private HOMEs are recorded retained. An empty prepare
ledger subsequently produces a JSON parse error; it is a later ledger failure,
not evidence of a completed request. Neither artifact contains the attempted
`failure.png`, so no failed-draft screenshot is asserted. Main stderr supplies no
additional owned product stack explaining the initial timeout. Cleanup signals
are not promoted to a preexisting crash cause.

The completed original subset is source-bound independently: three startup
processes and one original Review process exit `0/null`, custody settles, final
deny/Worker ledgers are empty, and their successful private HOMEs are removed.
The source drivers and shared launch/custody files retain their prior reviewed
bytes. Later native suites are skipped, so this is 18/4 rather than 83/12. The new
failed Main remains separate, with zero accepted draft operations; five prepare
results and three composer seeds have not been observed.

The native pure gates pass separately: Write label 11 tests/38 assertions,
completed CRLF output 16/32, aggregation/Review 140/421 across three files, branch
command 15/50, original Review diagnostic contracts 13 and draft contracts 11.
These are not additional native operations. The four product repairs retain
their local proof; this failed matrix is not release acceptance.

The macOS artifact is `12099513385`, 576,283 bytes, SHA-256
`468636010d966bf24b34b00036fd7a03b37ca1b1a26d24c09f7e5037d7599b93`.
All 55 safe regular ZIP entries pass CRC; expanded bytes are 712,322. Root's
37-check partial-failure audit has no failed evidence checks, SHA-256
`532e4d76c5cd09471140d1304f9a4e2c87a99204ed9a97f9b1f5b518f33c74f3`.
Two uploaded original-subset PNGs were visually inspected; the new failure PNG
is absent. The audit helper initially indexed an unavailable optional `main`
field, then used an absent/None check; this corrected only the local evidence
reader, not product behavior or test results.

The Linux artifact is `12099831811`, 586,894 bytes, SHA-256
`c937589c1aff9ab29f3491d93ed1124128a89e43db0f1dd3261e77be41da3a5f`.
All 57 safe regular ZIP entries pass CRC; expanded bytes are 724,500. Its
independent failed-summary SHA-256 is
`c030d7fad0d5f972e6898c6418646d2192449ff1048606c5576157d62245fd2e`.

The Windows artifact is `12099945854`, 451,149 bytes, SHA-256
`22ec933ad5274f50c22157833e2c2965be702b1f3599c769f83162ec87c01911`.
All 57 public regular entries pass CRC; expanded bytes are 594,473. Its
42-check independent partial-failure summary has zero failed evidence checks,
SHA-256 `d8dbccce1ebacfb74054366e877cf9c7f3c2af88d46e6dd36f564604133978dd`.
First error is the same Session-preparation timeout at 44.293 seconds. No
ChildProcess exit for Main 3788 has been observed then; the monitor starts
cleanup at 57.465 seconds and records
root `SIGTERM` at 59.819 seconds, before observing `1/null` at 59.864 seconds.
This is not evidence of a crash before cleanup. Observed custody settles
21 identities to zero, query failure/truncation are false, and the failed HOME
is retained. The deny is channel-only, the prepare ledger is empty, and no
failure PNG is uploaded. The original 18/4 subset is independently normal and
clean; the later six suites, early upload and NSIS are skipped. Windows also
passes the 31 pure NSIS/signal contracts, which do not execute an installer.
Root independently rechecked API/ZIP/receipts and all seven unit-log hashes;
its three fixture source fingerprints match the exact CRLF conversion of Git
bytes. The initial LF-only evidence comparison was corrected in the reader,
without modifying source or rerunning native tests.

The Web artifact is `12098824470`, 1,476,417 bytes, SHA-256
`2019579e5eaf47a2b55c8f7cf48b4f52efeff2367213528747a2d4a393c5c03f`.
The independent reader verifies 31 actual browser cases: service worker 11,
authentication 4, child state 8 and annotations 8. The nine attachment/image
regressions with 45 assertions and 64 lifecycle contracts are separate pure
counts. All 106 recorded source hashes match the exact Git blobs and all 33
PNG chunks, CRCs and dimensions validate. Early child capture, full birth
custody, normal browser exits, zero remaining identities, bounded raw logs and
successful private HOME removal pass. The old reducer negative control retains
its two expected controls, six expected UI failures, actual Node-1/tee-0 pipeline
and physically verified failed-profile retention; these are not additional
passing browser cases. Root visually inspected two exact uploaded PNGs. The
Web audit SHA-256 is
`fbcc5b76ac2afdc1d66d7201ce6e4b51d7409baf57add76efd0ccafb1afe6434`.

macOS and Windows partial-failure summaries were independently peer checked.
Their evidence-reader corrections do not explain the native failure. No local
browser, Electron, native application, Keychain, PowerShell, installer, provider
or external account operation was run for this cycle. The overall
release-operation goal remains active.

## CI19 — reviewed follow-up awaiting native repeat

The frozen code checkpoint is `02cf5d65c2ae90a4917c1a332e87287f615baa45`,
containing CI18's code, the selected local main
`19efab9225723c76af447f8b9d9f65aace3b0780` and the follow-ups below. CI18 remains
failed; this preparation records local checks and source review, without a new
native or browser pass. Later main changes belong to a later source-bound cycle.

- `c4f45d63b37b27d0deca020d5b4cb7a5bbce01c1` preserves the authoritative
  absolute target of an external worktree file in the summary and Review.
  Relative parent tools are kept separate when their caller cwd is unknown;
  only known absolute identities are merged. Review passes absolute POSIX,
  Windows drive and UNC targets through without prepending the parent root.
  The same reducer and mounted Card/Viewer regression suite records twelve
  failures and five passing controls with the old frozen modules, then passes
  all seventeen after the fix.
  These are owned event/openPath recorders, not actual OS file opens.
- `ef9b2e10176ef70b2376f1839a23071ab1114576` prevents a complete streamed
  fenced code block from being split at its internal blank lines. The shared
  fence scanner now also chunks the stable prefix outside fences while
  preserving indentation and raw CRLF code. Actual SSR reproduced the broken
  code/prose structure; 54 related tests/118 assertions pass. The original 26
  leaf test bodies and done/plain/throttle/memo declarations remain unchanged.
  SSR does not execute the 120ms effect or prove native incremental timing.
- `1870b31c565ea45e1a0ae7d954558ba3888d6d5f` and
  `152c6c1a9a05c78790ed7d1db37aa51439dcb816` replace the new fixture's
  blanket channel denial with strict admission of three owned read-only metadata
  methods to the original production listener. Exact parameter keys, two owned
  Session IDs, single-frame/ID limits and a finite 128-request cap are checked.
  Turns, configuration, writes, fork/compact, shell control and foreign requests
  remain denied. No metadata reply is mocked. Production no-worker routes may
  initialize directories or clean owned staging inside the isolated HOME.
  Final metadata validates every record and retains late allowed reads; the
  earlier Main snapshot must be its exact unchanged prefix. Late forbidden
  requests and metadata IO failures still reach the original denial/failure
  gates. Two frozen VM failures and 22 guarded contracts support this fixture
  correction; they do not identify CI18's unrecorded native RPC method.

Root independently checks the combined final source:

| Local gate                                 | Result                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Actual combined Review/path/Markdown shard | 211 tests / 617 assertions / 7 files; zero failure/skip                                                                      |
| Broader R27 Card/Viewer/parser controls    | 215 tests / 752 assertions / 14 files; overlaps the combined shard and is not added to it                                    |
| Node contracts                             | 66 tests / 6 files: NSIS/signal 31, original Review diagnostics 13, draft 22; zero failure/skip                              |
| Actual Desktop package types               | Both no-emit commands pass, covering main/preload/renderer and mobile                                                        |
| Renderer production compilation            | Passes at `771da9e6919d217c5b73d429277d5b7385183b94`; every `packages/desktop/src` byte is unchanged from that UI checkpoint |
| Static checks                              | Twelve changed source paths lint with zero warnings; those paths and workflow pass format; three MJS files parse             |

The prior CI18 root build and fourteen-workspace checks retain their original
checkpoint. They were not all rerun for this follow-up; current changed UI source
received the actual Desktop typecheck and renderer compilation above. Author
source-only type diagnostics are retained separately rather than called a clean
full workspace check.

The workflow adds only four explicit test arguments to CI18's existing guarded
aggregation step. All 44 Bash blocks still parse. Step order, budgets, logs and
90-entry early/162-entry final public artifact allowlists are unchanged. No new
artifact path or private HOME/profile/cache/binary is uploaded.

The twelve original native/harness files retain their frozen blobs. The new
Review fixture's three-operation body is byte-identical, SHA-256
`ac5e7e1f291decef502e72aefe487807340b1f58f29ce49892c6d65c1e3b2202`.
Its required five actual prepare results, three composer seeds, seven negative probes,
early full-birth capture, normal `0/null` exit, late denial checks and HOME
cleanup requirements remain intact. Original 83 operations/12 Main and the new
planned 3/1 must be audited separately in the next native run. CI17's NSIS cause
and earlier native failures remain unresolved until direct evidence supports a
conclusion; a successful metadata VM does not repair an installer.

The frozen combined local-source receipt is
`ci19-frozen-local-source-gates-proof-20261017.json`, SHA-256
`2875a62c373d9fbc8056117800e2ccd070e0771c0bfe1064626cb1665c8dc59a`.
It binds all twelve changed source hashes/blobs, seven raw check logs, author
proofs and the unchanged native/workflow boundaries. Final workflow SHA-256 is
`32603ae10ecb9c09e4a769ea77cdece86719419c251986ac6444977400a4097e`.
No local browser, Electron, Keychain, PowerShell, installer, provider or external
account operation was executed. The next push remains restricted to the
already-authorized acceptance branch; no remote main, tag, PR or release is part
of this cycle. The operation-audit goal remains active.

## CI19 — draft callback failure and Windows Review identity failure

[Run 39031300464](https://github.com/cjhyy/codeshell/actions/runs/39031300464),
push attempt 1, binds source `f77af15c6f11f4eb791ac72df77667cb892bc002`.
The final run API records overall failure: Web succeeds and all three native
jobs fail. The original CI18 failure and every earlier unknown remain separate;
the CI19 preparation section above keeps its original local-only scope.

| Platform | Actual accepted original subset                       | First failed native fixture                            | Unexecuted acceptance                                                 |
| -------- | ----------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| macOS    | Startup 7/3 Main plus original Review 11/1 Main: 18/4 | New draft: 0/3 completed operations, one observed Main | Six later original suites and DMG skipped                             |
| Linux    | Startup 7/3 Main plus original Review 11/1 Main: 18/4 | New draft: 0/3 completed operations, one observed Main | Six later original suites, AppImage build/runtime and updater skipped |
| Windows  | Startup 7/3 Main                                      | Original Review: 0 operations, one observed Main       | New draft, six later original suites and NSIS skipped                 |

The completed original subsets have normal Main exits, observed full-birth
custody settled with zero remaining identities, and recorded successful inner
HOME removal. They are not the original full 83/12 or the new planned 3/1.
Directory packaging succeeds separately; no packaged UI or installer acceptance
is inferred from the build receipt.

On macOS and Linux the new fixture reaches the real staged Review UI and first
production `preparePrompt` request. Both record the first failure as
`Cannot read properties of null (reading 'prompt')`, at driver line 473:28 in
`review-ui-operations`. Their final Main snapshots and durable IPC logs contain
one complete, returned production prompt and two owned `goalGet` requests.
The seven negative probes are blocked; denied and Worker ledgers are empty.
This establishes the current read-only route boundary without identifying
CI18's unrecorded denied method.

Actual failure PNGs show the old unsent prefix and first production prompt in
the composer, with readable Chinese. The full operation's assertions did not
finish, so its count stays zero. macOS Main exits normally `0/null` with observed
custody 13→0; Linux exits `0/null` with 15→0. Neither requests a cleanup signal.
Both controllers fail and both owned HOMEs remain recorded as retained. The
private HOMEs are not uploaded and cannot be physically rechecked by the
artifact reader. No generated-image or updater PNG is claimed for these skipped
stages, and the full AppImage mode/cache/sandbox/ten-GET runtime checks do not run.

Windows fails earlier in the original Review's `harness-main-identity` phase:
`electronApplication.evaluate: Resulting promise was garbage collected.`
The first-error record occurs before cleanup and before any observed
ChildProcess exit.
Later authorized cleanup signal requests, Main exit `1/null` and observed
birth-custody settlement 32→0 are recorded separately. The HOME removal flag is
false; no Review failure PNG or returned Main identity is invented. Service/GPU
stderr during cleanup does not establish the GC cause, which remains unknown.
The new draft callback correction below does not repair or explain this RPC
failure. NSIS does not execute in this run.

Web independently passes its unchanged 31 browser behaviors: ServiceWorker 11,
authentication four, child state/send/stop eight and annotations eight. Image
units nine/45 assertions and lifecycle Node contracts 64 remain separate.
The audit verifies 106 source hashes, 33 PNG CRCs, early canonical browser/HOME/
profile capture, normal exits, observed birth custody, final ledgers and HOME
cleanup. The old-reducer negative run keeps two passing controls and six
expected failures, with runner-verified retained profile; these are not extra
passing behaviors. Two current-run images are visually inspected.

All native jobs pass the separate Write 11/38, output 16/32, aggregation 211/617
across seven files and branch 15/50 guarded regressions. They also pass original
Review Node 13 and draft Node 22. Windows additionally runs the 31 NSIS/signal
contracts; that Windows-only step is skipped on macOS/Linux. Pure tests are not
added to the native operation counts or relabeled as installation evidence.

The frozen independent summaries are:

- Web `ci-39031300464-web-independent-20261017/ci-39031300464-web-independent-audit.json`,
  SHA-256 `dfd70c4dbdec6d820820a97414182260082daa15292f3e6559bbd1617c09575d`.
- Linux `ci-39031300464-linux-independent-20261017/verified-failed-summary.json`,
  SHA-256 `52d0d456672e682e58ccaece2c5bd5ec327b48613af2885de58943da18a37522`.
- macOS `ci-39031300464-mac-independent-20261017/verified-failed-summary.json`,
  SHA-256 `b82cc422e32a07c7717f5f0b762113d0cc01a60c1840e0b60fdfdd86d14778de`.
  Its independent raw-evidence peer is
  `ci-39031300464-windows-independent-20261017/mac-failed-summary-peer.json`,
  SHA-256 `dcc95deb1ddf918caf6630d767dd3cfd364ee914a7c73926ac594e7271028cb1`.
- Windows `ci-39031300464-windows-independent-20261017/verified-failed-summary.json`,
  SHA-256 `d1ca51ef8ae030dc90e739cb3a268f8db764107a48c97f9fc9cbae0e9f15b332`.
  Its 22-check raw-evidence peer is
  `ci-39031300464-windows-root-failure-peer.json`, SHA-256
  `9a69458223a6d3a511194097dfa2ab0b39a86ffd638af7c2024a958aba07a3f4`.

Two subsequent repairs have local, source-bound evidence only:

- `99357a70e3da855052f7b7483de762fa10e7b507` fixes exactly three fixture
  callbacks: Electron's first evaluation argument is its module, and the owned
  payload is the second. The wait predicate and both response-arm callbacks now
  bind that second argument. Actual extracted driver/harness functions under the
  public two-argument signature reproduce the old null-prompt read and arm
  rejection: 22 controls pass and three contracts fail; the fixed 25 all pass.
  Removing only the three added first-parameter tokens restores the entire old
  driver byte-for-byte. Page callbacks, operation assertions, five prepare
  results, three seeds, seven probes, deadlines, custody and HOME gates stay
  unchanged. Proof `codeshell-review-draft-evaluate-proof-20261017/verified-source-summary.json`
  has SHA-256 `7aca3eb2ded5c360f24fcab38fe2791b4fb3d90c27e86aefb2533ddc9c465644`.
- `56cee4415482ab16439250172ed793aa74897b3b` addresses the independent
  COMPOSE enclosing-snippet preview defect. Real Core Edit leaves write two owned
  temporary-file scenarios with identical operation payloads but different final
  bytes, despite each old string being globally unique at its actual edit.
  Payload containment alone therefore cannot prove a common file location.
  The fix removes only that outer-baseline reconstruction and retains independent
  preview hunks; inner replay, full Write and opaque barriers remain. This is a
  conservative operation preview, not an authoritative final-file diff. The
  producer is the actual Core leaf, not Engine/ToolExecutor/approval or a provider.
  The guarded reproduction has two controls/two failures; the author fix shard
  passes 219 tests/767 assertions across 15 files. Its proof
  `codeshell-snippet-containment-fix-proof-4__a6lmw/verified-summary.json` has
  SHA-256 `03a616c44617cc83fca55417b616e8d90d2e95348e27129c53977de912178392`.

At the integrated code checkpoint `9c23bd4581b87a801fe13eb3793a34f97aba777e`,
Root records the combined nine-file UI shard 231 tests/686 assertions and Node
69 across six files, with zero failure/skip. Both actual Desktop no-emit
configurations, renderer production compilation and five-source lint checks
pass. These overlapping local checks are separate from the CI19 results and do
not establish native recovery. No local browser, Electron, Keychain, PowerShell,
installer, provider or external account operation is run for these two repairs.
The operation-audit goal remains active.

## CI20 — local checkpoint only

The local checkpoint `686a05377be77e5513a9935eb4845d4bee9c3acc` binds six
source/workflow paths and the two scoped repairs above. Its receipt
`ci20-frozen-local-source-gates-proof-20261017.json`, SHA-256
`2f9bbf2e4adb700140a97973c745b2ccecdac5040dc7d4b39bc0f75c59453ca4`,
records 231 tests/686 assertions across nine files and Node 69 across six files
(31 NSIS/signal, 13 original Review, 25 draft), with zero failure/skip. Both
Desktop typecheck commands, renderer compilation, five-source lint and six-path
format checks pass. The original twelve native fixture/harness blobs remain
unchanged; native recovery and NSIS revalidation remain pending. Windows GC
cause stays unknown. This is not final release-source validation: later main
changes are outside this checkpoint. No dispatch or new runtime result is
asserted here.

## CI20 — combined candidate frozen locally

The final local candidate `635bed14e717638fe756664134a0a0d94bd8c1bc`
includes selected main `4ad2052b6fd697af6141d8e60df1724cff509383`, the two
repairs recorded above, and the three scoped follow-ups below. The earlier
`686a05377be77e5513a9935eb4845d4bee9c3acc` checkpoint keeps its original,
narrower scope. The new frozen receipt
`ci20-final-combined-source-gates-proof-20261017.json`, SHA-256
`9826236b78e62c95618a9880d38b3f249d1a43b5a9c89cd49be69ba961fa2e99`,
binds 33 source/workflow paths and the compiled/tested checkpoint
`dfb153a3b53c6c56a3fdb085e3e4f07c009cacbd`; all package sources, scripts and
build manifests remain unchanged through the final local candidate.

Root's combined guarded shard passes 310 tests/2,578 assertions across twenty
files, with zero failure/skip. Node contracts pass 69 across six files
(31 NSIS/signal, 13 original Review, 25 draft). The safe full workspace build,
all fourteen workspace typechecks and four Desktop static bundles
(main/preload/renderer/mobile) pass. Thirty-two source paths lint with zero
warnings and 33 source/workflow paths pass format. These combined tests overlap
the author shards and prior checkpoints; their counts are not added together.

- `acb288f9099b1ef95be4516ede7e601eeca132e3` retains late external-completion
  attribution and marks snapshot coverage unresolved without an execution
  receipt. Actual reducer events and the React notice consumer reproduce six
  failures with twelve passing controls against selected main; the author shard
  passes 198 tests/624 assertions across eight files. Proof
  `codeshell-turn-diff-external-proof-uwqzyd7y/verified-summary.json` has SHA-256
  `4408ad0f8f183947140616ba620f56236b0904f3993f2956151b5b64dffe2306`.
- `8041caccac3903470428fd776918e6d1bd2720ac` resolves real physical case aliases
  without lowercasing distinct files. The owned Mac filesystem establishes the
  same device/inode for the two spellings: four original assertions fail and one
  control passes; the fixed shard passes 29 tests/1,590 assertions. Proof
  `codeshell-turn-diff-case-proof-r8Vle7/verified-summary.json` has SHA-256
  `cac4490e856c6b23ddf0f82a81811163a497bd1bd89071e87211c1f8bbc21e11`.
  This does not establish Windows filesystem execution.
- `63447e30edad5ab9cf5f627af85afa15513843a3` preserves UTF-8 BOM bytes during
  capture. Actual owned-file tracker results reproduce five failures with two
  passing controls; the fixed old/new shard passes 30 tests/1,669 assertions.
  Independent patch application preserves exact BOM, CRLF and no-final-newline
  bytes, while malformed UTF-8 stays rejected. Proof
  `codeshell-turn-diff-bom-proof-20261017/verified-source-summary.json` has SHA-256
  `a9d11f6fbd6f428a754db51ef643034a03e89f4f666c5ebadf31ff970743ed02`.

These are source, owned-file and compiler checks, not native recovery. The three
new Review draft operations have never completed successfully in actual native
acceptance. Windows Review GC and the CI17 NSIS failure causes remain unknown;
NSIS revalidation is pending. No local browser, Electron, Keychain, PowerShell,
installer, paid provider or external account operation is executed for these
checks. The original native/harness blobs and acceptance gates stay frozen.
The full CI20 run has not been dispatched; no runtime outcome is asserted.

## CI20 — panel locator and Windows test portability failures

[Run 39034148714](https://github.com/cjhyy/codeshell/actions/runs/39034148714),
push attempt 1, binds source `cecd79dc876da244bf7dd3277774e82d3d3866db`.
Web succeeds; all three Desktop jobs fail. The earlier preparation entries keep
their original local-only scope. The final run API has SHA-256
`24515e547f743e3dc48ca8c4f19a7e205d12d9e9b22660f3d031fcba6bee5249`.

macOS and Linux each pass the original startup seven/three Main and Review
eleven/one Main. Their new draft fixture records two completed operations:
the full staged prompt appends once after the existing unsent prefix, and a
held staged response cannot append after the real scope changes. The current
unstaged response then appends exactly once. Actual full input equality and
unchanged model/permission controls are verified by those operation receipts.

The third operation switches to B, releases the held A response, and reaches
`reviewPanel` at driver line 150, called from line 536. The first error is a
strict locator violation: the global `new-tab` locator matches two elements.
Four actual production preparations, IDs 1–4, return; held results 2 and 4 are
released. B's fifth preparation is not reached. The later `4 !== 5` ledger
assertion is secondary. The final renderer-seed snapshot is absent because its
statement is unreached; this is not evidence that zero seed events occurred.

Both runs have two actual owned `goalGet` reads, seven blocked negative probes
and empty denied/Worker ledgers. macOS Main exits `0/null` with observed
full-birth custody 14→0; Linux exits `0/null` with 17→0. Neither requests a
cleanup signal. Both controllers fail and both owned HOMEs remain recorded as
retained; private HOME contents are excluded from the artifacts. Failure PNGs
show B's original unsent prefix and one visible launcher plus button. That image
does not expose hidden DOM or independently establish locator cardinality.
The original full 83/12, new complete 3/1, later six suites, AppImage runtime,
updater and DMG acceptance are not completed in this run.

Windows fails earlier in the guarded twenty-file aggregation shard: 310 tests
complete with 297 passing, thirteen failing and 2,511 assertions. The failures
are one POSIX-only omission predicate, ten short/long canonical-path equality
blocks, one interrupted-state raw-path predicate and a filename containing
characters Windows cannot create. Its six new physical case-alias tests pass
on the actual case-insensitive Windows filesystem. These are unit filesystem
results, not Electron acceptance. All later branch/native/package/early-upload/
NSIS stages are skipped; there are zero native receipts and zero PNGs.
The uploaded six public logs pass CRC checks. Git LF and projected CRLF test
hashes are separately labeled; actual Windows test source files are not uploaded.
Historical Windows Review GC and NSIS causes remain unknown.

macOS's aggregation shard passes 310/2,578; Linux passes 310/2,575, reflecting
the explicit filesystem-dependent test controls. Their Write 11/38, output 16/32,
branch 15/50, original Review Node 13 and draft Node 25 pass separately.
Windows passes Write 11/38, output 16/32 and Node 31+13+25 before its shard
failure. Its branch shard is skipped. These counts overlap local and author
checks and are never added to real UI operations or installer acceptance.

Web independently passes the original 31 real browser behaviors, image nine/45
and lifecycle contracts 64. Its separate expected-negative run retains two
controls and six known failures, with runner-verified retained profile. The
audit binds 106 source hashes, 33 PNGs, normal browser exits, observed birth
custody, final ledgers and HOME cleanup; current screenshots show readable CJK.

Frozen independent summaries are:

- Web `ci-39034148714-web-independent-20261017/ci-39034148714-web-independent-audit.json`,
  SHA-256 `b6c5bc56ea1726c5a98c059df377578cb0aa5ff286d516569de6b0f0e9397378`.
- Linux `ci-39034148714-linux-independent-20261017/verified-failed-summary.json`,
  SHA-256 `8617826376520128c9a48d5ae6f781b14fd41ad99967318f83fb596652ec5656`.
- macOS `ci-39034148714-mac-independent-20261017/verified-failed-summary.json`,
  SHA-256 `d960df9647ca427662d1f89761e9eb3bd62241d8db88a081c03bfae7c104f90f`.
- Windows `ci-39034148714-windows-independent-20261017/verified-failed-summary.json`,
  SHA-256 `23425a4c19e944e9303a04eeae9f90f88c1c8d3a2bb69eb43b6f310a471ff9fb`;
  its eighteen-check raw-evidence peer has SHA-256
  `73c351c310e78b7becf4daa4f23d76ce30d238d4ba6f516e4d240491d12c83e5`.

The next fixture corrections must preserve strict unique visible panel targeting,
all original operation assertions, five real preparations, three final seeds,
failure retention and normal-exit/custody gates. Windows portability corrections
must preserve all test cases and platform-valid filename coverage. None of
those corrections establishes native recovery until a fresh run completes.
No local browser, Electron, Keychain, PowerShell, installer or provider is run
for this audit. The operation-audit goal remains active.

## CI21 — local frozen preparation

Candidate `5b353ba81579cff4fa318c864d4fc9978eed5e63` combines the three scoped
corrections below. Its frozen local receipt
`ci21-frozen-local-source-gates-proof-20261017.json`, SHA-256
`26e09a9c2ea1ae335459531b4c080c111448edf7c98ce5afbe0b0122d231b518`,
binds eight source/workflow paths and compiled/tested checkpoint
`13edfb6bf2dcd0809a5db69c1ce2bb1951468312`; all package sources, scripts and
build manifests remain unchanged through the candidate.

- `efe9482d84a4251300eda53b5799f8e42976eb63` scopes the draft fixture's panel
  controls to one active, visible, non-inert Session dock. It retains strict
  rejection of missing or duplicate controls and the entire three-operation
  body. Actual extracted-helper locator contracts reproduce three failures with
  28 passing controls against the old helper; the fixed 31 pass. Proof
  `codeshell-review-draft-visible-scope-proof-20261017/verified-source-summary.json`
  has SHA-256 `beadb4ef62b4a0ac0887e34f0edd12fc9034d60897902bfb539cec00ebfd9440`.
- `fb6d04a183a093d763c138a83d70261b3efef923` changes only three test fixtures:
  native canonical owned paths, exact omission-path equality and a Windows-valid
  Unicode/space filename. POSIX quote/tab coverage and all test counts stay.
  CI20 supplies the actual Windows thirteen-failure evidence; the local Mac
  control passes 39/1,727, including six unchanged case-alias tests. This is not
  a Windows green run. Proof
  `codeshell-turn-diff-platform-proof-cy_7vmjn/verified-summary.json` has SHA-256
  `0cc97b2a90a492c6294ef6ce098fc874b1ccd8ac4b8151082795c24726b2aaef`.
- `38494198cf56098f82d471f4ab1ad24e771b596b` keeps an incomplete UTF-8 suffix
  at the same raw incremental-output cursor while output is live. Owned-file
  RingFile/BashOutput leaves reproduce thirteen failures with seven controls;
  the fixed related shard passes 50/710 across four files. Process status and
  the local instance registry are mocked; no actual shell or pipe timing is
  tested. Proof `codeshell-utf8-frontier-fix-proof-52mnt060/verified-summary.json`
  has SHA-256 `b8502a5481d1699ca69b6011c9cdab071696021e52cf9a312dc0c77270b0cd23`.

Root's final combined guarded shard passes 344 tests/3,256 assertions across
23 files. Node contracts pass 75 across six files (31 NSIS/signal, 13 original
Review, 31 draft), with zero failure/skip in both shards. Safe full workspace
build, all fourteen workspace typechecks, four Desktop static bundles,
seven-source lint with zero warnings and eight-path format checks pass.
Overlapping author and earlier counts are not added; assertion totals can vary
with explicit filesystem controls. The workflow adds only three test arguments
within its existing budgets and artifact/permission/native gates.

All evidence above is local source, owned-file or compiler validation. Actual
native draft acceptance remains two of three on macOS/Linux; Windows has not
rerun its corrected pure tests or reached native acceptance. Historical Windows
Review GC and NSIS causes remain unknown, and installer revalidation is pending.
No local native/browser, Keychain, PowerShell, installer or provider is run for
this preparation. No CI21 dispatch or runtime result is asserted.

### CI21 seed acknowledgement supplement

Fixture-only commit `493ef92e27cbcc5ab934b31f2fa2702214b25be1` separates
composer-seed attempts from App acceptance. Pure tests execute the actual
publisher/consumer source and App bucket guard: late A is rejected while B is
active without writing either draft, yet the old recorder counts four attempts
as three expected accepted events. Both listener registration orders reproduce
the error: 31 controls pass and two fail across 33 tests. The fixed 37 contracts
pass, including optional absence of a late attempt, pending acknowledgements,
bounded overflow and rejection of unknown or extra events. Proof
`codeshell-review-draft-seed-ack-proof-20261017/verified-source-summary.json`
has SHA-256 `fe77fff42e36207c56053f4083bfc133be030bbf18cbbbc6ca57ffd1dcdc5801`.

All attempts remain recorded; acknowledgement is read after synchronous event
dispatch in a microtask. Success still requires exactly three accepted tuples
for preparations 1/3/5. At most one additional rejected tuple may match held
preparation 4 after the first two accepted entries. Events carry no Main request
ID; the real five-call ledger, ordering and complete A/B draft checks provide
the cross-binding. Original UI actions, guards, budgets and cleanup gates stay.

Root's final six-file Node gate passes 81: NSIS/signal 31, original Review 13
and draft 37, with zero failure/skip. The six new contracts are not added to the earlier
344-test product shard. Production sources and build manifests remain unchanged
from `5b353ba81579cff4fa318c864d4fc9978eed5e63`; this is fixture instrumentation
and pure verification only. Three-platform native and installer revalidation
remain pending, with historical GC/NSIS causes unknown. No CI21 execution or
runtime result is asserted.
