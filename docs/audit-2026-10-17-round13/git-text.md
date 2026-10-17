# Round 13 — Git text helpers and additional transcript source review

Frozen baseline: `7927a7c8b80b4aec710dee1f6d831ad1982bb466`. Result: **0 new confirmed bugs, 0 formal candidates**. Product code unchanged.

## Git parser and branch-name data

Read `packages/coding/src/git/parse-log.ts`, `utils.ts`, `worktree/slug.ts`, `worktree/query.ts` and corresponding existing test source. Inspected the ordinary parser consumers in `packages/coding/src/capability-runtime.ts:72–85` and `packages/tui/src/cli/commands/builtin/git-commands.ts:70–80` statically; no context provider or command was invoked.

The ordinary pipe-containing subject defect is already **A04** in [the October 16 root report](../audit-2026-10-16/root.md), and the shared stdout trim/status-column defect is already **A03** there. May 30 findings also discuss the split boundary. Neither is counted again, and no new pipe/status fixture or actual Git producer was run. Read-only [Git pretty-format documentation](https://git-scm.com/docs/pretty-formats) confirms the source format fields: `%s` subject, `%an` author and `%ci` committer date; it supplies format context only, not new installed-Git execution evidence.

The one first guarded command was:

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/coding/src/git/parse-log.test.ts packages/coding/src/git/worktree/slug.test.ts
```

[First raw combined output](evidence/root-git-text-existing.first.log) and [exit receipt](evidence/root-git-text-existing.first.exit.json) were saved before inspection: **8 pass, 17 expectations, 0 fail/skip**, guard completed. These existing tests cover normal/missing parser fields, empty lines, pure slug/prefix formatting and rejection of invalid branch-name strings. They do not launch Git, create a worktree, import the utils runtime, resolve executables or touch a repository.

`worktree/query.ts` was source-only. Its existing tests execute Git and create repositories/worktrees, so they were not run. No new ownership, cleanup, prefix-security or custom Git-layout claim was promoted from this source read.

## Additional transcript source inspection

Also read `packages/desktop/src/renderer/automation/mergeTranscripts.ts`, `foldTranscript.ts`, and `importRuns.ts`. This extends source inspection to cursor/turn identity, disk/live overlap and run-import filtering. Their runtime paths were **not executed**. In particular fold carries localization imports, and this batch does not restore the previously skipped i18n validation direction.

The large combined test-source read was truncated by the tool. It does **not** prove full reading of the test files: merge/fold test excerpts and the separate merge/import test-title inventory only are counted as inspected test source. The small `importRuns.ts` product file was independently read in full afterward. No tests or product outputs were repaired/retried, because no runtime experiment was started for these transcript modules.

Current source explicitly prefers durable client/steer identities, keeps an epoch-bound cursor, chooses run timing as a unit, and uses a disk-authoritative overlap strategy. The reports already include earlier transcript-window, replay-time and cursor findings; these are excluded. No stronger ordinary producer/contract failure was demonstrated for legacy identity fallback, timing ties, or optional import caps. They remain unpromoted source observations rather than speculative candidates.

## Dedup and limits

[Structured historical search](evidence/root-dedup.json) scanned all prior docs/bugs Markdown and parsed JSON, including archives: **1,075 Markdown + 641 JSON = 1,716 files; 171,493 JSON string leaves; 0 parse errors**. Current round excluded. Contexts are capped per pattern, with total match counts retained; keyword search is not proof of semantic completeness. Transcript patterns were added by metadata-only script expansion, not by rerunning product code.

No actual Git/gh command from product helpers, model, network business request, UI/IPC, user history, terminal/PTY, filesystem applier, real automation or permission/custody experiment ran. Read-only official documentation access and the audit's own Git branch/integration operations are separate from product helper execution. No shared dependency/dist build or full build/typecheck/lint/suite claim. Source pins and coverage distinctions are in [root source manifest](evidence/root-source-manifest.json).
