Title: test(architecture): guard Core directory dependency layers

Base: codex/architecture/g1-ipc-budget-scan (`dcf469b3abfa47e92283ac6af5123b0d365c92d5`)
Head: codex/architecture/g2-core-layers
Worktree: /private/tmp/codeshell-architecture-g1
Commit: 6d7aa7e1fe68e528546a7ab2473ad9476f10f4c1
Stack: G1 → G2. After G1 merges, rebase G2 onto the resulting main and rerun contracts; do not merge during Astra implementation.

Core's directory dependencies can grow upward or become mutually dependent without a guard. Add an AST-based check in the existing architecture-budget test, assigning directories to the eight reviewed layers and freezing the 29 existing upward file→directory edges and six same-layer mutual pairs. Both exception sets must match current evidence: new dependencies fail, and removed dependencies require removing their stale allowances.

The scanner resolves module paths using the root TypeScript configuration. It handles value imports, side-effect imports, namespace/default imports, value reexports, dynamic import, require, and import-equals; declaration-level and all-named type-only forms are excluded. Root entry files are outside the directory guard. `tool-system/builtin` is distinct from tool infrastructure. Test/declaration files and `__fixtures__`, `fixtures`, `__tests__` directories are excluded. New unclassified directories fail even if they contain no cross-directory imports.

Evidence:

- All 29 upward rows and all six mutual pairs match appendix A exactly. No layer changes or allowance expansion was necessary, and no production import was changed.
- Source discovery finds 632 production TS/TSX files, rather than the appendix's 633: the required exclusion removes `sources/__fixtures__/runtime-mock.fixture.ts`.
- The implemented scope has 43 directory nodes and 228 unique cross-directory edges, with root files excluded and value reexports included. This is the enforced graph, not the appendix's broader raw 259-edge summary. The actual acceptance tables (29 and six) were reproduced independently and match exactly.
- Local detailed inventory: `/private/tmp/codeshell-g2-import-inventory-20261110.json`.

Validation:

- All three guarded contracts pass: architecture budgets, package boundaries, preload IPC — 28 passed, 0 failed.
- `bun run lint:test-shards` passes: 2675 files covered, no new test file.
- Standalone strict TypeScript no-emit check of the changed test passes (`ES2022`, `ESNext`, bundler resolution, bun/node types).
- Nine independent negative probes reject new utils→engine dependencies and name the file/target: normal import, export, dynamic import, require, import-equals, package alias, mixed value/type import, namespace import, side-effect import.
- Type-only import/export/import-type and fixture/test/declaration exclusion probes pass without false positives.
- New unclassified-directory and same-layer-cycle probes fail as intended.
- Stale upward and same-layer allowlist probes fail as intended.
- All temporary probes were removed; changed-file formatting and `git diff --check` pass.
- Direct ESLint continues to report only the same two baseline `no-regex-spaces` diagnostics in the untouched IPC special patterns; no new diagnostics.
- G1's full build remains the valid prerequisite here: G2 changes only this test, with no source or package changes requiring another build.

Not yet verified: full CI unit partitions, workspace typecheck, full lint and required GitHub CI; the coordinator owns the final combined-candidate run. No push/PR or CC review has happened.
