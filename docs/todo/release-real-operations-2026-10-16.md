# Release UI operation audit — 2026-10-16

Status: in progress. A passing row covers its stated fixture and boundary; this
is not a claim that every platform, external account, or packaged release works.
Continue the loop: operate the current interface, retain the failure, fix the
cause, repeat the operation, then check the combined build.

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
| Web transcript recovery | A pending restore accepted a send and later replaced it; live text received during durable recovery could be dropped. | Block send until restore finishes, fold the final notification buffer, scope cursor/error commits to the current load. |
| Web repeated stop | Repeated clicks sent duplicate cancellation requests. | A synchronous per-session cancellation guard. |
| Web mobile composer | Resize immediately before Enter could submit using stale wide-layout state. | Read the current media query at the key event. |
| Web questions | Choice labels/descriptions and options-only constraints were not rendered; optional asynchronous questions blocked subsequent tasks. | Render single/multi choice controls and preserve synchronous approval blocking. Optional questions remain answerable while work continues. |
| Web late errors | Failed run/cancel/approval/upload responses appeared in another selected session. | Keep errors with the initiating session; preserve global authentication expiry. |
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
| Web `test-chat-operations-browser.mjs` | Actual Chromium/React/controller/ProtocolClient through native loopback HTTP/WebSocket. The Host protocol peer is a fixture; this suite does not invoke the Engine/provider. Covers 17 operation sequences including failures, reconnect, attachments, choices and scope switching. |
| `e2e-media-playback.mjs` | Production media protocol and actual Chromium WAV/MP4 decoding, seeking, coordination, range errors, missing/corrupt/outside-root rejection, narrow layout and session release. Generated local media only. |
| Settings/model/theme/profile suites | Native IPC and synthetic local data. Theme surfaces, model configuration, static export output and memory promotion have separate receipts. MCP mutation and cross-project credential cases continue below. |
| Background work/source suites | Real authoritative session/delegation/automation/background records and recovery; no model needed for synthetic history. |
| Device relay / optimization lab | Owned local relay / feature-flagged fixture; current enrollment controls, cancellation, reconnect and restart. No public relay or live paid evaluation. |
| Current operations / cost history | Operations UI uses native preload and a trace IPC shim delegating to compiled `ModelTraceHistory`/`ModelTraceStore`; independent read failures and session/log metadata are synthetic. Cost history uses production usage/trace IPC and compiled receipt stores, plus a fresh guarded driver and new Main PID for cold recovery. No provider/model request. |

## Remaining acceptance work

- Retain the first combined-run MCP failure as unclassified. Two subsequent
  diagnostic runs against the combined build passed (10 attempts, 7 commits,
  all 8 actual stdio probes exited, no network/renderer errors). A later green
  run does not identify the cause of the earlier failure.
- Operations/cost suites now cover the current conversation/trace/diagnostic
  interface. The removed RunsView cross-session summary is not restored;
  production UsageLedger IPC/cold recovery and current request/attempt cost UI
  remain asserted, including unknown prices, missing usage and partial history.
- Continue release-artifact verification after this local integration. Current
  operation coverage is recorded below; an installed/signed package is a
  separate boundary.
- Native OS approval automation, packaged application launch/install/update,
  Windows/Linux-specific runtime behavior, live external accounts and actual IM
  delivery have not been established by the rows above.

The actual native batch review was requested in an owned, confined Main with no
worker or HTTP request. CUA could not observe it: ScreenCaptureKit returned
`SCStreamErrorDomain -3802` twice using the exact fixture app path. Only that
recorded Main PID was terminated after command identity verification. No native
cancel/readability/default-focus result is accepted from this attempt. Its
private receipt is `native-batch-inspect/evidence/cua-observation.json` under the
operation audit output directory.

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
