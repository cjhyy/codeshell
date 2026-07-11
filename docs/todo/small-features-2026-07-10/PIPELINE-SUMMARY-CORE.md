# Core Engine Feature Pipeline Summary

Branch: `feat/sf-core` (base `517f80ff`, `main` HEAD at worktree creation)

Scope: only `packages/core` was changed in commits. This summary intentionally remains uncommitted at the worktree root.

## Baseline

- Dependencies were initially absent, so `bun install --frozen-lockfile` was required before tests could run; it produced no tracked changes.
- Baseline `cd packages/core && bun test`: **2793 pass / 6 skip / 4 fail / 2 errors** (2803 tests, 432 files).
- The baseline failures were:
  - `AgentServer agent/forkSession > rejects a live busy source without forking`
  - `ExternalAgentSessionStore > preserves interleaved upserts from concurrent writers`
- Those same two pre-existing failure groups remain in every final full-suite run; no new failure was introduced.

## Task 1 — goal judge V1 nits

No new commit was created because both requested fixes and their exact regression tests were already present in the branch base:

- `b391b85c fix(goal): bound serialized judge evidence size (MINOR-3)` — budgets evidence after JSON serialization, including control-character expansion.
- `cd93df9f fix(goal): encode judge cache keys without collisions (NIT)` — uses collision-free JSON-array serialization for cache-key fields.

Files verified: `packages/core/src/hooks/goal-stop-hook.ts`, `packages/core/src/hooks/goal-stop-hook.test.ts`.

Test at verification time: `bun test src/hooks/goal-stop-hook.test.ts` — **98 pass / 0 fail**.

Decision/deviation: creating an empty or duplicate commit would have falsified the requested TDD history. Task 2 subsequently removed the obsolete V1 single-tool evidence projection and its projection-specific tests as required by its plan.

## Task 2 — recent complete conversation rounds for goal judge

Commit: `84ddab08 refactor(goal): judge recent complete conversation rounds`

Files changed:

- `packages/core/src/engine/goal-judge-context.ts`
- `packages/core/src/engine/goal-judge-context.test.ts`
- `packages/core/src/engine/engine.ts`
- `packages/core/src/engine/turn-loop.ts`
- `packages/core/src/engine/turn-loop-continuation.test.ts`
- `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts`
- `packages/core/src/engine/engine.auto-compaction-goal.test.ts`
- `packages/core/src/hooks/events.ts`
- `packages/core/src/hooks/goal-stop-hook.ts`
- `packages/core/src/hooks/goal-stop-hook.test.ts`

Implementation: replaced private `toolResults + progress` projection with the latest complete API-round slices; kept whole-round dropping, 6-round/3000-token/12000-character caps, sensitive-result redaction, nested-image stripping, reasoning omission, emergency truncation with tool metadata preserved, and a SHA-256 conversation digest. Public `HookContext` was not changed.

Tests: targeted goal-judge/turn-loop suite **112 pass / 0 fail**. Full suite afterward: **2757 pass / 6 skip / 4 fail / 2 errors**; the pass-count reduction is from intentionally deleting 36 obsolete V1 projection tests.

## Task 3 — prompt cache diagnostics

Commit: `7519107e feat(engine): attribute prompt cache prefix drops`

Files changed:

- `packages/core/src/engine/prompt-cache-diagnostics.ts`
- `packages/core/src/engine/prompt-cache-diagnostics.test.ts`
- `packages/core/src/engine/model-facade.ts`
- `packages/core/src/engine/turn-loop.ts`
- `packages/core/src/engine/engine.ts`
- `packages/core/src/engine/engine.prompt-cache.test.ts`
- `packages/core/src/engine/turn-loop-continuation.test.ts`
- `packages/core/src/engine/turn-loop-usage-cache.test.ts`
- `packages/core/src/llm/client-base.ts`
- `packages/core/src/llm/client-base.prompt-cache.test.ts`
- `packages/core/src/llm/providers/anthropic.ts`
- `packages/core/src/llm/providers/anthropic-tools-cache.test.ts`
- `packages/core/src/llm/providers/openai.ts`
- `packages/core/src/llm/providers/openai-openrouter-anthropic-cache.test.ts`
- `packages/core/src/llm/providers/openai-reasoning-effort-drop.test.ts`

Implementation: added process-keyed HMAC-SHA256 fingerprints for cache scope and system/tools/config prefixes; canonical tool hashing preserves tool order; a 256-session LRU recorder attributes cache-read collapses to changed prefixes and emits differentiated hints; schema/scope changes reset comparison; primary and continuation calls are sampled; sticky semantic/security flags remain hot and auditable.

Tests: targeted prompt-cache suite **66 pass / 0 fail**. Full suite afterward: **2774 pass / 6 skip / 4 fail / 2 errors**.

## Task 4 — split `engine.ts`

Completed commits:

1. `3049a259 refactor(engine): extract subagent spawner`
   - Added `packages/core/src/engine/run-types.ts`, `subagent-spawner.ts`, and `subagent-spawner.test.ts`; updated `engine.ts`.
   - Child Engine construction remains injected from the facade; the extracted module never imports `engine.ts`.
2. `34bf83f7 refactor(engine): extract run environment resolver`
   - Added `run-environment.ts` and `run-environment.test.ts`; updated `engine.ts`.
   - Moved sandbox resolution/cache, network overlay, shell environment, and worktree setup environment.
3. `7895578d refactor(engine): extract file history hook`
   - Added `file-history-hook.ts` and `file-history-hook.test.ts`; updated `engine.ts`.
   - The run-scoped disposer owns registration cleanup; ApplyPatch uses the run cwd.
4. `400c90b1 refactor(engine): extract run finalizer`
   - Added `run-finalizer.ts`, `run-finalizer.test.ts`, and `engine-import-boundary.test.ts`; updated `engine.ts`.
   - Extracted identity-safe removal of injected context messages and added architecture guards against `tool-system -> engine.ts` and extracted-module back imports.
5. `491516e6 refactor(engine): extract auxiliary pipeline`
   - Added `auxiliary-pipeline.ts` and `auxiliary-pipeline.test.ts`; updated `engine.ts` and `engine.summarize-signal.test.ts`.
   - Moved auxiliary client selection/cache, compaction summarizer, memory extraction, extraction-model selection, and dream dispatch.
6. `1331afd7 refactor(engine): extract permission controller`
   - Added `permission-controller.ts` and `permission-controller.test.ts`; updated `engine.ts`.
   - Controller now owns mode/plan state, busy-run pending changes, effective rules, backend selection, and live classifier reconfiguration.

Verification per extraction: TypeScript `--noEmit`, focused tests, and a core full-suite run. The last Task 4 full run was **2790 pass / 6 skip / 4 fail / 2 errors**. Relevant focused suites included 4 finalizer/boundary tests, 8 auxiliary tests, 41 memory/dream tests, and 110 permission/plan-mode tests, all green.

Result: `packages/core/src/engine/engine.ts` decreased from about 3,932 lines to 3,194 lines. Engine now delegates subagent spawning, environment resolution, file-history lifecycle, injected-context cache cleanup, auxiliary work, and permission control.

Incomplete/deviation: the plan labels this task M but describes a 13-module, staged, multi-PR decomposition of a roughly 1,400-line strongly coupled `run()` plus long-lived control planes. The remaining `run-session`, `run-components`, `goal-run-controller`, `turn-loop-factory`, `run-loop-driver`, full finalization/persistence dispatch, `runtime-config-controller`, `tool-context-factory`, and final facade contraction were not safely completed in this pipeline. Continuing would have violated the requested one-block-at-a-time TDD/full-regression constraint. The completed modules obey the intended dependency boundaries and leave a tested seam for follow-up work.

## 任务5 子agent sandbox/mcp

Commit: `95fb7493 feat(agent): scope child sandbox and mcp servers`

Files changed:

- `packages/core/src/agent/agent-definition.ts`
- `packages/core/src/agent/agent-definition.sandbox-mcp.test.ts`
- `packages/core/src/engine/subagent-spawner.ts`
- `packages/core/src/engine/subagent-spawner.test.ts`
- `packages/core/src/tool-system/context.ts`
- `packages/core/src/tool-system/builtin/agent.ts`
- `packages/core/src/tool-system/builtin/agent.resolve-type.test.ts`
- `packages/core/src/tool-system/builtin/agent.send-input.test.ts`
- `packages/core/src/tool-system/builtin/agent.sandbox-mcp.test.ts`

Implementation:

- Added `AgentDefinition.sandbox?: SandboxMode` using core's existing `off | auto | seatbelt | bwrap` enum. It remains orthogonal to `permissionMode`; no conflicting approval-policy enum was introduced.
- Added `AgentDefinition.mcp?: string[]` with `skills`-style semantics: omitted inherits the parent's complete MCP config, `[]` exposes no MCP servers, and a non-empty allowlist can only retain parent-configured server names.
- Added YAML frontmatter parse/serialize support. MCP lists reuse the existing list normalizer and accept YAML arrays or comma/whitespace-separated strings.
- Propagated both scopes through role resolution, initial/background spawn, synchronous spawn, and transcript-replay continuation.
- Child sandbox modes are handed to the existing `RunEnvironmentResolver` through `EngineConfig.sandbox`. After review hardening, the spawner receives the parent's fully resolved run config and a role may only preserve or tighten it; it cannot downgrade an isolated parent to `off`/`auto`.
- Child MCP filtering produces the child `EngineConfig.mcpServers`, so existing MCP connection, prompt visibility, generic-resource filtering, and executor gates all use the same restricted set.

Tests:

- Required TDD red run: **5 pass / 6 fail** before implementation.
- Focused agent-definition/spawner/role/continuation suite: **38 pass / 0 fail**.
- TypeScript `--noEmit`: passed.
- Full suite after implementation: **2797 pass / 6 skip / 4 fail / 2 errors** (2807 tests, 444 files). The only failures are the two pre-existing concurrency groups recorded in the baseline; no new failure was introduced.

Decision/deviation: the lightweight plan is intentionally uncommitted at `docs/todo/small-features-2026-07-10/subagent-sandbox-mcp.md`. Sandbox was not deferred because core has a clean reusable OS sandbox enum and `run-environment` integration point. The role field controls the shell sandbox backend only; it does not alias or alter approval/permission mode.

## 复审修复

### BLOCKER 1 + MAJOR 2 — effective sandbox inheritance and monotonic restriction

Commit: `55f82f3f fix(agent): inherit and preserve effective sandbox`

Files changed:

- `packages/core/src/engine/engine.ts`
- `packages/core/src/engine/subagent-spawner.ts`
- `packages/core/src/engine/subagent-spawner.test.ts`
- `packages/core/src/tool-system/builtin/agent.sandbox-mcp.test.ts`

Fix:

- Engine now resolves the parent run's complete effective `SandboxConfig` before constructing the subagent spawner. This includes project/user settings and prevents an undefined role sandbox from falling through the subagent's project-settings skip to interactive `off` defaults.
- `CreateSubAgentSpawnerDeps.parentSandbox` is required and carries that effective config into every child.
- `resolveChildSandbox` is monotonic: `seatbelt`/`bwrap` parents cannot be overridden by role modes; an `auto` parent cannot be downgraded to `off`/`auto`; an explicit child backend selected from a less restrictive parent still follows the existing fail-closed backend resolver.

New tests:

- Four red-to-green matrix cases: parent `seatbelt|bwrap` × child `off|auto`.
- Project-settings-only integration case: raw `EngineConfig.sandbox` absent, effective parent `seatbelt + network deny`, undefined child role inherits the full effective config.
- Focused sandbox/spawner suite: **23 pass / 0 fail**. Full suite: **2802 pass / 6 skip / 4 fail / 2 errors**.

### MAJOR 3 — goal judge content-level credential scrubbing

Commit: `72baa2f9 fix(goal): scrub secrets from judge conversation`

Files changed:

- `packages/core/src/utils/secret-scrubber.ts`
- `packages/core/src/utils/secret-scrubber.test.ts`
- `packages/core/src/engine/goal-judge-context.ts`
- `packages/core/src/engine/goal-judge-context.test.ts`
- `packages/core/src/hooks/goal-stop-hook.ts`

Fix:

- Extracted the existing defense-in-depth scrubber into a shared pure module instead of leaving it private to background-task rendering.
- Before conversation rendering and digesting, recursively scrubs ordinary message text, tool input values, string/nested tool results, while retaining the explicit `sensitiveToolResultRedactions` path.
- Coverage restored for environment/provider tokens, Authorization headers, URL userinfo/query credentials, JSON/YAML fields, and CLI credential arguments.

New tests:

- Reproduction first showed the combined conversation object/prompt retaining all eight plaintext sentinels.
- Added one end-to-end conversation scrub test plus seven pure scrubber regression cases.
- Goal/scrubber focused suite: **70 pass / 0 fail**. Full suite: **2810 pass / 6 skip / 4 fail / 2 errors**.

### MINOR 4 — goal judge hard-limit postcondition

Commit: `28fdc644 fix(goal): enforce judge context hard limits`

Files changed:

- `packages/core/src/engine/goal-judge-context.ts`
- `packages/core/src/engine/goal-judge-context.test.ts`

Fix:

- After iterative field truncation, builds a deterministic structural skeleton that collapses text while retaining tool metadata where the budget permits.
- Adds an absolute final verification of both rendered characters and estimated tokens. If even structural overhead cannot fit, returns an empty conversation with a deterministic one-character placeholder.

New tests:

- 100 text blocks at `maxChars=900/maxTokens=250` reproduced **5709 chars / 2006 tokens** before the fix.
- An explicit `maxChars=1/maxTokens=1` case covers irreducible structural overhead.
- Goal lifecycle/context focused suite: **103 pass / 0 fail**. Full suite: **2812 pass / 6 skip / 4 fail / 2 errors**.

### MINOR 5 — accurately name the extracted cache helper

Commit: `90013178 refactor(engine): clarify injected context cache helper`

Files changed:

- `packages/core/src/engine/engine.ts`
- `packages/core/src/engine/injected-context-cache.ts` (renamed from `run-finalizer.ts`)
- `packages/core/src/engine/injected-context-cache.test.ts` (renamed from `run-finalizer.test.ts`)

Fix/decision:

- Chose the lower-risk review option: renamed the module to describe its actual responsibility rather than claiming the complete finalizer extraction.
- The earlier `400c90b1` commit extracted only injected-context removal. Session hooks, usage/state persistence, title/memory dispatch, and result mapping remain in `engine.ts` and remain listed as incomplete Task 4 work.

New test evidence:

- The renamed test first failed because `injected-context-cache.js` did not exist, then passed after the implementation rename.
- Helper plus architecture-boundary suite: **4 pass / 0 fail**. Full suite: **2812 pass / 6 skip / 4 fail / 2 errors**.

## 复核补修

Commit: `761184a1 fix(goal): redact key-aware judge inputs`

Files changed:

- `packages/core/src/engine/goal-judge-context.ts`
- `packages/core/src/engine/goal-judge-context.test.ts`
- `packages/core/src/utils/secret-scrubber.ts`
- `packages/core/src/utils/secret-scrubber.test.ts`

Fix:

- Added shared `scrubSecretValue()` for key-aware recursive sanitization of JSON-like tool inputs/results. Object keys are normalized case-insensitively across underscore/hyphen/camel variants.
- Sensitive keys (`password/passwd`, token variants, `api_key/apikey`, `authorization/auth/bearer`, cookie variants, client/private/AWS keys, etc.) redact their complete value regardless of whether the value itself contains a recognizable prefix.
- Header containers remain ordinary objects and recurse into keys such as nested `headers.Authorization`; ordinary string values continue through the existing free-form scrubber.
- Goal conversation sanitization now delegates structured blocks to the shared key-aware function before rendering and digesting.
- Normal business keys and evidence (`name`, `title`, `description`, metadata, ordinary URLs/JSON fields) remain intact.

New tests:

- TDD reproduction: a real nested `tool_use.input` containing `password` and `headers.Authorization` leaked plaintext before the fix; the pure test also failed because no deep scrub API existed.
- Nested key-aware goal-context coverage for `password`, `headers.Authorization`, `CLIENT-SECRET`, `Refresh_Token`, and `privateKey`, including prompt/conversation/digest assertions and preservation of ordinary fields.
- Pure key matrix covering case and separator variants plus nested headers and normal-key preservation.
- Exact preservation regression for ordinary text, a normal URL, and normal JSON business fields.
- YAML literal block / indented continuation scrubbing while retaining sibling status/description evidence.
- Scrub-before-emergency-truncation regression preventing a long secret suffix from escaping.
- Two 40k-character large-input performance/non-throw cases.

Verification:

- Focused `goal-judge-context + secret-scrubber`: **27 pass / 0 fail**.
- TypeScript `--noEmit`: passed.
- Full suite: **2819 pass / 6 skip / 4 fail / 2 errors** (2829 tests, 445 files); only the two pre-existing concurrency failure groups remain.

## 终审补修

Commit: `315426d0 fix(goal): preserve non-secret token fields`

Files changed:

- `packages/core/src/utils/secret-scrubber.ts`
- `packages/core/src/utils/secret-scrubber.test.ts`

Fix:

- Removed suffix-based sensitive-key matching. Keys are still normalized to lowercase alphanumeric form, but now must equal an entry in the explicit sensitive-key set.
- `designToken`, `color_token`, and `colorToken` therefore remain ordinary design-system evidence instead of being erased merely because their normalized names end in `token`.
- Real credential variants remain covered through exact normalized entries: `access_token`, `refresh_token`, `client_secret`, `api_key`, and `Access-Token` normalize to `accesstoken`, `refreshtoken`, `clientsecret`, `apikey`, and `accesstoken` respectively.
- Free-form value scrubbing is unchanged, so recognizable provider tokens, Authorization strings, URLs, structured text, and CLI secrets are still redacted independently of their object key.

New tests:

- TDD reproduction first showed all three design-token fields incorrectly becoming `[REDACTED]`.
- One combined regression asserts the three business values remain byte-for-byte while five genuine sensitive-key variants still redact, preventing both over-redaction and a security regression.

Verification:

- Focused `secret-scrubber + goal-judge-context`: **28 pass / 0 fail**.
- TypeScript `--noEmit`: passed.
- Full suite: **2820 pass / 6 skip / 4 fail / 2 errors** (2830 tests, 445 files); only the two pre-existing concurrency failure groups remain.

## Final status

- Baseline: **2793 pass / 6 skip / 4 fail / 2 errors**.
- Final after final-review follow-up: **2820 pass / 6 skip / 4 fail / 2 errors** (2830 tests, 445 files); expected known failures are the same two baseline groups above. The net test-count change reflects obsolete V1 tests removed in Task 2 plus new coverage added by Tasks 2–5 and all review passes.
- Git status should contain only `?? PIPELINE-SUMMARY-CORE.md` and `?? docs/todo/small-features-2026-07-10/subagent-sandbox-mcp.md`.
