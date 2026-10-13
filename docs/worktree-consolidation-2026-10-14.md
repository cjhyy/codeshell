# Worktree consolidation, 2026-10-14

This integration retains useful work from completed task branches without
replacing the current release tree with an older checkout.

- `codex/examples/computer-use-mini`: dependency-free simulated calculator and
  stdio RPC walkthrough; it makes no model calls or real desktop operations.
- `codex/review/remaining-modules-20261012` and
  `codex/review/server-desktop-20261012`: historical review reports and recorded
  reproduction evidence. Findings, paths, versions and results describe the
  original baseline, not the current release's acceptance status. Evidence logs
  are retained verbatim.
- `codex/browser/devtools-module`: private browser diagnostics workspace,
  consumed by Desktop and aligned with the current workspace release version.
- `codex/core/producer-journal-storage-spike`: isolated, inactive research
  fixture; see its README for the boundary and guarded tests.
- `codex/operations/host-batch-slots`: fixed Native issue-batch proposal,
  approval and per-Run authority, plus preserved synthetic acceptance fixtures.
  Source fixtures for manual Native dialog and worker checks are retained;
  merely including them does not claim that those manual checks were performed.
- Local `main` commits for room discovery, project execution location and CUA
  setup are integrated through this clean task checkout and validated together.

Cleanup preserves original Git tips under local
`refs/cleanup-preserved/20261014-pcigcfaq/` references. Non-reproducible ignored
evidence is archived outside disposable worktrees before they are removed.
Active worktrees and unfinished modifications stay with their owners.
