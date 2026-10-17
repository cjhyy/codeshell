# Round 5: Core prompt composition and instruction ordering

Frozen product commit: `9a421b3e65d5bfe662b78062cb86bd99483a683a`. Read `CODESHELL.md`; no product, dependency, build, Git state, user data, or external service changes. Two first-run guarded shards completed: **6 pass / 33 expect / 0 fail / 0 skipped**. One fresh **P3** finding; one historical duplicate excluded.

## Current contract and callers

The real implementation is `packages/core/src/prompt/`, with built-in presets in `packages/core/src/preset/index.ts`. Coding contributes its ordinary preset data and `coding.md` section from `packages/coding/src/index.capability.ts:287–354`; there is no `packages/core/src/presets` directory.

- `Engine` constructs a fresh `PromptComposer` at `packages/core/src/engine/engine.ts:3155`; `buildPromptComposerConfig` supplies the composition boundary finder at `:3180–3182`. The coding module registers its finder at `packages/coding/src/index.capability.ts:354`; the finder walks the filesystem for `.git` at `packages/coding/src/capability-runtime.ts:62–69`.
- The scanner promises priority order `managed → user → project (root→cwd) → local` at `packages/core/src/prompt/instruction-scanner.ts:53–57`. `combineInstructions` preserves its input order at `:130–135`.
- `PromptComposer.getInstructions` calls those two functions at `packages/core/src/prompt/composer.ts:412–416`; `buildUserContextMessage` emits the resulting text at `:155–177`. The Engine consumes that message at `packages/core/src/engine/engine.ts:2424–2431`.
- Named sections are module-owned strings that override built-ins when supplied (`packages/core/src/prompt/section-loader.ts:28–35`). `buildPresetSystemPrompt` assembles preset section order and applies tool metadata gates (`packages/core/src/preset/index.ts:270–294`). Composer tool names and behavior have explicit `cacheBreak: true` (`packages/core/src/prompt/composer.ts:322–357`).

## PROMPT-01 — P3: ancestor local instructions are ordered before descendant project instructions

**Defect location:** `packages/core/src/prompt/instruction-scanner.ts:108–112`, inside the directory loop at `:92`. The advertised ordering contract is at `:57`; there is no later source-priority sort before the return at `:115`.

**Condition:** a caller supplies a project boundary above `cwd`, an ancestor contains `CODESHELL.local.md`, and a descendant contains `CODESHELL.md`. This is an ordinary supported nested-project configuration; the analogous compat names use the same loop. The latter is a source inspection conclusion, not a second dynamic case.

**Actual:** an owned two-level fixture returns:

```text
project depth 0: ROOT_PROJECT
local   depth 0: ROOT_LOCAL
project depth 1: CHILD_PROJECT
local   depth 1: CHILD_LOCAL
```

The actual `PromptComposer` carries that sequence unchanged into its instruction reminder. Root-local content therefore precedes a later descendant project block despite being labeled a local override.

**Expected:** the documented source-priority contract requires all project entries, ordered root→cwd, followed by local overrides: `ROOT_PROJECT, CHILD_PROJECT, ROOT_LOCAL, CHILD_LOCAL`. Collecting local entries separately until after the project walk would satisfy that contract while preserving local depth order. If depth is intended to outrank source, the current API contract instead needs an explicit change; the implementation currently contradicts its stated order.

**Impact and severity limit:** **P3** for a deterministic ordering/precedence contract mismatch in instruction context. Consumers relying on local overrides being the final layer receive the wrong sequence for nested work. No model was run, so this evidence does **not** establish that any model obeys one conflicting instruction rather than another, nor any tool, security, or permission consequence.

**First-run evidence:** [fixture](evidence/prompt-instruction-order.test.ts), [raw merged stdout/stderr](evidence/prompt-instruction-order.first.log), [exit status](evidence/prompt-instruction-order.first.exit.txt). The shard has 2 tests and 14 assertions, exit 0, complete JUnit receipt reported by the guarded runner. Tests assert the observed defect and separately record the documented expected sequence; their green status does not mean the ordering is correct. Test 1 exercises the real scanner and combiner; test 2 exercises the actual composer. Only owned temporary files and an injected boundary function are used; no Engine, real Git boundary finder, model, provider, or network is exercised.

## Candidate disposition and historical deduplication

[Dedup ledger](evidence/prompt-dedup.json) scans **808 Markdown/JSON files** under every pre-existing `docs/audit-*`, `docs/review*`, and `docs/archive` root, with path hashes, query expressions, matching Markdown excerpts and parsed finding records. The new Round 5 directory is excluded from that historical corpus. There are 14 instruction/order, 9 custom-prompt, and 44 section/preset Markdown matches plus 10 matching JSON records; these are search results, not finding counts. No equivalent prior ancestor-local/descendant-project ordering finding was located. Archived module guides contain stale implementation details and were used for deduplication context, not as the current contract.

| Candidate | Disposition | Evidence / reason |
| --- | --- | --- |
| PROMPT-01: local/project interleaving | Fresh P3 | Current public scanner JSDoc plus real scanner/composer owned-data reproduction above. |
| C-PROMPT-01: custom system prompt coexists with preset sections despite “takes precedence” | **Duplicate; not counted** | `docs/archive/review-2026-05-30/backlog_ided.json` `_id: 36`, and the corresponding `findings.json`, `backlog_confirmed.json`, `low_confirmed.json`, titled “Ambiguous system prompt precedence not enforced.” No new dynamic experiment. |
| C-PROMPT-02: instruction cache could retain edited text when a composer is reused | **No fresh product finding** | Current Engine constructs a new composer per run. In-place cache lifetime alone does not establish a production defect. |
| C-PROMPT-03: section override, tool gating, SectionCache invalidation | **Bounded counterchecks pass** | First-run composition shard: actual built-in presets, contributed section data, reused composer gate changes, explicit cache-break/invalidation semantics. |

## Validation and evidence limits

Executed commands, each once, with raw stdout plus stderr saved before any result interpretation:

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round5/evidence/prompt-instruction-order.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round5/evidence/prompt-composition.test.ts
```

| First-run shard | Tests | Assertions | Exit | Outcome |
| --- | ---: | ---: | ---: | --- |
| [instruction-order](evidence/prompt-instruction-order.first.log) | 2 | 14 | 0 | Completed, 0 failures, 0 skipped |
| [composition](evidence/prompt-composition.first.log) | 4 | 19 | 0 | Completed, 0 failures, 0 skipped |
| Total | **6** | **33** | — | **0 failures / 0 skipped** |

The composition shard dynamically checks actual Core built-in preset assembly, contributed section trimming and order, missing-section error, general-preset browser instruction gating across reused composer calls, and SectionCache reuse/break/invalidation/empty-section behavior. Coding's declaration and its actual markdown are read as source/data and passed to the real section loader; **the coding module, adapters, and Engine are not instantiated**, so this is not a coding-composition runtime receipt.

No fixture, dependency, or platform failure occurred; therefore there is no failed direction or repaired/retried experiment. A separate documentation count-parser assertion failed once; [the assembly note](evidence/prompt-receipt-assembly-note.md) preserves its terminal response and explains the correction from unchanged logs, with no test rerun. No real models, CLI processes, Git commands inside fixtures, network requests, hooks, permissions/auth/security experiments, injection experiments, user data, build, broad test suite, or typecheck. Previously failed CLI/data/recorder/JSON-summary/Discord directions were not revived. All **28/28** source files match the frozen Git blobs in the [source manifest](evidence/prompt-source-manifest.json); per-shard counts, log hashes, and cleanup limits are in [receipts](evidence/prompt-receipts.json). Raw `.log` files may require force-add because the repository ignores logs.
