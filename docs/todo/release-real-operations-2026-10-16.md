# Release UI operation audit — 2026-10-16

Status: in progress. A passing row covers its stated fixture and boundary; this
is not a claim that every platform, external account, or packaged release works.
Continue the loop: operate the current interface, retain the failure, fix the
cause, repeat the operation, then check the combined build.
The release target is macOS, Windows, Linux Desktop and Web. Native Windows/Linux
execution is still pending; cross-platform fixture tests are not native acceptance.

## Reproduced and repaired

| Area | Real trigger and failure | Repair and regression |
| --- | --- | --- |
| Desktop browser | Switching internal tabs destroyed the guest, page draft and navigation history. Changing the guest set also replaced unsubmitted address drafts. | Retain each guest with its own navigation listeners, activate only the selected automation target, discard after idle, preserve unsubmitted addresses. `e2e-panel-operation-cycles.mjs`: guest identity, draft, history, background navigation, close, idle reconstruction, load failure/retry. Idle time is advanced in the owned fixture; it is not a five-minute wall-clock soak. |
| Desktop panel sizing | A 390px viewport kept a 479px dock and clipped actions. | Constrain the dock to its parent and wrap browser actions. Native screenshots at 390/768/1280px. |
| Review | Selecting a repository's initial commit showed “no changes”; invalid Git ranges also appeared empty. | Read a commit with `git show --root --first-parent`; propagate real Git errors. Real repositories cover root, ordinary and merge commits, bad index/recovery, working and staged changes. |
| Credentials | Pending saves could be repeated; rejected writes escaped to an unhandled renderer error; old project completion cleared another project's form. | Lock before dialog/IPC, disable pending controls, present a generic error, preserve failed drafts, remount forms at the project boundary. Native create/grant/environment/cookie/rename/delete/restart and A→B pending completion cycles. |
| Static plugin export | Long review content and action labels overflowed narrow dialogs. | Bound grid content and wrap actions; real export picker cancel, existing-target rejection, duplicate click and successful file output. |
| MCP settings | Pending mutations stayed clickable and long commands pushed actions outside the viewport. | Serialize mutations and constrain cards/actions. Native stdio initialize/tool discovery, settings rejection/retry, atomic rename, missing-executable recovery, deletion and cold recovery passed twice on the combined build; retain the earlier unclassified failure. |
| Automation | A delayed failure from task A appeared in task B after selection changed. | Store action errors by job. Native schedule save/retry/reload, prompt cancel/failure/retry, resume failure/retry/pause, delete failure/retry; successful mutations reach the real Cron store. No run-now/model turn. |
| Desktop cold start | The renderer called `pet:set-active-session` before Main registered its handler. | Register the Pet APIs before loading the renderer while hydration continues behind their ready promise. Three cold launches, renderer reloads and a second main window verify the native load boundary and actual Pet IPC. |
| Concurrent project migration | Two fresh renderer windows each obtained an empty migration token; the second completion threw after the first wrote the durable marker. This appeared in actual packaged Main stderr. | Permit completion-only replay for a token issued by the current service whose pending paths are empty. Invalid, pending and restarted-service tokens remain rejected; authorization still closes after completion. Real ProjectStore/parallel renderer regressions verify one marker write and unchanged bytes/inode/mtime on replay. Three actual cold launches/reloads plus a second window then completed with zero migration errors in captured Main stderr. |
| Web transcript recovery | A pending restore accepted a send and later replaced it; live text received during durable recovery could be dropped. | Block send until restore finishes, fold the final notification buffer, scope cursor/error commits to the current load. |
| Web repeated stop | Repeated clicks sent duplicate cancellation requests. | A synchronous per-session cancellation guard. |
| Web mobile composer | Resize immediately before Enter could submit using stale wide-layout state. | Read the current media query at the key event. |
| Web questions | Choice labels/descriptions and options-only constraints were not rendered; optional asynchronous questions blocked subsequent tasks. | Render single/multi choice controls and preserve synchronous approval blocking. Optional questions remain answerable while work continues. |
| Web late errors | Failed run/cancel/approval/upload responses appeared in another selected session. | Keep errors with the initiating session; preserve global authentication expiry. |
| Web delayed conversation title | Actual Worker completed B, the user switched to A, then B's auxiliary title finished. The durable title and event were correct, but the shared sidebar retained B's old title. | Refresh the shared session list/history on title events. A request revision prevents an older list success or failure from replacing newer results; authentication expiry remains global. Actual Host/Worker/SSE regression preserves A's draft while B's late title updates, with separate unit races for old 200/500/401 responses. |
| Web question drafts | Switching sessions while an answer was pending unmounted its form and lost the answer on failure. | Keep unresolved forms by request and hide other sessions accessibly. |
| Ordinary-session write recovery | Background filtering hid the only uncertain-write review entry for a normal conversation. | Add the existing review UI to conversation management, loaded only on request. Native cancellation, read-only reconciliation, manual uncertainty acceptance and cold Main/Engine recovery preserve the original unknown result and never replay its write. |
| Execution trace keyboard access | At 820px the focused final type filter was clipped; retrying a failed detail dropped focus to the page body. | Scroll the focused filter into view and move retry focus to the stable detail heading. Native geometry, hit testing and focus checks at 1280/820/390px in light/dark themes. |

## Evidence boundaries

Run Bun units through `node scripts/run-bun-test-shard.mjs`; run native fixtures
through `node scripts/run-isolated-node-smoke.mjs`. Desktop builds must finish
before tests consume their emitted assets. Package release verification owns a
clean dependency rebuild and must finish before other checks read `dist/`.

| Suite / operation family | Boundary actually exercised |
| --- | --- |
| `smoke-panels.mjs` | Compiled Electron Main/preload/renderer, actual stdio Engine worker, owned HTTP streaming provider, real synthetic tool actions, usage/cache and 429 recovery. Network and native custody receipts are retained. |
| `e2e-panel-operation-cycles.mjs` | Native Electron guests, real files and multiple roots, Git and PTY. Owned folder picker result and local HTTP page; no external browser account. |
| `e2e-panel-recovery-ui.mjs`, `e2e-panel-app-window.mjs` | Install/update/rollback review, cancellation, duplicate click, two-project isolation, corrupt repair, retained document bytes, actual cold Main restart, window identity and cleanup. Synthetic Panel packages. |
| `e2e-credential-operations.mjs` | Real Main encrypted credential stores and owned browser login/cookie flow. Selected requests are held/rejected to exercise failures; other IPC invokes production handlers. OS modal answers are controlled fixture results. |
| `e2e-automation-operation-cycles.mjs` | Real Main Cron store, renderer controls and durable reload. One update/resume/delete failure is injected; successful retries invoke original handlers. |
| `e2e-startup-operation-cycles.mjs` | Real cold processes and window lifecycle. Observes native load/handler registration without substituting IPC. |
| `e2e-pet-runtime.mjs` | Actual compiled worker/Pet, local model, synthetic installed stdio MCP discovery, conversation/work continuation, memory cold recovery, native safeStorage. Existing default-Keychain metadata is pinned and verified unchanged; no operator plugin configuration or actual IM delivery is covered. |
| Local macOS arm64 package | Production `afterPack` supplies the locked Node archive and ad-hoc signs/verifies helpers, Node and the app. Builder identity is explicitly null; Developer ID signing, notarization and publishing are disabled. The first actual ASAR Main/preload/renderer/Node-mode-worker launch verified preimport guards and package identity, then failed before any model request: native `isEncryptionAvailable` entered without returning and shutdown timed out. Before/after full-tree hashes and deep strict signature verification matched; the private HOME remains because worker-exit receipts were incomplete. This is not a passing packaged Pet acceptance. |
| `e2e-ui-packaged.mjs` | A new local ad-hoc app containing the migration repair passed 13 actual UI operations: settings navigation, owned directory-picker result followed by real theme review/install, `cstheme:` image decoding in both modes at actual 1280/768/390px BrowserWindow content widths, and persisted theme/mode after renderer reload. Seven screenshots retained. Main guard, normal-exit spawn count zero, model requests zero, native secret-storage calls zero, unchanged full package inventory/signature and private HOME removal verified. A post-run process-table observation found no command referencing that app or its private userData; this is not a historical all-OS-descendants exit acknowledgement. |
| Web `test-chat-operations-browser.mjs` | Actual Chromium/React/controller/ProtocolClient through native loopback HTTP/WebSocket. The Host protocol peer is a fixture; this suite does not invoke the Engine/provider. Covers 17 operation sequences including failures, reconnect, attachments, choices and scope switching. |
| Web `smoke-web-host-operations.mjs` | Actual SPA/AuthGate/Hub, headless Host and stdio Core worker against one owned SSE provider. A real upload 201 is held while switching A→B, then remains staged only in A. An owned WebSocket is dropped during streaming; missed journal events replay after reconnect with exactly one primary request per turn. A separate sequence reproduces and repairs the inactive conversation title. Model and auxiliary-title requests are counted separately after shutdown. Driver/Host/worker origin guards, process birth custody, provider closure and remaining-process receipts pass. Service workers are blocked; this does not test their lifecycle or a live provider/account. |
| `e2e-media-playback.mjs` | Production media protocol and actual Chromium WAV/MP4 decoding, seeking, coordination, range errors, missing/corrupt/outside-root rejection, narrow layout and session release. Generated local media only. |
| Settings/model/theme/profile suites | Native IPC and synthetic local data. Theme surfaces, model configuration, static export output and memory promotion have separate receipts. MCP mutation and cross-project credential cases continue below. |
| Background work/source suites | Real authoritative session/delegation/automation/background records and recovery; no model needed for synthetic history. |
| Device relay / optimization lab | Owned local relay / feature-flagged fixture; current enrollment controls, cancellation, reconnect and restart. No public relay or live paid evaluation. |
| Current operations / cost history | Operations UI uses native preload and a trace IPC shim delegating to compiled `ModelTraceHistory`/`ModelTraceStore`; independent read failures and session/log metadata are synthetic. Cost history uses production usage/trace IPC and compiled receipt stores, plus a fresh guarded driver and new Main PID for cold recovery. No provider/model request. |

## Three-platform acceptance preparation

An independent `desktop-ui-acceptance.yml` workflow builds native directory
packages on macOS, `windows-2022` and Ubuntu, then runs cold startup and the
packaged UI sequence. It is limited to manual dispatch or a dedicated acceptance
branch push, with read-only repository permissions. It uses no release identity,
notarization, tag or publishing command. Linux gets an owned Xvfb/SecretService
session and explicitly configured sandbox helpers; it does not use `--no-sandbox`.
No remote run has been triggered at this audit checkpoint.

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
or reads stored items. Actual Linux bus execution remains pending; Mac fixture
parsing/refusal tests do not establish it. Xvfb alone does not verify window-manager
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
- Native OS approval automation, installer/update, full packaged runtime,
  Windows/Linux-specific runtime behavior, live external accounts and actual IM
  delivery have not been established by the rows above.

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

| Repair | Trigger and current verification |
| --- | --- |
| Git file mentions (D01) | `git ls-files -z` plus streaming UTF-8 decoding preserves actual filenames, including Unicode and surrounding whitespace. Real Git tests verify returned paths remain readable. Before repair, actual Electron `@报告` showed no candidate despite the owned file existing; the screenshot and failed report remain at `codeshell-panel-operation-evidence-0cxOvA` in the system temporary directory. |
| Current-root mentions (D02) | The conversation root ID now reaches the existing Main root-authority check before ranking/capping. Omitted root IDs retain project-wide discovery; invalid, removed and replaced roots cannot fall back. Real Git/two-root, preload/authority and rendered Popover tests pass. Actual Electron selects the primary root's long-path match while the other root contains 30 higher-scoring matches. |
| Native JSON-lines Unicode (D03) | `StringDecoder` retains partial UTF-8 bytes across chunks. Pure production-decoder tests cover every split, byte-at-a-time input, multiline framing and error recovery. Native frame size/error rules remain unchanged. No Chrome/native socket/authentication/shutdown experiment was run for this repair. |
| Disk session recovery (SWC-05/06) | Invalid non-object records are skipped locally without rewriting healthy data. Sorting and cursor comparison share the same comparator. Actual Core-backed reader/temporary-disk regressions and existing authorization/archive/filter cases pass with pre-Core deny-all HTTP guards. Equal-mtime cases are explicitly constructed; natural production timestamp equality is not claimed. |
| Late memory pin UI | An old pin may complete its originally authorized save but cannot refresh another store visit, reopen a different/closed selection or discard an editor draft. Actual React controls with owned IPC stubs cover late read/save/error/refresh, leaving and returning, both editing orders, another selection and closing details. Normal pin persistence/refresh remains covered. These are component/IPC-stub receipts, not native-store persistence evidence. |
| Revoked composer mentions | File/recent selections bind to their selected text ranges. Editing/removing those ranges drops their metadata for ordinary send, queue and force-send; clearing/restoring does not revive it. Still-visible selections and explicit pasted/dropped/uploaded attachments remain. Recent provenance is retained. Real React/Popover tests with owned submission spies and range-helper tests cover Unicode, spaces, duplicate occurrences and suffix edits. No Engine/model was invoked for this metadata regression. |

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

| Suite | Actual operation and evidence boundary |
| --- | --- |
| `e2e-memory-pin-operation-cycles.mjs` | Seven compiled Electron Main/preload/renderer sequences: normal pin, late user→dream completion, pending selection B, both edit/pin orders, closed details, and a late failed save. Successful saves call the original production handler and verify actual A content/pin state; B/dream whole-file hashes remain unchanged. Each successful sequence commits once; the rejected save commits zero times and leaves A's complete hash unchanged. Read/save timing and one error are controlled. `native-memory-pin/receipt.json` records source `a396d1656`, compiled-source hashes, zero worker/network attempts and renderer errors, Main exit 0/no signal, 21 observed process incarnations cleaned/zero remaining, and HOME removal. No Engine, provider or account is used. |
| `e2e-composer-reference-operations.mjs` | Nine real native keyboard/mouse/clipboard/file-chooser sequences through ChatView/App, preload and Main. Unicode/space mentions retain visible metadata; delete/suffix/paste edits revoke it for ordinary send, queue and force. Explicit picker files and production-staged pasted images remain; actual image bytes match both metadata SHA256s and decode to 8×8. Main captures and answers run/control requests before the Engine; its model catalog and owned chooser selection are controlled. File/root authorization, staging and session persistence remain production handlers. `native-composer-reference-final/report.json` records 11 run, 2 steer, 2 unsteer and 4 cancel requests, zero workers/pending/errors, Main exit 0/no signal, 37 observed incarnations cleaned/zero remaining, and HOME removal. This proves submitted metadata, not Engine consumption. |
| `test-service-worker-browser.mjs` | Eleven actual Chromium ServiceWorker/CacheStorage sequences exercise production registration, worker and offline UI. Root/mobile cache ownership, scoped legacy cleanup, activated controller replacement, 320px offline layout, reconnect, uncached API/upload/project/POST/public-query responses, and failing private root navigations pass. The HTML shell and HTTP/API replies are owned fixtures; no authenticated account or Host is involved. A local proxy never forwards and rejects external HTTP/CONNECT/upgrade requests; actual page HTTP/HTTPS and SW HTTP negative probes are retained. This is evidence for those channels, not an OS network sandbox. `service-worker-cli/report.json` and two screenshots remain; all eight observed browser incarnations settled cleaned with zero remaining. |

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
