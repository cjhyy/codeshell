# refactor(server): share headless worker environment defaults

H1 removes four copies of Desktop-only worker environment cleanup. A dependency-free `headlessWorkerEnv(base, extra)` helper beside `worker-bridge-core.ts` clears the five Desktop host switches, sets local credential access, then applies explicit caller overrides. The focused `@cjhyy/code-shell-server/worker` entry exports the helper. The environment sent to spawned workers is unchanged.

Base: `origin/main@fcd8406d5`. Branch: `codex/server/h1-headless-worker-env`. Worktree: `/private/tmp/codeshell-architecture-h1`. Commit: `e2952dff58061a039a8ed36a8c60405820553f5b`. No PR opened and no merge performed; coordinator owns publication and CC review.

## Evidence differences

- The two `headless-server.ts` blocks are identical as described. `agent-task-host.ts` also writes `CODE_SHELL_CREDENTIAL_ACCESS: "local"`.
- `desktop-web-service.ts` previously omitted the credential override in its callback; `agent-task-host.ts` applied it before spawning. The shared helper now supplies `local` one layer earlier and the final spawned environment is unchanged.
- Server callers import `WorkerBridgeCore` by a package-local relative path. Desktop Web previously had no direct worker-entry import. Server callers now import the adjacent helper; Desktop Web imports its public `/worker` export.
- The five keys are stored once in a constant array and cleared with a loop. Consequently production code has **zero** literal `CODE_SHELL_OPERATION_BATCH_ACCESS: undefined` blocks, rather than one literal block in the helper. The existing test file contains the explicit expected value. There is one cleanup implementation and no copied cleanup block in any caller.

## Four-call-site environment comparison

`undefined` means absent in the spawned child environment. `inherited` means the value supplied by the base environment is preserved. Every arrow is **before → after**. Values not listed are inherited without change.

| Key | Headless primary worker | Headless Panel tasks | Panel agent-task host | Desktop Web Panel callback |
|---|---|---|---|---|
| `CODE_SHELL_REMOTE_LINK_CLIENT_SECRET` | undefined → undefined | undefined → undefined | undefined → undefined | undefined → undefined |
| `CODE_SHELL_OPERATION_BATCH_ACCESS` | undefined → undefined | undefined → undefined | undefined → undefined | undefined → undefined |
| `CODE_SHELL_MODEL_REQUEST_SIGNING` | undefined → undefined | undefined → undefined | undefined → undefined | undefined → undefined |
| `CODE_SHELL_WORKSPACE_ACCESS` | undefined → undefined | undefined → undefined | undefined → undefined | undefined → undefined |
| `CODE_SHELL_HOST_MCP_SERVERS` | undefined → undefined | undefined → undefined | undefined → undefined | undefined → undefined |
| `CODE_SHELL_CREDENTIAL_ACCESS` | local → local | local → local | local → local | inherited → local in callback; local → local at final spawn |
| `CODE_SHELL_DATA_ROOT` | workerDataRoot → workerDataRoot | workerDataRoot → workerDataRoot | inherited → inherited | inherited → inherited |
| `CODE_SHELL_CAPABILITY_MODULES` | opts value, otherwise Link → same | opts value, otherwise Link → same | custom buildEnv unchanged; otherwise coding default → same | inherited → inherited |
| `ELECTRON_RUN_AS_NODE` | inherited → inherited | inherited → inherited | inherited → inherited | 1 → 1 |

Base selection is also unchanged: headless and Desktop Web start from `process.env`; Panel tasks use `options.buildEnv?.()` when supplied and otherwise `process.env` with the coding default. A custom Panel `buildEnv` is not implicitly augmented with coding.

## Capability-set difference retained for owner review

- `startHeadlessServer` without explicit `workerCapabilityModules`: Link provider only.
- `serve/cli.ts` supplies coding plus Link provider.
- Standalone `createPanelAgentTaskHost` without `buildEnv`: coding only.
- Desktop Web supplies its own `buildEnv`; capability modules remain inherited rather than receiving the Panel default.

This PR leaves those choices intact. It does not alter Desktop `agent-bridge.ts`, which intentionally uses host access.

## Validation

- PASS: isolated `node scripts/run-bun-test-shard.mjs --timeout 30000 ./packages/server/src/worker-bridge-core.test.ts`: 27 pass, 0 fail, 74 assertions. The two new cases verify all five cleanup keys, local credentials, unchanged frozen base, preserved capabilities, and caller-extra precedence through the public worker entry.
- PASS: Prettier on only the six owned paths; `git diff --check`.
- Initial contract run before dependency linking: 26 pass / 1 fail. The failing package-boundary bundling test could not resolve `esbuild`; architecture budgets and IPC contract passed. This is recorded as an environment failure, not a passing acceptance check.
- PASS: `TMPDIR=/private/tmp/codeshell-architecture-tmp bun run build` (all packages in the root build chain); log `/private/tmp/codeshell-h1-build.log`.
- PASS: isolated runner over `worker-bridge-core.test.ts` and `panels/agent-task-host.test.ts`: 46 pass, 0 fail, 147 assertions; log `/private/tmp/codeshell-h1-targeted-tests.log`. This includes the existing real-child custom-builder environment regression.
- PASS: final isolated three-contract run (`architecture-budgets`, `package-boundaries`, preload `ipc-contract`): 27 pass, 0 fail, 244 assertions; log `/private/tmp/codeshell-h1-contracts.log`.
- PASS: `bun run lint:test-shards`: 2,675 files covered, rest-server 240/240 and largest process 765/772; no test files added. ESLint on all six owned paths: 0 errors or warnings.
- PASS: `bun run --cwd packages/desktop typecheck`, covering both Desktop and mobile configs; log `/private/tmp/codeshell-h1-desktop-typecheck.log`. The first attempt found copied stale workspace package snapshots; converting only local ignored dependencies to workspace symlinks resolved it. No source workaround was made.
- PASS: `/private/tmp/codeshell-h1-env-comparison.mjs` extracts all four original and current callback expressions via the TypeScript AST, evaluates them using synthetic environment values, and deep-compares ten scenarios. Default/custom/empty capability values and custom Panel builders that omit capability modules retain their values. Desktop's intermediate credential-only difference is asserted, then final process environments are compared.
- BLOCKED: `serve-host-unsupported.test.ts` and `hub-server.test.ts`: 25 failures at loopback `listen(0)` before worker behavior can run; Bun reports `EADDRINUSE`. An independent Node HTTP listener reproduces `EPERM`, establishing the sandbox restriction. Mixed-run log `/private/tmp/codeshell-h1-server-tests.log` (46 passed, 25 failed); these integration tests are not claimed as passed.
- BLOCKED: Desktop Web Panel and bridge integration tests: 3 failures due to the same loopback restriction (Panel child fixtures subsequently reach their 20-second timeout); log `/private/tmp/codeshell-h1-desktop-tests.log`. Re-run outside the restricted sandbox.
- Full CI shards and GitHub required checks: coordinator's final combined-candidate validation; not claimed here.
