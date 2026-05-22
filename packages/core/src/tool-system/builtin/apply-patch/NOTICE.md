# Third-party attribution

Files in this directory contain code adapted from
[OpenAI Codex `codex-rs/apply-patch`](https://github.com/openai/codex/tree/main/codex-rs/apply-patch),
licensed under the Apache License 2.0. See `LICENSE-codex` for the full
license text.

## What was adapted

| Source (Rust)                    | Target (TypeScript)   | Notes                                 |
| -------------------------------- | --------------------- | ------------------------------------- |
| `src/seek_sequence.rs`           | `seek-sequence.ts`    | Direct port — same four-pass strategy |
| `src/parser.rs`                  | `parser.ts`           | Direct port of the V4A grammar parser |
| `src/lib.rs` (chunk replacement) | `applier.ts`          | `compute_replacements` algorithm port |
| `apply_patch_tool_instructions.md` | tool description (`index.ts`) | Patch-format prompt cribbed from the original |
| `tests/fixtures/scenarios/`      | `tests/fixtures/apply-patch/` | 22 golden scenarios used verbatim     |

## Intentional behavioral divergence

`applier.ts` adds a two-phase commit (plan → snapshot → write → rollback)
that Codex does not have. As a consequence:

- Fixture `015_failure_after_partial_success_leaves_changes` produces a
  different on-disk result here than in Codex: we leave **no** files
  behind when a hunk fails, whereas Codex leaves the partial writes from
  earlier hunks. The conformance test asserts our stronger guarantee.

Set `allowPartialOnCommit: true` on `applyPatch()` to fall back to
codex-style non-atomic semantics if needed.
