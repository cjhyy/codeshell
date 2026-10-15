# Release and UI review — 2026-10-15

User authorization: publish the pushed code, then continuously review and improve
the overall UI until **2026-10-16 11:00 Asia/Singapore (03:00 UTC)**.
Stop starting changes at the deadline; preserve and verify outstanding work,
deliver a final report, and disable the follow-up heartbeat.

## Release

**Published:** [v0.9.43](https://github.com/cjhyy/codeshell/releases/tag/v0.9.43)
from merged commit `156f2fad1`. Source CI `38707301929` and release workflow
`38708921953` passed completely. Windows, macOS (Intel/Apple Silicon) and Linux
installers are present; all three updater manifests report `0.9.43`.
Independent public registry reads confirmed all 10 packages at `0.9.43` with
their `latest` tags after publication. Release title and notes were updated.
Do not recreate or move the tag.

The initial blockers below are retained as resolved verification history.

- Baseline: `origin/main` `bb01243ac`; latest public version `0.9.42`.
- Prepared version: `0.9.43`, commit `b149c8f44` on
  `codex/release/0.9.43-20261015`.
- Worktree: `/Users/admin/.codex/worktrees/release-ui-20261015/codeshell`.
- Main CI `38703068601` exposed stale Link action
  counts, a one-line architecture-budget excess, inherited bridge enumerability
  in a React test and an obsolete native-select/external-track theme E2E.
- Integrated test fixes `1ae1b1974` and `3fa768267`; theme E2E now uses the real
  Radix selector and validates local playback.
- Main follow-up CI `38705047770` passed 10 jobs and the theme acceptance, then
  exposed a shared App mock leaking into the subagent dock fixture and two
  obsolete native-select reads in Optimization Lab E2E. The dock fixture now
  imports its own production module (`79ed30b2e`, 175 related tests passed).
  Optimization Lab reads the durable ID from visible frozen details and checks
  the actual selected Radix option. Its full isolated Electron/worker/local-HTTP
  acceptance passed, including restart, native authorization, request counts,
  revoke/stop and no automatic replay/spending. Both state aliases are explicitly
  bound to its seeded Electron HOME when called through the outer guarded runner.
- Local verification passed: package release smoke (10 tarballs, 48 typed
  entries), all 14 workspace typechecks, complete Desktop build, targeted
  guarded tests (28 tests, 496 assertions), ESLint baseline (0 errors), and real
  Electron theme E2E with retained screenshots.
- Desktop build initially hit a Cua Driver download timeout; retried with the
  existing checksum-verified archive and offline mode. All native driver
  signature/architecture/version checks remained enabled, and full build passed.
- Publish through the repository tag workflow after integration and validation;
  verify all native installers, npm registry versions/tags, GitHub Release and
  update manifest versions before reporting publication complete.

## UI review

Current integration worktree:
`/Users/admin/.codex/worktrees/ui-task-center-20261015/codeshell`, branch
`codex/integration/ui-review-wave7-20261015`. Other work advanced remote main to
`0.9.44`; this branch merged `976a79322` and `bb7a9b59a`, preserving the incoming model-capability,
forwarding and Figma updates. The CSS merge preserves both context-selection and
file-action styles. Do not revert incoming work or republish another version on
the assumption that `0.9.43` is still the repository manifest version.

First wave integrated into remote main at `3ddba56c7` (integration hashes):

- `ddf69b9f7`: compact Task center header and advanced-filter popover; 14 real
  browser layout cases, search/filter/clear/resize/focus/actions, 22 existing tests.
- `8f9222b4e`: Web file navigation failure/retry, target-bound responses, canonical
  file links and immediately readable mobile previews. Independent review and
  520 Web tests plus production browser checks passed.
- `0f65bd55f`: Desktop file directory recovery and empty/filter states,
  container-responsive previews, visible keyboard/touch actions and IME-safe
  comments. Existing workspace tests and real browser checks passed.
- `6dfad0fba`: stable native-textbox/listbox/option accessibility relationships;
  actual Chromium AX checks and 185 related tests passed. VoiceOver speech has
  not been tested.
- `b36304590`: fix focus when file-panel layout hides the active row/back button.
  A strict regression first failed, then passed. Outside non-focusable pointer
  interaction is also protected after independent review.
- `69eb92e65`: stable localized composer name and replacement-popup ownership.
- `81a4141d5`: Web return-to-latest control, stable new-output counts, explicit
  follow behavior and session/reconnect cleanup. Two independent reviews, 524
  Web tests and real browser streaming/resize/keyboard checks passed.
- `34ffb19ff`, `ac708240c`: theme deletion preserves the current choice until
  Host accepts, reports errors, prevents duplicate deletion and restores keyboard
  focus without taking it from another control. Theme-mode buttons expose their
  selection and stay synchronized across windows. Real keyboard/Host timing,
  eight layout/theme/language cases and independent review passed.

The combined 14-workspace typecheck, complete Desktop build, ESLint baseline,
both Web production-browser fixtures, all 15 Desktop browser fixtures and real
Electron navigation/settings checks passed. The guarded renderer/Web/persistence
shard passed 3,291 tests with 12,330 assertions (one separately covered browser
test skipped). CI now also runs both Web browser fixtures with the already-installed
locked browser. Remote CI `38713943455` passed all UI/renderer/Web checks but found
an old Electron Task center locator (textbox instead of the new searchbox) and an
intermittent Figma large-response read stall. The locator fix `e028d0d5b` is on main
and its full 2,050-record Electron acceptance passed locally. Follow-up CI is
`38716066133` passed all 12 jobs. Figma is still under isolated diagnosis of the
intermittent Bun transport behavior; keep all response budgets and
overflow/recovery assertions intact.

The first autocomplete browser run exposed a pending-caret timing issue: a queued
production rAF can interrupt Playwright fill's select-all/insertText replacement.
An independent deterministic reproduction matched the double-mention result.
The fixture now drains the callback after every pointer/Enter/Tab pick and retains
the original failure context; no assertions were loosened. The complete browser
matrix passed on rerun. The corresponding real fast-user-interaction race is
being fixed separately in the second composer commit.

The second review wave uses independent trees: Desktop context settings read,
edit and reset recovery; Web workspace/session navigation; and autocomplete
cleanup after an accepted send and cancellation of stale caret restoration.
Root also reproduced update-settings issues with production components and an
owned bridge: a long error expands a 320px page to 5,853px, a delayed initial status
overwrites a newer event, and version/action rejections are unhandled. Evidence:
`/tmp/codeshell-updater-ui-before-20261015/report.json`; no network was allowed.
Continue with the current commits and evidence instead of redoing the initial audit.

Second wave was delivered to remote main at `f7287c91c`. CI `38717940777`
passed all 12 jobs. Combined local verification
passed: all 14 workspace typechecks, full Desktop build, lint baseline, 3,289
guarded renderer/Web tests (12,322 assertions; one separately covered browser
test skipped), all 19 Desktop browser fixtures, all three Web fixtures, and real
Electron Settings/2,050-record Task center acceptance:

- `6396a90f2`, `809e0495b`: updater snapshot/event ordering, recoverable reads and
  actions, long-error wrapping, keyboard retry focus and concise update guidance.
  An independent production fixture passed 32 layouts and 15 behavior cases,
  including Sidebar error toasts; no native update or external request was made.
- `2134bfe99`: short-screen Web sidebar keeps navigation/session/root lists
  scrollable and account controls reachable; native environment-dialog close
  restores its trigger. Fourteen layouts and real keyboard navigation passed.
- `2dcd041ff`: Context settings cannot overwrite unknown settings after a failed
  read, accept normal numeric drafts, preserve failed save/reset drafts and name
  actual slider thumbs. Sixteen layouts and 24 related tests passed.
- `bd17170a6`, `9fab94dee`: accepted send/queue/Guide closes suggestions, rejected
  submission retains the draft, and later input/focus/scope operations invalidate
  stale caret callbacks. Ten submission and 15 deterministic caret cases passed,
  plus independent native-keyboard review.

Both merge conflicts preserved all changes: Appearance + Context fixture entries,
and the listbox useId + new caret hook in ChatView. CI now includes all 19 Desktop
browser fixtures and all three Web navigation/scrolling fixtures.

Third-wave changes were delivered to remote main at `505263089`. CI
`38722674533` passed all 12 jobs on attempt 2. The first attempt passed 11 jobs
but the existing paced-output smoke measured stream p95 265ms against its 200ms
limit: four worker fsync calls exceeded 200ms (maximum 280.062ms), while source
write, Main observation/snapshot and stdout writes stayed below 1ms. Diagnostics
were retained in `/tmp/codeshell-ui-wave3-ci-failure.log`; only the failed job
was rerun, with all thresholds and production code unchanged. They passed the
final combined local gate:

- `5efea027a` (source `7b00fb28e`): native keyboard-accessible AskUser options,
  IME-safe confirmation, rejection recovery and request-bound question state.
  Thirty-two production layouts, StrictMode and 41 related tests passed.
- `aaef664f3` (source `8a0c49ec4`): wrap long Approval/Tool card identities while
  keeping risk, error, duration and controls visible. StatusDot was measured as
  0×0 and transparent in all five states; it now renders an accessible 8px circle
  with state colors and a reduced-motion-safe running indicator.
- `bb39301a0` (source `9cac247f3`): preserve all receipt characters and original
  line breaks, including long URLs/hashes and 50-line answers. Sixteen production
  layouts passed; resolved receipts cannot resubmit.
- `1411d3c0f`: keep approval/question and composer scroll regions within their
  actual pane. Request existence owns the bounded mode, avoiding inline/sticky
  IntersectionObserver oscillation. Resize and focusin only scroll the region
  containing the current focus; no focus is taken from another control. The
  independent fixture passed 32 header layouts, 16 true ChatView layouts and ten
  behavior cases, including 120-frame stability, A→B decision identity and native
  Select resize/escape focus visibility.
- `cd0cbc026`, `c1a1b7f35`: retain the Figma overflow/recovery transport contract
  against current production sources in the shipped Node runtime. Isolated
  diagnosis reproduced intermittent multi-MiB node:http stalls in Bun 1.3.11;
  Node passed 300 repetitions. This is a test-runtime correction, not a production
  transport fix. The 8MiB/20s budgets remain unchanged, and exact-origin guards,
  four denied-network probes, cancellation/abort socket closure, physical request
  counts, credential state, 413 mapping and recovery remain asserted. Root's
  guarded provider suite passed 29 tests and 311 assertions.

Third-wave final local checks so far: all 14 workspace typechecks, full Desktop
build (main/preload/renderer/mobile/extension), lint baseline (0 errors, 104
existing warnings) and 3,395 guarded renderer/shared/Web tests with 12,590
assertions passed (one browser test separately covered). All 22 Desktop browser
fixtures passed, including 144 Quick Chat layouts, 120 interactions, 72 responsive
cases, the new Ask/receipt/tool/approval fixtures and all existing shared overlays.
Evidence
includes `/tmp/codeshell-ui-wave3-*`, `/tmp/codeshell-approval-portal-final-review.log`
and the independent task fixture reports.

The next-wave read-only ordinary composer audit reproduced a P1: twelve queued
items stretch the main composer to 726–742px, or 890–906px with a long draft, in
240/360/480px panes. Mouse wheel cannot reach input/Stop through the clipped root.
Keyboard-induced hidden-root scrolling does not count as a solution. The actual
Quick Chat panel already scrolls internally and has no queue interface. All queue
wire contracts passed. Independent implementation starts from `1411d3c0f` on
`codex/desktop/composer-overflow-20261015`; preserve all pending-interaction fixes.
Evidence: `/tmp/codeshell-ordinary-composer-audit-20261015/report.json`.

Two further independent review tasks are accepted for the next wave:

- Desktop Sidebar P1: in 800×360, the session scroller falls to 12px; in a
  390×360 drawer the account footer is outside the viewport. At 320×240, navigation,
  empty-state actions and account controls are clipped. Keep the content in a
  usable scroll region and the footer reachable, preserving pagination, session
  states and menus. Source `9862c50be`; production owned-bridge evidence:
  `/tmp/codeshell-desktop-sidebar-audit.mjs`. A separate tiny search-dialog content
  region at 320×240 is retained as a later P2, not part of the Sidebar fix.
- Settings navigation P2: clear-search and narrow search-result activation lose
  focus to BODY; switching across the responsive breakpoint while searching does
  the same, including an isolated native Electron 200% zoom. Hand off only
  settings-navigation focus to its visible equivalent, retain search selection,
  and preserve content/external/portal focus. Evidence:
  `/tmp/codeshell-settings-focus-review.log` and
  `/tmp/codeshell-settings-focus-electron-review.log`.

Fourth-wave implementations use separate branches/trees from the latest delivered
main: `codex/desktop/composer-overflow-20261015`,
`codex/desktop/sidebar-overflow-20261015` and
`codex/desktop/settings-nav-focus-20261015`. Integrate only their reviewed commits
on the current root branch, refresh main, and verify the final combination before
delivery. Third-wave CI must be checked before another main push cancels it.

Fourth wave delivered to remote main at `94f1a462b`. CI `38733481703` completed
successfully with all 12 jobs green, including real Electron, real win32, all
workspace types, guarded unit shards and all responsive browser checks.
The root branch contains these reviewed commits:

- `95579ea41` (source `dc92d56cd`): Sidebar content scrolls as one region while
  the account footer stays reachable. Resize/focusin only scroll the currently
  focused descendant. Twenty Chrome layouts, seven behavior cases and sixteen
  isolated native Electron 200% layouts passed, with no hidden-ancestor scrolling.
- `b536278d5`, `c4959f81a` (sources `85724a135`, `9ef67cddd`): active main chat
  with a queue reserves 40% for output and scrolls the composer in the remaining
  space. Without a queue, normal draft height is retained with at least 64px of
  output in short panes. New-chat nested scroll/focus bounds and actual pane
  width are respected; pending 60/40 and Quick Chat rules remain. Sixty production
  layouts and fifteen behavior cases passed, with original Ask/autocomplete,
  types/build/lint and independent review.
- `9fc5973bb` (source `1072834c8`): Settings clear/result/breakpoint focus
  ownership, search selection preservation and self-owned popup close restoration.
  Optional SimpleSelect/Notification close callbacks preserve other callers'
  default behavior. Chrome dev/production eight-layout matrices, isolated native
  Electron dev/production zh/en 100%↔200%, 25 guarded tests and independent
  production review passed. Synthetic composition only proves the event guard,
  not operating-system IME or VoiceOver acceptance. Root independently reviewed
  the 141-line ownership hook and component changes. The frozen combination is
  passed all 14 typechecks, full renderer/shared/Web shard, lint and all 25 browser
  fixtures; the separate Sidebar and 60+15 composer combined fixtures also passed.
  Root final types, Desktop full build, lint baseline and 3,395 guarded tests
  (12,591 assertions) passed; actual Electron Settings/search E2E passed. The
  first full browser run found an invalid extra variant root in the tool-card
  fixture's real-Chat mode: its outer main also claimed data-chat-variant, causing
  ordinary composer CSS to match a pending chat through the phantom ancestor.
  Production TSX only assigns that attribute in ChatView. The fixture now leaves
  the attribute on the standalone cards surface only, asserts exactly one variant
  root, and retains all bounds/wire/120-frame assertions. No production change or
  assertion weakening was made; the complete 25-fixture rerun passed before the
  fresh-origin fast-forward delivery.
- Root separately owns the accepted search-dialog short-window P2 on
  `codex/desktop/session-search-layout-20261015` in the clean reused
  `file-browser-ui-20261015` tree, checkpoint `c5b7473a7`. Scoped
  short-window density and wrapped mode labels increase 320×240 results from
  8px to 85–97px; title empty states fit. Owned production audit passes recovery
  and focus, but the new strict mouse-wheel fixture found a real unresolved
  headless-Chrome scrolling issue: error list client97/scroll128 can scroll programmatically yet
  native wheel20/40/800 never emits scroll, despite correct target and no prevented
  event. Independent release_audit confirmed six fresh cases. The same production
  source in isolated actual Electron 320×240 factor1 passed native mouse wheel
  and full Retry hit/visibility in both languages, so this is not established as
  a production transport/UI scroll failure. Runtime/harness diagnosis continues.
  Do not integrate or claim this search fix complete until actual mouse and
  keyboard reachability is proven. Root file:
  `shell/SearchDialog.browser.fixture.mjs`; logs
  `/tmp/codeshell-search-layout-fixture.log` and
  `/tmp/codeshell-search-native-wheel-review.log`. Existing shell 27 tests, scoped
  lint and Desktop/mobile typecheck passed. Keep the strict wheel assertion;
  temporary catch-only instrumentation and nonmodal diagnostic build plugin must
  be cleaned before final integration. Root has handed this clean tree/branch to
  release_audit exclusively; do not edit it concurrently. ui_audit independently
  investigates primary Playwright/Chromium sources and minimal harness variables.
  The runtime distinction is now demonstrated: native Electron and owned native
  headless-Chrome 320×240 popup windows pass wheel/Retry; a fresh context created
  directly at 320×240 also passes. The same existing headless Chrome page resized
  via viewport emulation fails native wheel even with modal=false, plain scroll
  divs, bringToFront, no blur, two gestures and 120-frame settling. Chrome
  155.0.8059.79 was used. Headful Chrome preserves the resize workflow and passes.
  Do not add a product wheel handler or blame Radix based on that harness failure.
  Preserve exact viewport, native wheel and full-button assertions in the final
  fresh/native-window harness; live resize also needs its own real-window proof.

Next read-only audits are delegated: bridge_test_fix owns actual Sessions/Runs
pages; ui_audit owns actual connection-configuration panels (models/text/speech/
search). Both must use only owned bridge/state and report reproduced issues
before implementation on a fresh branch from the next delivered main.
The Sessions/Runs audit has now confirmed and accepted the next implementation
scope: a 320×360 Runs pane can have zero detail height even with no model rows;
12 valid per-model usage rows reduce a 480px pane's list/detail to 16/26px. A long
Sessions read error pushes its only Retry below a 320×360 pane, and wheel cannot
reach it through AppMainView's hidden ancestor. Preserve complete model evidence,
history identity, pagination and authority while bounding and scrolling the
page content. Refresh/delete failure focus is being checked as the same recovery
boundary. Evidence: `/tmp/codeshell-history-ui-review-report.json`,
`/tmp/codeshell-runs-usage-800x480.png`,
`/tmp/codeshell-sessions-error-320x360.png`.
The connection audit independently confirmed Search settings recovery failures:
a rejected Tavily default-provider write leaves a false Default marker and an
unhandled rejection; a rejected Serper Clear loses the unsaved draft, and a
held Save overwrites newer typing on success. The actual Settings→Connections
owned-bridge fixture also reproduced a 280px card minimum exceeding a narrow
nested group, plus long connection IDs widening the page. Evidence:
`/tmp/codeshell-connections-ui-audit-20261015/report.json`. Accept recovery and
actual-pane card bounds as the next independent scope; preserve persisted
connection/provider identity, confirmation and all existing probe authority.

Fifth wave is now implementing three independent scopes from delivered main:
release_audit owns Search and its exact viewport/native-wheel harness in the
file-browser tree; bridge_test_fix owns `codex/desktop/history-page-recovery-20261015`
in the desktop-bridge tree; ui_audit owns
`codex/desktop/connection-settings-recovery-20261015` in the context-settings tree.
Root integrates reviewed commits in the current UI5 branch, preserves incoming
main and verifies the final combination before another push. UI4 CI is now green.

Search is now complete and integrated as `9882f5b35` (source `ed1bc6374`, parent
`94f1a462b`). The final six-file commit contains scoped short-window density,
fully wrapped search mode labels and a 371-line production fixture, registered
as the 26th browser check. Chrome uses fresh contexts at each exact initial
viewport; Electron uses actual BrowserWindow content sizes and also proves wheel
after every live resize. Both passed 32 layouts/102 observations with strict
wheel, full Retry bounds/hit, unchanged action wires, query/focus retention,
synthetic composing guard and Escape return. All hidden/clip ancestors stay at
scroll zero; no product wheel handler or diagnostic build plugin remains. Types,
renderer build, scoped lint and 24 guarded tests passed; independent review was
green. Root independently passed the integrated 32/102 fixture. The unpublished
checkpoint history is retained on
`codex/desktop/session-search-layout-checkpoint-20261015` (`b48e9b9d3`).
Root also independently passed all 32/102 Electron layouts and native live-resize
wheel checks after integration; evidence `codeshell-search-layout-cgJAWY` and
`/tmp/codeshell-ui-wave5-search-native-combined.log`.

The actual Settings→MCP audit confirmed the two detail viewers have no dialog
role/focus containment/Escape ownership, leave keyboard focus in background
actions and push Close offscreen with long server names. Owned bridge evidence:
`codeshell-mcp-details-audit-zr8R5s/report.json`. release_audit now owns
`codex/desktop/mcp-detail-dialogs-20261015` in the clean sidebar worktree, based
on main `94f1a462b`. Accepted scope is only ToolsViewer/ErrorDetailViewer modal
keyboard/focus recovery and complete long-content bounds. Preserve every tool
and raw diagnostic; no MCP probe/save/trust/credential/transport changes.
Its completion and independent review determine whether it joins UI5 or UI6.

UI5 History is integrated as `b192e9cc9` (source `0dc8b31dd`, base `94f1a462b`):
complete model usage has a bounded named keyboard scroll region, list/detail
retain useful minimum reading areas, and Sessions owns its error/empty/list
scrolling. Refresh/delete/rename use synchronous guards and focus ownership;
failed drafts remain, external field/blank clicks prevent recovery focus theft.
Source checks passed 19 guarded tests/143 assertions, Desktop/mobile types,
renderer build, scoped lint/format, 8 Chrome layouts and 4 actual Electron
language/100–200% zoom layouts. ui_audit independently reviewed and passed the
production matrix. The same final fixture against unmodified Root history
failed directly on minimum readable run detail height; evidence
`/tmp/codeshell-history-page-recovery-before.log`.

UI5 Connections is integrated as `9cd1cbe66`/`a5552da9d` (source
`1054493cf`/`89c3eda85`, base `94f1a462b`). Search writes commit UI state only
after success, preserve newer provider drafts and selection, serialize pending
operations and protect unknown settings after failed reads. Actual user/project
wire contracts and legacy credentials remain intact. Shared cards fit their
actual pane and long IDs/subtitles wrap. Source checks passed 50 guarded
tests/72 assertions, Desktop/mobile types, renderer build, scoped lint/format,
24 production layouts/187 observations and independent bridge review. Strong
document-height/hidden-ancestor assertions caught an escaping sr-only heading;
the final local `relative` containing block fixes it without global shell edits.
Evidence `codeshell-connections-ui-p5YgCr/report.json`; baseline fails the same
default-provider and long-ID assertions. Root reviewed the final source and
registered both new fixtures; combined UI5 gates remain pending MCP delivery.

MCP is now integrated from `febb3dee2` (parent `94f1a462b`); only the two
viewers and their actual opener capture changed. Complete tools/raw diagnostics
remain; standard dialogs contain Tab, close with Escape and return only owned
focus. External pointer/focus, window blur and unmounted targets cancel return.
Source Chrome 16 layouts/84 observations and real Electron 16/96 (including
12 actual live-resize observations) passed with no errors/outside requests/
mutations. Types, renderer build, lint/format and 13 lifecycle tests passed,
with two independent product reviews green. Before evidence fails directly
because the old viewer has no dialog role. Root registered the MCP fixture;
UI5 now freezes Search/History/Connections/MCP for combined gates, 29 browser
fixtures in total. No additional release/version change is planned.
Combined all 14 workspace types, lint (0 errors/104 existing warnings) and full
Desktop main/preload/renderer/mobile/extension build passed. Guarded units passed
3399 tests/12595 assertions across 372 files (one separately browser-covered
skip); all 29 browser fixtures passed. Sequential production full-app Electron
Settings, Search and Operations pages all passed. Logs are
`/tmp/codeshell-ui-wave5-{typecheck,lint,desktop-build,unit,overlays,native-settings,native-search,native-operations}.log`.
Root independently verified every final scope in the combination and refreshed
remote main before delivery. UI5 is delivered at `bef6e513e` and independently
confirmed by remote ls-remote. CI `38740819315` completed with all 12 jobs
successful, including real Electron, real win32 and the full desktop/browser
shard. Current integration now starts UI6 from the
delivered main while its three independent scopes refresh against that base.

The repository's later release `v0.9.44` was published at 09:44:42Z with all
14 native/update assets present. This follows our verified `v0.9.43` publication;
preserve that later release and collect UI work under Unreleased.

Root's production TopBar→NotificationHistory audit passed 16 language/theme/
window combinations down to 320×240 with 40 complete long notifications, native
wheel, keyboard reachability, full final actions and exact Escape focus return.
No product change is needed; evidence
`/tmp/codeshell-notifications-ui-audit-20261015/report.json`. The initial immediate
post-unmount focus sample was premature; waiting for Radix close autofocus
confirmed correct return in every case without modifying product behavior.

Next independent candidate: valid long cloud environment/project names make
NewProjectDialog's linked-project view scroll 2073px inside a 286px client width.
CloudProjectSignIn starts at 2310px scroll width and a rejected owned login leaves
BODY focus; native form focus can scroll Close to negative x. Root reproduced
18 production component layouts with zero page errors/outside requests and
confirmed active App/CloudProjectWorkspace entry points. Evidence:
`/tmp/codeshell-project-dialogs-ui-audit-20261015/report.json` and screenshots.
ui_audit may independently verify after Connections delivery. Any accepted fix
must be limited to layout/focus recovery, preserving login identity, authority,
password clearing, duplicate-submit, stale-binding and reconnect semantics.
Independent ui_audit reproduced long-name overflow and normal-name SignIn
failure (6/6 BODY after settling); local chooser failure retains its own button.

bridge_test_fix independently confirmed CloudProjectWorkspace metadata can
collapse an enabled restored draft and output to zero after a definite connected
send failure: native 800×480 at actual 200% zoom (400×240) has a 397px long-error
alert above a 0px chat. Keyboard can focus the clipped textarea and shift the
hidden app ancestor; native wheel cannot recover it. Names tested stay within
host/server limits (128/80). Accepted scope is only complete bounded, named,
keyboard-scrollable identity/status/error metadata and existing action/focus
reachability, preserving all ChatView/runtime/send/auth behavior. New branch
`codex/desktop/cloud-workspace-metadata-20261015` may start from current origin
main `94f1a462b` because this component is unchanged, then must refresh against
delivered UI5 before final gates. Evidence `/tmp/codeshell-cloud-banner-review-report.json`
and `/tmp/codeshell-cloud-banner-native-report.json`.

UI6 also accepts ui_audit's independently reproduced Cloud chooser/sign-in/
manager layout and owned failure-focus scope on
`codex/desktop/cloud-dialog-recovery-20261015`; preserve all authentication,
identity, password-clearing, uncertain-state and request guards. release_audit
owns `codex/desktop/profile-dialog-layout-20261015`: actual Settings Editor,
Memory and Switch dialogs have existing modal semantics but lose Escape focus,
scroll Close outside short windows and overflow with long content. Limit changes
to bounded header/body/footer, complete content and safe actual opener capture;
preserve save/switch/memory/capability business. Each starts from fresh main
`94f1a462b` because these files are unchanged, then must refresh delivered UI5
before final verification. Independent owned fixtures only; no real credentials,
provider traffic or configuration writes. Native windows are coordinated.

Primary checkout currently remains on another task's main at `2e0462c68`,
containing other local task commits, plus pre-existing `.claude/` and
`docs/todo/browser-panel-runtime-design.md`. Leave it untouched; task delivery
uses the clean integration checkout and does not publish unknown local commits.

UI6 metadata is integrated as `df9ad21f4` (source `488944948`, refreshed source
merge `9e779bfe1` against delivered UI5). Only CloudProjectWorkspace layout and
owned focus visibility change: complete status/error metadata stays within 40%
of the pane, leaving useful ChatView space, with named keyboard scroll and
ResizeObserver adjusting only a currently focused metadata descendant. Source
production/development Chrome 8+8 layouts, actual Electron language/100–200%
zoom 4 layouts, 16 guarded tests/46 assertions, Desktop/mobile types, renderer
build and scoped lint/format passed. Independent ui_audit/Root product review
found no blocker. Exact legal 1015-character before source leaves chat height
zero; after preserves full error/name/draft/identity/action wires, portal focus
and all hidden ancestor/document bounds. Root registered the 30th fixture.

Root also owns `codex/web/model-editor-focus-20261015` in the exclusively reused
file-browser worktree, from UI5 `bef6e513e`. Actual Workbench with 12 connections
opens a last-row editor thousands of pixels above the viewport and leaves BODY
focus on open/cancel/save failure; dirty Continue likewise loses focus. Scope
is inline editor open/close/owned failure/Continue focus, keeping all API,
secret, revision, validation, draft and confirmation behavior. Independent
bridge checks confirmed source ownership guards and 12 held-write outcomes,
with real field/blank interaction; window-blur cancellation is synthetic,
not an OS-level claim. Root's strict document-height assertion additionally
caught an escaping absolute sr-only legend; a local positioned editor fixes
612px document height in a 360px pane. Formal production/development 8 layouts/
10 behaviors, 524 guarded Web tests/2452 assertions, types/build/lint have
passed before that CSS bound; final reruns with the retained tighter assertion
are in progress. The same final fixture against unchanged UI5 fails directly
on visible/focused model field, not a timeout.
Final Web source is `81bae2e8b`/`ea35fe965`; production and development 8/10
reruns, public isolated test command, final app build and scoped lint all pass
with document width/height and hidden-ancestor assertions retained. bridge
independently passed the final production 8/10, CSS review, 12 held-write
outcomes and dirty Continue in three sizes. Source hooks match reviewed blobs
`6fe8acdbc4`/CSS `d87d44babc0`. The fourth Web browser command is registered in
the existing desktop CI shard after browser installation/workspace build.
Root integrates both commits into UI6; only Cloud dialogs and Profile dialogs
remain outstanding before combined gates.

UI6 Cloud dialogs are integrated as `8eb2fe4ed` / `550724291` / `cff9a7dc7`
(source `6c6611f95` / `15b2aebbd` / `2e479aa3f`), with the 31st public Desktop
fixture registered. Chooser, manager and re-login keep bounded header/body,
complete legal names/errors and visible Close. A local operation focus lease
retains captured identity and cancels after explicit pointer/focus handoff,
window blur, identity changes and unmount; uncertain manager failures still
require Reload, failed login still clears its password. Native disabled-control
FocusScope fallback is accepted only while the original operation owns focus.
ResizeObserver only scrolls marked owned auto-scrollers with a current focused
descendant, never the hidden shell or focus itself. Source production Chrome
141 observations, development 33, actual Electron 69 including true 100/200%
zoom and live resize, 21 guarded tests/42 assertions, Desktop/mobile types,
renderer build and lint/format passed. Root and bridge independently reviewed
the frozen source; final combined UI6 verification remains outstanding.

Root's combined metadata + new Cloud sign-in portal Chrome matrix passed all
8 layouts without errors. Additional read-only actual SettingsPage Appearance
and Shortcuts review passed 32 language/theme/window cases down to 320×240;
both sound/music sliders retain keyboard focus and hit visibility, all owned
layout/document bounds hold and outside traffic/page errors are zero. Existing
intentional theme/nav title truncation is not an overflow regression. Evidence
`/tmp/codeshell-audio-shortcuts-ui-audit-20261015/report.json`; no product edit.

UI7 accepted candidates from bridge's real Workbench owned-HTTP evidence:
Skills detail GET finishing after the user resumes search steals input focus
and later typing; create-close tries to focus its still-disabled opener before
React re-enables it. bridge owns the local asynchronous pane/return focus scope.
Models default save and connection deletion reject while the only error sits
above the viewport (320 default error y−118; last-row deletion y−3302, also
y−2272 at 1280). Confirmation initially opens below the short viewport with
BODY focus. ui_audit may own local feedback/confirm/focus recovery after its
independent Profile review. Keep original writes, revisions, replacement rules,
drafts, refresh and authorization semantics. Evidence
`/tmp/codeshell-web-settings-readonly-review-report.json`; neither fix is part
of UI6 until independently completed and explicitly integrated later.

UI7 Skills checkpoint `dae09e610` is clean and ready for refresh after UI6.
Only HubSkills, its local CSS and `scripts/test-skills-browser.mjs` change.
Production/development StrictMode 34 observations each, 16 guarded tests/59
assertions, types/build/lint/format passed; ui_audit independently reviewed.
Old Root `12ca02005` has the same HubSkills blob as delivered UI5; formal close
and held-read tests fail directly there. Callback ownership spans the actual
click through asynchronous response; still-focused filters stay visible when
the pane is inserted, and close waits for React's re-enabled opener.

UI7 MCP checkpoint `96357a2a4` is clean in the exclusively owned file-browser
tree on `codex/web/mcp-ui-recovery-20261015`, with the verified Web model editor
commits as prerequisites. Only HubMcp, local CSS and its new browser fixture
change; public commands/CI registration await UI7 integration. Actual Workbench
read-only baseline reproduced edit/cancel BODY focus and failed edit/removal
errors thousands of pixels above the viewport in 320/1280 windows. Local
bounded full error feedback now remains with the operation, a remounted Edit
opener is resolved by service identity, and source-owned recovery cancels on
explicit pointer/focus handoff, blur or unmount. Regular save cannot probe;
explicit Save and Test retains its exact owned HTTP sequence. Native disabling,
401 auth loss, original credentials/reuse consent, cancellation and inheritance
guards remain. Strict production/development each pass 30 observations,
524 guarded Web tests/2452 assertions, types/build/lint/format pass. Final
product blob `5982ace2b` / CSS `3eb874589` differs from bridge's reviewed Node
version only by formatter whitespace. Root's before test fails directly on
focused/hit input and 3140px document height. bridge additionally reproduced a
real Workbench rail brand SVG pointer handoff missed by HTMLElement-only guards;
the Node fix passes its four edit/remove × success/rejection cases without
reclaiming focus. Evidence `/tmp/codeshell-web-mcp-svg-peer-{review,after}.log`,
before `P9SjEx` / after `q12vgQ`; do not describe Root's injected SVG case as
the actual entry proof. No UI7 change has been pushed yet.

UI6 Profile dialogs final source `0f8a718ec` is integrated as `6464cf566`,
with the 32nd Desktop browser fixture registered. Editing, memory and switch
review use bounded content and visible Close/footer actions, with the actual
More/Edit/Deactivate opener captured by callers. Focus intent spans asynchronous
requirements and preview, explicit nested confirmations and Select portals;
external focus/pointer/window blur permanently cancels return. Old closing
callbacks consume their own content's lease, so rapid A-close/B-open cannot
dispose or restore B's ownership. Resize only scrolls marked owned content for
the current focused descendant. Native Save/Apply retain focus via aria-disabled
while original synchronous save/adopt/close guards still block duplicate work.
Original memory/capability/preview/adopt/configuration wires are preserved.
Source production Chrome 16 layouts/968 observations, actual Electron 16/1004
including true 200% zoom and 36 focus-preserving live resizes, 68 guarded tests,
Desktop/mobile types, renderer build and lint/format passed. ui_audit independently
verified held preview, held requirements, delayed close blur and rapid reopening
in production/development; Root read the final ownership helper and callers and
reviewed wide/narrow screenshots without a new blocker. Strict before source
fails directly on 138px hidden dialog scroll. Root's integrated Cloud metadata
and new SignIn portal additionally passed all 4 native language/100–200% cases.

At UI6 freeze the primary checkout has advanced under another task to
`f158ed9b5`, 30 local commits ahead of remote UI5 `bef6e513e`, including panel
launcher and child conversation work. The pre-existing untracked files remain
unchanged. Continue delivering only this goal's clean integration branch; do not
publish, reset or synchronize those other local commits.
UI6 combined gates now start after a fresh fetch; UI7 changes remain separate.

UI6 final combined gates passed on the frozen product source. All 14 workspace
types, full Desktop main/preload/renderer/mobile/extension build, lint (0 errors,
104 existing warnings), all 32 Desktop browser fixtures and four isolated Web
browser commands passed. The guarded combined shard completed with 3399 passes,
12603 assertions across 372 files, and one existing Chromium-covered skip.
The first shard found three legacy source-string expectations for old Close
and create-callback wiring; source `c11f983a0`, integrated as `aba4829ff`, updates
only that contract test while retaining pending-close guards and actual creation
requirements. The full zero-failure shard rerun is recorded; product code did
not change or require repeated layout/build checks. Native full-App Settings
and DigitalHumans E2E passed sequentially, plus the four combined Cloud metadata
/ new SignIn portal native language/100–200% cases. Scoped follow-up lint,
format and diff checks passed. Logs: `/tmp/codeshell-ui-wave6-{typecheck,lint,
desktop-build,unit,overlays,web-latest,web-sidebar,web-files,web-settings,
native-settings,native-digital-humans,cloud-metadata-native}.log`.
UI6 was pushed and remote main confirmed at `3c6d8573f`. CI `38755011185`
has passed 11 of 12 jobs, including Electron E2E; the Desktop test job is still
running. Continue to preserve other tasks' local main commits.

UI7 integrates only source changes for Web Skills (`7d874cabd`), model action
recovery (`99cc938d1`, `5e8deab0d`, `b9330f911`) and MCP recovery
(`a3559b1bd`, `6d5d14d31`). MCP's queued-refresh follow-up retains the visible
error and owned recovery after a rejected removal is followed by an updated
configuration where the target disappeared. Independent production cases cover
owned, external field, blank pointer and window blur at 320x240 and 390x360;
each preserves exactly one DELETE and two reads. Final production/development
fixtures each pass 34 cases, with no outside request or page error.
The three new Web browser commands are registered in the existing isolated CI
step. Desktop ModelPill source and its native fixture are being finalized as the
fourth scope. Final combined gates and delivery remain pending.

Initial audit history follows:

- Read-only audit is in progress, including Desktop and mobile/Web.
- Initial mobile candidates were excluded after entry-point inspection: those
  components are legacy code, and the actual mobile entry uses Web DesktopApp.
- Active Desktop candidates include FilesPanel read-error/empty states,
  keyboard-visible file actions, IME-safe comment dismissal and theme-removal
  error feedback. Reproduce before implementing.
- Chromium reproduced the FilesPanel blank read-error state, three invisible
  focused actions and CommentBox composition Escape cancellation. Web HubFiles
  also shows stale root entries after a failed request to another directory.
  Evidence: `/tmp/codeshell-ui-audit-2026-10-15/`.
- Further confirmed review targets: composer/listbox accessibility links,
  theme uninstall recovery and mode selection semantics, plus a return-to-latest
  control in the Web conversation view.
- Layout audit reproduced unreadable preview widths in the default 480px
  Desktop dock, a 390x360 Task center with its list below the viewport, and Web
  mobile previews opening below the visible content. Evidence:
  `/tmp/codeshell-ui-layout-audit-2026-10-15/`.
- UI implementations are isolated from the release: Desktop file browsing,
  compact Task center filters and Web file browsing each have a task worktree.
  Their commits will be integrated after the current version is tagged.
- Baseline UI verification passed: all 11 responsive overlay fixtures and real
  Electron navigation/settings tests. Captured screenshots are retained under
  `/tmp/codeshell-ui-20261015-navigation` and `/tmp/codeshell-ui-20261015-settings`.
- Use production component browser fixtures and isolated Electron E2E for visual
  evidence. Prioritize reproduced user-visible issues and consistent UI behavior.
- Each concurrent implementation uses its own task branch/worktree. Keep Panel
  business changes in the independent `codeshell-panel-apps` repository.
- Preserve primary checkout's `.claude/` and
  `docs/todo/browser-panel-runtime-design.md`; they are not task-owned.

## Continuation

- Heartbeat: `codeshell-ui-10-16-11`, every half hour until the deadline.
- Goal remains active. Do not mark it complete before the authorized timed work
  and final report are finished.
- Use guarded test runners and isolated application state; avoid live paid model
  calls. Record verified results and exact commits here as work progresses.
