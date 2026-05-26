# Plugin & Settings Shell Hook Trust Model

**Date:** 2026-05-26
**Status:** Standard. Closes [Gate 0 bullet 4](16-core-overall-design-standard.md#gate-0-safety-gate) — "plugin/shell hook execution path is documented as trusted or routed through Bash-equivalent safety."
**Scope:** `packages/core/src/hooks/shell-runner.ts`, `packages/core/src/plugins/pluginCommandHook.ts`.

This document records the explicit trust model for two paths that spawn
user-configured shell commands outside the LLM's tool-call surface.

## TL;DR

User-installed shell hooks (settings hooks + plugin command hooks) are
**trusted code**. They execute with the user's full shell privileges, no
permission classifier, no sandbox. Consent is at *install/configure
time*, not per-execution. This is the same trust level as the user's
`.zshrc` or anything `npm install`'d locally — and is materially different
from Bash tool calls, which the model proposes and the permission
classifier brokers.

If this trust level is unacceptable for an install, the user must remove
the hook from settings or uninstall the plugin. There is no opt-in
sandbox today; adding one is post-stability work tracked in section 5.

## The two paths

### Settings shell hooks

Source: user-edited `~/.claude/settings.json` (or equivalent), top-level
`hooks` array.

Runner: `packages/core/src/hooks/shell-runner.ts:runShellHook`

Execution model:

- `spawn(config.command, [], { shell: true, cwd, env })`
- inherits the engine process environment
- stdin: HookContext JSON envelope
- stdout: HookResult JSON (codeshell-native protocol)
- 60s default timeout, SIGTERM → SIGKILL escalation
- no permission classification; no sandbox

### Plugin command hooks

Source: a plugin's `hooks.json` (or equivalent), installed under
`~/.claude/plugins/...`.

Runner: `packages/core/src/plugins/pluginCommandHook.ts:runPluginCommandHook`

Execution model:

- `spawn(spec.command, [], { shell: true, env: { CODESHELL_PLUGIN_ROOT, ... } })`
- `CLAUDE_PLUGIN_ROOT` is stripped from the inherited env (a separate
  identity story — see `varRewrite.ts`).
- stdin: HookContext JSON envelope
- stdout: CC-style plugin output (`hookSpecificOutput.additionalContext`
  etc.), normalized to HookResult.messages
- 60s default timeout, SIGTERM → SIGKILL escalation
- no permission classification; no sandbox

## Why these are trusted, not classifier-routed

The permission classifier (`packages/core/src/tool-system/permission.ts`)
brokers actions **the LLM proposed**. Its threat model is: "the model is
adversarial, the user is the principal, ask before letting model output
mutate the system."

Shell hooks invert this:

| Aspect              | Model-proposed Bash                    | User-installed shell hook                   |
| ---                 | ---                                    | ---                                         |
| Who chose the command? | LLM, in real time                   | User, at install/config time                |
| Visibility at run? | Inline in transcript, requires consent | Silent unless logged; consent already given |
| Who reads the output? | LLM (it goes into transcript)        | Engine internals (HookResult shape only)    |
| Repeat frequency?  | Once per LLM decision                  | Every matching event (could be every turn)  |

Treating user-installed commands as model-proposed would mean prompting
the user on every hook fire ("allow `git status` for the
SessionStart hook?"). That defeats the purpose of hooks. Bash-tool
classification would also misfire — most hook commands contain shell
metacharacters by design (pipes, command substitution) and would be
forced through `ask` mode, which has no UI for hooks.

The Claude Code project takes the same stance: settings hooks and plugin
command hooks are "code you chose to install," distinct from "actions
the model wants to take."

## Boundaries that DO apply

Even though shell hooks aren't classifier-routed, the engine **does**
enforce:

1. **Timeout** — 60s default, `SIGTERM` then `SIGKILL` (closes Gate 0
   "child process abort works for ... long-running tools" — `shell-runner.ts:81-101`, `pluginCommandHook.ts:133-151`).
2. **No `--no-verify`-equivalent bypass of git hooks** — out of scope; the
   user's own git config governs.
3. **No `acceptEdits`/`bypassPermissions` modes affect hook execution** —
   hooks always run (per matcher) regardless of permission mode.
4. **Hook output cannot upgrade a permission decision to `allow`** — the
   classifier downgrade-only rule (`executor.ts:clampHookDecision`,
   closed under [Gate 0 bullet 3](16-core-overall-design-standard.md#gate-0-safety-gate))
   applies equally to settings hook output and plugin hook output. So
   even if a malicious hook tries `{ decision: "approve" }`, it can only
   tighten a real decision, not relax one.
5. **`CLAUDE_PLUGIN_ROOT` stripping** for plugin hooks (separate identity
   concern; see `pluginCommandHook.ts:95-105`).
6. **Malformed output is dropped, not crashing** — JSON-parse failure,
   non-zero exit (other than 2 = deny), or spawn error all resolve to
   `{}` (no effect) so a buggy hook can't wedge the engine.

## What's expected of users

Treat `settings.json` `hooks` entries and plugin installs the same way
you treat:

- A line you add to `~/.zshrc`.
- A package you `npm install` and import.
- A shell script you save to `~/bin/` and put on PATH.

Review hook commands before saving them. Audit plugins before installing
them. Codeshell does not gate execution at hook-fire time because there
is no signal at that point that the system can use to decide — the user
already said yes by configuring the hook.

## Audit logging

Today, hook execution is logged at the `engine.run` boundary and at hook
failure paths (`shell-runner.ts:62-67`, `:113-117`, `:159-162`;
`pluginCommandHook.ts:116-120`, `:163-168`, `:173-179`). What's logged:

- spawn errors
- non-zero exit codes (with stderr preview)
- timeouts
- malformed JSON output

What's **not** logged today, and intentionally so:

- the command string verbatim (it's already in `settings.json` /
  plugin manifest — duplicating risks leaking secrets if the user
  embedded a password inline)
- stdin content (HookContext can be sensitive)
- stdout content beyond what `HookResult.messages` carries through

If a user-facing per-fire audit log is needed in the future, it should
be opt-in (e.g., `CODESHELL_HOOK_AUDIT=1`) and capped.

## 5. Future work (not blocking core stability)

These are options if/when the trust model needs to harden:

- **Hook allowlist**: a settings field like `hooks.allowedCommands: ["git", "rg"]`
  enforced before spawn.
- **Per-fire prompt**: an opt-in mode where the user is asked once per
  *new* hook command (then remembered). Same UX as the
  classifier's "remember this decision" path.
- **Hook sandbox**: route hook execution through the same `SandboxBackend`
  as Bash. Cost: hooks frequently need access to repo state outside the
  Bash sandbox profile (e.g. reading `.git/`), so the sandbox profile
  would need to be looser, defeating most of its value. Trade-off study
  required before committing.

None of these are required for Gate 0; they would extend it.

## Cross-references

- Permission classifier (model-proposed actions):
  `packages/core/src/tool-system/permission.ts`,
  [A1 spec](../superpowers/specs/2026-05-26-a1-permission-hardening-design.md).
- Hook downgrade-only policy: `packages/core/src/tool-system/executor.ts:clampHookDecision`.
- Plugin identity (`CLAUDE_PLUGIN_ROOT` rewriting): `packages/core/src/plugins/varRewrite.ts`.
- Standard §S4 "Security Boundaries Fail Closed":
  [16-core-overall-design-standard.md#s4](16-core-overall-design-standard.md#s4-security-boundaries-fail-closed).
