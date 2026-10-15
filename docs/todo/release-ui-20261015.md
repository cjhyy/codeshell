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
`codex/integration/ui-review-wave4-20261015`. Other work advanced remote main to
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

Fourth wave in progress (root branch contains the reviewed commits):

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
  running all 14 typechecks, full renderer/shared/Web shard, lint and 25 browser
  fixtures; the separate Sidebar and 60+15 composer combined fixtures passed.
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
