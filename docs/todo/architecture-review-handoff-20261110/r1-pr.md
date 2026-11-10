# chore(architecture): remove retired Arena workspace

R1 deletes the unused private Arena workspace, its dormant and excluded TUI command, and the unreferenced Arena CLI preload fixture. Workspace aliases, ESLint lists, Docker manifests, release metadata, test shard inputs and current architecture references follow the deletion. The workspace count becomes 13; CDP removal remains R2.

Base and last pre-deletion source reference: `fcd8406d51bf34696417dd9dd90c609f1d5ca640`. Branch: `codex/architecture/r1-remove-arena`. Worktree: `/private/tmp/codeshell-architecture-h1`. Commit: `f667c728e80a33711fd29b708c6dca347023bd3c`. No PR or merge has been performed; publication and CC review belong to the coordinator.

## Retained contracts

- Existing Core export/tool/preset guards and TUI CLI/onboarding rejection of retired Arena entry points remain intact.
- Logout and settings migration still clean old user `arena` settings.
- Release recovery still recognizes old tagged job names.
- Historical dated/archive documents and all `docs/architecture/archify` artifacts are unchanged. Earlier audit observations in chapter 12 remain explicitly historical.
- Core `/extension` exports remain unchanged. The task's 13 now-unused symbols (`ClientDefaults`, `Colorizer`, `ContentBlock`, `ModelEntry`, `ModelPool`, `NOOP_COLORIZER`, `ToolCall`, `addTokenUsage`, `extractJSON`, `extractJSONArray`, `resolveMaxOutput`, `webFetchTool`, `webSearchTool`) remain published contract decisions for the owner.

## Evidence differences and coverage

- The rest shard drops by exactly 11 Arena test files, from 392 to 381 (budget 400). No new test file was added.
- Additional current architecture references existed in chapters 03 and 05: the Arena LLM-consumer row and capability import boundary lists. Those current references were removed mechanically along with the requested chapter 06/07/00/index updates.
- Chapter 12 gets only the Arena-removal correction here; E2 owns the wider release-unit rewrite. Its pre-convergence export-count snapshot and audit history remain as historical evidence.
- The private-workspace rejection tests now use the existing `browser-devtools` private package. The ESLint capability-boundary probe now runs in Pet. Their rejection assertions remain unchanged in meaning.

## Validation

- PASS on the committed candidate: `bun /private/tmp/codeshell-r1-verify/scripts/check-test-shards.ts` in a clean detached checkout of `f667c728e`: 2,664 files covered; rest 381/400, rest-server 240/240, Desktop 765/772. Log `/private/tmp/codeshell-r1-shards-final.log`. The initial pre-staging invocation failed because the guard reads `git ls-files` and still saw deleted Arena files; that invocation is not counted as passing.
- PASS: `git diff --check`; only modified code/config files were formatted.
- PASS: `bun run typecheck`, including its prerequisite full root build and all 13 workspace typechecks; log `/private/tmp/codeshell-r1-typecheck.log`.
- PASS: `bun run lint`: 0 errors, 90 warnings (baseline maximum 98); `bun run lint:engine-bypass`; logs `/private/tmp/codeshell-r1-lint.log` and `/private/tmp/codeshell-r1-engine-bypass.log`.
- PASS: isolated runner over the three required contracts plus `tests/eslint-boundary-guard.test.ts`: 32 pass, 0 fail, 265 assertions; log `/private/tmp/codeshell-r1-contracts.log`.
- PASS: isolated runner over Core export, tool-registry, preset, settings-manager, and TUI CLI option guards: 72 pass, 0 fail, 411 assertions; log `/private/tmp/codeshell-r1-retained-guards.log`.
- BLOCKED: `bun run test:package-release` completed ten public packages' clean-build/pack/extract, strict NodeNext declaration checks, 50 runtime-entry imports, and strict published owner-auth consumer compilation. Its final packed owner-auth HTTP lifecycle failed at `listen(127.0.0.1)` with `EPERM`. The whole command is not a pass; re-run outside the restricted sandbox. Log `/private/tmp/codeshell-r1-package-release.log`.
- BLOCKED: lockfile regeneration. The first attempt could not write Bun's default cache temp data; a task-owned `BUN_INSTALL_CACHE_DIR` fixed that permission issue. `bun install --lockfile-only --ignore-scripts --offline` still attempted registry connections, all denied by the sandbox. Copying 1,328 existing `.npm` cache metadata files reduced requests but did not eliminate them. `--prefer-offline` and a final `--frozen-lockfile` attempt likewise exited 1 with manifest `ConnectionRefused` / `FailedToOpenSocket`. Logs: `/private/tmp/codeshell-r1-lockfile-cached.log`, `/private/tmp/codeshell-r1-lockfile-prefer-offline.log`, `/private/tmp/codeshell-r1-lockfile-frozen.log`. `bun.lock` remains **unchanged and still includes Arena**; it must be regenerated with Bun in a network-enabled environment before this task can meet full acceptance. No lockfile was hand-edited and no dependency version upgrade was accepted.
- Full CI shards and GitHub required checks remain the coordinator's final combined-candidate acceptance; they are not claimed here.
