# external-agents

**One-line role.** Normalizes the user's `externalAgents` settings block (Claude Code / Codex CLI) into a fully-defaulted config, and defines its types — the source of truth for whether a Mobile Web Remote "Room" runs in a trusted (bypass-permissions) workspace.

## 职责 / Responsibility

This module is pure settings glue. It takes the optional, possibly-sparse `externalAgents` object that a user may put in their settings file and produces a `ResolvedExternalAgentsConfig` where every field has a concrete default. Its most consequential output is `claudeCode.trustedWorkspaces`, the allowlist that the desktop main process consults when deciding a Room's permission mode (a trusted cwd may run `bypassPermissions`; everything else is downgraded to `default`). It does NOT launch processes, manage jobs, or talk to the agents — it only resolves config. (The former `/cc` & `/codex` managed-job launcher path was removed; the phone now talks to resident Rooms only.)

## 文件 / Files

| File | Purpose |
| --- | --- |
| `config.ts` | The single function `resolveExternalAgentConfig` — fills in defaults for every field. |
| `types.ts` | Raw (`*Settings`, all-optional) and resolved (`Resolved*`, all-required) interfaces plus `ExternalAgentMode`. |
| `config.test.ts` | bun:test coverage: default `safe` mode / empty arrays, and pass-through of `trustedWorkspaces`. |

There is no `index.ts`; the public surface is re-exported from `packages/core/src/index.ts`.

## 公开接口 / Public API

```ts
// from "@cjhyy/code-shell-core" (re-exported via core index.ts)

function resolveExternalAgentConfig(
  settings: ExternalAgentsSettings | undefined,
): ResolvedExternalAgentsConfig;

type ExternalAgentMode = "safe" | "dangerous";

interface ExternalAgentsSettings {        // raw input, all optional
  claudeCode?: ClaudeCodeSettings;
  codex?: CodexSettings;
}

interface ResolvedExternalAgentsConfig {  // fully defaulted output
  claudeCode: ResolvedClaudeCodeSettings; // { command, defaultMode, dangerousArgs[], trustedWorkspaces[], autoStartInTrustedWorkspaces }
  codex: ResolvedCodexSettings;           // { command, args[] }
}
```

Defaults applied by `resolveExternalAgentConfig`: `claudeCode.command="claude"`, `defaultMode="safe"`, `dangerousArgs=[]`, `trustedWorkspaces=[]`, `autoStartInTrustedWorkspaces=false`; `codex.command="codex"`, `codex.args=[]`.

## 怎么用 / How to use

Resolve config and gate a Room's permission mode on `trustedWorkspaces` (mirrors the real call site in `packages/desktop/src/main/index.ts`):

```ts
import { resolveExternalAgentConfig } from "@cjhyy/code-shell-core";

const settings = ((await readSettings("user", cwd).catch(() => null)) ?? {}) as {
  externalAgents?: Parameters<typeof resolveExternalAgentConfig>[0];
};
const cfg = resolveExternalAgentConfig(settings.externalAgents).claudeCode;

const norm = (p: string) => p.replace(/\/+$/, ""); // ignore trailing slashes
const trusted = cfg.trustedWorkspaces.some((p) => norm(p) === norm(cwd));

// A non-trusted cwd can never silently get bypassPermissions:
const mode = trusted ? "bypassPermissions" : "default";
```

Calling with no settings yields safe defaults:

```ts
const cfg = resolveExternalAgentConfig(undefined);
// cfg.claudeCode.defaultMode === "safe", trustedWorkspaces === [], command === "claude"
```

## 注意 / Gotchas

- **trustedWorkspaces is a security boundary, not a convenience.** The desktop main process treats it as the source of truth for granting `bypassPermissions` to a Room; an explicit `bypassPermissions` request from a non-trusted cwd is downgraded to `default`. Don't weaken this matching. Real call sites normalize trailing slashes (`/\/+$/`) before comparing — paths are matched by string equality, not realpath/case-folding, so the comparison is sensitive to canonical form.
- **The Zod schema is separate.** Validation of the raw block lives in `packages/core/src/settings/schema.ts` (`SettingsSchema.externalAgents`). If you add a field to `types.ts` / `config.ts`, mirror it in that schema or the field will be stripped on validation.
- **`dangerousArgs` is config-provided, not hardcoded** — it's intentionally externalized so it tracks CLI flag changes without a code release.
- **ESM `.js` imports.** Internal imports use `.js` extensions (`./types.js`, `./config.js`) per the package's ESM/NodeNext setup, even though the sources are `.ts`.
- **Pure function, no side effects.** `resolveExternalAgentConfig` reads nothing from disk and starts no process; callers do the I/O (e.g. `readSettings`) and pass the block in.
