# A4 — `ToolContext.cwd` Consistency Across Builtin Tools

**Date:** 2026-05-26
**Status:** Approved — implementation in progress
**Closes:** [Gate 1](../../architecture/16-core-overall-design-standard.md#gate-1-correctness-gate) bullets 1–2 + [§S5](../../architecture/16-core-overall-design-standard.md#s5-toolcontextcwd-is-the-only-execution-root)
**Plan reference:** [Phase A — A4](../plans/2026-05-26-core-stabilization.md#a4-cwd-consistency-across-all-tools)

---

## Problem

`Bash` correctly consumes `ctx.cwd` (`bash.ts:98`: `const cwd = ctx?.cwd ?? process.cwd()`), but the rest of the builtin tool fleet still falls back to `process.cwd()`:

| Tool | File:line | Current cwd source | Accepts `ctx`? |
|---|---|---|---|
| `ApplyPatch` | `apply-patch/index.ts:78` | `process.cwd()` (hardcoded) | No |
| `Glob` | `glob.ts:29` | `args.path ?? process.cwd()` | No |
| `Grep` | `grep.ts:60` | `args.path ?? process.cwd()` | No |
| `REPL` | `repl.ts:63` | `process.cwd()` (hardcoded) | No |
| `PowerShell` | `powershell.ts:46` | `process.cwd()` (hardcoded) | No |
| `Skill` | `skill.ts:41` | `scanSkills(process.cwd())` | No |
| `Arena` | `arena.ts:261` | `new SettingsManager(process.cwd())` | **Yes** (already in signature) |

This breaks every scenario where the host process cwd differs from the Engine's cwd: desktop running multiple session windows, managed runs, worktrees, sub-agents started in a sibling directory.

The framework is already ready: `ToolContext.cwd` is defined (`context.ts:95`), `executor.ts:328` already passes `ctx` to the registered executor, and `registry.ts:127` declares the executor signature as `(args, ctx?) => Promise<string>`. Only the per-tool implementations need to be wired.

## Approach

A single mechanical change applied to all 7 tools:

1. Add `ctx?: ToolContext` to the `execute` function signature.
2. Resolve cwd as `const cwd = ctx?.cwd ?? process.cwd();` — same pattern as `Bash`.
3. Use that local `cwd` for:
   - `apply-patch`: pass to `applyPatch(hunks, { cwd })`.
   - `glob`/`grep`: resolve `args.path` relative to `cwd` when it is a relative path; fall back to `cwd` when `args.path` is absent.
   - `repl`/`powershell`: pass to `execSync(..., { cwd, ... })`.
   - `skill`: pass to `scanSkills(cwd)`.
   - `arena`: pass to `new SettingsManager(cwd)`.

The `process.cwd()` fallback is intentional. It keeps unit tests that don't construct a full `ToolContext` working, and matches the `Bash` precedent. The standard's "ctx.cwd is the only execution root" rule is satisfied because every production path injects `ctx` through `ToolExecutor.setContext(ctx)`; the fallback is a defensive default, not an alternative source.

### Relative path semantics

For `Glob`/`Grep`, the existing tools accept an `args.path` parameter. After A4:

- absolute `args.path` → used as-is (with the same final classification rules);
- relative `args.path` → resolved against `ctx.cwd`;
- missing `args.path` → defaults to `ctx.cwd`.

Same applies to `apply-patch` hunks if they reference relative paths inside the patch — `applyPatch(hunks, { cwd })` already does this resolution; we just feed it the right cwd.

### `process.chdir` immunity

The point of the change is that tools must work correctly even when the host process cwd is unrelated to the Engine cwd. Tests must deliberately set `process.chdir(tempA)` and `EngineConfig.cwd = tempB`, then assert tools resolve against `tempB`.

## Tests

New file `tests/tool-cwd.test.ts`. Each test:

- creates two temp dirs `A` and `B` with distinct file contents;
- calls `process.chdir(A)`;
- constructs a minimal `ToolContext` with `cwd: B`;
- invokes the tool's executor with `ctx`;
- asserts the result reflects `B`, not `A`.

Cases:

1. `Glob` — files exist in B but not A; pattern matches only B's files.
2. `Grep` — distinct content in B; pattern hits B's content.
3. `ApplyPatch` — relative patch path resolves to B/file, not A/file.
4. `REPL` — runs `pwd` (Node REPL emulation: `console.log(process.cwd())`) — output is B.
5. `PowerShell` — skipped on macOS/Linux unless `pwsh` is installed; mark as opportunistic.
6. `Skill` — `scanSkills` picks up a marker in B's skills dir, not A.
7. `Arena` — settings loaded from B, not A.

`process.chdir` between tests is a global mutation. We restore it in `afterEach`.

## Out of scope

- Changing tools that don't depend on cwd (Read uses absolute paths only — already correct; LSP, Plan, TodoWrite, etc.).
- MCP tool wrappers — separate channel, MCP servers manage their own cwd.
- Worktree tool — already manages its own cwd as part of its semantics.
- Removing the `process.cwd()` fallback. Keeping it preserves existing call-sites that don't wire `ToolContext` (older tests, ad-hoc scripts).

## Verification

- All new tests pass.
- Existing tests for the touched tools (`apply-patch.test.ts`, `tools.test.ts`, etc.) keep passing.
- `bun run lint:engine-bypass` OK.

## Risk and rollback

- Risk: a test that previously relied on `process.cwd()` (the implicit value) breaks because a `ctx.cwd` it didn't set is now consulted first. Mitigation: the fallback (`ctx?.cwd ?? process.cwd()`) preserves the old behavior when `ctx` is undefined. Tests that previously passed should keep passing.
- Risk: `apply-patch`'s `applyPatch(hunks, { cwd })` ignores the cwd in some hunk modes. Spot-check during implementation.
- Rollback: revert is per-file; each tool change is independent.
