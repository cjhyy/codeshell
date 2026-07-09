# Review: Unpushed Quality Batch 2026-07-08

Range reviewed: `da84f435~1..HEAD` on `main` (`43` commits).

Verdict: **not merge-ready**. The code builds and lint has no errors, but the required full `bun test` run is red with two non-baseline failures from this batch.

## Verification

- `git diff --check da84f435~1..HEAD`: pass.
- `bun run build`: pass.
- `bun test`: fail. Summary: `4890 pass`, `6 skip`, `3 fail`, `11015 expect() calls`, `4899 tests across 711 files`.
- Failing tests in the full run:
  - `public VERSION > matches package.json version` — known baseline.
  - `PTY sender ownership > write, resize, and kill require the starting webContents` — batch regression/full-suite instability from `c621140a`.
  - `VirtualMessageList scroll-away notifications > notifies when user scrolling breaks sticky bottom` — batch regression/full-suite instability from `a49c1b72`.
- Known lockfile/rm-race baseline failure did not appear in this run.
- Diagnostic isolated runs for the two batch failures both passed; I did not count these as the official full-suite result.
- `bun run lint`: pass with `0 errors`, `167 warnings` (`6` potentially fixable). Warnings are accepted per ask; no ESLint boundary errors fired.

## Findings

🔴 `c621140a` / `packages/desktop/src/main/pty-ownership.test.ts:59` — new regression test fails in the required full suite, even though it passes isolated.

The failing test is part of this batch and therefore cannot be treated as baseline. It exercises PTY ownership through module-global state: `_setPtyForTest` mutates the module loader hook in `packages/desktop/src/main/pty-service.ts:47`, and sessions live in the process-global `sessions` map at `packages/desktop/src/main/pty-service.ts:162`. The test cleans this up in `afterEach` at `packages/desktop/src/main/pty-ownership.test.ts:53`, but the required full `bun test` run still failed while an isolated run passed. That makes the regression test order-dependent or otherwise flaky under the real suite command.

🔴 `a49c1b72` / `packages/tui/src/ui/components/VirtualMessageList.test.tsx:18` — new scroll-away regression test fails in the required full suite and is sensitive to process-global fullscreen state.

The test mounts `VirtualMessageList` without a `FullscreenModeContext.Provider` at `packages/tui/src/ui/components/VirtualMessageList.test.tsx:21`. `VirtualMessageList` only wires `ScrollBox` in fullscreen mode; flow mode returns before the scrollable branch at `packages/tui/src/ui/components/VirtualMessageList.tsx:147`. Separately, `tests/ui/fullscreen-mode-env.test.ts:18` mutates `process.env.CODESHELL_FULLSCREEN` around dynamic imports. Under Bun's parallel file execution, this can cache the default fullscreen context as flow mode and make `handle!.scrollBy(-3)` at `packages/tui/src/ui/components/VirtualMessageList.test.tsx:40` a no-op. The isolated file passes, but the full suite failure is a merge blocker.

🟠 `5ece9d28` / `packages/core/src/cli/__tests__/agent-server-stdio-factory.test.ts:38` — test isolation is still process-global despite the commit message.

This test captures prior env at module load (`packages/core/src/cli/__tests__/agent-server-stdio-factory.test.ts:8`) and then sets `process.env.AGENT_CWD` and `process.env.HOME` at top level before importing the module under test (`packages/core/src/cli/__tests__/agent-server-stdio-factory.test.ts:38`). It restores only in `afterAll` at `packages/core/src/cli/__tests__/agent-server-stdio-factory.test.ts:43`. With Bun running files in parallel, unrelated tests can observe the fixture HOME/AGENT_CWD for the duration of this file.

🟡 `8a0a2c7c` / `packages/tui/src/cli/commands/max-context-tokens.test.ts:18` — regression test is source-text coupling, not behavior.

The added test reads `repl.ts` and asserts a literal import/call string at `packages/tui/src/cli/commands/max-context-tokens.test.ts:19`. This catches one exact implementation shape, but it does not prove that `replCommand` actually passes the resolved value into session config. A behavior test with a stubbed model/settings path would be stronger and less brittle.

🟡 `c72df028` / `packages/cdp/src/driver.test.ts:145` — printable key coverage is narrow for the behavior added.

The test proves `"a"` carries `text` and `Enter` does not, but the implementation has additional paths for shifted punctuation, named printable keys, numpad keys, and modifier-blocked text in `packages/cdp/src/keymap.ts:223`. This is not tautological, but it leaves the higher-risk mapping branches mostly unexercised.

🟡 `eb568522` / `packages/core/src/cc-orchestrator/external-agent-bindings.ts:63` — commit is not atomic to its message.

The commit is titled `fix(infra): enforce lint boundary guards in ci`, and most of it is CI/ESLint work. It also changes runtime error wrapping in `packages/core/src/cc-orchestrator/external-agent-bindings.ts:63`, `packages/core/src/cc-orchestrator/external-agent-session-store.ts:119`, and `packages/core/src/git/worktree.ts:290`. Those changes are low risk, but they are unrelated to the lint-boundary CI guard and should have been a separate scoped commit.

🟡 `eb568522` / `tests/eslint-boundary-guard.test.ts:22` — lint guard test writes probe files into the real source tree.

The test creates files under `packages/core/src` and `packages/desktop/src/renderer` (`tests/eslint-boundary-guard.test.ts:7`) and runs `bunx eslint` against them (`tests/eslint-boundary-guard.test.ts:46`). It does remove them in `finally` at `tests/eslint-boundary-guard.test.ts:55`, but a killed/interrupted run can leave untracked source-tree artifacts. Prefer a temp fixture directory or ESLint API fixture where possible.

## Behavior Changes Without Tests

None found in the strict commit/file-level scan: every runtime or workflow behavior commit in this range includes a related test file or workflow assertion in the same commit.

Caveats:

- Some tests are weak or brittle, especially `8a0a2c7c`'s source-text assertion and the YAML workflow shape assertions.
- `eb568522` includes small runtime error-cause changes under an infra commit without focused behavior assertions.
- The two new failing full-suite tests mean the batch is not green even though isolated diagnostics pass.

## Consistency Notes

- Formatting/whitespace: `git diff --check` passed.
- ESLint guardrails: `bun run lint` exited `0`; no `core -> tui` or renderer runtime CodeShell-package import errors were reported.
- No leftover debug logging or obvious dead code from the reviewed diffs stood out beyond existing lint warnings. Lint warnings remain warnings, but the merge gate requested here is blocked by tests, not lint.
