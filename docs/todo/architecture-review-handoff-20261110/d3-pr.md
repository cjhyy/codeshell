# D3: pilot Desktop module lifecycle with External Runtime

Draft PR for `codex/desktop/d3-runtime-module-registry`, stacked on R2 `b92e6dfa27d77771cf168095e6fc12f325ea44c7` (`codex/architecture/r2-remove-legacy-cdp`). Worktree `/private/tmp/codeshell-architecture-h1`; original task baseline `fcd8406d51bf34696417dd9dd90c609f1d5ca640`. Candidate commit `4207e8aa876f735c3ad29255c3ecbb555633c8a8`. No published PR number and no independent CC review yet.

External Runtime's service and approval state now belong to one lazy module. `desktop-shutdown.ts` defines the minimal named `start`/`dispose` contract and a registry that starts synchronously in registration order, disposes in reverse order, and awaits each cleanup. Partial starts participate in cleanup; a cleanup failure does not skip preceding owners. Repeated starts/disposals coalesce, duplicate names and restart after disposal are rejected.

Only this domain is registered. Main still supplies all window ownership, project authority, feature flag, tool-context, approval mirroring and stream-delivery callbacks. Registration acquires no service resources. The single `desktopModules.start()` remains exactly in the first-window `if (!bridge)` block after AgentBridge/subscription creation, before external Goal wiring; it adds no `await`. Shutdown calls the registry exactly where the old `externalRuntimeService.stopAll()` ran, after room teardown and before Cua child stop, and keeps that promise in the existing `Promise.allSettled`. The module calls stopAll before synchronously clearing its service getter, preserving the old shutdown boundary. The approval instance remains captured for existing teardown callbacks, as before.

No AgentBridge implementation or Pet domain is migrated. No IPC literal, public export, protocol field, persistence format, dependency or generated fixture changes.

## Measured evidence

- AST comparison of all 11 authority/routing properties against the R2 parent is identical after formatting: approvals `windows`, `ownerWebContentsId`, `onPendingChange`; service `featureFlags`, `registerSession`, `releaseSession`, `resolveProjectBinding`, `emit`, `sessionStateChanged`, `toolContextOverrides`, `backgroundWork`. Proof script `/private/tmp/codeshell-d3-move-proof.mjs`.
- `index.ts`: 4589 → 4576 lines (-13); `createWindow`: 1349 → 1295 (-54); top-level `let` declarations: 31 → 29. Both mutable external-domain fields moved into the module.
- Existing 5000-line budget remains unchanged: `ceil((4576 + 100) / 500) * 500 = 5000`. Lowering to4500 would violate the stated >=100 spare-line rule; reaching that band requires <=4400 lines. The pilot does not expand into another domain merely to change this number. No budget was raised or replaced with an exact count.
- Before moving code, searched tests that mention/read main `index.ts`; raw inventory `/private/tmp/codeshell-d3-index-text-readers.txt`. Actual readers include preload plugin/media/MCP/hook/install/command/source contracts, external runtime routing, repository budgets/IPC contract, main quick-chat restoration and Panel notifications, Pet window source contracts and DigitalHumansView composition contracts. Only the external-runtime-routing literal needed updating from the old global name to the module getter; the same cancelWindow assertion remains. Other `index.ts` matches refer to unrelated files or comments.

## Validation

Passed (all unit tests used the guarded isolated-HOME runner):
- Root `bun run build`, followed by `bun run typecheck:workspaces` (all12 packages including Desktop main/renderer/mobile and Web SPA). This is the root `typecheck` script's exact sequential pair. Logs `/private/tmp/codeshell-d3-{build,typecheck}.log`.
- `bun run --cwd packages/desktop build:main` passed; `/private/tmp/codeshell-d3-desktop-main.log`.
- `bun run lint`: 0errors,90existing warnings <=98 baseline; targeted ESLint also clean. `lint:engine-bypass` passed.
- `lint:test-shards`:2660 files, largest Desktop process764/772, no new test files.
- Required architecture/package/IPC contracts:27pass,0fail,240assertions; `/private/tmp/codeshell-d3-contracts.log`.
- Shutdown registry/module, external approvals and external-runtime preload routing:47pass,0fail,172assertions; `/private/tmp/codeshell-d3-targeted.log`.
- Ten existing source-reader suites:29pass,0fail,155assertions; `/private/tmp/codeshell-d3-source-readers.log`. DigitalHumansView source contract additionally31pass,0fail,259assertions; `/private/tmp/codeshell-d3-digital-human-contract.log`.
- Five new tests live in existing `desktop-shutdown.test.ts`: synchronous ordered start/reverse awaited cleanup through actual shutdown handler; partial startup and cleanup failures; negative duplicate/disposed registry cases; real lazy ExternalRuntimeService subscription/teardown without creating a session; source proof for unchanged first-window/start and shutdown call positions. No new mock.module calls.

Not verified in this environment:
- Electron E2E remains blocked by the same-worktree R2 attempt: output-history-recovery fails before Electron launch while `diskutil` cannot access DiskManagement in the sandbox. It never reached the known main-CI promise-garbage-collected error, so equivalence is not claimed. This unchanged environmental prerequisite was not repeatedly retried for D3; `/private/tmp/codeshell-r2-electron-e2e.log`. Full Electron E2E must run on the final candidate/eligible CI before acceptance.
- The full Desktop shard was not repeated after R2's recorded interrupted failing run; final combined-candidate CI/all-shard validation remains parent-owned. That run's failures have not been proven baseline-equivalent. D3's directly affected unit/source suites pass as above.
- R1/R2's unregenerated bun.lock and full Desktop native Cua-driver signature failure remain inherited blockers, not resolved by this domain pilot. No paid eval or real operator credentials used.
