# Review: origin/main..HEAD unpushed 12 commits

Scope reviewed: exact `origin/main..HEAD` range. Tests not run; read-only diff review.
Reviewer: Codex (via DriveAgent), 2026-07-09.

## Verdict per commit

| Commit | Verdict | Notes |
|---|---:|---|
| e1a9f616 docs(todo) | LGTM | Docs-only. |
| 7c7f0c98 fix(desktop) | needs-attention | `.agents` symlink guard is too broad. |
| a81f1a9a fix(core) | needs-attention | `update()` can still reset interval phase. |
| 9ec19281 fix(core) | LGTM | Single `turn_complete(max_turns)` producer remains in Engine. |
| 45b6c6f7 fix(core) | LGTM | Approval cache is now session-bucketed; same-session reuse preserved. |
| a4668368 feat(protocol) | LGTM | SDK exposes approval session metadata/resolved event. |
| b48d3582 fix(protocol) | LGTM | `requireExisting` checks before `getOrCreate`; `goal_cleared` emitted on real clear. |
| dcb0a665 feat(tool-system) | LGTM | PowerShell explicitly marks sandbox `{ backend: "off" }`. |
| 08651545 feat(core+desktop) | LGTM | Tool summaries route by id/agent; id miss safely no-ops. |
| ab264b54 test(tool-system) | LGTM | Tests pin real executor permission-hook hardening. |
| f277abbb test(core) | LGTM | Tests pin ContextLimitError retry and terminal status. |
| 657c6fce test(core) | LGTM | Tests pin goal budget, bounded continuation, and goal clearing. |

## Detailed findings

### 1. Major: `.agents` read guard accepts broader symlink escapes than intended

File: packages/desktop/src/main/safe-read.ts:23

The guard now accepts any resolved path with a `.agents` path segment. Because the skill scanner follows symlink entries under skill bases at packages/core/src/skills/scanner.ts:126, a listed `.code-shell/skills/<name>` symlink can resolve outside the project to an arbitrary path containing `.agents/.../SKILL.md`, then be allowlisted and read in full.

Suggested fix: make the check structural and root-aware. Allow only expected roots, especially project `.agents/skills`, and for the symlink case require the resolved target to stay under the sibling project `.agents/skills/<name>` root. Add a regression test for `.code-shell/skills/s -> <tmp>/outside/.agents/skills/s/SKILL.md`, expecting rejection.

### 2. Major: `CronScheduler.update()` resets interval phase when schedule fields are unchanged

Files: packages/core/src/automation/scheduler.ts:502, :530, :543

Reconcile preserves unchanged timers, but `update()` treats presence of `schedule` or `timezone` as a change. A full patch such as `{ name: "renamed", schedule: current.schedule }` re-arms the interval and pushes `nextRun` to `Date.now() + interval`.

Suggested fix: validate on field presence, but re-arm only on value changes:

```ts
const scheduleChanged =
  (patch.schedule !== undefined && patch.schedule !== job.schedule) ||
  (patch.timezone !== undefined && patch.timezone !== job.timezone);
```

Apply in both store-backed and in-memory branches. Add a test that advances halfway, updates with unchanged schedule/timezone plus a non-schedule edit, and verifies `nextRun`/first fire stay unchanged.

## Regression risk

Most changes are well covered and low risk. The safe-read change touches a security boundary and should be tightened. The scheduler issue is a smaller but direct regression against the absolute interval scheduling goal.

Guardrails checked: no core import from TUI, no desktop renderer runtime import of CodeShell packages, and added tests use `bun:test`.

## Ship or hold

Hold until the safe-read symlink guard is narrowed. Patch the scheduler same-value update edge before shipping as well.
