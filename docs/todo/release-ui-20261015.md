# Release and UI review — 2026-10-15

User authorization: publish the pushed code, then continuously review and improve
the overall UI until **2026-10-16 11:00 Asia/Singapore (03:00 UTC)**.
Stop starting changes at the deadline; preserve and verify outstanding work,
deliver a final report, and disable the follow-up heartbeat.

## Release

- Baseline: `origin/main` `bb01243ac`; latest public version `0.9.42`.
- Prepared version: `0.9.43`, commit `b149c8f44` on
  `codex/release/0.9.43-20261015`.
- Worktree: `/Users/admin/.codex/worktrees/release-ui-20261015/codeshell`.
- Publication is pending. Main CI `38703068601` exposed stale Link action
  counts, a one-line architecture-budget excess, inherited bridge enumerability
  in a React test and an obsolete native-select/external-track theme E2E.
- Integrated test fixes `1ae1b1974` and `3fa768267`; theme E2E now uses the real
  Radix selector and validates local playback. No release tag exists yet.
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
