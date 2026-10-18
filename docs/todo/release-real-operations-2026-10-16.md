# Release UI operation audit — 2026-10-16

Status: in progress. A passing row covers its stated fixture and boundary; this
is not a claim that every platform, external account, or packaged release works.
Continue the loop: operate the current interface, retain the failure, fix the
cause, repeat the operation, then check the combined build.
The release target is macOS, Windows, Linux Desktop and Web. Authorized native CI
has now executed; its passing and incomplete boundaries are recorded below.
Cross-platform fixture tests alone are not native acceptance.

The latest completed run, CI39, **FAILED** overall: Web, macOS, Linux and the
independent Windows NSIS job succeed; the Windows matrix fails during its
acceptance fixture's packaged UI launch. Main PID 5976 exits with
`3221225477` (`0xC0000005`) before the SDK launch returns, with zero packaged UI
operations and HOME retained. The cause remains unknown; ordinary startup
without the harness was not established. Independent NSIS separately passes
16 phases, six normal controller roots and 26 UI operations; it does not
overwrite the matrix failure or establish a repair or release readiness.
See the [CI39 actual results](#ci39--completed-results-and-windows-packaged-ui-launch-failure).
Earlier failures and their preparation checkpoints remain retained.

CI35 failed its original Windows matrix during initial installation: Setup exits
with code `3221225477` (`0xC0000005`), while queried crash metadata identifies no
exact application event or fault module. The cause remains unknown; CI36 does
not establish a repair for that failure.
See the [CI35 actual results](#ci35--completed-results-and-windows-initial-install-failure).

CI29 failed overall across five jobs; its original result remains unchanged. macOS, Linux
and Web pass their stated audited scopes. The original Windows matrix accepts
38 operations/five normal Mains plus separate Review drafts three/one, then
fails Composer identity before any Composer operation. Its recorded exit
`1/null` is not normal acceptance; cleanup/exit ordering and the GC cause remain
unknown. A separate fresh Windows NSIS job completes first installation and
thirteen installed UI operations, then times out during replacement. Replacement
UI, uninstall, cache cleanup and final OS-state validation are not reached.
See the [CI29 actual record](#ci29--actual-five-job-results-paused-goal-deletion-and-two-windows-failures).
CI28/27/26/25/24 failures and their unknown causes remain in their original
records.

CI14 remains the latest fully passing matrix in its earlier, narrower scope,
before expanded NSIS acceptance. The
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

## CI21 — functional progress with Windows custody and installer failures

[Run 39037383789](https://github.com/cjhyy/codeshell/actions/runs/39037383789),
attempt 1 / push, binds source
`037c2afbb05f2fcb3b2f3f3588be2b4a980032a1`. Its final API reports overall
failure: Web, Linux and macOS jobs succeed; Windows fails at actual NSIS install.
The frozen final run API has SHA-256
`bd4381cca5841d74a7c009080bd74285bba128d5b2dde2e1555cddae3729c69e`.
Job success is insufficient evidence for process ownership or release readiness.

Web independently passes the original 31 browser behaviors, image nine/45 and
64 lifecycle contracts. Separate negative controls retain two passing controls
and six expected failures with runner-verified private-profile retention.
The audit binds 106 source hashes and 33 CRC-checked PNGs, actual normal browser
exits, observed full-birth custody, final ledgers and recorded HOME cleanup.
Current logout/relogin and 390px annotation samples show readable CJK.

Linux independently passes original 83 operations/12 Main launches and, separately,
new Review drafts three/one. Its actual AppImage runtime supplies APPIMAGE/APPDIR,
passes the first-JS identity/sandbox barriers and performs ten owned manifest GETs
across five failure/healthy-retry pairs. Source/cache bytes, ASAR and managed-Node identities remain bound and unchanged.
Full `07777` inventories retain only the exact recorded authorized directory
`0755→0700`, sandbox and LICENSE normalization deltas.
Suite inner HOMEs are recorded removed; both outer package-launcher scratch roots
are intentionally retained. Actual generated-image, narrow settings, Review,
updater and three draft PNGs have readable CJK in the independently viewed samples.

macOS independently passes original 83/12, new drafts three/one and the separate
DMG installed/reinstalled UI 13+13 across two mounts, both detached. Its 212 machine
checks are exactly 116+55 original checks plus 41 draft checks. Summary v2 corrects
one inherited prose count of 173 to 171; the original summary/freeze and all raw
receipts remain preserved. This does not alter any runtime result or condition.
Ad-hoc local packaging is not Developer ID, notarization, Gatekeeper, real
Applications installation or automatic update installation acceptance.

Both new Mac/Linux draft sequences verify five actual production preparations,
two results held only after their real handlers finish, complete A/B input equality,
original prefixes and unchanged model/permission controls. Each observes three
attempts and three accepted seeds, zero rejections and zero pending acknowledgements.
The optional rejected late-A event is not observed in this run; events have no
Main request ID. Two actual owned readonly metadata requests form the complete
final prefix, with zero late rows. Mac Main 9016 exits `0/null`, observed custody
25→0; Linux Main 5857 exits `0/null`, 17→0. Both record HOME removal, empty denied/
Worker and signal ledgers, seven blocked probes and complete durable diagnostics.
These three/one results are kept separate from original 83/12 and DMG 26/two.

Windows independently retains functional original 83/12 and new draft three/one
with recorded normal Main exit tuples, five preparations and three accepted seeds.
However, the panel cleanup ledger adopts PID 976 through a newer process lineage:

```text
PID   PPID  complete recorded UTC birth
3188  2356  2026-10-17T13:46:56.2948840Z
5136  3188  2026-10-17T13:47:26.7472560Z
5968  5136  2026-10-17T13:47:26.8281970Z
4512  5968  2026-10-17T13:47:27.6041920Z
2520  4512  2026-10-17T13:47:27.6162490Z
976   2520  2026-10-17T13:41:23.3361640Z
```

PID 976 predates both its claimed parent and Main; diagnostics record a SIGTERM
request for 976. Full Windows custody acceptance is therefore withdrawn despite
successful UI actions and HOME-removal flags. The request does not independently
prove OS signal delivery or its effect. This is not established as the Setup cause.
The finding `custody-identity-order-finding.json` has SHA-256
`a01e1575ee648dd43ae52c5fc3fd57e3cf88b2494205612c16ea9a50c2705d58`.

The real installer completes six pre-installation stages and a normal NSIS build,
then Setup exits `3221225477/null`, before cleanup and before installed-UI or
registration acceptance. Its captured stdout/stderr are empty. No exception
module, OS or product cause is established. Replacement, uninstall, cache cleanup,
final registry restoration and both installer UI rounds are unreached. The owned
installer root is retained; pre-install absent-state probes do not prove post-failure
OS state. Uploaded command/inventory hashes cannot independently rehash the absent
raw installer executable. Early and final uploads retain the available evidence.

Separate actual aggregation gates pass 344 tests: Mac 3,256 assertions, Linux
3,253 and Windows 3,247, reflecting platform controls. Write 11/38, output 16/32,
branch 15/50, original Review Node 13 and draft Node 37 are separate; Windows also
passes its 31 NSIS/signal contracts. They are not added to native actions.
Frozen independent summaries under `codeshell-real-operation-cycles-20261016` are:

- Web `ci-39037383789-web-independent-20261017/ci-39037383789-web-independent-audit.json`,
  SHA-256 `cf66127eba13e7165135438708e37316b9f8e6805f036d8700d41cc2218e7159`.
- Linux `ci-39037383789-linux-independent-20261017/verified-summary.json`,
  SHA-256 `e5fac22a8763f6d120eb62132682eb9e42da93643ab5992c9bc7f4299b820504`.
- Mac `ci-39037383789-mac-independent-20261017/verified-summary-v2.json`,
  SHA-256 `43fc055e5ced5c4708050802f029d0fc6b02f980df1f814a1f64bba2451ecd9c`.
- Windows `ci-39037383789-windows-independent-20261017/verified-failed-summary.json`,
  SHA-256 `e8c694477b0644da219517c8681d2dc4f429d90aa363af1cf1c9628ff310aab8`.

Historical GC, prior inode differences and older incomplete installer observations
remain unexplained. CI14 remains the latest fully passing matrix; CI21 is not a
complete Windows custody or installer pass.

## CI22 — local source preparation after the custody finding

Candidate `8daede3417cd4e0efdb03ad5cecbe87e8b40dcac` combines the scoped UI repairs,
process-lineage restriction, explicit-test selection guard and installer diagnostics.
Its frozen local receipt `ci22-frozen-final-combined-source-gates-proof-v2-20261017.json`,
SHA-256 `80016388c9c95113ce96007e8dae250bacc7c93d075089df0602a1acfd889085`,
binds 21 non-document source paths and eight final logs. This is local evidence;
CI22 has not been dispatched and no new native or installer result is asserted.

- MCP args `09e5aaed1dedd72a2d821b9ec1925fd51df26d74` preserves structured original
  arguments until Args changes. Actual React/MiniDOM create→reopen/no-edit gives
  three failures with fifteen controls; the related fixed shard passes 34/60.
  Manual edits and explicit clears retain the existing parser/deletion semantics.
- Marketplace origin `2ee3f5efb36453a61a86caa430c8e4e2c2081f35` distinguishes a
  marketplace named `local` from a direct-local install using real catalog path/
  key provenance, not that word alone. Unknown or conflicting origin refuses both
  update/uninstall routing. Twelve actual catalog/extracted-UI/Main-route tests
  give seven failures with five controls; related fixed tests pass 27/154.
  Destructive callees are inert; this is not actual installation or uninstallation.
- MCP rename `ce87d2b0b5574c4b65f6ed81e746159b023a5e2a` retains only supported
  `connectTimeoutMs`, `connectRetries` and `inlineImages` before applying the existing
  editor patch. It preserves zero/false, old-key tombstones, scopes, plugin locks
  and explicit clears without persisting UI flags. Three actual rename failures
  have twenty passing controls. Fixed component tests pass 33/61 across two files,
  including a second UI rename while refresh is still pending. Pinned import-free
  production merge declarations execute in an owned memory sink; LF and CRLF source
  forms yield the same hash. No Main/Core configuration module or actual MCP
  connection is executed by these new cases. Existing probe input mapping does
  not forward these three fields, so real connection-option behavior is not claimed.

The three author proofs, respectively, have SHA-256
`bea8873ff978d4b8929d81f0d8e77df2b3e01167e8263713355c7875f25b4060`,
`0ddf221129a21d331187716c769130f0842977f650f32da5a1ed8af3d0b01152` and
`4fbb896a29b30b3747031a81ad359cd511d154626d29756f6f43bc22480d1ee0`.
Missing-dependency setup failures remain recorded separately, never counted as
product RED. These component/owned-file checks do not validate a real MCP account.

Custody fix `f88ca1e46b86393ff971b2a9f9c3ddc1c173c29e` keeps the existing fresh
PID/full-birth and reuse checks, adding child birth ≥ current pinned-parent birth.
The complete recorded Windows chain reproduces the flaw in pure metadata: seven
controls pass and seventeen fail; fixed dedicated 24 pass. Full seven-fraction
Windows precision and equal-second POSIX children are retained. Malformed snapshots
reject atomically; established watchers latch them as unproven. Owned orphans and normal
exit/caps remain covered. Actual helper/watchdog calls use guarded fake snapshots,
timers and signal spies; no OS query or signal is exercised by those dedicated runs.
Proof SHA-256 is `8a18a49dc59446205d609adade8cc4784258f12d16ff4a7554747594aaa294ce`.
This source fix does not restore CI21's revoked custody acceptance.

A separate local execution mistake invoked bare Node `--test` in a task worktree
based on 037. It triggered default discovery before being interrupted with code 130.
Visible retained records contain 55 TypeScript failures and 17 interrupted/cancelled
cases; truncated output is incomplete. Missing middle output, other test-body effects
and descendant settlement are unknown; zero side effects cannot be claimed.
Later explicit pure tests cannot resolve this incident. Frozen incident SHA-256 is
`2c6644cb611725f6a56808a291c357052e62d5d362687ea40bf325a2dfbdf49a`;
independent assessment is `5b6e545f5b92a5b72dbc64c9183e3cfd2b550469217b74d9350cff6ca3026032`.
The new wrapper rejects bare/options-only discovery, directories, globs, symlinks
and invalid selectors before HOME creation/spawn; ten pure VM contracts pass.
Explicit file selection still does not prove test purity or provide an OS sandbox.

Installer instrumentation adds bounded readonly crash-metadata collection using
fixed PowerShell 7 and the runner's existing owned HOME/TEMP environment. Query
or environment failures remain unknown/unproven; they cannot make the installer
pass. Fifteen pure contracts pass, without actual PowerShell/EventLog execution.
This records a future failure; it does not fix or explain Setup `0xC0000005`.

Root's complete 405/3,470/30-file product shard and full workspace build remain
at checkpoint `4062f1fff5431c1803fa95b9762289dd0938030c` (proof SHA-256
`da13b1c7eb0ed7c3ef41934598c303a0c18a51d4bb94dfaad94eaad3452e1522`).
At final 8dae, Root separately passes the two-component 33/61, all fourteen actual
workspace typechecks, three-source lint/format and four safe Desktop static bundles.
Non-Desktop workspace/build/package/lock bytes remain unchanged from 4062;
there is no claim of a new full 410-test shard or final-HEAD full workspace build.
Final Node passes 130 across nine explicit pre-read pure files: original 81,
24 lineage, ten wrapper and fifteen crash-diagnostic contracts. Its source at
`aa6f897b84caea1f5df06bb31fa9eb308a55740b` has eleven pins identical to final 8dae
(proof SHA-256 `b8bf7e675eaba67bb230685866d0b371f52b128bd52871266b176fdc603ba57e`).
Overlapping counts remain separate. Three-platform native, Windows custody,
Setup/installer UI and actual crash-diagnostic collection still require fresh CI.

The final engine-bypass scan also reruns successfully at
`95ef93b1c96a9f9b3b872bf54eefe826a26d0c49`; the 21 source pins remain unchanged.
Concurrent static round42 records P3 `TRANSCRIPT-R42-01` in TUI background detail.
Desktop/Web do not consume that translator registry transcript; this separate TUI
issue remains for the next loop, with no repository-wide zero-defect claim.

## CI22 — actual Web and macOS passes, Linux and Windows failures

[Run 39042276064](https://github.com/cjhyy/codeshell/actions/runs/39042276064),
attempt 1 / push, binds source
`07e5791b1fc1ad1fcfd5c55c2913d8a45f1b20cb` and finishes overall failure.
Web and macOS succeed; Linux fails at actual packaged update checks and recovery,
and Windows fails its pure draft/lineage/wrapper contract step before native work.
These results replace no earlier source-bound failure or unknown.

Web independently verifies 31 actual behaviors: ServiceWorker 11, authentication
four, child lifecycle eight and annotation eight. Image nine/45 and lifecycle
Node 64 remain separate. The expected old-reducer run has two passing controls
and six expected failures, with retained profile physically checked by the runner.
All 57 public ZIP files pass CRC; the current workflow's public allowlist and 106
source hashes are independently checked (99 product-map paths plus seven fixture/
helper pins). All 33 PNGs pass chunk CRC; actual logout 1280px and annotation
390px samples have readable CJK. Five recorded birth sets contain 7/21/10/10/10
processes, each settling to zero with normal browser `0/null` and empty signal
ledgers. Successful Auth/SW/child inner HOMEs and the annotation profile are
recorded removed; the negative HOME/profile stays. Private remote roots are not
uploaded or re-enumerated locally; a late final write cannot restore removed HOME.

macOS independently passes original 83 operations/12 Main launches, the separate
new drafts three/one and DMG installed/reinstalled UI 13+13 across two detached
mounts. Its 212 checks retain 116+55 original and 41 draft checks. Draft Main 13515
exits `0/null`, observed custody 29→0, HOME removed; five real preparations yield
three attempts/accepted seeds, no rejection/pending, and two readonly metadata
records with no late rows. Its actual aggregate is 410 tests/3,480 assertions/30
files; Review Node 13 and draft/lineage/wrapper Node 71 are separate. Ad-hoc
packaging does not prove Developer ID, notarization, Gatekeeper or auto-install.

Linux independently retains 73 completed original operations/11 normal Main
launches, plus the separate new drafts three/one. It does not complete original
83/12. The real AppImage reaches first JS with actual Main 9307 under runtime
launcher 9304, owned APPIMAGE/APPDIR and sandbox enabled. A later synchronous
identity `electronApplication.evaluate` rejects with “Resulting promise was
garbage collected”; updater operations and manifest GETs are both zero. The cause
is unknown, with no proof of a crash, GPU, OS, P1 or model cause. Actual Main
raw stderr and a timestamped first-error journal are absent, so GPU/network and
cleanup timing cannot be independently ordered. The fallback
`mainExits` row names runtime 9304; it is not an actual Main exit tuple.
Six recorded SIGTERM cleanup requests accompany observed custody 11→0, without
proving normal Main exit or OS signal delivery. Updater HOME and outer launcher
scratch remain retained. Source/cache byte identities and full `07777` inventories
keep their exact authorized normalization deltas. Earlier pure aggregate
410/3,477/30, Write 11/38 and Node 13+71 remain separate from native operations.
The failed updater audit has 67 facts; earlier runtime and draft audits retain
145 and 41 checks. Recorded chronology has no conflict at POSIX second precision;
this does not retrospectively restore CI21 Windows custody.

Windows fails at Node VM initialization with “Cannot use import statement outside
a module.” Its actual combined TAP has 61 passing tests and one failed file; the
ten wrapper VM cases never register. Separate NSIS pure contracts pass 46 and
Review diagnostic contracts 13. Build/package, Write, full Bun aggregate, original
83/12, new draft three/one, installer/registry/replacement/uninstall and native
crash-metadata queries are skipped. Native operations and Main launches are zero;
this is not an assertion that the CI host spawned no processes. No HOME, installed
payload or OS-restoration acceptance is available from this skipped native run.

Frozen summaries under `codeshell-real-operation-cycles-20261016` are:

- Web `ci-39042276064-web-independent-20261017/ci-39042276064-web-independent-audit.json`,
  SHA-256 `798949c12fd8edd9762d37183f11308c5d2bb26fa7bd900ae34f218d3b5726c2`.
- Mac `ci-39042276064-mac-independent-20261017/verified-summary.json`,
  SHA-256 `b2d4a5871231b42e6ff6092da2c663029086027e7a8f28bfc1d8dbc6234b7d69`.
- Linux `ci-39042276064-linux-panel-independent-20261017/settings-verified-failed-summary.json`,
  SHA-256 `24b2f79cab9e6facdbd03c8602f46f3d132efe0ca6a895935e8c6d61d1bf1e0a`.
- Windows `ci-39042276064-windows-independent-20261017/verified-failed-summary.json`,
  SHA-256 `169ffd5ea3c45ae99cb569ce0594fe1167ebefbb57f777ea6c544f09333f5571`.

CI14 remains the latest fully passing matrix. Historical Setup `0xC0000005`, GC,
inode differences and local discovery-incident effects/descendants remain unknown.
Neither current macOS/Web success nor dedicated pure tests resolves those records.

## CI23 — local test-harness preparation only

Commit `bd1704b988ee68cafc61cbd513ba6417f3fd7c3e` changes only
`scripts/run-isolated-node-smoke.test.mjs`: normalize CRLF before the same six-import
whitelist, import removal and actual wrapper-body VM compilation. The production
wrapper, flags, guards, signal authority and original ten cases are unchanged.
One added pure case executes actual LF and CRLF forms through identical inert
spies, comparing explicit success, bare refusal and unknown-flag refusal. Local
11 pass. The separate local RED adapter's zero/two failure is an adapter error,
not valid product RED; its corrected prepared form was stopped without execution.
Actual CI22 Windows VM failure is ground truth, but the runner's raw wrapper bytes
were not uploaded; no independent raw-byte CRLF observation is claimed.
Author proof `codeshell-node-smoke-crlf-proof-20261017/verified-source-summary.json`
has SHA-256 `9df22d819c93d9b3bd3f7092e842178e595799544fb1b4f1ed3f809075c101dc`.

Root's exact nine-file guarded Node gate at bd170 passes 131, zero failures/skips.
The frozen extension proof `ci23-frozen-local-crlf-extension-proof-20261017.json`,
SHA-256 `fddf4a519718d014bb6f4e2820e9d71a0e5b350f0f394b528f3542c29e0567bf`,
binds the single test delta, twenty unchanged source pins and syntax/lint/format.
This is local pure validation, not fresh Windows or installer execution. Package,
build, lock, workflow and production sources remain byte-identical to 07; the
source-bound CI22 local component 33/61, fourteen typechecks and four safe static
bundles are reused, with no new full build or native claim. Linux identity GC is
unmodified and unknown. CI23 has not been pushed or executed; native/installer
revalidation remains pending, and no retry or weakened gate is a recovery claim.

## CI23 — actual platform results and Windows uninstall failure

[Run 39044613569](https://github.com/cjhyy/codeshell/actions/runs/39044613569),
attempt 1 / push, binds source `0b17496707e0f4d679a86a9d8b4c22477093e8a6`.
The final run fails overall: Web, macOS and Linux succeed; Windows fails at the
post-uninstaller existence gate. The four source-bound audits remain separate.

Web verifies 31 actual behaviors (SW 11, Auth four, child eight, annotations eight),
with image nine/45 and lifecycle Node 64 counted separately. The old-reducer
negative run retains two passing controls and six expected failures, with its
private HOME/profile checked retained by the runner. All 57 public files pass ZIP
CRC; 106 current-source hashes and 33 PNG chunk CRCs match. Five observed birth
sets 7/20/10/10/10 settle to zero with normal browser `0/null` and empty signal
ledgers. Successful Auth/SW/child inner HOMEs and annotation profile are removed;
private remote disks are not independently re-enumerated by the offline reviewer.
Actual logout 1280px and annotation 390px samples have readable CJK and layout.

macOS passes original 83 operations/12 Main launches, separate new drafts
three/one and DMG installed/reinstalled UI 13+13 across two detached mounts.
Its 212 checks retain 116+55 original and 41 draft predicates. Draft Main 6320
exits `0/null`, custody 14→0, HOME removed; five preparations produce three attempts
and three accepted seeds, no rejected/pending seed, two readonly rows and no late
rows. The independent peer retains these predicates and checks 254 metadata/
receipt facts, not additional operations. Current CJK/narrow-screen PNG samples
are readable. Ad-hoc packaging is not Developer ID, notarization or auto-install.

Linux passes original 83/12 and separate new drafts three/one; draft Main 6242
exits `0/null`, custody 13→0, HOME removed, with five preparations and three accepted
seeds. Actual AppImage Main 9429 under runtime 9426 reaches the first-JS guard with
seven probes, owned APPIMAGE/APPDIR and enabled sandbox, without `--no-sandbox`.
The exact owned sandbox helper retains inode/hash and root:root `4755`; source/cache
byte identities and full `07777` inventories keep 75 authorized normalization
deltas. Ten `/latest-linux.yml` GETs cover five error modes and five healthy retries,
without asset download, install, Worker, model or nativeStorage calls. Main bootstrap
and runtime exit normally; all original twelve plus draft one settle, inner HOMEs
are removed, and both outer launcher scratch roots remain intentionally retained.
Recorded parent chronology has no conflict; it is not an exhaustive OS process audit.

Windows independently passes original 83/12 and separate new drafts three/one,
then real installed and replacement UI 13+13 with two normal Main exits and removed
private UI HOMEs. NSIS reaches install, replacement and both UI phases. Its original
48-record journal is complete: uninstall process-exit `0/null` is sequence 45,
process-final sequence 46, firstError sequence 47 and controllerFinal sequence 48. All six build/install/UI/
replace/UI/uninstall process roots have normal `0/null`, empty signal ledgers and
cleaned birth custody; the outer controller nevertheless exits 1. The first error
is `Error: Preexisting owned destination refused` in uninstall, at
`await absent(installation)`: lstat finds an entry at the owned installation path.
Residual names, types, contents and cause are not recorded; this is no proof of an
empty directory, delayed exit or OS cause. Uninstall absence, cache cleanup and
final OS restoration remain unverified, with the NSIS root retained. No compensating
delete, registry change or rerun follows that first failure in the retained evidence.

Pure gates remain separate from native counts: actual aggregate 410/3,480/30 files
on macOS, 410/3,477/30 on Linux and 410/3,471/30 on Windows; Review Node 13 and combined
draft/lineage/wrapper 72 pass. Windows NSIS contracts pass 46; Write 11/38 is separate.
Recorded custody covers captured incarnations, not every OS process or signal delivery.
Uploaded inventories bind package identities; absent raw app/ASAR/installer bytes
are not independently rehashed. Current successes do not explain historical GC,
Setup `0xC0000005`, inode differences or discovery-incident effects/descendants.

Frozen summaries under `codeshell-real-operation-cycles-20261016` are:

- Web `ci-39044613569-web-independent-20261017/ci-39044613569-web-independent-audit.json`,
  SHA-256 `51393e64cc38b8e35a3f9a1f8f66bd6eb9507ff6885427a222ed228670d4a87e`.
- Mac `ci-39044613569-mac-independent-20261017/verified-summary.json`,
  SHA-256 `c05d457a18a6d4561da7404a31a0269ae15ed7a64f588812f5db87b52bf10a3a`;
  `independent-panel-peer.json` SHA-256 `b84b61d887b389990bb05eb3a80e05e9175c310d585e21b3f5c0741d090d0e21`.
- Linux `ci-39044613569-linux-panel-independent-20261017/verified-summary.json`,
  SHA-256 `a36d8f578fb224d7a3b6c2adb52880f877d8ca81b16740cee31c27fb29c7646d`.
- Windows `ci-39044613569-windows-independent-20261017/verified-failed-summary.json`,
  SHA-256 `92456f969b46c8d077dcb3a1d5a4046fe563409f2337f5d05ce37063fb1c674d`.
  Its `nsis-verified-failed-summary.json` SHA-256 is
  `6e1f42a9837e9b54a121790376cbf66b44eb579556efa1dea0525b6e65d5232e`.

The Root final matrix binding `ci23-root-final-matrix-binding-20261017.json` has
SHA-256 `fcbfbd6b39816e6a2108fb7875d92e3d091456acb44970aa2a333e1bf96a8842`.
The Windows `independent-panel-nsis-failed-peer.json` has SHA-256
`b62afc08392948358fef17cb4ebac973438a6b005f54536ddb335b716f83701e`;
its 95 metadata checks add no native operations or uninstall acceptance.

## CI24 — local child fallback revocation preparation only

Commit `5a01299e6ed7f2e48a84a1e77c1be48ce0b54377` changes only Desktop renderer
`types.ts` and `types.test.ts`. A live child's correlated request now retains its
text frontier; a matching tombstone removes only that request's partial text,
including after parent flushing. Previous successful text, other agents, main
feed/pointers, tool revocation, no-ID compatibility and terminal authoritative
text stay protected. The current CI23 candidate and its runtime evidence are unchanged.

Seven added cases drive the actual reducer. Immutable-source RED has 110 tests:
105 pass and five fail; fixed GREEN passes 110 tests/299 assertions, zero failures/
skips, including the original 103 control bodies/order preserved byte-for-byte.
The first module-resolution attempt executes zero cases and is excluded from RED.
The exact admitted guarded single-file run validates complete success JUnit;
raw temporary XML is not retained, and failed RED exits before success-JUnit
validation. Only the two changed paths receive lint/format checks; no new native,
browser, provider, full build or installer validation is claimed by this repair.
Source proof `codeshell-child-fallback-revocation-proof-20261017/verified-source-summary.json`
has SHA-256 `346295666283139cae1fde47046e1d067d21db14811393cabfebcb5d7651586b`.
Additional NSIS diagnostics are still work in progress, not completed preparation
or an explanation of the CI23 uninstall failure. CI14 remains the last fully passing
matrix; a future CI24 runtime result is not asserted.

## CI24 — combined local gates, runtime pending

The local candidate is `a5c516be8a418d13fa6a77850c6894a0f27a6ff8`; CI24 has
not been pushed or executed. Its four runtime jobs and actual Windows residual
observation remain pending. CI23's post-uninstaller absence gate remains failed;
the new diagnostic does not repair or explain the residual entry or its cause.

Root's complete guarded Bun v2 shard passes 417 tests/3,502 assertions across the
same thirty finite files, zero failures/skips, at
`2bd5cfebb0fdc325900f8dd0d612eb51a8e35451`. All thirty input pins remain identical
at a5c. The earlier full shard's 416 passes/one failure out of 417, with 3,497
assertions, remains retained: broad `.not.toContain("B")` matched a random temporary
path header while the actual net patch was correctly `-A/+C`. It is a test assertion
false positive, not a reproduced UI product defect. Commit
`3da3ea529af842941cb551faa3d531db6d055e67` fixes only that test: default fixture
`a.ts` stays, the first case uses `aB.ts` deterministically, and the negative check
matches complete diff content rows. Exact single-file RED has 22 passes/one failure;
fixed GREEN has 23 tests/1,555 assertions, zero failures/skips. Other twenty-two
cases, positive patch/applyDiff roundtrip and tool IDs are preserved. Its proof is
`codeshell-turn-diff-content-assertion-proof-20261018/verified-source-summary.json`,
SHA-256 `39f8c20269adcdc84942fc187bab798c67b8e40d51547fb0b9f0cea6115ea316`.

The combined explicit Node gate passes 140/140 across nine pre-read files at a5c,
zero skipped/cancelled/failed; legacy native-query tests are excluded. Six changed
source files pass lint with zero warnings and formatting; actual engine-bypass and
diff checks pass. Fourteen workspace typechecks and four safe Desktop bundles
(main/preload/renderer/mobile) were actually passed at
`82561a1be323994113cd5de2b9decf20115f7328`. Subsequent deltas are the excluded Core
test, standalone acceptance scripts/tests and docs. Compiled production inputs are
unchanged; those checks are reused at their original source checkpoint, not claimed
as a fresh current-HEAD build or new full workspace build. Counts overlap earlier
component/reducer checks and are not summed into additional tests or native operations.

Commit `ab2d78960c720edd0c434ef7358804accc7ab9d9` adds passive bounded metadata
only after the same post-uninstaller absence error. It retains the first failure
and records bounded direct-child name/type/regular-size metadata without following
links, recursion, file contents, deletion, retry, new process authority or changed
installer gates/budgets. IO, alias, drift, unsafe name, cap and soft-deadline errors
remain bounded unknown outcomes; the original acceptance still fails. It writes an
existing receipt field, requiring no new public artifact or workflow path.

The diagnostic's first module setup failure registers zero named cases; it is not
product RED. The next 17-case run has 16 passes/one failure because its mock maps
`..` to a parent file Stats; the helper correctly refuses that alias. Correcting
only the mock yields 17 passes. Initial regex-space lint is fixed with equivalent
quantifiers/formatting; final-source 17 and three-file static checks pass. A separate
undefined-error trigger flaw was found and fixed during source pre-read before
those tests. No actual Windows metadata collection or installer is run locally.
Author proof `codeshell-nsis-post-uninstall-metadata-proof-20261017/verified-source-summary.json`
has SHA-256 `92b810c3961bcdec5c754a7e36eaed5fbfea864ab687e49db8fded0d8c059757`.
The later independent NSIS source peer passes 46 readonly checks, zero failures,
without running tests/VM/native. Its `independent-panel-source-peer.json` SHA-256 is
`4d4936b56b77675cdef9cdc9a7fdd1c8c96bcd936a664ecfe49a8524e549c855`.

The frozen combined local proof `ci24-frozen-combined-local-gates-20261018.json`
has SHA-256 `2045ee7fb04ff8ad4874549aaaf86ef1805f831baaf1b55622c4959b44bbe7bb`.
It binds actual Bun v2 log `b8b714ab69d10bfde42dbe7b6f506792f40a1f51cab6f433234b6a0a4848a1dd`,
Node log `4ee314f167b7e58a21236af3865fddf142fb208bce702b0b224dafb1113a1593` and static
log `28503a2cb3cc525006537e4d8689461526b968d5667660f9423629b617a52b32`.
These are local pure/mocked or owned-filesystem checks, with no local native App,
browser, PowerShell, process-query, real installer or provider validation. Historical
GC, Setup, inode, revoked CI21 custody and discovery-incident effects/descendants
remain unresolved; neither local green gate nor diagnostics establishes a new runtime pass.

## CI24 — actual platform results and empty uninstall directory

[Run 39049375903](https://github.com/cjhyy/codeshell/actions/runs/39049375903),
attempt 1 / push, binds source `9a2d118502fe184dc0271360f97c8fdbe06deb01`.
Web, macOS and Linux pass their audited scopes; Windows fails only step 39, the
production NSIS lifecycle. Step 40 successfully uploads its failed evidence.
CI14 remains the last fully passing matrix; earlier failures and preparation-only
records above are retained at their original source and scope.

Web passes 31 actual behaviors: SW 11, Auth four, child eight and annotations eight.
Image unit nine/45 and lifecycle Node 64 pass separately. The old-reducer negative
run retains two passing controls and six expected UI failures, with the private
HOME/profile checked retained; those failures are not added to the 31 passes.
Normal browser exits, observed birth custody, late ledgers and successful HOME
cleanup pass their source-bound predicates, without an OS-wide confinement claim.

macOS passes original 83 operations/12 Main launches, separate new Review drafts
three/one and DMG installed/reinstalled UI 13+13 across two attachments: one writable
construction stage and one final readonly verification; both are detached.
Linux passes original 83/12 and separate new drafts three/one. Actual AppImage Main
9262 and runtime 9258 both exit normally; ten manifest GETs cover checks/retries,
with zero asset downloads, Worker, model or nativeStorage calls. Enabled sandbox,
owned image/cache identity and 75 approved mode normalizations remain checked.
Both platforms pass their original normal-exit, captured-incarnation chronology,
settlement and inner-HOME gates. Linux launcher scratch retention is intentional.
These are fixture-scoped successes, not signing, automatic update installation or
persistent user-data migration acceptance.

Windows independently passes original 83/12 and separate new drafts three/one.
Five real preparation IPCs produce three attempts and three accepted composer seeds;
full A/B inputs and model/permission controls remain bound to the actual receipts.
NSIS then passes install, replacement and both 13-action installed UI sequences.
Actual installed Mains 7832 and 2212 exit `0/null`; both private UI HOMEs are removed.
All six build/install/UI/replace/UI/uninstall native or controller roots exit
`0/null`, with empty signal-request ledgers and cleaned custody. All uploaded 28
full-birth map copies have 374 parent edges and no chronology contradiction;
this is not an exhaustive OS process or signal-delivery audit.

The unchanged uninstall absence gate still fails at source line 719,
`await absent(installation)`, with firstError
`Error: Preexisting owned destination refused`. The complete 48-record journal
orders uninstaller exit at 45, settled process-final at 46, first-error at 47 and
controller-final at 48. The original first error is synchronously retained before
awaiting the new passive observation. The controller exits 1 and retains its owned
NSIS root; uninstall, cache cleanup and final-integrity phases do not complete.

`postUninstallObservation` now records schema 1, trigger
`post-uninstall-absence-failure`, scope `exact-owned-installation-direct-children`,
status `observed`, rootType `directory`, complete `true`, entries `[]` and reason
`none`, in 2.7152 ms. The fixed limits are 128 entries/65,536 compact metadata bytes
and a 2,000 ms soft deadline, with pending IO and directory close awaited. The
actual CRLF checkout helper pin `fe55e3456e4a075f48b1a6463ec3e3eb2e16bc21951f06f0ee23f0e17b746e3d`
matches Git LF source `140f12cc942eed8b97a09fa3edcce0d7ec42a9b84113bc40a186d71281968f55`.
This proves an empty ordinary directory only at that single observation time.
`reason: none` means diagnostic completion, not absence of an installer failure.
There is no uninstalled registry/shortcut snapshot, cache-cleanup record or final
OS-state snapshot; OS restoration is not approved. No compensating delete, retry,
new process query or registry write follows the failure.

The locked template's working-directory/removal sequence and official NSIS
current-directory restriction are a conditional source clue, not a confirmed
cause from this observation alone. A minimal production `customUnInit` working-
directory repair is being prepared and is not yet natively verified. No template,
installer predicate or cleanup authority is relaxed in CI24. Historical GC, Setup
failure, inode drift and discovery-incident consequences remain unresolved.

Pure counts are separate: actual aggregation is 417/3,502 across thirty files on
macOS, 417/3,499/30 on Linux and 417/3,493/30 on Windows, all zero failures/skips.
Review Node 13 and combined draft/lineage/invocation 72 pass; Windows NSIS Node 55
passes. Write 11/38, output-clean 16/32 and branch 15/50 are separate. No overlapping
author totals or metadata checks are added to native operations.

Frozen terminal APIs under `codeshell-real-operation-cycles-20261016` are:

- `ci-39049375903-final-run-api.json`, SHA-256
  `da69d46788ffa7560b6ea974649ef49ef5d443fe85345cf8c4e1f47d2fd23f10`.
- `ci-39049375903-jobs-progress-20261017T164357Z.json`, SHA-256
  `800d33a90c1c8108986b60c4a4fc5827327d8f3890186fe0c3c138e4757fbebb`.
- `ci-39049375903-final-artifacts-api.json`, SHA-256
  `1a449918a7360fe568ce611b23c82cc90c517067edfa9e44568d640e257a3faa`.

The four source-bound summaries and two independent peers are:

- Web `ci-39049375903-web-independent-20261018/ci-39049375903-web-independent-audit.json`,
  SHA-256 `dfe8cab9479db5ccefcdd569316091516e9de97d4b18c82500fb8a369225e049`.
- Mac `ci-39049375903-mac-independent-20261018/verified-summary.json`,
  SHA-256 `9c71593080854d00fc0610080f29647dfbee6d7af48e8deae770f1044bcc2ef3`;
  `independent-web-final-peer.json` SHA-256
  `52757af05370fdce5f0c45b537afab7fd520f8b13253608bf81e88296919e84a`.
- Linux `ci-39049375903-linux-panel-independent-20261018/verified-summary.json`,
  SHA-256 `740a95b94443ca95cdd8fa10e84cf3776a31dda29cb15f97d32ccf48fb3f3ab0`.
- Windows `ci-39049375903-windows-independent-20261018/verified-failed-summary-v2.json`,
  SHA-256 `6ce7a90d28ed5d039a5fe86ec972c0b8757f286d3f4ef860e83d3579447c53e2`;
  `independent-panel-nsis-failed-peer.json` SHA-256
  `7ac552442277dc30c2cd6779c6be8b0cf6628d2b09815bc7f610667e7fad845a`.

Windows final artifact 12107362814 has SHA-256
`af4367fe69b4833e39091e71b6aa04ad2e27c094c598044a7f10fef16289e32e`:
169 finite-allowlist public files pass CRC, with no private HOME or raw installer/
ASAR bytes uploaded. All 127 early files remain byte-identical in the final ZIP.
Installed payload identity is cross-bound through recorded hashes, not independently
rehashed uploaded binaries. Five Windows PNGs are actually viewed; metadata for
49 PNGs does not mean 49 independent visual approvals. The first offline reader
summary selected an earlier source-line number for the same `absent` text; the
retained v2 scopes line 719 correctly, without changing any runtime evidence or
acceptance condition.

The NSIS-specific corrected summary `nsis-verified-failed-summary-v3.json` has
SHA-256 `0f33bfef8944de3d8f87cd157ffcddd69c0bdf495f360039f6a609391a1be410`.
A separate offline output-field correction replaces a journal-object count/hash
that shadowed the already-validated first inventory. The actual retained inventory
has 910 rows and compact JSON SHA-256
`714e8e457607feb6dae9596b97f862d389460a3b92ec4f1e0691f2d408333d51`,
matching the runtime integrity record. All 892 original predicate results and raw
records remain unchanged; there is no reader, test or native rerun. The original
summaries remain retained. `nsis-output-field-correction.json` SHA-256 is
`75d79ef9ab8f19f5c8bf1889d30507ddbf93a2013e1b4473b6f723ec656cad9b`.
The independent output-correction peer preserves the earlier 82-check peer and
has SHA-256 `b39c552b80110a05e31945561e0803cdb354edf90ca092f6561261cc377f5ddf`
(`independent-panel-nsis-output-correction-peer.json`); it performs no rerun.

## CI25 — production uninstaller working-directory candidate

Candidate `950cacea117d501b58e03e00c240ea14ebf537df`, based on CI24 source
`9a2d118502fe184dc0271360f97c8fdbe06deb01`, adds the supported fixed-basename
NSIS include `nsis-uninstaller-init.nsh` under the strictly bound `build` resources
directory. Its 176-byte LF macro uses only `customUnInit` and `SetOutPath "$TEMP"`.
The locked electron-builder 25.1.8 template invokes it after uninstall-mode
initialization and before the existing removal path. This is a source-supported
repair candidate; CI24's observed empty directory alone does not prove the runtime
working directory or the exact cause of its failed removal.

The three default-resource absence checks remain byte-identical. The original six
NSIS settings, installer arguments, 16 phases, installed/replaced UI 13+13, OS/cache
checks, normal-exit, birth custody, HOME gates and budgets remain unchanged. The
runner records the known include's actual size/SHA-256 in
`source.nsisUninstallerInit` and checks the same bytes after package construction.
Existing production-configuration negative data rejects an alternate include path
and an array value. The default `installer.nsh` proposal was discarded because the
actual preflight explicitly requires that default resource to be absent.

Author source proof `codeshell-nsis-uninstaller-working-directory-proof-20261018/verified-source-summary.json`
has SHA-256 `47a9a9a4f1857d87ca57c6c030afe9d8a548fe7379500297e150b2840dc86e97`.
The independent source-only peer passes 32 checks, zero failures, without running
tests or native code; `independent-panel-source-peer.json` has SHA-256
`251d3cb17d820ebc28ee1e7d957e7cd0b6d2c616a90624d90293b49bcc37f071`.

Root's combined local gates at source `950cacea117d501b58e03e00c240ea14ebf537df`
pass the actual full thirty-file Bun shard: 417 tests/3,502 expectations, zero
failures/skips. Nine pure Node files pass all 140 tests with zero failures, skips or
cancellations. Fresh checks cover all fourteen workspace types and four safe
Desktop bundles: main, preload, renderer and mobile. Three changed MJS files pass
syntax and zero-warning ESLint; package JSON and those MJS files pass formatting,
with engine-bypass and diff checks also passing. The frozen combined proof
`ci25-frozen-combined-local-gates-20261018.json` has SHA-256
`0bc77d94949ce12af0f72ab0c21bda777f6192b3ea4e9fb50caab9ad5666e740`.

These local tests and compilation are separate from native operations. No local
browser, App, installer, PowerShell, process query or provider validation is run for
this candidate. CI25 has not yet executed; all four runtime scopes and the actual
Windows install/replacement/uninstall gate remain pending. CI24 still fails the
unchanged uninstall absence predicate. Historical unknown GC, Setup, inode drift,
revoked CI21 custody and discovery-incident consequences remain unresolved.

## CI25 — actual platform results and installation failure

[Run 39052422751](https://github.com/cjhyy/codeshell/actions/runs/39052422751),
attempt 1 / push, binds source `8e366d97c92c614f00df989006f5b8208185246f`.
All four jobs are terminal: Web and Linux succeed in their audited scopes;
macOS startup custody and Windows NSIS installation fail. CI14 remains the last
fully passing matrix. These results do not repair or explain earlier failures.

Web job 117453519997 passes its actual 31 behaviors: ServiceWorker 11, authentication
four, child eight and annotations eight. Image nine/45 and pure lifecycle Node 64
pass separately. The old-reducer negative run has two passing controls and six
expected UI failures, with private HOME/profile retention verified by the runner.
The six complete send/cancel payload arrays equal the final settled Host RPC rows,
each count one. Five observed full-birth maps contain 7/20/10/10/10 processes, all
settled to zero with normal `0/null` browser exits, empty signal-request ledgers,
required late-ledger checks and source-bound successful HOME/profile cleanup.
Failed private profile contents are not uploaded or independently enumerated here.

Web artifact 12108455504 is 1,476,109 bytes, SHA-256
`bf98118816a0ae24e13ecaf60277dde60c98c1370b8fe91852d6b49aebaa8ec6`.
Its 57 canonical public files pass ZIP CRC and the exact workflow's 28 finite
patterns. The reader checks 106 exact-source hashes plus 13 offline provenance pins
and all 33 PNG chunk CRCs. Two actual CI PNGs at 1280px and 390px show readable CJK
and narrow annotation content within the viewport. The first reader exits zero;
this approves only the stated Web fixture, not native or full-matrix acceptance.
Web summary `ci-39052422751-web-independent-20261018/ci-39052422751-web-independent-audit.json`
has SHA-256 `3668dd8ce56aca2bb6f7e6ca807debc1a782ca0d75712da72ad2e2464888a3ef`;
`download-and-audit-freeze.json` has SHA-256
`b53f13534a1b69a78d73a06720e1ae1076ded2a3f566d4237b4e8dce3a50e66e`.

macOS job 117453519962 fails step 27, source Main cold startup/reload/second window.
Cycle one observes three real Pet IPC operations and two actual renderer loads.
Actual Main 8668 exits `0/null`, but its watcher records a process-metadata query
failure: `timeout, 1730ms`. Settlement remains `unproven`, `queryFailed: true`, with
both remaining fields `null`; its eight full-birth rows have seven chronological
parent edges. No signal request, Worker, denied attempt, renderer error or known
Main error is recorded. The private HOME is retained according to the receipt and
source gate; its physical runner contents are not independently available here.
These observations do not approve cycle one or complete startup seven/three.

The first diagnostic assertion is sequence 24 at `startup-cycle-gates`, source
`e2e-startup-operation-cycles.mjs:63`, after Main exit/close sequences 18/19. It
rejects `unproven` versus required `cleaned`. The per-cycle first error remains
available even though `closeCycle` cleared the active reference before throwing its
aggregate error. Cycles two/three, the post-exit Keychain metadata recheck, subsequent
native operations, new Review drafts and DMG checks are not reached. The fixed
POSIX `/bin/ps` metadata query has a 1,500ms timeout; the reported 1,730ms spans the
whole synchronous call/catch, not isolated process CPU/runtime. The failing query's
precise phase, scheduling/native cause and descendant state remain unknown. No
budget, predicate or retry is changed, and no infrastructure cause is assumed.

Mac artifact 12108735118 is 208,219 bytes, SHA-256
`1e7cc5ef502fff0dafc33372243c704728ba27ee86c4c3b7ae6825a53ef79c72`.
All 22 public files pass CRC and the 163 finite workflow patterns. Pure Bun
417/3,502, Review Node 13 plus combined Node 72, Write 11/38, output 16/32 and branch
15/50 pass separately; none substitutes for the failed native custody gate.
Two uploaded startup PNGs show readable Chinese project-trust dialogs. The Root
failed summary is `ci-39052422751-mac-independent-20261018/root-verified-failed-summary.json`,
SHA-256 `5c64538a3ef0d3cca98f8c45065111dda4f75707b52bca8798cffa376abb0663`.
The independent failed-aware peer `independent-web-failed-peer.json` has SHA-256
`596f2d999866bfbf9dd561f0f45ef942deec8be61d535a142838d25a5b5d370e`;
the subsequent Root-summary peer `independent-web-root-summary-peer.json` has
SHA-256 `61ded79e95412b2155c616bb2570c2e4fc76ce45048a20dbcb9df4c0e30a2d92`.

Linux independently passes original 83 operations/12 Main launches and separate new
Review drafts three/one. Actual AppImage Main 9407/runtime 9404 exit normally; five
update checks and five healthy retries make ten owned manifest GETs, with no asset
download, Worker/model/nativeStorage action. First-instruction guards, actual
APPIMAGE/APPDIR identity and enabled sandbox remain bound. Source/cache full
07777 inventories are unchanged against their respective baselines; 75 authorized
source-to-extraction mode normalizations remain explicit. Required inner HOMEs are
removed; outer launcher scratch retention remains intentional. The auditor views
actual narrow CJK/settings, update-error and session-fence PNGs; complete draft
content is checked in JSON rather than inferred from the partly visible input.

The packaged UI Main 8920 exits `0/null`, with 12 observed incarnations settled to
zero and its HOME removed. Its ledger also records three owned-descendant SIGTERM
requests, targeting 9041, 8926 and 8925. These remain separate from Main's normal
exit: source and full-birth map cross-binding does not upload every fresh query,
prove signal delivery, prove every descendant normal exit or constitute an OS-wide
audit. The first two offline readers wrongly added an all-empty UI signal-ledger
assumption and failed. Root pre-reads the narrow correction; each fixed v2 reader
then exits zero once, preserving the failed readers/logs and the updater's unchanged
empty-ledger predicate. Native source, budgets and runtime evidence are unchanged.

Linux `ci-39052422751-linux-panel-independent-20261018/verified-summary.json`
has SHA-256 `ced4a426bb2d67d27c08bb8cf7dbbf48e72b0f77406176afcf6e5fa837d19c23`;
`final-evidence-freeze.json` has SHA-256
`570809b0f6df9dab9b7ffed304983fc0fcd5937935aae5593abf53534d4f00bf`.
Root's 58-file manifest binding `ci25-root-linux-binding-20261018.json` has SHA-256
`0dff19ff2d1071dbda5856bc01a443976ead20967abb02a0c6078b58b64bfbf8`.
Linux's actual Bun 417/3,499/30 is separate from macOS 417/3,502/30 and Windows
417/3,493/30; none is added to native counts.

Windows job 117453520014 fails only NSIS step 39; the final evidence upload succeeds.
Its original 83 operations/12 Main launches and separate new Review drafts three/one
pass the independent early audit. NSIS package construction exits `0/null` and
payload identity checks complete. The new hook is observed as 181-byte CRLF source,
SHA-256 `3d3088c3ffc419b6328fbe24061508c11c1659d0af74f585d2483a8c32c2c0cd`.

The actual failing phase is installation: Setup PID 6068, parent 1956, full birth
`2026-10-17T17:21:49.1857120Z`, exits `3221225477/null` (`0xC0000005`). Installed UI,
replacement and uninstall are not reached. This is not CI24's uninstall absence
failure; the new uninstaller macro is not thereby shown to have executed or fixed
that prior failure. Bounded crash-event metadata records `queried: true`, status
`unknown`, reason `no-exact-application-event`, with a 30,000ms query timeout and
maximum eight records per provider. It does not identify the installation failure's cause.
Windows artifact 12107843915 has 139 public files/CRC and ZIP SHA-256
`142611c1beb00ea69a19294fd8106756550cb96a4e125f5ee8691de3451e4784`.
The owned NSIS root is retained; partial installation effects and OS restoration
are not approved. The combined Windows summary
`ci-39052422751-windows-independent-20261018/verified-failed-summary.json` has
SHA-256 `4e43a02359f83e16ff3f3c458d559ab8498aeed986b8f267038df51ac16c4ac4`;
`nsis-verified-failed-install-summary-v2.json` has SHA-256
`34718f9eb1634bfadedffbb779ca6786dedfd9ab7871b1ac46330b6b9564e8e7`.
The retained initial offline NSIS reader did not account for an established bounded
stderr-tail projection and stopped before output; v2 validates that projection and
compares the exact journal core. No runtime evidence, source or gate changes.
The independent NSIS installation-failure peer passes 47 key metadata checks with
zero audit failures, retaining the actual Setup failure. Its
`independent-panel-nsis-install-failure-peer.json` has SHA-256
`7cd6bb229ced114c23df61a42da576403616a21f7e03fe27be01c2b5e3844f30`.
These metadata checks are not native operations or proof of installation success.

The first offline Mac metadata adapter wrongly compared a generated startup-guard
hash with the Git runtime-cost guard and stopped before its final output. The
retained correction pins the actual fixture source separately and treats the
generated hash only as a recorded receipt value. A separate optional Web image read
used an incorrect archive basename and failed before extraction/view; it adds no
visual approval. Both offline errors are preserved, not runtime causes or native
retries. Strict full-success Mac readers are not run against this failed job. No
local App, browser, test, process query, PowerShell, provider or production-source
change is performed for these audits. Historical CI14/CI24 records and unknowns remain unchanged.

Frozen terminal APIs under `codeshell-real-operation-cycles-20261016` bind this
exact run/source and all four jobs, with two successes and two failures:

- `ci-39052422751-final-run-api.json`, SHA-256
  `a629b80a9b4807c10a048e5628f58c56bfa5b0925575e1ec6eb027ba3d7d3c64`.
- `ci-39052422751-final-jobs-api.json`, SHA-256
  `a2cf80b2d76e63f5c6e338028d8252690ba3fb0534fd49eb283c7bc4c53ee9d8`.
- `ci-39052422751-final-artifacts-api.json`, SHA-256
  `db79cf3c45c61dc1c9b125af9b4a17bbe3eb8d5fd3f7e0261cf47c3d82035c70`.

Root's final `ci25-final-matrix-binding-20261018.json` has SHA-256
`ee950a41fef853d6b475b00463a578379ff27ac889990ab7a4eff00ae5a3289a`.
It cross-binds seventeen source-bound proofs; this is not an added test or native
operation count and does not turn the failed matrix into a pass.

## CI26 — goal-extension callback local preparation

The separate candidate `dc1f70b8c773304592e826624123d12f6b0dacd9` repairs the
source-confirmed `DESKTOP-R50-01`: a live tool process group drops the existing
optional goal-extension callback, hiding its extension action near a limit. The
repair passes that callback through `MessageStream` and `TurnProcessGroupCard` to
`GoalProgressView`. It does not change goal budgets, permission policy or Core goal
mutation. The same eleven SSR markup cases first produce nine passes/two failures
with 23 expectations, then pass all eleven/23. The original seven cases and all
original thirty workflow-shard source paths remain unchanged; the workflow adds
only `MessageStream.test.tsx` to that shard, making 31 files.

Author proof `codeshell-goal-extension-group-callback-proof-20261018/verified-source-summary.json`
has SHA-256 `201a3c62ad02524d3ec6bf0a9c32f34e2a1747b50d2fd7f257b6d6a7416270bf`.
Its independent fixed-source peer `independent-panel-fixed-source-peer.json` has
SHA-256 `74f7ea204e336b1e0e69c407b84a13c587be188cd243d41caabc3a76fc0751e6`;
source-only approval is separate from hosted runtime acceptance.

Root freshly checks the combined candidate: 428 Bun tests/3,525 expectations across
31 files, zero failures/skips; all 140 pure Node tests across nine files pass with
zero failures, skips or cancellations. All fourteen workspace types and four safe
Desktop bundles pass afresh. Three TSX files pass zero-warning ESLint and formatting;
the workflow passes formatting/path validation, with engine-bypass and four-path
diff checks also passing. The frozen combined local proof
`ci26-frozen-combined-local-gates-20261018.json` has SHA-256
`ef218d7b6a3123dccc3b227b962e8f224f3fe41a995ea4bdb861c2479d3aed2a`.

These are local pure/SSR/static results, separate from the actual CI25 counts.
No new native interaction, button click or Core goal mutation is validated; all
CI26 runtime scopes remain pending. This product repair does not fix or explain
CI25's macOS process-query timeout or Windows Setup exit. Their original budgets,
gates and unknowns are retained. No local native, browser, installer, PowerShell,
process query or provider is run for this candidate; the discovery-incident
consequences remain unknown.

## CI26 — actual platform results and Windows packaged launch failure

[Run 39054487947](https://github.com/cjhyy/codeshell/actions/runs/39054487947),
attempt 1 / push, binds source `ab3b801f00d18ceabe824c099c3bd4824bae32c3`.
The run fails overall. Web, macOS and Linux pass only the audited scopes below;
Windows fails the packaged UI step before its updater and installer lifecycle.
Final API and independent peer binding confirm three successful jobs and the failed
Windows job at this exact source. CI14's earlier green matrix had a narrower scope,
before expanded NSIS acceptance.

Web passes 31 actual behaviors: ServiceWorker 11, authentication four, child eight
and annotations eight. Attachment nine/45 and pure lifecycle Node 64 pass separately.
The old-reducer control retains two passing cases and six expected failures, with
private HOME/profile checked retained. Six complete send/cancel payload arrays
match the final settled Host RPC rows, each count one. The five observed birth maps
contain 9/21/10/10/10 processes and settle to zero with normal browser exits, empty
signal-request ledgers and the required late-ledger/HOME/profile gates. The 57
canonical public files pass ZIP CRC, 28 exact workflow patterns, 106 source hashes
plus 13 offline provenance pins and 33 PNG chunk CRCs. Two actual CJK/narrow PNGs
are viewed. No Desktop Bun count is added to Web's 31 behavior checks.
Web `ci-39054487947-web-independent-20261018/ci-39054487947-web-independent-audit.json`
has SHA-256 `0f8a4ff3d7ed688f7881a5e6d63c9c513527836096468a4ecc4f4b0dcfcec596`;
`download-and-audit-freeze.json` has SHA-256
`8c13e9de878294f70b6632a251799a6b73b76512064ce4fb2688a458de06ac33`.

macOS passes original 83 operations/12 Main launches and separate new Review drafts
three/one. DMG installed/reinstalled UI 13+13 uses two additional normal Mains.
Its two attachments are one writable construction stage and one final readonly
verification, both detached. All fifteen Main exit, observed-incarnation custody
and private-HOME gates pass. The new draft Main 44870 exits `0/null`, with 14
observed incarnations settled to zero, five actual prepare IPCs and three accepted
seeds. All four metadata readers finish their first execution with exit zero;
116+55+41 predicates overlap and are not added to native operations. The 144 public
files pass CRC and 163 finite patterns; 49 PNG CRC records and nine Root actual
views remain distinct. Three further independently viewed narrow/CJK images are
readable; full draft equality comes from JSON rather than a partly visible input.
Mac `ci-39054487947-mac-independent-20261018/verified-summary.json` has SHA-256
`ebc0f45307c9c1525303592f64c351fa92a9248c06df2198708f64569fdc902c`;
`independent-web-final-key-peer.json` has SHA-256
`2d1a5c48c676640f55a4c7c4e1043561e8b423f92fada0559ebdbaa0cc30146e`.
An independent key comparison first mistook a CRC-success Boolean for the count
49; its retained correction checks that Boolean and the 49-entry PNG list
separately, without rerunning the four original readers or any native operation.

Linux passes original 83/12 and separate new drafts three/one, including the actual
AppImage runtime, enabled sandbox, first-instruction guards, ten owned manifest
GETs and the source/cache full-permission and byte-identity gates. Source-to-extraction
normalization deltas stay explicit rather than being described as absent. Required
inner HOMEs are removed; outer launcher scratch retention is intentional. Packaged
UI Main 8761 exits `0/null`, with sixteen observed incarnations settled to zero.
Its three owned-descendant SIGTERM requests target 8879, 8767 and 8766. The ledger
is not empty; source/identity cross-binding does not prove every fresh snapshot,
signal delivery, every descendant's normal exit or OS-wide process coverage.
Linux `ci-39054487947-linux-panel-independent-20261018/verified-summary.json`
has SHA-256 `e7eaf2b1f2ecf5dfea0a938ee0ee01e665e437c96fdec03300e8aa417b676bf4`.

Windows passes only the first 60 original operations across ten Main launches,
plus the separate new Review drafts three/one. Step 34, actual packaged UI,
fails with zero completed UI operations and actual Main 1928 exiting
`3221225477/null` (`0xC0000005`). Updater, the early native-evidence upload and NSIS
are not reached. A suppressed taskkill attempt and empty observed signal-request
ledger are recorded without asserting a causal relationship to the abnormal exit.
The recorded Main incarnation, parent 1772, has full birth
`2026-10-17T17:45:00.5206260Z`; its observed one-process custody settles to zero,
but that does not substitute for the required normal exit. Both the inner HOME and
outer launcher scratch remain retained. Two first-JS guard rows belong to this one
Main, with seven probes; there is no returned packaged identity or rendered UI.
The SDK's fixed launch-wait error alone does not locate the native fault point.
The two debugger-attached observations are consistent with the SDK connection plus
the owned first-instruction inspector; they do not by themselves establish a fault.
SDK call-log arrival is not a kernel event
timeline, so its cleanup intent and the abnormal native exit are not assigned a
causal order. No installer success, OS restoration or cause fix is inferred.

Windows artifact 12108988217 contains 103 finite public files, all CRC-checked,
with ZIP SHA-256 `78dc1e8769fce922e218280b5b5155543b2a5d7d7b0ab0d9f60766714ed5d8ae`.
Its `ci-39054487947-windows-independent-20261018/verified-failed-summary.json` has
SHA-256 `833354ba635d1393179bbcfd5f346c81cde2e52ce6ddd9f2b3c4b168f996d930`.
The independent `independent-panel-packaged-launch-failure-peer.json` has SHA-256
`4fb17ef0303f12ea22a819c8b88548cb64f956510f4b298d3aebf9a10d4ec5ff`:
68 key metadata checks confirm the partial/failed scope, not a passing launch.
Recorded package integrity remains unchanged, but raw package/generated private
bundle bytes are not uploaded and are not independently rehashed from Git source.
Retained offline source/upload-locator/generated-bundle metadata corrections change
no raw evidence, source, launch gate, retry or native result.

Actual platform Bun results are 428 tests across 31 files, with 3,525 expectations
on macOS, 3,522 on Linux and 3,516 on Windows. The eleven MessageStream SSR cases are
included in those 428, not added again or called native goal-button interactions.
No dedicated goal-extension click or Core goal mutation is validated here. Earlier
CI25 query/Setup failures, revoked custody, inode drift and discovery-incident
consequences remain unexplained; this run does not retrospectively repair them.

One historical wording correction is limited to the CI24 Mac paragraph above.
Its retained raw DMG receipt has one writable construction attachment and one
final readonly verification attachment, both detached. The clarification
`ci24-root-dmg-attachment-wording-clarification-20261018.json` has SHA-256
`a40c63fccdb23367ba5ec8b0504fe166d05a7dbe1ddc1710b3cc33c327e4562c`.
CI24 raw ZIP `aa333be14c3fb7c71f9586a561cec1afe42991066b8cb962a36c9b265837979b`
and its original proofs are unchanged. Other historical mount wording is not
batch-corrected without its own raw verification.

Root's terminal `ci26-final-matrix-binding-20261018.json` has SHA-256
`03f67fb98a3c5c36ecb4a98cd78f94473d005b8591d93bdf3ca856dc9cdbfe13`.
It rehashes eighteen source-bound proof references. Final API records bind all four
jobs and their artifact digests. These are overlapping provenance checks, not
additional tests or native operations. The run remains failed; no publication or
full current release acceptance is established.

## CI27 — thin-image dimensions and packaged crash diagnostics (local preparation)

The local candidate checkpoint `0d0210d5cc6fbf00d38485e4e567c001ed71ec16`
combines product fix `14e897228e3b2d33095e6b06165943806536125e` and diagnostic
commit `32f3efc296228c7a9a5fb9be984c4061dc2d5760` with the CI26 actual record.
CI27 has not been pushed or run at this preparation checkpoint. CI26 remains
failed, and its Windows packaged-launch cause is not established or repaired by
this local preparation.

The R52 image-dimension fix clamps each rounded short side to at least one for
positive source dimensions. Its six numeric regressions fail on the old helper:
17 cases contain eleven controls passing and six failing, with 25 expectations.
The fixed helper passes all seventeen/25. The earlier R52-only local checkpoint
passes 445/3,550 across 32 Bun files, fourteen workspace typechecks and renderer/
mobile static bundles. These are numeric/source checks, without DOM, canvas,
image-encoding or actual thin-image runtime validation. The source-bound local
summary `codeshell-thin-image-dimensions-proof-20261018/verified-local-combined-summary.json`
has SHA-256 `01c7ab6f9f121bb23f0ed8141c07b1bdf2c12e505041d3495fa8f4cae6c119fb`.

The six-path diagnostic change preserves the original thirteen packaged UI
operation bodies, normal-exit, custody, HOME, transport and timeout gates. Only
`GITHUB_RUN_ID`, `RUNNER_ENVIRONMENT` and `ImageOS` are added to the existing
isolation allowlist, through both isolation layers; credential filtering and
private-HOME construction stay unchanged. An eligible actual failed, hosted
Windows Main still requires the exact source/package, PID/parent/full birth,
durable first error, complete settled custody and empty observed signal requests.
Its passive query uses the existing fixed PowerShell transport, nine private-HOME
fields, 30 seconds, 64 KiB and at most eight event records per provider, with one
query at most. Missing proof produces unknown with no query. No query result
changes the original error, cleanup authority, acceptance gates or failed status.

The first caught error is recorded before that catch's first await. This does not
establish an order across the SDK connection, the owned first-instruction inspector,
independent startup cleanup or the native fault. Original CI26 evidence and
unknowns remain unchanged. No local Windows EventLog, PowerShell, browser,
installer, process query or provider is executed for the diagnostic's tests.

The initial eighteen-test diagnostic attempt contains sixteen passes and two
assertion-authoring errors, not a product RED. Corrected/formatted v2 passes all
eighteen. Its v3 changes only explanatory text; final v3 execution belongs to the
new combined Node result below. Four new/wiring MJS files pass ESLint; the extra
wrapper check retains one unchanged `preserve-caught-error` violation on both
immutable 14e and the candidate. It is not an all-files lint pass. Six-file format,
five-file syntax, 71 literal workflow paths and diff checks pass separately.

The diagnostic author proof `final-source-review-v3.json` has SHA-256
`e7ed1b206bf29c888c658ecb4a3b564d6503b5ea3c6f550e7b8402eb8d648ba6`;
Root's source review has SHA-256
`ceea2ae89b6c1a2e85ab767e8113726a47dd37f50e297d375632a131b2953141`,
independent Panel source peer has SHA-256
`be83f7b6b2d2efc5a6ff2f872ae8110e22ef6c756ace7dc93993f9ff50bced2f`,
and committed-content mapping has SHA-256
`8ec62c8054652173f487d5e7f97b0d92ee5a33017f26b1065e5be242f88839f1`.
All four are retained in `codeshell-packaged-main-crash-evidence-proof-20261018`.

Root's final checkpoint executes 445 Bun tests/3,550 expectations across 32 files
and 158 pure Node tests across ten files, with zero failures, skips or cancellations.
The collector's final v3 eighteen cases are included in 158, not added again.
The final `ci27-frozen-combined-local-gates-20261018.json` has SHA-256
`67c3e18e25516fbea6faf3ab39531319d49ffb04dcd689b4bd2f25bc9633c8c1`.
The fourteen typechecks and renderer/mobile bundles remain actual 14e results,
reused because all later TypeScript/build inputs are byte-identical; they are not
fresh typechecks or bundle runs at 0d021. The combined-freeze writer first stops
on a bytes/string metadata TypeError before writing its final proof. Its retained
correction changes only the writer; no source, raw log, runtime gate or test run
is changed or repeated.
These local checks are not a new native launch, a repaired Windows failure or
current full release acceptance. Three-platform and Web runtime validation at this
new candidate, plus the Windows installer lifecycle, remain pending.

## CI27 — actual platform results and installed UI launch failure

[Run 39058734301](https://github.com/cjhyy/codeshell/actions/runs/39058734301),
attempt 1 / push, binds source `85216160aeca0c6f0a22866fd007b13c223a0500`.
Final APIs bind four terminal jobs: Web and Linux succeed; macOS and Windows fail.
The overall run fails and does not establish release readiness.

Web passes 31 actual behaviors: ServiceWorker eleven, authentication four, child
eight and annotations eight. Attachment nine/45 and pure lifecycle Node 64 remain
separate. The old-reducer negative run retains two passing controls and six
expected UI failures, with private HOME/profile preservation checked by the
in-CI verifier. Six complete send/cancel payload arrays equal the final settled
Host RPC rows, each exactly once. Five observed birth maps contain 7/19/10/10/10
processes and settle to zero with normal browser exits, empty observed signal
ledgers and the original late/HOME/profile gates. Its 57 regular public files pass
ZIP CRC and 28 exact workflow patterns; 106 source hashes plus thirteen provenance
pins and 33 PNG CRCs are independently checked. Two actual CJK/narrow PNGs are
viewed without observed horizontal clipping. The shared wrapper adds only three
hosted metadata names; credential filtering, HOME reconstruction and the complete
Web job block remain unchanged. Desktop counts are not added to Web behaviors.
Web summary has SHA-256
`3f0f505ea8938c3cf925c26ab3ad72e534f62cf43a69e27de3570a680612616a`;
its complete freeze has SHA-256
`bf1ec9c47619f377affdeb261c73be7241fce17964c482b1abe5f4e488c7efc1`.

macOS fails step 27 after one cold Main. Three actual Pet operation groups
(cold renderer, reload and production second window) and two loadFile records
are observed, but zero startup cycles are fully accepted. Main 6764, parent 6687,
exits `0/null`; fourteen observed incarnations settle to zero with query failure
false, nontruncated evidence and no recorded signal requests. The controller
records normal exit/close at sequences 18/19, cleanup settlement at 22, post-exit
Keychain preflight phase at 24 and first error at 25. The error is
`CODESHELL_KEYCHAIN_PREFLIGHT_IDENTITY_CHANGED`, stage `account-before`:
`sameInode` alone is false; home/path/device/owner comparisons are true.
The private HOME is retained. `launchStarted:false` concerns this post-exit
preflight invocation, not the Main that already ran. Raw pinned/current inode
values are not uploaded, so physical replacement, actor, timing and cause are
not established. This is not CI25's process-query timeout. Cycles two/three and
all later source suites, Review drafts, packaged UI, updater and DMG are not reached.

The Mac artifact has 22 canonical regular public entries, all CRC-checked, with
ZIP SHA-256 `19cfdc2b188b818c178651aa9983592d632adfedfc3fa354b2f8c1edf5e5fb14`.
Its failed-aware summary has SHA-256
`e9797e392f54dbd127f5c5bbf36356749c8de49b644b2c88389eb97cd79e33d2`;
independent key/visual peer has SHA-256
`5b539dfe87fe508754b0565c2bfc2c6863ef8bdfcc297574018efcc74e3df726`.
Two actual images show readable Chinese trust-dialog text and a wrapped owned
path. The second-window frame is translucent with dialog/background overlap;
one frame does not establish a persistent visual defect or validate later screens.
The generated startup guard SHA is recorded only; private generated bytes are
not uploaded and are not treated as a static Git source hash.

All four prepared Mac success readers remain unexecuted. Their v1 count
substitution accidentally changes two 524,288-byte limits to 524,458; peer review
catches this before execution and v2 restores the original caps. The first actual
failed-aware reader also stops on an incorrect requirement that two bootstrap
identity/probe receipt logs be empty. The corrected v4 checks their exact identity
and seven-probe contract; true worker/denial ledgers still must be empty. It runs
once with exit zero. The retained errors and 39 metadata conditions are offline
audit facts, not additional native cases or changes to the original failure/gates.

Linux passes original 83 operations/twelve Main launches and separate Review
drafts three/one. Draft Main 5987 exits normally with fifteen observed incarnations
settled to zero. Packaged UI Main 8652 exits normally with eleven observed
incarnations settled to zero and an empty recorded signal ledger. Actual AppImage
Main 9155 and runtime 9150 exit normally, with sixteen observed incarnations settled
to zero, ten owned manifest GETs and the source/cache full-07777, byte-identity and
sandbox-helper 04755 gates. Runtime inner-HOME removal and intentionally retained
outer-launcher scratch remain distinct. Recorded custody does not prove OS-wide
process/signal completeness or every descendant's normal exit. Twenty-two map
copies/218 edges, 35 PNG CRCs and three actual image views are not additional
native operations. Three preserved readers finish their only execution with exit
zero; two additional offline metadata errors remain retained. Linux summary has
SHA-256 `4b50a371b3413eeab758325494642703decc80f3b6e13962773775878506382a`;
its complete freeze has SHA-256
`1cdfc289266e926561b77e6e4dfafdb8bf3748d4b0cdd1e6041ee37220ee941c`.

Windows passes original 83 operations/12 normal Main launches, plus separate
Review drafts three/one. Draft Main 4216 exits normally with 21 observed
incarnations settled to zero, five production prepare IPCs and three accepted
seeds. Step 39 then fails in the first NSIS-installed UI. Builder 1592 and Setup
5148 exit `0/null`, and installed payload/registration/two-shortcut identity checks
complete. The installed UI Node controller 3772 exits `1/null`; its actual Main
5224, parent 3772, birth `2026-10-17T18:49:32.9906110Z`, exits
`3221225477/null` (`0xC0000005`) before a returned runtime identity or any UI
operation. This separate one-incarnation Main custody is cleaned to zero without
recorded signals; that does not substitute for normal-exit acceptance. Eight of
sixteen NSIS phases complete. Replacement, uninstall, installation absence, cache
cleanup, final OS state and final integrity are not reached. Failed owned roots
and the installed UI private HOME are retained. Neither six normal NSIS roots nor
26 installed/replacement UI operations are established.

The new bounded passive Main collector actually queries and returns
`unknown/no-exact-application-event`, not absence of a crash or a module diagnosis.
SDK forced-cleanup suppression and empty observed signal ledgers do not establish
kernel ordering or the crash cause. The receipt reports a 1,693-byte first-error
file, with written flag and hash, but nested `ui-first/first-error.json` is missing
from the CI27 NSIS upload list. Its absent bytes cannot be independently rehashed.
Six actual collector source pins are bound to the controlled CRLF forms. The
uninstaller hook is source/build/payload-bound only; its macro is not executed.
Raw App/Setup/uninstaller bytes are not uploaded and signature remains
`not_verified`; runtime inventory/receipt binding is not direct binary rehash or
OS restoration proof.

The final Windows artifact contains 143 regular public entries, all CRC-checked,
with ZIP SHA-256 `c7560867feff9c25c26aee11a51637eb34c01f79cb8ab0f4e0ee7bc364cdf7ec`.
Its verified failed summary has SHA-256
`8041080ec8d7b3cfa41a84ea3f0f6ce1a079c6fd65357928b0adec60487623f5`;
NSIS detail has SHA-256
`fa2ae9746462946eeefe6679b04273700a8c759fb174086f35fa9d7d2466b0f6`.
Independent Panel key peer has SHA-256
`a508f1c164e55ae0f7637d7af27c3ad5f36089afcedf5eb9e058efd2b909c655`;
its summary binding has SHA-256
`9170662b92d1aa2374b8fb4f4a18db89c78d73b9f81193dfc7aefb97a897bb6c`.
These overlapping metadata predicates do not increase native operation totals.

Actual native-job Bun gates are 445 tests across 32 files, with 3,550 expectations
on macOS, 3,547 on Linux and 3,541 on Windows. Write eleven/38, output sixteen/32
and branch fifteen/50 remain separately reported. Review diagnostic thirteen and
combined draft/lineage/invocation 72 pure Node contracts are separate gates;
Windows installer/collector 73 pure contracts are not 73 actual Windows events.
R52 numeric helper coverage is not DOM/canvas/image-encoding validation, and
MessageStream SSR cases do not establish a dedicated native goal-button click or
Core goal mutation. No current or historical inode/query/GC/NSIS cause or
accidental discovery consequence is explained by these passing subsets.

Root's `ci27-final-matrix-binding-20261018.json` has SHA-256
`b9349102149826f2e317e1aed32489e2a5ccdb20bd071e51a41a79e176b10949`.
It binds seventeen proof references, final API source/job status and artifact
digests. Those are provenance checks, not native checks. The run remains failed;
no release, formal signing, publication or current full acceptance is established.

## Follow-up — installed UI first-error artifacts (source preparation)

Commit `406f75a483c6a99f4fddd2b3ab57dc70728ecaf5`, parent the exact CI27
source, adds only two final-upload literals:
`windows-nsis/ui-first/first-error.json` and
`windows-nsis/ui-replaced/first-error.json`. Removing them restores the complete
CI27 workflow byte-for-byte. Final native public patterns become 166; early native
91 and Web 28 remain unchanged. Runtime bodies, budgets, sixteen phases, six
controller roots, 26 UI actions and absence/OS/cache/custody/HOME gates are unchanged.
Format/diff/source checks are local preparation, without a new native execution.
Source proof has SHA-256
`fb0553c7c037b234c3c91dcbb5ada66fee9df5c6a6b8f45e79bd0f1d01c03b74`;
workflow SHA-256 is
`ffc4e7ae4749430dae0b14ab4c66a883733ddb2bc5552e15b2d5731b86922863`.
Its initial source-metadata slicing error is retained. At this preparation
checkpoint CI28 has not been pushed or executed. It does not recover the missing
file from the frozen CI27 ZIP, validate the uninstaller hook or explain/repair the
abnormal installed Main exit.

## CI28 — actual platform results and Windows Review identity failure

[Run 39060777611](https://github.com/cjhyy/codeshell/actions/runs/39060777611),
attempt 1 / push, binds source `ccceee3a05f8493af3d1e62c9d99cfa87b92fcb0`.
All four jobs are terminal: macOS, Linux and Web succeed; Windows fails. The
overall result is **FAILED**, not release acceptance. Product/runtime/wrapper
source and the Web job body are unchanged from CI27; the only workflow
delta is the two reviewed nested Windows first-error upload paths.

| Platform    | Actual accepted scope                                                                                                                                              | Incomplete or separate boundary                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS arm64 | Original 83 operations/12 normal Main launches; separate Review drafts three/one; DMG installed 13 and replacement 13 in two normal Mains.                         | Fifteen normal Mains total; owned same-build replacement, ad-hoc signing, no notarization/Gatekeeper or real user migration.                     |
| Linux x64   | Original 83 operations/12 normal Mains; separate Review drafts three/one; actual AppImage updater ten manifest GETs.                                               | No update asset download/install or OS-wide custody/signal completeness claim.                                                                   |
| Web         | 31 actual browser behaviors; attachment nine/45 and 64 pure lifecycle contracts separate; two controls plus six expected negative UI failures retain HOME/profile. | Owned HTTP/WebSocket fixtures; no real account/provider or all-browser-state claim.                                                              |
| Windows x64 | Seven startup operations in three normal Mains.                                                                                                                    | Review identity fails with zero operations; steps 29–39, including drafts, later source suites, packaged runtime, updater and NSIS, are skipped. |

Windows step 28 first latches
`electronApplication.evaluate: Resulting promise was garbage collected.` in
`harness-main-identity`. Actual Main 3296, parent 3268, has full recorded birth
`2026-10-17T19:10:29.7523420Z`. Durable first error sequence 10 precedes cleanup
start/request 11/12. Three descendant SIGTERM requests are recorded at 13–15,
then the Main SIGTERM request at 16; exit `1/null` and close follow at 17/18.
The first-error snapshot precedes this Main ChildProcess's recorded exit; it is
not a fresh OS-liveness observation. Neither the later exit nor requested signals prove
a pre-cleanup native crash, actual signal delivery, kernel ordering or the GC cause.

Twenty-four captured full-birth identities settle to zero with query failure
false and nontruncated evidence. That proves observed custody cleanup, not normal
Main acceptance or all OS descendants. The failed Review HOME is retained;
the second normal-exit refusal remains a secondary failure. Startup's three Mains
exit normally, its 17/4/4 observed sets settle to zero and its HOME is removed.
No Review page is returned, so no failure screenshot or later runtime result is
invented. The packaged passive EventLog collector and the two new nested
first-error upload paths are not exercised in this Windows job. Source validation
of those paths does not validate an actual nested upload or repair the missing
CI27 bytes. The 43-file public Windows ZIP passes CRC; its failed summary has
SHA-256 `be118c53818de5cda346f3b3b6b938f8732fadab331e6b52283b54d67909bb26`.

The bounded source review finds that the identity callback is already synchronous
and returns a plain object. The pinned SDK's evaluation/error-mapping chain
identifies the reported error class, not why V8 produced it; actual protocol
request/reply bytes and the physical CI SDK file are not uploaded. Official
[upstream issue 33737](https://github.com/microsoft/playwright/issues/33737) is a
similar report, not this run's proven cause or fix. Root's
static-chain receipt has SHA-256
`36e3864924ebdba2eea35b2176444f9518026e00441f3e93c8c020439e90c728`.
The independent feasibility conclusion has SHA-256
`4095c03f70193e866488d198645d60ec4e8badd3fb05163ca8805a355a54ccff`,
with append-only peer/source binding
`191b56b9c16fd81233fec9721faeabd5ea6a7d210ba38679869bafdb64800122`.
It establishes no reliable source fix. Public close listeners would not expose
the private Node Promise/context lifetime or cover launch failures without a
returned handle; their three proposed fake contracts remain unexecuted. No retry,
sleep, identity relaxation, replacement transport or speculative SDK repair is made.

macOS completes the original suites, separate drafts and both DMG UI sequences.
Four packaged Mains 36243/36978/39493/39993 exit `0/null`; their 8/14/14/9 observed
sets settle to zero, and complete signal-request objects have empty `requests`
with `truncated:false`. All fifteen distinct accepted Mains have normal exits,
observed cleaned custody and the recorded HOME removal gates. Package ASAR,
managed Node manifest and before/after inventory bindings agree in the runner;
raw App/ASAR/DMG bytes are not uploaded for local physical rehash. DMG attachments
are one **read-write construction stage** and one **read-only final verification**,
both detached, rather than two readonly mounts.

The Mac archive has 144 regular public files under 166 finite patterns, with all
ZIP CRCs checked. Twenty-seven map copies/245 edges and 49 PNG CRCs are metadata,
not extra operations. Root views six images; independent peer views three selected
images from that set. The 390px dark settings, complete wrapped generated-image
path and B-session draft are readable, without observed horizontal clipping.
The summary has SHA-256
`af8b63a5c4c80583a2634b0368e516e7a457ee2bdc8948819cf63416e71230c8`.
This pass does not explain prior Keychain inode mismatches, query timeouts or GC.

Linux Main 8912 completes packaged UI normally; actual AppImage Main 9457 and
launcher 9454 also exit normally. The updater makes exactly ten owned
`/latest-linux.yml` GETs for five error modes and five healthy retries, with zero
asset downloads, workers or native secret-storage calls. First-instruction
identity/probes, actual APPIMAGE/APPDIR, no `--no-sandbox`, the exact owned
root:root 04755 helper and full-07777 source/cache inventories pass. File bytes
and identities are unchanged; the exact authorized extraction permission
normalizations are retained. Removed runtime HOME and retained outer launcher
scratch remain distinct. UI/updater recorded signal-request arrays are empty,
which is not an OS-wide signal audit or all-descendant normal-exit proof.
The 142-file archive passes CRC under 166 finite patterns; 22 map copies/244
edges, 35 PNG CRCs and three actual image views remain metadata/visual scope.
Linux summary has SHA-256
`f7e14d68b56010dd43b2f4cd5c12b7dfc89a51f4b10fa7145e0f4550f3145c38`.

Web's 31 behaviors remain eleven ServiceWorker, four authentication, eight child
and eight annotation cases. Six complete payload arrays match final settled Host
RPC rows, each exactly once. Its five observed birth sets, 7/23/10/10/10, settle
to zero with normal browser exits and the original late-ledger/HOME/profile gates;
the negative run's HOME/profile remains retained. All 57 regular public files
pass CRC and 28 finite patterns; 106 source hashes plus thirteen provenance pins
and 33 PNG CRCs are checked. Two actual Chinese/narrow screenshots are readable.
The Web summary has SHA-256
`f96aed6b1d1d4b3066c44c4f4d2dbfd06682c2aa72e911969e09b691ab8dba42`.
English `lstart` birth values retain second precision and allow equality; they do
not provide subsecond or OS-wide process proof.

Offline audit mistakes remain separate from runtime results. The Mac preparation
first stops on a hand-copied old SHA before any reader; v2 binds the exact pinned
source. Its four admitted readers each run once with exit zero. A later summary
writer's wrong `observedSignals` key stops before writing its summary; correction
uses the complete raw `observedSignalRequests` object without rerunning readers.
A mistaken screenshot path is corrected before viewing the existing files.
Linux's three original readers each run once with exit zero; a later supplemental
19-total-calls versus nine-target-payload equality is rejected as overstrong.
After source/raw review, its corrected comparison accounts for all control frames
and the nine ordered complete payloads. Windows source-preparation assumptions
and three reader revisions are corrected before execution; only fixed v4 runs
once with exit zero. Web's two admitted comparisons each run once with exit zero.
These corrections neither change runtime gates nor turn metadata checks into
additional native cases; their first errors and unexecuted versions are retained.

Actual native-job Bun gates are 445 tests/32 files with 3,550 expectations on
macOS, 3,547 on Linux and 3,541 on Windows, each zero failures/skips. Write eleven/38,
output sixteen/32, branch fifteen/50, Review diagnostics thirteen and combined
draft/lineage/invocation 72 remain separate. Windows installer/collector 73 pure
contracts pass; they are not Windows native lifecycle events. Numeric thin-image
helper and goal-callback SSR tests do not establish dedicated native encoding,
button clicks or Core goal mutations. Earlier 445/158 local gates are reused only
by exact executable-input byte identity, not freshly rerun at CI28 or the current
docs-only checkout.

Root's `ci28-final-matrix-binding-20261018.json` has SHA-256
`a5ae7d57fafc9a699ef18795caa69e2e8abfaf988a8d98eed0ccbdaa0ed12ef8`.
It binds nineteen proof references to final API jobs, source and artifact digests;
those references are not native checks. The editing base additionally contains
195 reviewed round57 audit-doc paths, with one static Pet P3 outside this UI
scope and without new runtime proof. Historical finding totals are not remaining
defect counts. CI27/26/25/24 failures, the accidental discovery unknowns and the
unvalidated NSIS uninstall lifecycle remain intact. No release, publication,
new CI dispatch or acceptance-gate weakening is performed for this record.

## CI29 — actual five-job results, paused Goal deletion and two Windows failures

[Run 39065030384](https://github.com/cjhyy/codeshell/actions/runs/39065030384),
attempt 1 / push, binds source `463497e04d75f5a6d999a1fd59ea2f0260653784`.
All five jobs are terminal: Web, macOS and Linux succeed; the original Windows
matrix and independent Windows NSIS job fail. The overall result is **FAILED**.
The new independent job does not bypass the original matrix or establish release readiness.

| Scope                    | Accepted actual scope                                                                                                                                                                          | Remaining boundary                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64              | Original 83 operations/12 normal Mains; separate drafts three/one; required paused-Goal deletion one in the existing third preferences Main; DMG installed 13 and replacement 13 in two Mains. | Fifteen normal Mains total. Ad-hoc same-build replacement; no Intel Mac, notarization or Gatekeeper claim.                                   |
| Linux x64                | Original 83/12, separate drafts three/one and required paused-Goal deletion one without another Main. Actual AppImage updater ten manifest GETs.                                               | No update asset download/install or OS-wide process proof.                                                                                   |
| Web                      | 31 real behaviors: eleven ServiceWorker, four auth, eight child and eight annotation cases.                                                                                                    | Attachment nine/45, 64 pure contracts and two controls/six expected negative failures remain separate.                                       |
| Original Windows matrix  | Startup seven, Review eleven and Panels twenty: 38 operations/five normal Mains; separate drafts three/one.                                                                                    | Step 31 Composer identity fails with zero operations. Memory, preferences/Goal, packaged UI, updater and this matrix's NSIS are not reached. |
| Independent Windows NSIS | Ten phases complete, including first installation, installed identity and thirteen UI operations in normal Main 7996.                                                                          | Step 20 fails during replacement. Replacement identity/UI, uninstall, cache cleanup and final integrity are not completed.                   |

The new Goal acceptance uses a real status-popover Delete click, preload,
original no-child Main fallback and SessionManager CAS in owned paused session A.
Both macOS and Linux record exactly one true deletion, preserved Goal identity
and revision seven, terminal `user_cleared`, state revision zero to one and null
Goal after reload. Four original RPC requests are recorded on each platform,
with complete final-prefix reconciliation and no late rows. Runtime assertions
preserve A's explicit business fields, A's transcript bytes and B's whole
state/transcript bytes. Private files are not uploaded for a physical reread.

The nonempty unsent draft and permission remain identical immediately before and
after deletion. The actual model marker is empty before/after; this is not real
model-selection acceptance. Reload proves durable Goal absence and no UI revival,
not cross-reload draft restoration. This additional one operation adds no Main
and does not establish active Engine/provider use, GoalExtend or the R50 extension click.

Original Windows Main 4628, parent 5940, has recorded birth
`2026-10-17T20:11:22.4305600Z`. Composer first reports
`electronApplication.evaluate: Resulting promise was garbage collected.` at
`verifyElectronMainIdentity`, stage `launch`, with zero cases and no returned Main
snapshot. Its final receipt records exit `1/null`; 31 observed identities settle
to zero without query failure/truncation. The normal-exit gate refuses acceptance
and HOME retention is recorded. No first-error/cleanup/exit timeline, signal
ledger, Main stdout/stderr, guard snapshot, body or failure PNG is uploaded for
this source fixture. The data therefore establishes neither cleanup/exit ordering,
a pre-cleanup crash, actual zero-worker observation nor the GC cause.

The independent NSIS job is a distinct disposable Windows VM. Replacement Setup
2932 first records its 180,000ms budget failure at journal sequence 33, then a
SIGTERM request at 34 and exit `1/null` at 35. The process assertion follows at
36 and outer first error at 40. That observed order does not explain why
replacement remained unfinished or prove a dialog was reached. Earlier first
installed Main 7996 exits `0/null`, its thirteen UI operations pass and its HOME
is removed. The failed replacement's three observed identities settle to zero;
that is cleanup evidence, not normal replacement or six normal controller roots.
Replacement may have changed OS state despite no completed phase. Final payload,
registry/cache/OS state is unverified. The bound 181-byte CRLF NSIS hook source
and successful build do not prove `customUnInit` ran or fixed the earlier uninstall failure.

macOS preserves all fifteen normal exits and the original custody/HOME/package
bindings. DMG attachments are one read-write construction and one read-only final
verification, both detached. Linux AppImage Main 9378 and runtime 9375 remain
distinct; first-instruction guards, sandbox, exact 04755 owned helper, full-07777
source/cache inventories and ten updater GETs pass. Authorized extraction mode
deltas remain explicit; removed inner HOME and retained outer scratch are distinct.
Passive startup observations record normal preload result/write/SDK completion,
not failure-branch execution, a new identity authority or any prior GC cause.

Web's six full settled Host RPC arrays match once each. The five browser birth
sets close normally and settle cleanly with the original late-ledger/HOME gates;
the expected-negative HOME/profile remains retained. The 57-file ZIP passes CRC
under 28 patterns; 106 source hashes, thirteen provenance pins and 33 PNG CRCs are
checked. Two actual Chinese/narrow screenshots are readable. These finite Web
results do not establish desktop or full-matrix success.

The five frozen scope summaries have SHA-256:

- Web: `996be00740b543004a0ae15fe65fa2b03512a04c77b415b2b732057724b4b6d5`.
- macOS: `6c32d7b650011f10edf0937e59513bd4fb04732f892e9ebd91ac3c332e99344a`.
- Linux: `273c1a2b19fe4aca85483d88f49278be45e519134460369b111597ab9bfa2a52`.
- Original Windows matrix: `dec1f449bead5b845bfbe9b90115bc8ec47ae4c96ace45b6eee9b9cdd3556628`.
- Independent Windows NSIS: `130bb95d3dc99602e6a6050ac04bdb25c96fc6990d9109bdafe38e1c0cd94d21`.

Hosted native Bun gates pass 445 tests/32 files, with 3,550 expectations on macOS,
3,547 on Linux and 3,541 on Windows. Write eleven/38, output sixteen/32, branch
fifteen/50, Review diagnostic thirteen and draft/lineage/invocation 72 remain
separate. Windows installer/collector 73 and the independent job's sixteen
passive/Goal pure contracts are not native lifecycle events.

The local combined 174-test run first reports 172 passes/two failures: the pure
catch harness did not bind the newly added actual observer. Commit `463497e04`
corrects only that test binding; production is unchanged by the correction.
The final fresh explicit twelve-file run passes all 174 with zero failures,
skips or cancellations. Its frozen proof has SHA-256
`783a1d7638a882af240681ddbdf2b35fe69a59dcbb7f70215f5bc8d5654bb258`.
The first full log remains retained. Earlier local 445/type/bundle gates are
reused only by unchanged-input binding, not freshly rerun at this documentation head.

Offline first errors remain retained: Linux's passive reader initially assumes
a top-level updater identity; reviewed v2 selects the existing
`operations[0].identity` without changing native predicates. Unexecuted preparation
versions remain distinct from actual reader runs. Web's poll-interval guard stops
before its premature API request; the later permitted readers each run once.
Original Windows extraction and both finite outcome readers each run once, with
no success-reader shortcut or runtime retry. None of these metadata corrections
explains a native failure or changes its gates.

Root's `ci29-final-five-scope-verified-matrix-20261018.json` has SHA-256
`45d32e849af58f2a3a5967b753d51cbb89865dd09186b8afa653fb24351a1007`.
It binds final APIs, all five source-bound summaries/freezes and artifact digests;
provenance checks are not extra native operations. CI28 and earlier failures,
unknown causes and the accidental local discovery's unknown consequences remain
unchanged. No release, remote-main/tag push, publication, retry or gate relaxation
is performed by this documentation update.

## CI30 — prepared source, native execution pending

The candidate source is `46fef80a8029d84f4e7ebef165fcfba952e9ce31`.
This is a preparation record, not a new CI result or release approval. No CI30
push or hosted execution is recorded here. CI29 remains **FAILED**; its Windows
Composer GC cause and unfinished NSIS replacement cause remain **UNKNOWN**.
Earlier failures and all historical records above remain unchanged.

MCP project overrides now treat a configured name such as `team.docs` as one
literal record key inside the existing SettingsManager write lock. Commit
`27f2c29e3de4e1c1e36430dccd0e08eb5cf606b6` fixes the reproduced nested-write/schema
failure and failed literal-key inheritance deletion without changing the Manager,
schema, name validation or global write path. The real owned-file baseline is
seven passes/three failures: two defect triggers plus the separately approved
contract difference that deleted projects now fail closed rather than silently
no-op. The new and existing service shard then passes 27 tests/85 expectations,
zero failures/skips, with eighteen deny probes and zero actual transport attempts.
Both off and null literal overrides are deleted; sibling keys, raw fields
and local/profile precedence remain covered. No real MCP client/server is run.
Returning false for an absent override means no JSON write, not zero lock or
directory IO. The unchanged runner deletes its JUnit in `finally`; full raw logs
are retained, without a claim that the physical XML was frozen.

Updater commit `5cda96c8bb7ffd71e0b528b6d10d98af3400dac5` replaces inline technical
error text with a short summary and a closed Error details disclosure retaining
the full message. Its updated packaged fixture must still prove the new UI on
the actual candidate; no new native updater result is claimed at preparation.

Composer commit `836983d6a19d7481d0e4a4b177dee3b5eba01531` preserves the observed
first error, bounded Main output, cleanup order and three existing owned guard
records. Known failures retain HOME under the stricter complete-evidence gate.
NSIS commit `d73384dbdaf55c880ae88e7720f446ae703ab9d1` adds bounded advisory image
roles from the same existing process query, joined to current owned full-birth
identities. Roles grant no cleanup authority or physical image proof. These are
evidence improvements, not fixes for GC, replacement timeout or uninstall.
Neither adds a retry, native identity query, timeout extension or relaxed exit gate.

Root's explicit fourteen-file pure Node vector actually passes all 201 tests,
zero failures/cancellations/skips. Its first postprocessing receipt expected TAP
footer syntax, while the completed raw output used Spec footer syntax; null
counts caused a metadata assertion after the actual zero exit. The first receipt
and error remain retained. Reading the existing Spec footer verifies 201 passes
without rerunning tests; this is not a product or native failure. The verified
result has SHA-256
`12e20f311539a632bea05efd51a328a1cefe0a1749e13053f85146b7bb8c912b`.
The 27 Bun tests and 201 Node tests are distinct scopes and are not native cases.

Workflow commit `6637b34d8` adds three finite guarded steps: native-job operation
evidence/Goal contracts, project literal-key regressions, and the independent
Windows NSIS job's operation-evidence contracts. Original steps, native guards,
budgets, normal-exit/custody, OS/cache/HOME and acceptance predicates remain.
New exact public log entries do not imply native behavior has passed.

At source `46fef80a8`, Root's actual dependency build, fourteen explicit workspace
commands covering sixteen no-emit TypeScript checks, and renderer/mobile browser
bundles all exit zero. Bundle-size warnings remain: standalone Web 773.23 kB and
mobile 741.23 kB exceed 500 kB; renderer index 1,468.59 kB exceeds 1,000 kB. This is
not a zero-warning result or a Desktop native build/runtime test. The seventeen
static-command result has SHA-256
`f0c6e81636fd3984c8b673b3b91bb85051ea247f9a57856b7835c6279a69f811`.
The single shared-i18n `MessageStream.test.tsx` SSR shard at the same source
passes eleven tests/23 expectations, zero failures/skips, in one guarded run.
Its result has SHA-256
`14e0add86300b157ab045aec0c9e3bbbaacca01c7c3da966d3a962d5fa0eaeb0`.
It does not render the new UpdaterBanner. The historical 445-test/32-file gate is
not a whole-input-identical result for this candidate: shared misc runtime i18n
and Core-barrel definitions changed. Hosted CI must rerun all 32 files; the
historical result is not promoted to a fresh combined pass.
Hosted native execution, including full NSIS replacement/uninstall/OS restoration,
remains pending; no successful hook execution or readiness is inferred.

## CI30 — actual five-job results and pending follow-ups

[Run 39069879809](https://github.com/cjhyy/codeshell/actions/runs/39069879809),
push attempt one, is bound to immutable source
`2bbb517b615a6035e1c68fa8cac13f0b6f3a1eb2`. The final result is **FAILED**:
three successful jobs and two failures. This is not release approval. Later
source fixes below do not retrospectively repair this run or earlier failures.

| Scope                                        | Actual accepted boundary                                                                                                                                                                          | Result |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Web, job `117505097262`                      | 31 scenarios: service worker eleven, Auth four, subagent eight and annotations eight; six complete RPC arrays and representative images checked.                                                  | Passed |
| macOS, job `117505097131`                    | Original 83 operations/twelve normal Mains; separate Review drafts three/one; one paused-Goal acceptance in the existing Preferences Main; separate DMG thirteen plus thirteen/two Mains.         | Passed |
| Linux, job `117505097273`                    | Original 83/twelve, separate drafts three/one and Goal one in the existing Preferences Main; AppImage integrity, runtime, sandbox and ten GET gates.                                              | Passed |
| Windows matrix, job `117505097245`           | Original completed 54/seven normal Mains plus separate drafts three/one. Preferences completes six language/theme actions and three normal Mains but fails its required Goal gate; HOME retained. | Failed |
| Independent Windows NSIS, job `117505097241` | Ten of sixteen phases; first installed UI thirteen/one normal Main and three normal controller roots. Replacement times out; six required phases are not accepted.                                | Failed |

macOS and Linux also pass the new required HTTP-401 error-details disclosure:
short summary, initially closed details, full technical message retained and
keyboard close/reopen behavior. Composer's new public diagnostics and fixed
owned guard exports are checked separately from the original operation counts.
The two added diagnostic/Goal contract vectors are 43 pure Node tests in the
native matrix and 27 in the independent installer job; these are not native
operations. Windows actually records 445 tests/3,541 expectations/32 files,
while macOS records 445/3,550/32; platform counts are not copied between jobs.
The project-override regression is separately 27 tests/85 expectations.

Windows matrix step 35 first fails at `paused Goal: actual reload and durable
null`: the existing objective remains visible during the ten-second hidden
locator wait. The complete captured Main request/response pairs show a successful
`goalDelete` followed by two `goalGet` replies with `goal:null` and `paused:false`.
This is **not a deletion-failed result**. The required Goal acceptance remains
zero and the entire Preferences fixture is failed despite six completed actions
and three normal exits. Its failure gate precedes private JSONL reconciliation;
no successful durable-CAS verification or independent private-file reread is
claimed. Packaged UI, updater, DMG and the matrix NSIS path are skipped. Fifteen
uploaded owned maps contain 113 parent edges with no full-birth chronology
contradiction; this does not assert all OS processes or signal delivery.

The separate NSIS job accepts first-installed Main `1624` normal `0/null` and
thirteen UI actions with its private HOME removed. Replacement Setup `4548`
reaches the unchanged 180,000 ms watchdog: timeout sequence 33, authorized
SIGTERM request 34, exit `1/null` 35, then later process/outer assertions. The
cleanup-following exit is not proof of a spontaneous crash. `replace`,
`replacement-identity`, `replacement-ui`, `uninstall`, `cache-cleanup` and
`final-integrity` remain unaccepted; no final OS/cache restoration or complete
26-UI/six-root success is claimed. Advisory role observation has zero samples
and `observerFault:true`, so the two descendants' image roles and the replacement
cause remain **UNKNOWN**. Compiled hook bytes do not establish that the hook ran.

Root's final five-scope matrix, `ci30-final-five-scope-verified-matrix-20261018.json`,
has SHA-256 `7ed878fda1dd9186f02ee084c14d21e3ee9873ad0e01b2cd6a584e4a8d65e4c3`.
It binds final run/jobs/artifact APIs and all five immutable evidence freezes.
The Windows failed-aware summary has SHA-256
`d613d302551717abdcee8b2bd04215c058d92f837664779f8e5e1eb299b7753e`;
its seventy-reference freeze has SHA-256
`6250fbe6ede88d8d51ffb21106aef852b62fa641413dc2bcd08c72e73c4f9d41`.
The first offline reader omitted the existing `handshakeCompleted:true` field
from an exact metadata expectation. Its error is retained; the reviewed
four-field correction passes without removing a native gate. Other retained
metadata-authoring errors are not product or native failures.

### Source follow-ups awaiting a new combined run

Goal commit `8af52de38947a72cf9340595623cafe111ea9f40` reconciles an explicit
cleared Goal during transcript hydration rather than retaining the old renderer
cache. The pure baseline is seven passes/one meaningful failure; the related
suite then passes forty tests/85 expectations. This is source-level repair
validation; fresh hosted native Goal reload acceptance is still pending CI31.

Diagnostic commit `3676e9ba2048fc6f53ed19023119818f3907c37d` correctly binds the
role observer's default monotonic clock. A meaningful pure regression fails
before the fix, then twelve pure tests pass on Node 25.8.1/macOS. This repairs
an advisory observer defect; it does not explain or fix the NSIS timeout.

Attachment commit `98a5ac8e76d29b3923bdc7929a21dc8136c9b9d2` addresses
`ATTACH-R64-01`: different IDs in one session can share a PNG path, so retiring
an expired draft ID must preserve bytes still referenced by a valid sent item
or an item of unknown age. When all references expire, the file is removed once.
The owned-file baseline has zero passes/three failures/fifteen expectations;
the new five-test shard passes 32 expectations and the original 22-test shard
passes 85 expectations in separate guarded processes. These are owned temporary
files, not native UI, real-user attachment cleanup or provider execution.
The thirteen-reference source proof, `verified-source-summary.json` under
`/private/tmp/codeshell-attachment-retention-root-proof-20261018`, has SHA-256
`73ca7764f99109ed0730ef9be7b03c367ffb938a470f861e2e4981cbd0afb40f`.

These isolated source changes have not yet received a combined build/typecheck
or a source-bound CI31 run at this documentation checkpoint. Original budgets,
identity/custody/normal-exit, OS/cache/HOME and all existing acceptance gates
remain required. No release, signing, publication, retry or guard relaxation is
approved by this record. CI29 and all older unknown failures remain unchanged.

### Subsequent combined static checkpoint

After the preceding documentation checkpoint, Root source
`97909db793d2714f52a2e0ac3ea9402485e61b9d` includes the three follow-ups and passes
all seventeen finite static commands. The dependency build emits twelve
non-Desktop package declarations, Web static assets and the root shim;
fourteen workspace commands cover sixteen no-emit TypeScript checks; separate
renderer and mobile browser bundles also exit zero. This is not a complete
Desktop native build, package or native UI run, and no tests are inferred from
these static commands. The actual result at
`/private/tmp/codeshell-ci31-combined-static-root-20261018/verified-final-static-result.json`
has SHA-256 `579b7bf1a14784afb902d6e36bafb1243ecaf762bd84958068d9a2267fcf4fcb`.
Existing bundle-size warnings remain: Web 773.23 kB and mobile 741.23 kB exceed
500 kB; renderer index 1,468.78 kB exceeds 1,000 kB. This is not a zero-warning
result. The earlier pending statement remains its historical checkpoint;
source-bound native CI31 is still pending and CI30 remains failed.


## CI31 — actual dispatch with native results pending

The authorized acceptance branch was normally pushed from `2bbb517b615a6035e1c68fa8cac13f0b6f3a1eb2`
to `309a4fd134acf46cd535fd602da1f8defc3ce466`. Before and after remote checks leave
`origin/main` at `02d5d9a9ecbbb206d5f3d8a1d367e7081d937101`. No force push, tag,
release, signing, pull request or publication occurred.
[Run 39073589399](https://github.com/cjhyy/codeshell/actions/runs/39073589399)
is the actual push-triggered attempt one for that exact source and acceptance
branch. At this checkpoint all five jobs are in progress; no job or matrix
success is claimed.

The source includes the Goal hydration and shared-path attachment repairs from
the preceding checkpoint. Their finite guarded local gates are forty tests/85
expectations across three files, five new retention tests/32 expectations and
twenty-two original attachment tests/85 expectations in separate processes.
The final advisory NSIS role suite passes thirteen pure tests with no failures,
skips or cancellations. The default clock keeps its receiver; commit
`8bde05e31dd61157a283de7be1ff73e6f2e036c4` also copies the last existing role sample
when the first watchdog failure is recorded. Later cleanup samples cannot evict
that saved sample. It adds no process query or timer, and it does not establish
the unknown installer timeout cause or an atomic deadline observation.

The combined static checkpoint remains the seventeen actual successful commands
at `97909db793d2714f52a2e0ac3ea9402485e61b9d`. Only workflow, documentation and
the separately tested advisory MJS helper/test change after that source; all
TypeScript product and regression bytes are identical. Bundle warnings remain.
The final local gate record has SHA-256
`b528851d657f80beeddd6b749aa05ba62cd7da75f69d90055e13090f31e2073a`.
The workflow retains its existing native predicates and budgets and adds three
separate finite Goal/attachment commands with public logs. Native early/final
public patterns are 103/178, Web 28 and independent NSIS 59. Expected new Node
contract totals are 45 in the native matrix and 29 in the independent installer
job; their actual uploaded logs must be checked before acceptance.

A separate subsequent investigation concerns attachment IDs across cold module
lifetimes and is outside this frozen CI31 source. It has two meaningful local
baseline failures, not native restart acceptance; repair validation remains
pending at this checkpoint. CI30 remains failed, and older native failures and
the historical accidental-discovery effects remain unknown in their recorded
scopes. This dispatch is not release readiness.


## CI31 — completed five-job results

[Run 39073589399](https://github.com/cjhyy/codeshell/actions/runs/39073589399),
push attempt one at `309a4fd134acf46cd535fd602da1f8defc3ce466`, completed with
three passing jobs and two failures. The preceding dispatch checkpoint remains
historical. Root independently binds all five scope freezes and final run/jobs/
artifact APIs in `ci31-Root-final-five-scope-result-20261018.json` under
`/private/tmp/codeshell-real-operation-cycles-20261016`, SHA-256
`a3acc491eb19df9f3147f7a8c9dfc1e68729f7017188817531d791f19e205d49`.

| Job | Actual result and boundary |
| --- | --- |
| Web, job 117516056006 | Pass. Thirty-one operations: service worker 11, authentication 4, child work 8 and annotations 8. Six complete RPC arrays are independently cross-checked; this does not cover Desktop native behavior. |
| macOS, job 117516056211 | Pass. Original 83 operations/12 normal Mains; separate Review drafts 3/1; separate Goal deletion/reload 1 in the existing third Preferences Main; separate DMG installation/replacement UI 13+13/two Mains. |
| Linux, job 117516056146 | Pass. Original 83/12 plus separate drafts 3/1 and Goal 1 in an existing Preferences Main. Actual AppImage runtime Main 9691/launcher 9687, ten owned HTTP GETs, sandbox mode/identity, cache and private-HOME checks pass. |
| Windows matrix, job 117516056271 | Fail at step 22. The original attachment pure shard has 20 passes/two failures/82 expectations; native operations and native Mains are both zero. Desktop build ran earlier; native/package materialization did not run. |
| Independent Windows NSIS, job 117516056195 | Fail during replacement. Ten phases and first installed UI 13/one normal Main 7936 complete. Replacement UI, uninstall, cache cleanup and final OS-state checks are not reached. |

On macOS and Linux the separately reported finite source shards pass Goal
40/85 across three files, attachment retention 5/32 and original attachments
22/85. Native matrix operation-evidence contracts have 45 tests. These are
pure/owned-file checks and are not added to native operation counts. Recorded
custody maps/parent edges are 27/284 on macOS and 22/245 on Linux with no recorded
chronology contradictions. Their process precision and ownership boundaries
remain those of the supplied platform snapshots.

All admitted offline evidence readers ran once and passed. Linux's first fixed
GET failed with EOF before any response/ZIP was saved; the original error is
retained, followed by an explicitly reviewed recovery in a fresh namespace.
Its source-whitespace SyntaxWarning and two later summary-projection TypeErrors
are also retained separately; no reader or native rerun was used to hide them.
The final Linux summary uses the already observed integer Composer count nine.
Agents checked PNG chunk CRCs rather than viewing images. Root separately viewed
two fixed Web images and six fixed native images: narrow settings, Review draft
scope, reinstalled DMG settings, Linux 401 detail, wrapped generated path and
Linux settings. Those views show no visible clipping in the supplied captures;
this is not a visual review of every image or screen.

The Windows pure failures are a POSIX-only suffix assertion and inconsistent
canonical temporary-path representation. The test already used synchronous
`realpathSync`; exact old cwd/short-name alias bytes are absent from the log.
The source-level alias explanation is an inference. The first failing assertions
are retained; neither a product attachment failure nor native Windows success
is inferred from them.

The independent NSIS receipt records replacement Setup 2792, parent 7888, birth
`2026-10-17T22:16:10.6199300Z`. The actual journal order is watchdog failure after
180,000 ms, SIGTERM request, exit `1/null`, then assertion `1 != 0`; exit one
does not establish an installer crash before cleanup or signal delivery.
The repaired advisory observer records 184 samples with `observerFault=false`.
Its saved failure sample is existing query 180, watching, age 321.9683 ms, with
one Setup path-role row. Earlier owned children 2796/7128 are remembered in the
custody receipt while early role samples have rolled out. This does not prove
that no old uninstaller started, OS-wide child absence, an atomic deadline
snapshot, loaded-image identity, a window/dialog, or the timeout cause.

Read-only source investigation identifies two reachable paths worth
separating: the vendor's old-uninstaller `ExecWait` and a prompt-capable
nonzero-result branch. Neither is established as the reached failing path.
No production installer change, budget increase or weakened predicate follows
from this evidence. The `customUnInit` hook still lacks full successful native
uninstall validation. Earlier unknown GC/native failures remain unchanged.

### CI32 source repairs and finite local checks

Attachment commit `315fccffd507abd61d53f8e6e78fb1253e210c86` replaces the
module-lifetime counter suffix with a UUID for both image and ordinary-file IDs.
Two cold evaluations of the original service can generate the same ID for the
same session/path, allowing a newer draft manifest entry to replace a sent
reference. The image baseline is zero passes/two meaningful failures/seven
expectations. Later physical-file checks were not reached in that baseline;
no separate ordinary-file baseline failure is claimed. The final four-case
cold-module shard passes 22 expectations, retention passes 5/32 and the original
shard passes 22/85 in separate guarded processes. UUID uniqueness is
probabilistic and this repair does not recover previously overwritten metadata
or deleted bytes, or establish native restart/concurrent-write behavior.

Test-only commit `c19e4e1ea352d2e2079e64f135350f66e8782f09` uses the same async
canonical-path API as the service and checks full native-path equality with
`join(cwd, relPath)`. All 22 test names/order and all 62 static expectation sites
remain. Its guarded local shard passes 22/85; actual Windows validation awaits
CI32. The earlier source-authoring assertion error is retained separately and
is not a product regression or a test rerun.

Workflow commit `6359e8404faa0bfd3ebfbbd0b0b1e80884e313a9` adds the separate
four-case cold-module guarded command and its public log to both native upload
phases. Native early/final public patterns are now 104/179; Web 28 and independent
NSIS 59 remain. Existing required gates, budgets and failure handling remain.

Fresh combined source `1b546eef9e3346e0b1b3903df14b283a81530629` passes all
seventeen finite static commands: non-Desktop dependency build, fourteen
workspace commands/sixteen TypeScript configs, renderer and mobile bundles.
The verified static result has SHA-256
`d27277d854cf4cab682ffea843bc64b589cb5274a9e124d47b299af07786d188` at
`/private/tmp/codeshell-ci32-uuid-portable-static-root-20261018/verified-final-static-result.json`.
Existing bundle warnings remain Web 773.23 kB, mobile 741.23 kB and renderer
1,468.78 kB. At `6359e8404faa0bfd3ebfbbd0b0b1e80884e313a9`, a fresh combined
original attachment shard also passes 22/85 with both the UUID product repair
and portable fixture present. No full native Desktop build is inferred from
these local static commands. CI32 has not yet been pushed at this checkpoint.
CI31 remains failed and this record does not authorize or establish a release.


## CI32 — completed five-job results and attachment UI follow-up

[Run 39076696510](https://github.com/cjhyy/codeshell/actions/runs/39076696510),
push attempt one at `e2958ab5cbc4b0e459d896ac659d883d9ee48977`, completes with
four passing jobs and one failure. The preceding CI31 result and the CI32
not-yet-pushed checkpoint above remain historical records.

| Job | Actual result and boundary |
| --- | --- |
| Web, 117525207452 | Pass: service worker 11, authentication 4, child work 8 and annotations 8; 31 browser operations. |
| macOS, 117525207628 | Pass: original 83 operations/12 normal Mains; separate Review drafts 3/1; Goal 1 in the existing third Preferences Main; separate DMG UI 13+13/two Mains. |
| Linux, 117525207636 | Pass: original 83/12, separate drafts 3/1 and Goal 1 in an existing Preferences Main; actual AppImage runtime and ten owned update GETs pass. |
| Windows matrix, 117525207641 | Pass: original 83/12, separate drafts 3/1 and Goal 1 in an existing Preferences Main. Matrix NSIS completes all 16 phases, six normal native/controller roots and installed/replaced UI 13+13/two actual Mains, with installation/sibling absence, registry/shortcuts/default paths, cache and final OS-state gates passing. |
| Independent Windows NSIS, 117525207611 | Fail: ten phases and first installed UI 13/one normal Main complete; replacement exceeds the original 180,000 ms watchdog budget. Replacement and the remaining identity/UI/uninstall/cache/final-integrity phases are not accepted. |

The matrix's source and post-build receipt bind the configured 181-byte CRLF
`customUnInit` include, and its actual uninstall passes the original absence
predicate. This supplies full native uninstall acceptance for this source-bound
run. It is not a macro-execution trace or proof that the hook caused success,
and it does not resolve any independent or historical failure.

The independent job records watchdog failure, then SIGTERM request, exit
`1/null` and the later exit-code assertion. Exit one does not prove a crash
before cleanup. Its advisory role observer reports no fault; retained early
observations include two owned temporary old-uninstaller candidates, but path
roles do not identify loaded images, reached NSIS branches, dialogs or the
reason for the timeout. The remaining six phases are incomplete, not passing.

Frozen evidence for the five separate scopes:

- [Web freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39076696510-web-root-20261018/Root-Web-final-source-and-evidence-freeze.json).
- [macOS freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39076696510-mac-independent-20261018/final-evidence-freeze.json).
- [Linux freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39076696510-linux-panel-independent-20261018/final-independent-freeze.json).
- [Windows matrix freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39076696510-windows-matrix-independent-20261018/final-evidence-freeze.json).
- [Independent NSIS failed-scope freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39076696510-independent-windows-nsis-panel-peer-20261018/final-independent-freeze.json).

Finite pure counts remain separate: Goal 40/85 across three files, attachment
retention 5/32, original attachments 22/85 and cold-module attachments 4/22.
The product shard passes 445 tests across 32 files; expectations differ by
platform (macOS 3,550, Linux 3,547, Windows 3,541). Native matrix operation-
evidence contracts have 49 tests; these are not additional native operations.
Root separately [checks and views three Windows images](/private/tmp/codeshell-real-operation-cycles-20261016/ci32-Root-three-Windows-PNG-visual-review-20261018.json):
replaced narrow settings, Review draft scope and the wrapped generated-image
path. This is not a view or PNG-chunk check of all 49 Windows images, and the
Review screenshot alone does not establish session-isolation behavior.

### Attachment UI follow-up — finite local checkpoint

A later renderer-only candidate captures attachment ownership before async
work and rejects stale attachment results or errors after selection changes.
Its final formatted ownership shard passes 11 tests/158 expectations, and the
existing quick-chat lifecycle shard separately passes 8/18. Both have zero
failures/skips and run in distinct guarded Bun processes with inert bridge,
staging and media substitutes. Four-file ESLint passes with zero warnings.
These tests do not add native operations, browser decoding or real Main/provider
coverage to CI32, whose source predates the candidate.

The first Desktop typecheck then fails with 50 diagnostics; mobile typecheck
and renderer Vite build are not reached. Missing or stale workspace declaration
output is a source/input explanation to verify, not a proven explanation for
all errors or a typecheck pass. Declaration restoration and subsequent combined
validation remain pending at this checkpoint. The first failure and earlier
fixture-setup/authoring errors remain retained in the
[local first-stop record](/private/tmp/codeshell-attachment-async-owner-proof-20261018/final-validation-first-stop-observed-outcome.json).
A [source-only hosted-gate candidate](/private/tmp/codeshell-ui-attachment-owner-hosted-gate-source-20261018/source-plan-v2.json)
adds the two separate guarded commands and their two public logs to each native
upload list (early/final 106/181); existing budgets and predicates remain.
That proposal is not a pushed workflow or hosted validation. No new release
readiness claim follows from these local results.


### Subsequent private static checkpoint

The first fifty type diagnostics remain retained. At unchanged four-file source
`d64ef44078440162764a655695335061dd50d6d9`, six later authorized commands pass:
private-worktree Link/Core/coding JavaScript and declaration compilation,
Desktop and mobile no-emit checks, then the static renderer Vite bundle. The
[actual six-command result](/private/tmp/codeshell-attachment-async-owner-proof-20261018/standard-tsc-recovery-six-command-outcome.json)
binds their logs and unchanged source pins. Renderer `index` is 1,469.92 kB,
retaining the warning above the 1,000 kB threshold.

These are private-output static checks, without package clean/assets scripts,
emitted-code execution, full application runtime or native acceptance. The
renderer repair and hosted gates are locally combined at `00b0dc510da2ca0c85cacc82d35138167fa2d5a4`;
no follow-up acceptance push or native UI validation is claimed at this checkpoint.
CI32's completed failed result and all earlier checkpoints remain unchanged.

## CI33 preparation — composer ownership and Windows timeout diagnostics

The next renderer audit reproduces completed PDF paths, structured references
and a visible attachment error remaining in the other selected session. Its
first finite baseline has 12 passes/three meaningful failures/238 expectations.
The first repair run has 17 passes/two failures/340 expectations and stops before
the compatibility and static checks. One failure exposes a real pending-session
gap: a PDF drop materializes a sidebar session, but a subsequent image cannot
stage before the first send creates its Core Session. The other failure is an
incorrect test expectation that the pending configuration target is already a
persisted Session. Both first outcomes remain retained.

The final candidate stores paths, references and attachment errors with each
composer bucket. Returning to a session restores that session's unsent state.
Only an attachment prepare that itself created a pending session records a
renderer-memory project/root pin. Continuing that pending session requires the
same live, local, unarchived, unbound pending row, registered primary root and
available UI project fallback. Restored rows, revoked pending state, replaced
roots and resolved authority errors still reject. Existing persisted-session
authority and Main's staging path checks remain unchanged. This pin does not
establish a persisted Core Session, confirmed absence or filesystem identity.

The final formatted candidate passes 23 tests/437 expectations, the separate
quick-chat shard passes 8/18, five-file lint has zero warnings, both Desktop and
mobile no-emit checks pass, and the static renderer bundle passes. The renderer
index is 1,472.00 kB; the existing chunk warning remains. These are finite inert
renderer tests and private static compilation, without native UI acceptance.
The [Root-bound six-command result](/private/tmp/codeshell-composer-local-owner-proof-20261018/Root-v2-six-actual-result-binding.json)
binds the exact source, arguments and original output.

Windows diagnostic commit `d0823f3486a72deb5805e576d6f64c9406f386b7` adds a
single bounded primary-desktop capture only when the original replacement
observer reaches 170 seconds. The separate collector has its own process
custody and fixed output paths. It adds timing and query costs; the original
180-second Setup budget, arguments, first failure, 16 phases, six normal roots
and 26 UI checks remain. The image may include OS or other UI and does not
identify an owned window, reached installer branch or timeout cause. Missing or
invalid images remain unknown. A later production check without this collector
is still required.

The diagnostic's three finite Node files pass 51 tests. That run precedes one
reviewed test-only `let` to `const` correction; final four-file lint and diff
checks pass, without calling the final bytes a fresh 51-test run. No PowerShell,
desktop capture or NSIS operation was executed locally. The
[final source and checks](/private/tmp/codeshell-nsis-timeout-visual-diagnostic-proof-20261018/final-source-checks-summary-v5.json)
retain the first lint warning and all source-review corrections.

The combined hosted workflow adds separate ownership and quick-chat guarded
shards, the collector contract file, and two fixed diagnostic artifacts. Public
upload patterns are Web 28, native early/final 106/183 and independent NSIS 61.
No follow-up push or CI33 native result is claimed at this checkpoint. CI32
remains failed. Concurrent image capacity and repeated no-repo pending-session
attachments are separate source leads awaiting their own finite reproductions;
they are not covered by this repair or a release-readiness claim.

## CI33 — completed results and two attachment repairs

[Run 39082745570](https://github.com/cjhyy/codeshell/actions/runs/39082745570)
completed with three successful jobs and two failures at source
`8dfa3ef20cb9e860f4154180d4819a7d81c54915`. Web, macOS and Linux report success;
their evidence review is scoped separately. Both Windows jobs fail at
“Windows installer ownership and failure contracts”, before installation or
native UI acceptance. Each Windows artifact contains only the contract log.
The seven-file command reports 85 passing named cases plus a failed test module;
five crash-mode cases were never registered. These are not NSIS timeout results.

The crash test extracted its runner catch body by requiring `report.finished`
immediately after `finally`. The new diagnostic finalizer precedes that field,
so the source marker stopped matching. Commit
`be004047d881731251e527e87805390fe8848e57` uses the unique `finally` boundary
without changing the fifteen test bodies, five awaited modes or production
runner. Its exact finite file passes fifteen tests; explicit lint and diff
checks pass. The [source and actual result](/private/tmp/codeshell-nsis-crash-catch-boundary-proof-20261018/verified-single-test-source-and-results.json)
retain both original hosted failures. No Windows PowerShell, installer or
desktop capture ran locally. CI32's replacement timeout remains unknown; CI33
did not reach the new collector, and later validation without it remains due.

Web's independent review verifies the exact artifact digest, all 57 safe public
files and CRCs, source pins, 31 browser operations, six complete RPC payload
arrays and the separate finite test logs. Root viewed the narrow multiline and
explicit logout screenshots; it did not visually inspect all 33 PNGs. The
[final Web freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39082745570-web-root-20261018/Root-Web-final-source-and-evidence-freeze.json)
binds these observations. This does not validate the later two attachment fixes.

The next finite no-repository test reproduces a second pending-session gap:
dropping a PDF creates a sidebar session, but a subsequent image cannot stage.
Its baseline has two passes/one meaningful failure/145 expectations. Commit
`2026fdfae2039113da3399ed81a78a3a408d31c5` records an explicit no-repository
attachment pin only when that prepare created the pending row. Continuation
requires the same current Main-provided cwd, fresh live pending row and available
no-repository UI fallback; revoked, restored and resolved-invalid authority
controls still reject. It does not establish a persisted Core Session,
filesystem identity or confirmed absence. The original three cases plus three
negative controls pass six tests/267 expectations; two-file lint and Desktop
no-emit pass. The [commit and checked bytes](/private/tmp/codeshell-no-repo-pending-attachment-proof-20261018/final-two-path-commit-content-mapping.json)
bind the original failure and final checks.

Two concurrent image picks from an existing five-image main composer reproduce
seven images and no overflow message. Its baseline has two passes/one meaningful
failure/130 expectations; the serial and within-capacity controls pass. Commit
`462b2ebfd61a750c37adf2310386fd1df50f816d` limits the accepted results against
the latest owning draft inside one state update, committing attachment errors
there as well. Original images remain intact, a concurrent pair below the limit
keeps both results, and an invalidated session cannot receive the late result
or error. A mixed invalid-file control preserves its validation message along
with the overflow warning. The first five-case repair run has four passes/one
test-fixture failure because capacity validation precedes MIME validation for
the second file. Reordering the two fixture files makes that intended validation
path run; all original cases and assertions remain. The corrected five tests
pass with 230 expectations and zero skips; explicit three-file lint passes.
The [commit and complete retained outcomes](/private/tmp/codeshell-composer-image-capacity-proof-20261018/final-commit-source-proof.json)
separate the real baseline failure, fixture correction and final result.

The capacity repair applies to the main owning composer. Embedded QuickChat
fallback capacity is a separate source lead; current Pet chat has its own composer
and is not validated by that lead. Already issued staging calls are
not cancelled; excess results can leave unused staged files under the existing
retention policy. These finite inert renderer tests do not prove native UI,
provider delivery, filesystem authority or immediate staging cleanup. Combined
source checks and the next hosted run are still pending at this checkpoint.

## CI34 preparation — combined attachment checks and hosted follow-up

The combined non-document source is
`e57e6fcb0dc2cd4e75a45c82f9affde95556460a`. Four separate guarded renderer
shards pass 23/437, 8/18, 6/267 and 5/230 tests/expectations, each with zero
failures and skips. Explicit four-file lint, Desktop and mobile no-emit checks,
and the static renderer bundle all pass on that combined source. The renderer
index is 1,473.27 kB and retains the existing 1,000 kB chunk warning. The
[Root-bound eight-command result](/private/tmp/codeshell-real-operation-cycles-20261016/ci34-Root-combined-local-gate-20261018.json)
binds all arguments, raw output and unchanged source pins. These checks do not
launch the application, installer, browser or a provider.

CI33 macOS and Linux evidence review also completes. Each retains the original
83 operations/12 Main processes, separate Review drafts three/one and Goal
deletion one in the existing preferences Main. macOS additionally verifies the
two installed DMG UI runs of thirteen operations each; Linux verifies the
AppImage runtime's ten exact GETs, full permission modes and cleanup. The
[Mac result and two viewed frames](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39082745570-mac-independent-20261018/Root-seven-actual-results-and-two-visuals.json)
and [Linux result and two viewed frames](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39082745570-linux-panel-independent-20261018/Root-nine-actual-results-and-two-visuals.json)
bind the independent offline checks. PNG chunk CRC checks cover 49 Mac and 35
Linux images; Root actually views only two from each. These are separate facts.
Both also verify the CI33 ownership 23/437 and quick-chat 8/18 pure logs; the
later no-repository and capacity repairs were not in CI33. Reader preparation
and summary-writer metadata errors remain retained without rerunning acceptance
operations or weakening a predicate.

Workflow commit `9550714c61c8dd4cc925535903cc3c914e2d778f` adds only two exact
guarded shard commands and their four native early/final upload literals.
Public pattern counts become Web 28, native early/final 108/185 and independent
NSIS 61. Existing installation arguments, 180-second replacement budget, sixteen
phases, six normal roots and 26 UI checks remain unchanged. The fifteen-case
crash-contract correction and the new renderer tests still require hosted
execution on the combined source. No CI34 push or native result is claimed at
this preparation checkpoint; CI33 remains failed overall.

## CI34 — completed results and QuickChat image capacity

[CI34 run 39084864336](https://github.com/cjhyy/codeshell/actions/runs/39084864336)
executes immutable source `282c6869c070c2919c6e58baa7b386161a24b35e`, attempt one,
and finishes **failed**, with three passing jobs and two Windows failures.
The [terminal API snapshot](/private/tmp/codeshell-real-operation-cycles-20261016/ci34-progress4-run-api-20261018.json)
records the completed status; it does not replace the earlier in-progress snapshots.

Web passes its 31 browser operations and separate finite log/RPC checks. Root
views two of the 33 PNGs. macOS and Linux pass the original 83 operations/12 Mains,
separate Review drafts three/one and Goal deletion one in an existing preferences
Main. macOS also passes the installed/reinstalled DMG thirteen operations each;
Linux passes the AppImage custody, source/cache permission and ten-GET checks.
Root views two frames each for macOS and Linux. The [Web final binding](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39084864336-web-independent-20261018/Root-Web-final-results-and-two-visuals.json)
and [Mac/Linux final reference verification](/private/tmp/codeshell-real-operation-cycles-20261016/Root-ci34-Mac-Linux-final-freeze-reference-verification.json)
bind the exact raw sources, reader outputs and selected views. PNG CRC checks
cover integrity; they do not mean every frame was visually reviewed. The new
no-repository six/267 and main-composer quantity five/230 logs pass as separate
pure tests, not additional native operations or the later QuickChat repair.

Windows matrix Panel launch first fails at `harness-main-identity` with
`electronApplication.evaluate: Resulting promise was garbage collected.` There
are no completed Panel cases. Four recorded cleanup signal requests precede the
later observed Main exit `1/null`; this is not proof of an earlier Main crash.
Network-service and GPU warnings in stderr do not establish their causal order
relative to the first evaluation error. The [independent source/raw assessment](/private/tmp/codeshell-real-operation-cycles-20261016/ci34-Windows-matrix-first-failure-20261018/independent-panel-launch-gc-source-and-facts-peer.json)
retains this uncertainty. No retry, weaker identity assertion or normal-exit
exception is introduced. This Windows failure cannot inherit the complete 83/12
scope from passing platforms.

Independent Windows NSIS completes ten phases through `replacement-marker`,
three normal controllers (build, install, first UI), and the first thirteen
installed UI operations. Replacement reaches its unchanged 180,000 ms budget,
then requests termination of Setup PID 8184 and observes exit `1/null`.
The subsequent `1 !== 0` assertion is later than that timeout. Replacement,
replacement identity/UI, uninstall, cache cleanup and final integrity do not
complete. The original sixteen phases, six required normal controllers and 26
installed UI operations remain required. The two admitted offline readers pass
116 and 88 metadata conditions while retaining native acceptance **failed**;
the separate pure logs pass 90, 16 and 33 tests. Conditions and pure tests are
not additional native operations.

The diagnostic collector reaches its native trigger on this run. It is separate
from the six Setup/UI controllers: one capture operation, two observed owned
incarnations, no recorded capture signal requests, and a 1024×768 public PNG.
Root [actually views this one frame](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39084864336-independent-windows-nsis-panel-peer-20261018/Root-primary-desktop-actual-one-view.json):
a visible code-shell Setup dialog says “Failed to install old application files.
Please try running the installer again: 2.” This establishes the displayed
warning, not window/process ownership, a blocking wait site or its underlying
cause. Capture and independent custody queries consume resources; later native
validation without this collector remains due. No local installer, PowerShell,
Electron, browser or OS process query runs for these checks.

QuickChat's separate image-capacity reproduction now confirms the earlier source
lead. With five images already present, two competing picks originally retain
seven images without an overflow warning. The baseline has two passes, one
meaningful failure and 142 expectations; serial-limit and within-capacity
controls pass. Commit `66a12b7f9d56ebfaf2cd198b3bf882b9f26afd40` stores images and
attachment errors under the live bucket/session/creation nonce, commits against
the latest image array, and invalidates old completion on explicit clear/send,
including a send while the image array is still empty. Removing an image frees
capacity for pending results; closed/restarted owners reject late results and
errors. The real owner hook and actual QuickChatPanel/ChatView pass six finite
cases/241 expectations before formatting. The fake parent lifecycle is not an
actual Main/App session or provider-delivery proof. Already issued staging calls
are not cancelled; unused staged files retain their existing cleanup policy.

One format pass leaves all six production AST structures equal. The test's JSX
whitespace changes produce an original AST mismatch; a separate TypeScript raw
output comparison also differs on printer-retained commas/newlines. Both first
results remain retained. Neither is called a product failure or a successful
seven-file equivalence check. Root reads the complete formatting diff and
requires actual checks on the final formatted, combined source.

Workflow commit `cd4efdcc14c1ca4cc44f2e746c9502d6eea0192c` adds one exact guarded
QuickChat shard command and two log upload literals. Public profiles become Web
28, native early/final 109/186 and independent NSIS 61. Existing native commands,
installation arguments, identity/exit/custody checks and budgets are unchanged.
The combined non-document source is `2cc1270ffe2be21af96ea530a87d4fb8a063e9c1`.
All eleven final combined commands run once and pass: seven independent guarded
Bun groups have 47/238, 3/7, 23/437, 8/18, 6/267, 5/230 and the formatted
QuickChat six/241 tests/expectations, each complete with zero failures and skips.
Explicit nine-file lint, Desktop/mobile no-emit and the static renderer bundle
also pass. One nonfatal React `act` warning in the App integration fixture and
the existing Vite chunk-size warning remain visible; neither is suppressed or
called zero warnings. The [Root final combined result](/private/tmp/codeshell-quick-chat-combined-validation-preread-20261018/Root-eleven-final-combined-gate.json)
binds actual arguments/results, complete streams, seven observed test counts
and unchanged source pins. These are renderer/static checks, not native Main,
browser, installer or provider execution. This preparation checkpoint does not
claim a CI35 push or native pass; Windows release acceptance remains incomplete.

## CI35 preparation — controlled NSIS temporary path

Commit `c38c60232b5bb755c8ab5e4625911e62bb98a4d2` shortens only the owned
acceptance TEMP/TMP/TMPDIR mapping from `root/private-build/tmp` to `root/tmp`.
The driver and the three strict consumers use the same exact new mapping. HOME
and application state remain under `private-build/home`; aliases, foreign paths
and the previous deep TEMP cannot acquire the new metadata/collector authority.
Invalid role hints retain the original custody query and produce unknown advisory
roles; rejected crash metadata uses no query, and rejected desktop collection
starts no collector. Its fake metadata persistence still records unknown.

This is a controlled acceptance input change. The actual longest installed
relative path is 161 characters; the first installation's full path is 230.
Source arithmetic places a backup path at `250 + plugin-directory-leaf-length`
characters with the old TEMP, and `236 + leaf-length` with the new one. The
actual plugin directory and failing file operation were not captured. A legacy
path-length limit is a hypothesis, not the established cause of the warning or
a production long-path repair. The [source facts and bounded arithmetic](/private/tmp/codeshell-nsis-error2-path-source-investigation-20261018/verified-source-facts-and-path-budget.json)
retain that distinction. Production NSIS configuration, hook, install/uninstall
arguments, source-key/public profiles, watchdog identity/custody, 180-second
budget and original sixteen phases/six normal controllers/26 UI gates do not change.

The first exact four-file isolated Node run passes 66 tests, with no failures,
skips or cancellations. A subsequent format check finds layout issues in the
role fixture; after formatting that file, lint finds an existing unqualified
`structuredClone` global. The fixture qualifies it as `globalThis.structuredClone`.
Final one-file format check, seven-file lint and the isolated role file's
seventeen tests pass. The initial format/lint failures remain retained; the
whole 66-case invocation is not repeated at the final formatted commit.
The [Root source and actual-result binding](/private/tmp/codeshell-nsis-bounded-temporary-path-proof-20261018/Root-final-native-pure-and-commit-verification.json)
checks that the other six edited sources remain unchanged from the 66-case run.
These are pure fake-transport/metadata contracts, not native installer execution.

The [aggregate local gate](/private/tmp/codeshell-real-operation-cycles-20261016/ci35-Root-combined-local-gate-20261018.json)
binds the actual eleven renderer/static commands at `2cc1270` to identical input
blobs in `c38c602`, and separately binds the finite NSIS checks and final role
fixture. It does not claim all commands rerun at the aggregate source head.
This preparation checkpoint claims no CI35 push or hosted result. Windows Main
identity and replacement acceptance remain pending; diagnostic timing and the
later validation without the collector remain separate requirements.

## CI35 — completed results and Windows initial-install failure

[CI35 run 39088411780](https://github.com/cjhyy/codeshell/actions/runs/39088411780)
executes immutable source `f47c9e035ef698175896ddbac80eb6d01de6a16a`, attempt one,
event `push`. The [terminal run snapshot](/private/tmp/codeshell-real-operation-cycles-20261016/ci35-progress8-run-api-20261018.json)
and [five-job snapshot](/private/tmp/codeshell-real-operation-cycles-20261016/ci35-progress8-jobs-api-20261018.json)
record **four successful jobs and one failed Windows matrix job**, with overall
conclusion **failure**. The scopes below remain separate; pure tests, offline
metadata conditions and PNG integrity checks do not add native operations.

Web passes 31 browser operations. Six independently retained, settled full Host
RPC arrays match their complete intended payloads and single-call counts. PNG
chunk CRC checks cover 33 frames; Root actually views two selected frames.
The [Web result and two-view binding](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39088411780-web-independent-20261018/Root-Web-final-results-and-two-visuals.json)
retains that distinction rather than claiming all frames were visually reviewed.

Linux passes all nine admitted offline reader stages. Its source-bound native
scope is the original 83 operations/12 Mains, separate Review drafts three/one,
Goal deletion one within the existing preferences Main, and AppImage custody,
source/cache permissions and ten exact GETs with no asset download. Recorded
process evidence has 22 map copies/231 parent edges and no chronology conflict;
35 PNG containers pass chunk CRC checks. Root actually views two frames.
The [Linux result and visual limits](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39088411780-linux-panel-independent-20261018/Root-Linux-final-results-and-two-visuals.json)
retain faint scope-menu text over the Review file headers. The screenshot
producer does not wait for menu closure/exit-animation completion, so this frame
does not establish a stable, overlap-free layout. A closing-animation frame is
consistent with source, but the actual frame timing and cause are not proved.

macOS retains the first offline reader's failure: its extra assumption that the
startup cleanup-signal array must be empty rejects one recorded owned-descendant
request. A new source-aligned strict successor and the other six readers then
all pass, with original normal-Main, complete recorded ancestry, truncation,
custody and HOME predicates retained. The Main's recorded normal exit precedes
that descendant SIGTERM request; the record does not prove signal delivery or
normal exit of every descendant. The accepted scope is the original 83/12,
separate drafts three/one, Goal deletion in the existing preferences Main and
installed/reinstalled DMG thirteen operations each. There are 27 map copies/293
parent edges with no chronology conflict and 49 PNG chunk CRC checks; Root
actually views two frames. The [Mac final result and retained first failure](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39088411780-mac-independent-20261018/Root-Mac-final-results-and-two-visuals.json)
binds both the original error and the seven actual successor results.

Independent Windows NSIS passes all sixteen phases, six normal original
controllers and 26 installed/replaced UI operations (thirteen each). The strict
absence, sibling-preservation, registry/cache, final OS-state, full-birth custody,
source and HOME checks pass in this fixture's scope. The three offline readers
pass 172, 73 and eight metadata conditions respectively; these are not operation
counts. The desktop collector reports not-triggered, with no collector process
or PNG. This is not a claim that instrumentation generally has no timing cost.
Root actually views two installed/replaced UI frames. The [independent NSIS result](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39088411780-independent-windows-nsis-panel-peer-20261018/Root-final-NSIS-results-and-two-visuals.json)
binds the strict results and two views. It does not grant the separate Windows
matrix an installer or native-suite pass.

The Windows matrix fails at its initial NSIS `install`, after only the first six
phases through `payload-identity`. Its final ZIP is 2,787,274 bytes, SHA-256
`5722b03910741ffbec03dad55fd4ab9d8ab0f952adc82564f218caea645c82d4`.
Strict preflight accepts 157 regular members against the exact 186 public
patterns, with every ZIP member CRC checked; pattern count is not file count.
The [fixed ZIP and selected-data provenance](/private/tmp/codeshell-real-operation-cycles-20261016/ci35-Windows-initial-install-first-failure-20261018/selected-failure-data-and-preflight.json)
and [original job log](/private/tmp/codeshell-real-operation-cycles-20261016/ci35-Root-Windows-first-error-joblog-20261018-stdout.log)
retain the first failure before any failure-specific interpretation.

Setup PID 3000 has recorded parent 2252 and full birth
`2026-10-18T02:14:48.6347170Z`. Journal sequence 19 records its abnormal
`3221225477/null` exit before sequence 20's process-first-error and subsequent
cleanup; no termination request is recorded. Custody settles its one owned
incarnation to zero remaining, without a query failure or truncation. The
recorded stdout/stderr are empty. This is an initial-install failure, not the
earlier 180-second replacement timeout or identity-evaluation GC failure.
Installed UI, replacement, uninstall, cache cleanup and final OS-state validation
are not reached; process settlement alone does not establish OS restoration.

The existing bounded crash query actually runs and returns `unknown` with reason
`no-exact-application-event`. No matched fault module, offset or report ID is
available. The hexadecimal exit-code conversion is not an independently matched
exception diagnosis; an empty filtered projection does not prove that Windows
logged no event anywhere. The [independent source/data assessment](/private/tmp/codeshell-real-operation-cycles-20261016/ci35-Windows-initial-install-first-failure-20261018/independent-install-failure-source-and-data-facts.json)
binds the five selected raw records, journal order and immutable producers.

The two Windows jobs share the reported source/toolchain pins and controlled
HOME/TEMP/argument formulas, but their independently built Setup, ASAR and app
executable hashes differ. They are not a same-binary A/B comparison. Neither
independent success nor this crash proves a cause or repair associated with the
shorter TEMP. Root has accepted a minimal bounded count/provenance diagnostic
implementation plan; it remains a source proposal, with no new actual event query
or native validation at this checkpoint. No debugger, dump, retry, weaker
predicate or changed budget is introduced.

Review fixture follow-up `3149e8e78b9adedf0438fce20c8ee901f1d41336` changes exactly
two files. Its finite Node run passes thirteen tests with no failures, skips or
cancellations; explicit two-file lint and driver syntax checking also pass.
The [source follow-up proof](/private/tmp/codeshell-review-scope-menu-settled-proof-20261018/verified-source-summary.json)
has SHA-256 `0b98a35540ff4ec5153e7509c80acf0e3ca5405c6977dfdd834a216b40278826`.
It adds a capture barrier without claiming a product overlap cause. Actual
hosted menu-capture/native validation remains pending; no CI36 result is claimed.

CI35 remains failed and release is not recommended. Only the authorized dedicated
acceptance branch was pushed; no remote-main, tag, release or publication action
is claimed. All earlier failure records and preparation checkpoints above keep
their original time-bound statements.

## CI36 preparation — crash-query accounting and Review capture

Source checkpoint `541d59b601e4ecfb9e00f06b2660a495434d1a7e` combines the
previously recorded two-file Review capture barrier with four-file diagnostic
commit `609647a66422acdd1d4cb3087e7e3734b33c2ad6`. This is preparation only;
no CI36 push, run or native result is claimed at this checkpoint.

The existing bounded PowerShell query transport now emits schema-two accounting:
provider/rejection counts and the exact query window/start/finish times. The
helper checks their fixed shape, caps, arithmetic and time bounds. Exact
PID/full-birth/path matching stays mandatory; a same-microsecond birth mismatch
remains rejected. Seven-digit formatting does not restore the 100 ns precision
that CIM's microsecond representation may lack. No additional query, process,
retry, delay, event-content exposure or installer-budget change is introduced.
Explicit schema-one compatibility remains for historical records; the current
PowerShell producer emits schema two. These diagnostics do not repair or
establish the cause of the CI35 initial-install failure.

The [fixed diagnostic source and actual-check proof](/private/tmp/codeshell-nsis-crash-query-accounting-proof-20261018/verified-source-summary.json)
binds all four committed files. Its exact two-file isolated Node run passes
41 cases (33 original plus eight new), with no failures, skips or cancellations;
three-file lint and diff checking also pass. The original case bodies remain
preserved. The [actual result sequence](/private/tmp/codeshell-nsis-crash-query-accounting-proof-20261018/tests-and-lint-once/sequence-result.json)
is separate from the Review barrier's thirteen tests. These are injected pure
contracts, not actual PowerShell/EventLog or native installer execution.
The original identity, normal-exit, custody, HOME, OS/cache and sixteen-phase /
six-controller / 26-UI gates remain required. Hosted validation of both follow-ups
is pending; the completed CI35 failure and unknown cause above remain unchanged.

## CI36 — completed results and independent uninstall identity failure

[Run 39091671102](https://github.com/cjhyy/codeshell/actions/runs/39091671102)
executes source `ee4b4aa8080a515c793821d73ccc2e201bdc4036`, attempt one, from the
authorized acceptance branch. It finishes **failed**, with four successful jobs
and one independent Windows NSIS failure. The workflow retains the native final
186-pattern, independent installer 61-pattern and Web 28-pattern profiles.

| Scope | Actual audited result |
| --- | --- |
| Web | Passed: 31 operations, six complete RPC arrays and 33 PNG containers. Root viewed the 390px multiline comment and explicit logout/relogin frames. |
| Linux | Passed: original 83 operations/12 Mains, separate drafts 3/1, Goal deletion in an existing Main, and AppImage startup/update checks. Nine offline readers pass once; 35 PNG containers and 22 recorded map copies/201 parent edges have no chronology contradiction. |
| macOS arm64 | Passed: original 83/12, separate drafts 3/1, Goal deletion and DMG installed/reinstalled UI 13+13. Seven offline readers pass once; 49 PNG containers and 27 recorded map copies/304 parent edges have no chronology contradiction. |
| Windows matrix | Passed: original 83/12, separate drafts 3/1 and Goal deletion. Required updater error disclosure, Composer durable diagnostics and nine separate pure groups pass. NSIS separately completes all 16 phases, six normal controller roots and 26 installed UI operations, including uninstall absence/cache/final OS checks. |
| Independent Windows NSIS | Failed at uninstall identity establishment after 13 completed phases and two normal installed UI runs of 13 operations each. Uninstall, cache cleanup and final integrity remain unaccepted. |

Each reader runs only once after its source and actual immutable inputs are
reviewed. Native results come from hosted jobs; local ZIP/JSON/source readers and
PNG checks are separate. Original 83/12, drafts 3/1, Goal deletion, installer UI
and pure regressions are not added together as a single native operation count.
Windows original-suite recorded Main exits are all `0/null`; its complete
uploaded map traversal has 28 map copies/429 parent edges and no contradiction.

The independent failure is exactly `Cannot establish Electron test child PID,
parent PID and birth identity`. Uninstaller PID 7624/reported parent 3248 has no
recorded birth or settlement. Its result and cached exit code are null when failure
is recorded; the later exit observation is `0/null`. Journal events 45–47 retain
the process/outer first error before event 48 records that exit. A later zero
exit cannot replace the missing identity or prove successful uninstall cleanup.
The five preceding controllers are normal and cleaned; both installed Mains
3892 and 5348 exit normally with their private HOMEs removed.

Source review identifies a possible observation race: the runner starts its
child before the watchdog's synchronous CIM query establishes the initial full
tuple. Windows completion can precede delivery of the JavaScript exit callback.
The actual initial rows were not uploaded, so missing PID, mismatched parent,
missing birth and the precise OS exit time cannot be distinguished in this run.
This is a source-supported possibility, not an established cause or repair.
No retry, zero-exit exception, weaker custody predicate or longer installer
budget is accepted. A held native launch adapter remains an unimplemented design.

The matrix role reader retains its independent-job pure-log expectation of 33;
its resulting `incomplete-or-failed` label is preserved. The matrix workflow
actually invokes four explicit files and reports **49/49**, zero failures,
skips or cancellations. The separate additive reader strictly checks 49, and
the [scope correction](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39091671102-windows-matrix-independent-20261018/nsis-metadata/operation-evidence-scope-count-correction.json)
records both vectors without changing or rerunning the original reader.
The independent two-file group remains 33. Both Windows NSIS pure groups report
98/98; these tests do not establish native installer success.

Root's selected Linux Review frame shows the menu closed without the earlier
faint text residue. Its 390px dark Settings frame is readable without horizontal
clipping. Root also views macOS DMG Settings/Review draft and both independent
Windows installed/replaced 390px Settings frames. The matrix installer frames
are byte-identical to those two already-viewed images; visual reuse is recorded
without counting additional pixel views. These selected images do not imply
that every screenshot or OS window was inspected.

Root additionally views the Windows generated-image tool card: the full path
including spaces wraps, and its thumbnail/file card and controls are readable.
The standalone 390px Settings frame is byte-identical to an already-viewed
installer frame, so its visual observation is reused without another pixel view.

Fixed evidence summaries are retained for
[Web](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39091671102-web-independent-20261018/verified-summary.json),
[Linux](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39091671102-linux-panel-independent-20261018/verified-summary.json),
[macOS](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39091671102-mac-independent-20261018/panel-verified-summary.json),
[Windows original UI](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39091671102-windows-matrix-independent-20261018/original-ui/original-native-summary.json),
[matrix installer](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39091671102-windows-matrix-independent-20261018/nsis-metadata/verified-summary.json)
and the [independent failure](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39091671102-independent-windows-nsis-panel-peer-20261018/verified-failed-summary.json).
Their freezes bind raw inputs, exact reader sources and full first execution
outputs. Preparation/reader metadata errors remain separately retained.

CI36 is not release-ready. Its matrix success does not explain CI35's earlier
initial-install exit or prior GC/replacement failures. No remote-main push, tag,
release, signing or publication is performed by this acceptance run.

## CI37 — bounded initial-identity diagnostics prepared

Source commit `42c9a56a1e825b865294b55a3c3b8fe65ce37e7c` changes exactly four
files. The watchdog can retain a small diagnostic projection when its existing
initial snapshot cannot establish the child PID/parent/birth tuple. It records
the total row count and at most four matching-target rows, with bounded parent
and timestamp fields. It omits foreign process identities, paths, arguments and
environment values. This is the same already-returned snapshot; no second query,
retry, delay or new authority is introduced. The installer runner stores that
projection separately from its failed operation. The workflow adds the new
explicit test file to its two existing Windows NSIS pure-test vectors.

The original identity error, cleanup behavior and 180-second installer budget
remain unchanged. Observer exceptions cannot replace that error. A late zero
exit still cannot establish birth, settlement or successful uninstall. The
initial snapshot's missing-identity cause remains unknown; this is additional
diagnostic coverage, not a demonstrated race repair.

Root executes the exact eight-file vector once through the isolated Node runner:
**108/108**, zero failures, skips, cancellations or todos. These are the original
98 tests plus ten new tests, not 108 native operations. The vector includes
bounded owned temporary filesystem work, controlled source-fragment evaluation
and one actual Node CLI child that verifies non-hosted refusal. That child never
starts an installer or application. ESLint checks the three JavaScript files
with zero warnings; `git diff --check` passes. Formatting preserves the three
syntax trees, and the four committed files equal the tested source bytes.

The [Root local gate](/private/tmp/codeshell-real-operation-cycles-20261016/ci37-Root-combined-local-gate-20261018.json)
binds combined source `5f6ed25bc09bf8755e3a1305d39f684413ef3de1`, all 21 current
source pins, the original 19-pin CI36 checkpoint and 17 unchanged prior pins.
The old watchdog hash remains a separate historical value. Prior renderer,
typecheck and build results retain their original source/time boundaries; those
commands were not all repeated at this head. The [single actual local sequence](/private/tmp/codeshell-nsis-initial-identity-observation-proof-20261018/Root-tests-and-lint-once/sequence-result.json)
retains full outputs and unchanged-source verification.

CI37 has no hosted result at this preparation checkpoint. Native identity,
normal exit, custody, HOME, all 16 installer phases/six controllers/26 installed
UI operations, uninstall absence, cache and final OS predicates remain required.
CI36 and earlier failures retain their failed and unexplained status. Only the
already-authorized acceptance-branch push and hosted CI are prepared; no remote
main, tag, release, signing or publication is included.

## CI37 — completed results and independent initial-install failure

[Run 39095013874](https://github.com/cjhyy/codeshell/actions/runs/39095013874)
executes source `29c677f1e672b67763c65fbc5b26c683ea6e4ddb`, attempt 1, from a
normal acceptance-branch push. The final API records **four successful jobs and
one failed job**; overall status is **FAILED**. These results bind this source,
not a later local candidate. The CI37 preparation checkpoint above remains a
historical statement of what had been verified before this run.

| Scope | Audited result |
| --- | --- |
| Web | 31 browser behaviors and six complete payload-checked RPC arrays pass. |
| macOS | Seven offline readers pass once: original 83 operations/12 Mains, separate Review drafts 3/1, required Goal deletion in an existing Preferences Main, and DMG installed/reinstalled UI 13+13/two Mains. The artifact has 27 uploaded map copies/247 parent edges and 49 PNG container CRC checks. |
| Linux | Nine offline readers pass once: original 83/12, separate drafts 3/1, required Goal and AppImage checks. Actual AppImage Main and launcher remain separate normal processes; ten GETs/zero asset downloads and source/cache integrity pass. There are 22 map copies/248 edges and 35 PNG container CRC checks. |
| Windows matrix | Five UI readers pass once: original 83/12, separate drafts 3/1 and required Goal in an existing Preferences Main. The separate strict NSIS audit passes all 16 phases, six normal controller roots and 26 installed UI operations, including uninstall absence/cache/final OS predicates. |
| Independent Windows NSIS | Initial installation fails after six completed phases, before installed identity or UI. No installed UI operation is accepted; replacement, uninstall, cache and final OS restoration are not reached. |

Independent Setup exits `3221225477/null` before the first process error and
cleanup. The original failure is retained. Its exact PID/parent/full-birth record
does not establish why it exits. The bounded Application query reports zero
provider rows only in its fixed narrow window; WER is not queried and no exact
fault module is identified. This is not whole-system event absence. The new
initial-snapshot-miss observer is not runtime recorded on these process records;
its pure tests do not demonstrate that diagnostic branch or resolve the missing identity.
The separate matrix installer success cannot supply this failed job's evidence.

Pure checks remain separate from native operations. Mac Bun aggregation is
445 tests/3550 expectations/32 files; Linux is 445/3547/32. Required disclosure,
Composer durable diagnostics and the nine attachment/Goal pure groups retain
separate results. Matrix Windows NSIS contracts are 108 and operation-evidence
contracts are 49; its standalone passive-startup-goal log is **not uploaded**,
which does not establish zero execution. Independent NSIS separately records
108/16/33. These values are not additional native operations or a repeated full
local type/build result at this source.

Root performs **six current pixel-view calls**: two Mac frames, one Linux Review
frame, two Windows original-UI frames and one matrix installed-UI frame. Four
observations are reused only after exact ZIP/copy byte identity: two Web frames
and Linux Settings match previously viewed CI36 frames; matrix replaced UI
matches this run's already viewed installed frame. Current Review
menus are closed and readable in the selected frames. This covers selected
images only, not every PNG, every pixel or the complete interface. Reused images
are not new view calls or new native actions.

Evidence is retained in the [Web summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-web-independent-20261018/verified-summary.json)
and [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-web-independent-20261018/final-evidence-freeze.json),
[Mac summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-mac-independent-20261018/verified-summary.json)
and [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-mac-independent-20261018/final-evidence-freeze.json),
[Linux summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-linux-panel-independent-20261018/verified-summary.json)
and [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-linux-panel-independent-20261018/final-evidence-freeze.json),
[Windows UI summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-windows-matrix-independent-20261018/original-ui/verified-UI-summary.json)
and [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-windows-matrix-independent-20261018/original-ui/final-UI-evidence-freeze.json),
[matrix NSIS summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-windows-matrix-independent-20261018/nsis-metadata/verified-summary.json)
and [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-windows-matrix-independent-20261018/nsis-metadata/final-evidence-freeze.json),
and the [independent NSIS failed summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-independent-windows-nsis-panel-peer-20261018/verified-failed-summary.json)
and [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39095013874-independent-windows-nsis-panel-peer-20261018/final-evidence-freeze.json).
The six freezes bind exact raw inputs, reviewed reader sources and first
execution outputs; Root view receipts retain the selected-image bindings.

The underlying installation cause remains unknown. A separate upstream-source
backport candidate is being prepared; no tested or hosted repair is established
by this record. No remote main, tag, release, signing or publication is performed,
and this overall failed result does not support shipping.

## CI38 — bounded per-user installer folder copy prepared

Source commit `a3403f1ac0d2c4d6a29eec88bde9822df94c0454` backports the
[upstream bounded folder-copy repair](https://github.com/electron-userland/electron-builder/commit/a356198ec7c54c7795659342bff36d9a5162cd93)
to the locked app-builder-lib 25.1.8 template. The previous fixed-width read could
read beyond a short Shell-allocated path. A fixed secondary include replaces
that block before both installer and uninstaller setter expansion. It preserves
the existing HKCU installation path, LocalAppData fallback, original `/D`
override and complete uninstall initialization. Dependencies and production
installation options are unchanged. The runner records and rechecks both
project includes and the three relevant vendor-template hashes around build.
Independent source review finds no actionable issue in this scope.

The exact nine-file isolated Node vector passes **115/115**, with zero failures,
skips, cancellations or todos. Seven new source-contract/dataflow callbacks
cover bounded Unicode copying, failure cleanup, register/stack balance and path
precedence. They do not run NSIS or prove its ABI. The original eight files
retain their bounded owned-filesystem work, controlled source fragments,
intentional deny probes and real Node CLI refusal child. ESLint checks two files
with zero warnings; the staged diff check covers all five changed paths.

Root merges the tested source normally as
`0a0c5e11ed9a1d40668134896087b66b713b7d54`; all five merged blobs equal the
tested files. The [local gate](/private/tmp/codeshell-real-operation-cycles-20261016/ci38-Root-combined-local-gate-20261018.json)
binds 24 current pins, the CI37 21-pin checkpoint and 19 unchanged prior pins.
The historical watchdog pin remains bound to its original ee4 source. Earlier
renderer, typecheck and build results keep their original source/time bounds.
[Actual local results](/private/tmp/codeshell-nsis-safe-copy-implementation-proof-20261018/actual115-lint2-and-source-final-summary.json)
retain complete first outputs and unchanged-source checks. Formatting changes
two test property-name spellings and one callback parenthesis; their exact
syntax changes are explicit in the final strict comparison. Its first failed
expectation is retained, and source was not changed to satisfy that comparison.

Hosted execution is pending at this checkpoint. Both fresh Windows jobs still
require all 16 phases, six normal controller roots, two installed Mains and 26 UI
operations, plus exact source/custody/HOME/uninstall/cache/final OS checks. This
source-confirmed defect correction does not identify CI37's crash cause or
retroactively repair that failed run. The acceptance branch is the only
authorized remote target; no remote main, tag, release, signing or publication
is included.

## CI38 — completed results and two Windows failures

[Run 39099055462](https://github.com/cjhyy/codeshell/actions/runs/39099055462),
push attempt 1, executes source
`32b6d877933e650c72eb3f304bbb627b9abc4490`. The terminal API records three
successful jobs and two failures. The preceding CI38 preparation checkpoint
remains a historical statement; this section records the completed run.

| Job | Actual accepted or incomplete scope | Frozen evidence |
| --- | --- | --- |
| Web `117591376438` — success | 31 browser checks (11 + 4 + 8 + 8), six complete settled RPC arrays, 33 PNG chunk-CRC checks. Two controls and six expected negative UI cases remain separate. | [Summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-web-independent-20261018/verified-summary.json) `1fd4e9cd04bb…`; [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-web-independent-20261018/final-evidence-freeze.json) `98bdcfb9346a…`. |
| macOS `117591376422` — success | Seven offline readers exit 0: original 83 operations / 12 Mains; draft 3 / 1 and required Goal 1 on the original Preferences Main separately. DMG installed and reinstalled UI each pass 13 operations across two Mains. 27 map copies / 307 parent edges, no recorded chronology violations; 49 PNG CRC checks. | [Summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-mac-independent-20261018/verified-summary.json) `2c3df9ee889d…`; [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-mac-independent-20261018/final-evidence-freeze.json) `68180226a2fc…`. |
| Linux `117591376474` — success | Nine offline readers exit 0: original 83 / 12; draft 3 / 1 and required Goal 1 separately. AppImage Main and runtime launcher exit normally; ten feed GETs, zero asset downloads, source/cache integrity gates pass. 22 map copies / 223 parent edges, no recorded chronology violations; 35 PNG CRC checks. | [Summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-linux-panel-independent-20261018/verified-summary.json) `4a33540a9baa…`; [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-linux-panel-independent-20261018/final-evidence-freeze.json) `cc501a671ac0…`. |
| Windows matrix `117591376329` — failure | Startup receipt reports seven operations / three normal Mains. Review completes zero operations; later draft, Panels, Composer, Memory, Preferences, packaged UI, updater and NSIS steps are skipped. This does not supply the full original 83 / 12 or any matrix NSIS acceptance. | [First-error facts](/private/tmp/codeshell-ci38-review-first-error-source-map-20261018/actual-matrix-review-first-error-facts.json) `7eb41fa1df0d…`. |
| Independent Windows NSIS `117591376428` — failure | Four phases complete: preflight, baseline, stage-copy and toolchain. NSIS compilation fails; one build controller is recorded, zero normal installer roots and zero installed UI operations. The required 16 phases / six normal controllers / 26 UI operations are unmet. | [Failed summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-independent-windows-nsis-panel-peer-20261018/verified-failed-NSIS-summary.json) `b7c359530b9f…`; [freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-independent-windows-nsis-panel-peer-20261018/final-independent-NSIS-evidence-freeze.json) `d6cc94f084d1…`. |

The passing macOS/Linux scope retains its original normal-Main, full recorded
birth/custody, HOME, integrity and updater predicates. Both required 401 error
disclosures and Composer durable evidence pass. These observed owned-process
checks do not prove every OS process or every external service. The hosted pure
logs remain separate from native operations: macOS aggregates 445 / 3550 / 32
and Linux 445 / 3547 / 32. Independent Windows pure contracts pass 115 NSIS,
16 passive-startup/Goal and 33 operation-evidence cases despite its native build
failure; those counts do not establish an installer launch.

The matrix first error is the first `verifyElectronMainIdentity` evaluation for
Main PID 2076, before launch returns. Its cached child state has not observed an
exit. Cleanup and four recorded SIGTERM requests follow; Main exit 1 / null is
observed afterward. The original error remains primary, the later normal-exit
assertion also fails, the finite observed owned set cleans from 34 to zero, and
HOME remains retained. This sequence does not identify an earlier crash, SDK
cause, delivered signal or kernel ordering. No Review menu is reached, so CI38
does not exercise the menu-capture barrier.

Independent NSIS compiler output reports
`Abort not valid outside Section or Function` in `PAGE_INSTALL_MODE`, macro line
18, included from `assistedInstaller.nsh:75` in the `BUILD_UNINSTALLER` branch.
The outer failure is the subsequent exit-1 assertion. Both include hashes match
this run's source, but build failure prevents native validation of the bounded
copy hook, installation, replacement, uninstall, cache cleanup and final OS
restoration. The desktop collector is not triggered. Earlier `0xC0000005`
failures are neither reproduced nor proven fixed by this compiler diagnostic.

Root's selected visual review totals **two new view calls and four exact-byte
reuses**: current Web logout and Linux staged Review are newly viewed; Web
390px multiline, Linux 390px dark settings and two macOS settings/DMG frames
reuse previously viewed identical bytes. The current Linux scope menu is closed
without the earlier faint overlay; Web logout pixels remain supplementary to
its passed behavior receipt. These are selected frames, not all-pixel review
or additional native operations. See the [Web visual receipt](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-web-independent-20261018/Root-Web-final-results-and-selected-visuals.json),
[macOS visual receipt](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-mac-independent-20261018/Root-Mac-final-results-and-selected-visuals.json)
and [Linux visual receipt](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39099055462-linux-panel-independent-20261018/Root-Linux-final-results-and-selected-visuals.json).

Terminal [run](/private/tmp/codeshell-real-operation-cycles-20261016/ci38-progress8-run-api-20261018.json),
[jobs](/private/tmp/codeshell-real-operation-cycles-20261016/ci38-progress8-jobs-api-20261018.json) and
[artifacts](/private/tmp/codeshell-real-operation-cycles-20261016/ci38-progress8-artifacts-api-20261018.json)
anchor these five scopes. Full input hashes are retained in the
[private draft input index](/private/tmp/codeshell-ci38-release-results-draft-20261018/verified-input-hashes.json).
Subsequent source candidates remain separate and unvalidated at this checkpoint;
this section claims no candidate checks, new native repair or release readiness.

## CI39 — combined Windows corrections prepared, native acceptance pending

The next acceptance candidate combines three reviewed changes on the task
branch: the early NSIS root hooks, a fixed synchronous Windows source-Main
identity read, and production replacement validation without the desktop
collector. Their source commits are `a6919a66c27ab791b349d4fe9e1e92ad0a4244fa`,
`cb25bb091822b3529e353625362e298481c07b89` and
`90238a8f368fadd9dbd6149f532de4fe64d51cf2`; combined formatting is
`8cfa48c8432c806973e9330cc3abd979169b4499`. These changes are preparation for a
new hosted run and do not alter CI38's failed result.

The NSIS override now expands from `customWelcomePage` and
`customUnWelcomePage`, before the vendor install-mode page macros. The existing
uninstall welcome page and `customUnInit` are retained. The bounded-copy setter
body remains identical. Explicit root guards reject incompatible one-click,
all-users-page and removed-uninstall-welcome configurations; the current
assisted per-user configuration remains unchanged. Official NSIS v304 source
shows macro-buffer compaction on `!macroundef` and an active-cursor relocation
rule that motivates moving the override earlier. This is a source inference
consistent with the compiler diagnostic, not a binary/PC attestation of the
hosted compiler or proof of successful compilation. See the
[source review](/private/tmp/codeshell-ci38-nsis-macro-expansion-source-review-20261018/official-macro-buffer-facts-and-minimal-early-hook-proposal.json).

Windows source identity verification borrows the already owned in-process
Playwright 1.64.0 Main session and default execution context. A single fixed
`Runtime.evaluate` with `returnByValue: true` and `awaitPromise: false` reads
PID, parent PID, executable and HOME. Client/server child references, session,
context, module handle and exact four-field data are checked before/after;
the original four identity gates, captured monitor, first-error ordering and
cleanup authority remain. Ordinary business evaluation retains its existing
API. The fixed read avoids target Promise awaiting for these synchronous
metadata only. Neither source review nor fake-graph tests establish CI38's
collection cause or a general GC repair. Waiting for the existing SDK module
handle still has the prior no-timeout lifecycle boundary. See the
[independent peer review](/private/tmp/codeshell-windows-main-sync-identity-panel-source-peer-20261018/independent-four-source-and-pinned-playwright-peer.json).

The NSIS production runner removes the collector import, construction,
replacement callback wrapper and finish step. It passes the identical existing
role-observer callback directly to the watchdog. Its report declares exactly
`{status: "not-enabled", enabled: false, reason:
"production-validation-without-collector"}`. The original role observation,
budgets, first-error/custody checks and 13 static source hashes remain, including
two collector-source provenance reads. This does not claim zero observation
cost, zero child processes or absence of OS dialogs. Future evidence must show
the exact disabled marker and absence of collector JSON/PNG; the required
16 phases, six normal controller roots and 26 installed UI operations remain
unchanged. See the
[two-source peer review](/private/tmp/codeshell-windows-main-sync-identity-implementation-proof-20261018/peer-without-collector-two-source-review.json).

Root ran one combined guarded Node invocation with 12 explicit test files:
**159 tests passed, zero failed, cancelled, skipped or todo**. This includes the
original NSIS contract vector and the three Main-harness test files; it is not
an additional native operation count. Seven explicit MJS files were formatted
once; the full format-only diff was reviewed. Targeted ESLint for those seven
files reports zero warnings, and the eight-path diff check passes. All 53
protected source/config/tool references and validated source bytes are retained
across the checks. Full isolated invocation/stdout/stderr/result receipts are
bound by the [combined check result](/private/tmp/codeshell-ci39-combined-checks-20261018/combined-checks-final-result.json)
(`9e8282c473bb…`). No local Electron, installer, PowerShell, Keychain, native OS
query or SDK application was run in these checks. Owned temporary files, finite
timers and ordinary Node test/refusal child processes are included.

Only the previously authorized acceptance branch may be pushed for the next
full hosted run. Native compiler passes, real in-process identity behavior,
normal Main exit, full UI/installer acceptance and the earlier unexplained
Windows runtime failures still require new actual evidence. No release
readiness, remote-main push, tag, signing, notarization or publication is
claimed here.

## CI39 — completed results and Windows packaged UI launch failure

本节记录 [run 39101744806](https://github.com/cjhyy/codeshell/actions/runs/39101744806)，
`push` attempt 1，实际源码 `bf3b7b0b8dcc3196428a5faa060bca127cec3234`。
终态 API 为 **4 success / 1 failure，overall FAILED**；API 成功与完整证据
验收分列。前面的 CI39 准备段保留其当时“原生待验证”的历史时点。

| 范围 / job | 当前已验证的范围及限制 | 固定来源 |
| --- | --- | --- |
| Web `117599255111`，成功 | 2 个 reader 各一次退出 0；31 项浏览器行为（11 + 4 + 8 + 8）、6 个完整 settled RPC 数组 exact-once、33 张 PNG chunk CRC。 | [summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-web-independent-20261018/verified-summary.json) `d5851503…`；[freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-web-independent-20261018/final-evidence-freeze.json) `97bfca8f…`。 |
| macOS `117599255217`，成功 | 7 个 reader 各一次退出 0；原 83 操作 / 12 Main、另计 draft 3 / 1 与同一 Preferences Main 上的 Goal 1。DMG 安装及重装各 13 操作、共 2 Main；27 份 map / 303 条父边，无记录内时序冲突，49 张 PNG CRC。 | [summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-mac-independent-20261018/verified-summary.json) `01abcb17…`；[freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-mac-independent-20261018/final-evidence-freeze.json) `0f3b4b73…`。 |
| Linux `117599255278`，成功 | 前 8 项及实际 parent 绑定后的第 9 项各一次退出 0；原 83 / 12、另计 draft 3 / 1 与 Goal 1。AppImage Main 9789、runtime 9785 各正常结束；10 次 feed GET、0 下载；22 份 map / 202 条父边，无记录内冲突，35 张 PNG CRC。 | [summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-linux-panel-independent-20261018/verified-summary.json) `1f0be5a1…`；[freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-linux-panel-independent-20261018/final-evidence-freeze.json) `8aa92202…`。 |
| Windows matrix `117599255226`，失败 | `playwright-launch` 未返回；Main 5976 退出 `3221225477/null`，packaged UI 0 操作。5 个 success-only reader 未运行，不能据此前步骤的 API 成功补填完整原 83 / 12 或后续 NSIS。 | [固定 6 文件独立首错 peer](/private/tmp/codeshell-ci39-packaged-ui-first-error-source-plan-20261018/actual-six-file-packaged-first-error-independent-peer.json) `46b0a789…`。 |
| 独立 Windows NSIS `117599255261`，成功 | Main / Role / Desktop 各一次退出 0；严格完成 16 阶段、6 个正常 controller root、26 项 installed UI（首次 13 + 替换后 13）。原 fullbirth、normal、HOME、OS/cache/absence 门槛保留。 | [summary](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-independent-windows-nsis-panel-peer-20261018/verified-independent-NSIS-summary.json) `59346d09…`；[freeze](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-independent-windows-nsis-panel-peer-20261018/final-independent-NSIS-evidence-freeze.json) `d8bbfdec…`；[Root 收据](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-independent-windows-nsis-panel-peer-20261018/Root-Independent-NSIS-final-review.json) `db3bd3c9…`。 |

Mac/Linux 保留原 normal Main、完整记录出生身份、owned cleanup 顺序、custody、
HOME、源码/缓存完整性及各自 DMG/AppImage 判据；required 401 错误详情键盘
展开/收起与 Composer durable stdio/guard 也通过。有限 owned 集合不代表 OS
全部进程，也不等于所有子进程自然正常退出。

纯测试不加入原生操作数：Mac 聚合 **445 / 3550 / 32**，Linux **445 / 3547 / 32**；
49 个 operation-evidence、Core 27 / 85 及 9 组 Goal/附件日志按其原范围另列。
Web 的 synthetic 9 / 45、64 个纯生命周期合同及 2 个对照 / 6 个预期失败 UI
也与 31 项实际浏览器行为分开。Windows-only 合同不从 Mac/Linux 的 skipped
标记推成执行通过；此前本地组合 159 项的准备记录也不是新增原生验收。

Windows 首错为 `electron.launch: Process failed to launch!`，阶段
`playwright-launch`。Main 5976 / parent 6184 的完整 birth 已记录；既有 preload
结果和私有 receipt 写入均 fulfilled，7 个 Main guard probes 已观察，但 SDK
没有返回，后续 packaged identity/UI 未进入。其 `0xC0000005` 仍未定位到
故障模块或根因；这不是 source launcher 同步身份读取的失败调用路径。
这是**验收 harness 下的 Windows packaged 启动失败**；尚未证明未加 harness 的
普通用户启动是否同样崩溃，产品与验收仪器的根因都仍未知。Root 的
[固定首错复核收据](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-windows-matrix-independent-20261018/Root-Windows-matrix-first-failure-review.json)
（`6560b72f…`）保留同一范围与清理边界。

原生 `taskkill` 被拒绝，监视器记录的 signal requests 为空；同一出生身份的
owned 集合从 1 清至 0，HOME 保留。清理完成不能替代 normal Main 或 UI 成功；
SDK kill/close 日志顺序也不能认定谁触发该退出。固定窄窗 Application 查询
返回 0 行、WER 未查询，没有关联故障模块/原生堆栈。旧 GC、NSIS 与本次
相同数值状态码不构成同因或已修复的证据。

独立 NSIS 是同一构建、未签名 per-user CI 夹具的一次完整通过，不扩展为跨版本
升级、签名/公证或整个 Windows matrix 通过。Main / Role / Desktop 的
172 / 70 / 6 是离线元数据条件，另有 **118 / 16 / 33** 个纯合同日志，均不加入
16 / 6 / 26 原生计数。13 个 fixture source keys、两 include 与原 8 + 3 vendor
pins 绑定当前源码；原 180 秒预算等门槛不变。collector 的 exact 三键状态为
`{status: "not-enabled", enabled: false, reason: "production-validation-without-collector"}`，
固定 collector JSON/PNG 均不存在；这不等于零观察成本。collector 本身没有
截图/像素查看；另行查看的两张 installed UI 图不属于 collector 产物。
独立成功不能覆盖 matrix 的 packaged 启动失败，或证明旧 GC/崩溃已经修复。

本轮 Root 视觉抽查为 **4 次当前实际查看 + 4 次精确字节复用**：新看 Web
logout/re-authentication 1 张、Mac 390px 主题设置 1 张、独立 Windows NSIS
installed UI 2 张；复用 Web 390px multiline、Mac DMG reload 及 Linux
设置/Review 两帧。Windows 两张分别为首次安装的 settings-390-dark 和替换后
reload-390-dark；标题、搜索、主题选中、导入控件、换行说明与预览可读，垂直
滚动可见，所选 viewport 无可见横向溢出或重叠。它们不是 disabled collector 图。
Mac 所选画面也可读、无可见横向截断。主题持久性仍依原 13 + 13 行为收据，
Web 像素本身也不证明旧 pending state 已清，须依行为/RPC 收据。各平台 PNG
CRC 不等于查看了全部像素，也不增加 native 操作。对应 [Web](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-web-independent-20261018/Root-Web-final-results-and-selected-visuals.json)
`9191bb0d…`、[Mac](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-mac-independent-20261018/Root-Mac-final-results-and-selected-visuals.json) `c537f02e…`、
[Linux](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-linux-panel-independent-20261018/Root-Linux-final-results-and-selected-visuals.json) `4beb0281…`；另见 [独立 Windows installed UI 视觉收据](/private/tmp/codeshell-real-operation-cycles-20261016/ci-39101744806-independent-windows-nsis-panel-peer-20261018/Root-Independent-NSIS-selected-UI-visual-review.json)
`10720fbf…`。

[终态 run API](/private/tmp/codeshell-real-operation-cycles-20261016/ci39-progress6-run-api-20261018.json)、
[jobs API](/private/tmp/codeshell-real-operation-cycles-20261016/ci39-progress6-jobs-api-20261018.json) 与
[artifacts API](/private/tmp/codeshell-real-operation-cycles-20261016/ci39-progress6-artifacts-api-20261018.json) 固定本轮身份。
完整引用 SHA 见 [私有输入索引](/private/tmp/codeshell-ci39-release-results-draft-20261018/verified-input-hashes-v3.json)。
四个成功 job 已按各自范围完成证据验收；Windows matrix 失败与未知原因不变。
当前不建议发版，不声称 remote main/tag/release/publication 或下一轮结果。

## CI40 — bounded Windows launch diagnostics preparation

CI39 的 Windows packaged 启动 `0xC0000005` 仍是未定位的发版阻塞。当前准备的
诊断候选用于增加下一次 hosted CI 的可判别证据，不声称修复崩溃，也不改用
重复运行直到成功的结论。最新已完成运行仍为上节 CI39，overall FAILED。

作者任务从最新已获取的 `origin/main` 开始，正常接入验收基线；exact 五路径提交
`512f78e459bbf043949a427323441e16d7fb3a70` 已经过独立源码 peer，随后在任务
整合分支完成格式整理及标准时钟导入。最终受检查源码提交为
`c2c1a124a8bc5cc67dec0fad6c24b365a0bff15e`；此段仅追加记录，不改变源码。

只有现有 hosted Windows x64/win22 仓库身份满足条件的 packaged UI 调用显式
启用诊断，默认关闭。诊断在同一个 captured ChildProcess 上记录退出、关闭、
stdio 与 SDK 清理请求的有限回调顺序和缓存状态，并在原私有日志 append 成功后
保留 stdout/stderr 各最多 64 KiB 的副本。每次最多 64 条事件，最多 8 次启动；
文本另有同等上限及已知路径/URL/控制字符处理。它不提供通用秘密清洗、内核
顺序、OS 存活或原生崩溃原因证明。结果进入现有 receipt 的独立 sibling 字段；
原 startupObservation schema、first-error、preload、正常退出、出生身份、
watchdog、taskkill 拒绝、HOME 与全部原生验收条件保持。

本地首次：格式整理 0，显式 7 文件 Node 合同 **83/83**，lint 发现
`performance` 的 `no-undef`，该失败与完整日志保留。修正仅为从
`node:perf_hooks` 显式导入标准 `performance`；Root 逐字核对其余源码未变。
在新证据目录重新验证最终源码：同 7 文件 **83/83**，fail/cancel/skip/todo
均 0，lint 与 scoped diff-check 各退出 0；66 项受保护依赖/源码 pins 保持。
这 83 项是纯 Node 合同，不是原生 UI 83 操作。新增 7 例覆盖退出与清理先后、
不吞原 error 的 errorMonitor、事件和日志上限、UTF-8/快照隔离及回调故障。

[最终本地 gate 与源码 pins](/private/tmp/codeshell-ci40-combined-checks-perf-hooks-repair-20261018/final-local-gate-and-source-review.json)
（3808 B，`f4f7352134754c72146db55120aa7abbc9ad86a5259ac106e8f6f720196155bf`）
绑定最终五路径；[原完整差异与冻结](/private/tmp/codeshell-packaged-launch-event-diagnostics-proof-20261018/five-source-v1-freeze.json)
及 [独立 peer](/private/tmp/codeshell-packaged-launch-event-diagnostics-panel-source-peer-20261018/independent-five-source-v1-peer.json)
保留作者基线，格式变化与单行导入修正由 Root 后续记录约束。没有本地运行
Electron、安装器、PowerShell、原生进程查询、Keychain 或真实 inspector。
既往裸 Node 的整体效果仍为 UNKNOWN；已审的纯测试含普通 Node CLI 拒绝子进程、
自有临时文件及 fake SDK/VM，不能概称全任务零子进程或零 native 效果。

工作流选择及上传 profile 均未变。未来 hosted 纯日志预期为 operation-evidence
49 + 7 = 56、独立 passive-startup-goal 16 + 7 = 23；须再以实际 TAP 验证。
独立 operation 33、NSIS 118 及原生 83/12、draft 3/1、Goal 1、NSIS 16/6/26
各自保留，不能混计。此准备记录不包含 CI40 run/job/artifact 或原生结果；
下一次仅推送已获授权的验收分支。未推送 remote main、打 tag、签名、公证或发版。
