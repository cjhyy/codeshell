# C1 — Move home path helpers below Settings and Session

Base: `codex/architecture/g4-mock-module-ratchet` (`63c19a06ed6f9606e1af703713cefabede47b51d`). Stacked draft; do not merge before independent CC review.
Branch: `codex/core/c1-path-helpers`. Worktree: `/private/tmp/codeshell-architecture-g1`.

Moves the original `userHome` and `codeShellHome` implementations and comments into node-only `utils/paths.ts`, preserves the old Settings/Session re-exports, and repoints 23 production importers. `HOME ?? homedir()` and `CODE_SHELL_HOME || join(homedir(), ".code-shell")` remain distinct, including empty-string behavior. No `sessionsRoot` code/guard edits or public-entry changes.

Evidence difference: the checklist's 30/15 usage counts include unrelated local same-name helpers; those are not merged. Removing runtime's Session edge exposed an existing reverse `utils/execFileNoThrow -> runtime/spawn-common` edge. To satisfy the no-new-cycle guard, mechanically extracted `isBrokenPipeError`, `killChildTree`, and their Windows helper into node-only `utils/process-tree.ts`, retaining old runtime exports. No process behavior or stateful runtime manager moved. G2 upward allowlist 29 -> 28; same-layer pairs 6 -> 5 (model-catalog/settings removed). No new exceptions.

Validation:
- Full `bun run build`: PASS, log `/private/tmp/codeshell-c1-build-20261110.log`.
- Full `bun run typecheck:workspaces` after build: PASS. After the subprocess extraction, repeated Core build/typecheck: PASS.
- Guarded 9-file targeted suite (Settings paths, session home guard, public exports, spawn helpers, execFileNoThrow, architecture/package contracts, unchanged composition golden): 122 pass / 0 fail. `/private/tmp/codeshell-c1-final-targeted-20261110.log`.
- Three whole-repo contracts separately: 29 pass / 0 fail. `/private/tmp/codeshell-c1-contracts-20261110.log`.
- `lint:test-shards`: PASS (2675 files); `lint:engine-bypass`: PASS.
- Changed Core files ESLint: 0 errors / 4 pre-existing warnings. Architecture guard retains the original 2 known regex-space lint errors (not changed in this task).
- Core shards attempted using guarded `bun run test --shard`: shard 31 completed 352 pass / 2 fail (SessionStart engine-dependent tests); shard 32 completed 508 pass / 115 fail (filesystem identity/storage tests). Shards 1 and 2 stopped after repeated sandbox-driven failures/timeouts: 65 pass / 21 fail and 1788 pass / 25 fail lines observed, respectively; these are partial results, not suite totals. Logs `/private/tmp/codeshell-c1-shard{1,2,31,32}-20261110.log`. Coordinator separately reproduced diskutil/Engine initialization failures on baseline; rest shard also reports inability to bind local port 0. No claim that the affected shards pass locally.

Remaining verification: full CI unit shards, platform smoke/E2E and independent CC review require the final candidate/environment. No paid eval or real credentials used; no new test file or mock.module; no fixture update. No PR has been created by this delegated worker.
