# Round 15 — CLI integer/context options and static session config

Frozen baseline: `ae777b3fce6fc9986e69ceb62802f3bb3f6aa478`. Result: **0 new confirmed bugs, 0 formal candidates**. Product code unchanged.

## Executed first baseline

Read `packages/tui/src/cli/parse-int-option.ts` and `commands/max-context-tokens.ts` plus their existing tests in full. The first guarded command was:

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/tui/src/cli/parse-int-option.test.ts packages/tui/src/cli/commands/max-context-tokens.test.ts
```

[First raw combined output](evidence/root-cli-existing.first.log) and [exit receipt](evidence/root-cli-existing.first.exit.json) were saved before inspection: **9 pass, 12 expectations, 0 fail/skip**, guard completed. Eight tests invoke actual pure helpers; one test reads the owned REPL source and asserts resolver wiring. The latter is a source integration assertion, not an executed REPL or model session.

Cases cover positive decimal integer conversion, leading zeros, invalid/nonnumeric/zero/negative/trailing-garbage rejection, model-over-settings context limits and the documented default. Actual Commander argument parsing, process exit behavior and a running CLI were not exercised. The imported InvalidArgumentError class alone is not whole-Commander or CLI validation.

## Ordinary producers and exclusions

`packages/tui/src/cli/main.ts:71,101,131` statically wires positiveIntOption for max turns, background wait and session limit; `commands/runs.ts:101,276` does so for run/event limits. `commands/run.ts:128`, `repl.ts:157` and `runs.ts:64` use the shared context-limit resolver. Only relevant source ranges and search references were read; these commands were not imported or run.

The May 30 unvalidated parseInt/NaN case and old REPL duplicated context fallback already have historical records and current defensive/helper wiring. They are not new findings. An arbitrary integer beyond JS's exact-integer range or direct zero/non-finite context values lacks a demonstrated ordinary accepted producer/limit contract here; no speculative candidate is promoted from such inputs.

`packages/core/src/cli/stdio-session-config.ts` and `stdio-host-config.ts` were read in full as small source modules. Protocol prompt overrides use nullish precedence; a missing cwd has a documented no-project fallback. The former imports the settings manager, and the latter concerns host declaration classification. Neither was imported, tested, or used to read settings/host state; no permission/access/actual worker claim follows from this static read.

## Dedup and scope

[Full historical dedup](evidence/root-dedup.json) scanned all prior docs/bugs Markdown and parsed JSON, including archives and excluding this batch: **1,102 Markdown + 723 JSON = 1,825 files; 200,618 JSON string leaves; 0 parse errors**. Exact CLI/helper and session-config keyword contexts are retained with per-pattern caps. Historical plans with “expected FAIL” are design text, not this batch's failed runs or current bug evidence.

No actual CLI/program.parse, REPL, run/session factory, protocol request, settings persistence, real model/network/account/user home data, terminal/PTY, native app, automation or external message ran. No dependency/dist build or full build/typecheck/lint/suite claim. Selected source pins and partial-consumer read ranges are recorded in [root source manifest](evidence/root-source-manifest.json).
