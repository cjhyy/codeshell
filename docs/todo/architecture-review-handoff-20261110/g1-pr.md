Title: test(architecture): count IPC budgets across all desktop sources

Base: main (`fcd8406d51bf34696417dd9dd90c609f1d5ca640`)
Head: codex/architecture/g1-ipc-budget-scan
Worktree: /private/tmp/codeshell-architecture-g1
Commit: dcf469b3abfa47e92283ac6af5123b0d365c92d5

The IPC growth guard only counted a hand-maintained file list, allowing new registrar and preload modules to bypass it. Scan every production `.ts` file under Desktop main/preload recursively, excluding `.test.ts`, `.fixture.ts`, and `.d.ts`. Preserve the six main special patterns, the account-device preload pattern, all existing review comments, and the exact account-device / output-history assertions. Production IPC behavior and `ipc-contract.test.ts` are unchanged.

Evidence correction from G1:

| Measurement | Main routes | Preload invokes |
| --- | ---: | ---: |
| Original selectors (48 / 16 files) | 390 | 371 |
| New selectors on the original files | 390 | 373 |
| Previously omitted files | 82 | 108 |
| Full scan / new ceiling | 472 | 481 |

The task list's preload total of 479 missed two calls even within its original list: `preload/account-features-api.ts` uses `ipcRenderer.invoke` for snapshot and refresh, while its old selector searched only `ipc.invoke` (0 instead of 2). The revised guard counts both receivers. The exact 390/371 legacy self-check passed; the 373 comparison difference is explained rather than hidden. No new routes or invokes are introduced, and file line caps are unchanged.

All 82 previously omitted main registrations match appendix B (9 files). All 108 previously omitted preload calls also match appendix B (9 files). Detailed original paths and per-file measurements are saved locally in `/private/tmp/codeshell-g1-count-inventory-20261110.json`.

Validation:

- Guarded `tests/architecture-budgets.test.ts`: 4 passed, 0 failed.
- Negative probe in a new nested main registrar: fails with 473 > 472.
- Negative probe in a new nested preload adapter: fails with 482 > 481.
- Exclusion probes: `.test.ts`, `.fixture.ts`, and `.d.ts` containing calls under both roots remain excluded; guard passes. All probe files were removed.
- `bun run lint:test-shards`: passes, 2675 files covered; no test files were added.
- Changed file formatted; `git diff --check` passes.
- Direct ESLint of this root test still reports the same two existing `no-regex-spaces` errors as the baseline version (the copied four-space special regex and retained exact assertion). `bun run lint` targets packages; this change does not alter those patterns or suppress the rule.
- `bun run build`: passed in this worktree. The package-boundaries bundle test initially failed because the new checkout lacked Host `dist/index.session-files.js`; after the full build, all three required contracts passed together: architecture budgets, package boundaries, and preload IPC contract — 27 passed, 0 failed.

Not yet verified: full unit partitions, workspace typecheck, full lint and required GitHub CI. The coordinator will run final combined-candidate checks. No PR was pushed or opened in this subtask, and no CC review has happened.
