# Release UI operation audit — 2026-10-16

Status: in progress. A passing row covers its stated fixture and boundary; this
is not a claim that every platform, external account, or packaged release works.
Continue the loop: operate the current interface, retain the failure, fix the
cause, repeat the operation, then check the combined build.
The release target is macOS, Windows, Linux Desktop and Web. Authorized native CI
has now executed; its passing and incomplete boundaries are recorded below.
Cross-platform fixture tests alone are not native acceptance.

## Reproduced and repaired

| Area                                       | Real trigger and failure                                                                                                                                                                                                                                           | Repair and regression                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop browser                            | Switching internal tabs destroyed the guest, page draft and navigation history. Changing the guest set also replaced unsubmitted address drafts.                                                                                                                   | Retain each guest with its own navigation listeners, activate only the selected automation target, discard after idle, preserve unsubmitted addresses. `e2e-panel-operation-cycles.mjs`: guest identity, draft, history, background navigation, close, idle reconstruction, load failure/retry. Idle time is advanced in the owned fixture; it is not a five-minute wall-clock soak.                                                                                                                                      |
| Desktop panel sizing                       | A 390px viewport kept a 479px dock and clipped actions.                                                                                                                                                                                                            | Constrain the dock to its parent and wrap browser actions. Native screenshots at 390/768/1280px.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Review                                     | Selecting a repository's initial commit showed “no changes”; invalid Git ranges also appeared empty.                                                                                                                                                               | Read a commit with `git show --root --first-parent`; propagate real Git errors. Real repositories cover root, ordinary and merge commits, bad index/recovery, working and staged changes.                                                                                                                                                                                                                                                                                                                                 |
| Credentials                                | Pending saves could be repeated; rejected writes escaped to an unhandled renderer error; old project completion cleared another project's form.                                                                                                                    | Lock before dialog/IPC, disable pending controls, present a generic error, preserve failed drafts, remount forms at the project boundary. Native create/grant/environment/cookie/rename/delete/restart and A→B pending completion cycles.                                                                                                                                                                                                                                                                                 |
| Static plugin export                       | Long review content and action labels overflowed narrow dialogs.                                                                                                                                                                                                   | Bound grid content and wrap actions; real export picker cancel, existing-target rejection, duplicate click and successful file output.                                                                                                                                                                                                                                                                                                                                                                                    |
| MCP settings                               | Pending mutations stayed clickable and long commands pushed actions outside the viewport.                                                                                                                                                                          | Serialize mutations and constrain cards/actions. Native stdio initialize/tool discovery, settings rejection/retry, atomic rename, missing-executable recovery, deletion and cold recovery passed twice on the combined build; retain the earlier unclassified failure.                                                                                                                                                                                                                                                    |
| Automation                                 | A delayed failure from task A appeared in task B after selection changed.                                                                                                                                                                                          | Store action errors by job. Native schedule save/retry/reload, prompt cancel/failure/retry, resume failure/retry/pause, delete failure/retry; successful mutations reach the real Cron store. No run-now/model turn.                                                                                                                                                                                                                                                                                                      |
| Desktop cold start                         | The renderer called `pet:set-active-session` before Main registered its handler.                                                                                                                                                                                   | Register the Pet APIs before loading the renderer while hydration continues behind their ready promise. Three cold launches, renderer reloads and a second main window verify the native load boundary and actual Pet IPC.                                                                                                                                                                                                                                                                                                |
| Concurrent project migration               | Two fresh renderer windows each obtained an empty migration token; the second completion threw after the first wrote the durable marker. This appeared in actual packaged Main stderr.                                                                             | Permit completion-only replay for a token issued by the current service whose pending paths are empty. Invalid, pending and restarted-service tokens remain rejected; authorization still closes after completion. Real ProjectStore/parallel renderer regressions verify one marker write and unchanged bytes/inode/mtime on replay. Three actual cold launches/reloads plus a second window then completed with zero migration errors in captured Main stderr.                                                          |
| Web transcript recovery                    | A pending restore accepted a send and later replaced it; live text received during durable recovery could be dropped.                                                                                                                                              | Block send until restore finishes, fold the final notification buffer, scope cursor/error commits to the current load.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Web repeated stop                          | Repeated clicks sent duplicate cancellation requests.                                                                                                                                                                                                              | A synchronous per-session cancellation guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Web mobile composer                        | Resize immediately before Enter could submit using stale wide-layout state.                                                                                                                                                                                        | Read the current media query at the key event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Web questions                              | Choice labels/descriptions and options-only constraints were not rendered; optional asynchronous questions blocked subsequent tasks.                                                                                                                               | Render single/multi choice controls and preserve synchronous approval blocking. Optional questions remain answerable while work continues.                                                                                                                                                                                                                                                                                                                                                                                |
| Web late errors                            | Failed run/cancel/approval/upload responses appeared in another selected session.                                                                                                                                                                                  | Keep errors with the initiating session; preserve global authentication expiry.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Web delayed conversation title             | Actual Worker completed B, the user switched to A, then B's auxiliary title finished. The durable title and event were correct, but the shared sidebar retained B's old title.                                                                                     | Refresh the shared session list/history on title events. A request revision prevents an older list success or failure from replacing newer results; authentication expiry remains global. Actual Host/Worker/SSE regression preserves A's draft while B's late title updates, with separate unit races for old 200/500/401 responses.                                                                                                                                                                                     |
| Web question drafts                        | Switching sessions while an answer was pending unmounted its form and lost the answer on failure.                                                                                                                                                                  | Keep unresolved forms by request and hide other sessions accessibly.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Ordinary-session write recovery            | Background filtering hid the only uncertain-write review entry for a normal conversation.                                                                                                                                                                          | Add the existing review UI to conversation management, loaded only on request. Native cancellation, read-only reconciliation, manual uncertainty acceptance and cold Main/Engine recovery preserve the original unknown result and never replay its write.                                                                                                                                                                                                                                                                |
| Execution trace keyboard access            | At 820px the focused final type filter was clipped; retrying a failed detail dropped focus to the page body.                                                                                                                                                       | Scroll the focused filter into view and move retry focus to the stable detail heading. Native geometry, hit testing and focus checks at 1280/820/390px in light/dark themes.                                                                                                                                                                                                                                                                                                                                              |
| Web authentication                         | A real tab status check invalidated an outstanding successful login. An old device-revocation 401 could also expire a newer login.                                                                                                                                 | Suppress status reads during login and bind authentication-loss callbacks to the initiating login identity. Actual cookie HTTP/WebSocket browser sequences cover both races, explicit logout with pending chat work, and a current-login 401 after closing its dialog. Hosted Linux Chromium under Xvfb passes all four, including actual blur followed by a trusted focus event.                                                                                                                                         |
| Language and theme preferences             | The selected language card stayed stale, another same-origin window did not follow language changes, and switching a manually booted theme to System missed later media changes.                                                                                   | Use the language provider as the selected-card authority, listen to native storage events, and retain the media listener while checking the current stored mode on every event. Seven focused scenarios, six real-browser sequences, and six actual macOS Electron sequences across three cold Main processes pass. Hosted macOS and Linux native sequences also pass; Windows remains pending.                                                                                                                           |
| Packaged update checks                     | The installed updater emitted an error event and then rejected its promise: a real missing-manifest 404 changed from not-available to error. Filename-only classification also hid 401/403/500/invalid YAML.                                                       | Use one error policy for events and promise rejection; only an actual 404 status denotes a missing manifest. Actual packaged Main/preload/Settings/electron-updater verifies five response classes and five healthy retries, ten exact manifest GETs, no asset/download/install action.                                                                                                                                                                                                                                   |
| Review diff paths and lines                | Hunk body lines beginning with `+++`/`---` were mistaken for headers; rename and Git-quoted Unicode paths could target the wrong file.                                                                                                                             | Parse headers in their actual section, decode Git quoting and preserve real rename paths. Actual macOS Main/Review/preload/renderer passes four diff checks and four plain-click file previews against owned Git. Three-platform CI now includes this operation family.                                                                                                                                                                                                                                                   |
| Host project case policy                   | A Web client lowercased POSIX paths and could create a session in the wrong case-distinct Linux project.                                                                                                                                                           | Project metadata carries the Host's case policy; grouping and session creation share that policy and prefer stable project IDs. Actual React handler and owned path-policy tests pass. This is not native Linux Host registration acceptance.                                                                                                                                                                                                                                                                             |
| Context forwarding after truncated history | Selecting RECENT from the actual 512 KiB history tail could forward OLD because visible groups used raw-history ordinals.                                                                                                                                          | Preserve durable source event IDs and resolve the exact raw range; reject unknown, ambiguous or discontinuous mappings. Eight actual reader/fold/React-handler scenarios pass without invoking a fork or provider.                                                                                                                                                                                                                                                                                                        |
| Multiline annotations                      | Actual CommentBox typing and Save retained the full text, but its wire projection displayed only the first line and interpreted colon/fake-entry text as other fields.                                                                                             | Version only new multiline blocks and consume a bounded explicit line count. Actual CommentBox/codec/AnnotationsBlock passes eight browser sequences at 1000/390px, with whitespace and fake-format text preserved. Ordinary single-line wire stays byte-compatible; ambiguous historical unframed comments are not guessed.                                                                                                                                                                                              |
| Web child-stream lifecycle                 | Background child detail changed a completed parent to running; a child error also cleared the parent's live output. Supported orphan tool results bypassed ordinary display cleanup.                                                                               | Keep child activity in its own bucket, retain the parent's lifecycle and normalize both tool-result orders equally. Combined reducer/replay/controller regression passes 86 tests/242 assertions. Actual Workbench/ProtocolClient browser verification passes eight sequences at 1280/390, with real Send/Stop and expanded tool-result controls.                                                                                                                                                                         |
| Native file labels and image previews      | Actual Windows Files/CommentBox displayed the complete native path as its short filename. Real React tests additionally exposed incorrect drive/UNC image IPC paths, root-level Markdown image directories, and a POSIX media fallback losing a literal backslash. | Preload platform selects native separators for display and dirname; complete locators and file authority remain unchanged. Image attachments preserve native absolute paths and join relative paths only once. FilesPanel, Markdown, attachment/media cards, recent references and workspace labels share the display helper. The combined focused shard passes 115 tests/386 assertions, followed by Desktop build and all 14 workspace typechecks. Native Windows verification of these repairs is pending the next CI. |

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
