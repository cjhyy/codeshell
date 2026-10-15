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
`codex/integration/ui-review-wave1-20261015`. Other work advanced remote main to
`0.9.44`; this branch merged `976a79322` and `bb7a9b59a`, preserving the incoming model-capability,
forwarding and Figma updates. The CSS merge preserves both context-selection and
file-action styles. Do not revert incoming work or republish another version on
the assumption that `0.9.43` is still the repository manifest version.

Implemented task commits (integration hashes):

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

These product changes are awaiting final combined verification and integration
into main. The combined 14-workspace typecheck, complete Desktop build, ESLint
baseline and the two Web production-browser fixtures have passed. The complete
renderer/Web unit shard and 15 Desktop browser fixtures are running. CI now also
runs both Web browser fixtures with the already-installed locked browser.

The second review wave uses independent trees: Desktop context settings read,
edit and reset recovery; Web workspace/session navigation; and autocomplete
cleanup after an accepted send. Continue with the current commits and evidence
instead of redoing the initial audit.

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
