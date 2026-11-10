Title: test(architecture): cap files that use module mocks

Base: codex/architecture/g2-core-layers (`6d7aa7e1fe68e528546a7ab2473ad9476f10f4c1`)
Head: codex/architecture/g4-mock-module-ratchet
Worktree: /private/tmp/codeshell-architecture-g1
Commit: 63c19a06ed6f9606e1af703713cefabede47b51d
Stack: G1 → G2 → G4. Rebase each dependent branch after its base merges, then rerun contracts. No Astra-stage merge is authorized.

Module mocks can leak across Bun test files and force more isolated processes. Add a file-count ceiling in the existing architecture-budget test for code under `packages/` and `tests/`, including fixtures and JavaScript variants. Exclude installed dependencies and generated dist. Failures explicitly ask contributors to use dependency injection. No permanent module mocks, production code, or new test files are added.

Evidence correction:

- The task list's 66 files / 206 occurrences exactly matches TypeScript/TSX alone.
- Seven existing `.mjs` fixtures contain another 66 occurrences, making the complete code baseline **73 files / 272 occurrences**. The guard includes them so changing a file extension cannot bypass the cap.

| Additional existing JavaScript fixture | Occurrences |
| --- | ---: |
| `packages/desktop/src/main/__fixtures__/agent-bridge-link-account-access.mjs` | 11 |
| `packages/desktop/src/main/__fixtures__/agent-bridge-mcp-credentials.mjs` | 13 |
| `packages/desktop/src/main/__fixtures__/agent-bridge-remote-credentials.mjs` | 11 |
| `packages/desktop/src/main/__fixtures__/desktop-web-integration.mjs` | 11 |
| `packages/desktop/src/main/__fixtures__/desktop-web-panels.mjs` | 3 |
| `packages/desktop/src/main/__fixtures__/external-runtime-stream-restart.mjs` | 12 |
| `tests/fixtures/collection-main-url-document-types.fixture.mjs` | 5 |

The current baseline also includes `tests/fixtures/arena-cli-preload.ts`. If R1 is integrated first, rebase this branch and lower the landing ceiling to 72 after remeasurement; do not keep the removed fixture's allowance. Full local inventory: `/private/tmp/codeshell-g4-mock-inventory-20261110.json`.

Validation:

- All three guarded contracts: architecture budgets, package boundaries, preload IPC — **29 passed, 0 failed**.
- Negative probe adding one new `.test.ts` containing a module mock: fails at 74 > 73 with dependency-injection guidance.
- Independent `.mjs` probe: fails identically. All temporary probes removed.
- `bun run lint:test-shards`: passes, 2675 test files covered, no new file.
- Strict standalone TypeScript no-emit check of the changed test passes.
- Changed-file formatting and `git diff --check` pass.
- No production/package change since G1's successful full build. The two pre-existing direct-test ESLint `no-regex-spaces` diagnostics from the preserved IPC regex remain documented in G1/G2; they are unrelated to this guard.

Full unit partitions, workspace typecheck, full lint and required GitHub CI remain for the coordinator's final combined-candidate verification. No push, PR, merge or CC review was performed by this subtask.


Post-R1 integration ratchet: commit f170248a8 on codex/architecture/g4-post-removal-ratchet removes the retired Arena file from the original73-file allowlist, leaving72. This follow-up is based on combined candidate5cbf73d1b; it does not raise the original baseline or add a mock.module call. The final ESLint/boundary guard suite passed6/0 on that integration. Preserve the initial73-file evidence above as the pre-removal measurement.
