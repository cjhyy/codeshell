# capability-control

**One-line role.** A read-only projection + folding layer over the four extension capabilities (builtin tools, MCP servers, skills, plugins) plus sub-agent roles — it answers "what's enabled here" and routes every enable/disable write to the right settings key, including the tri-state project overlay.

## 职责 / Responsibility

This module unifies five heterogeneous capability sources behind one shape (`CapabilityDescriptor`) so callers never branch on `kind`. It computes the *effective* enabled state by folding a project's `capabilityOverrides` (tri-state `on`/`off`/`inherit`) over the global baseline, and the `CapabilityService` routes toggle-writes to the correct settings key/mode (denylist, allowlist, or `mcpServers` record flag). It is strictly a computed view: the source of truth stays in the loaders and `SettingsManager`; descriptors are never persisted. Boundaries — it does not load skills/plugins/tools itself (those are injected) and does not perform the run-time tool gating; it only produces the lists and overlay math that the engine and hosts consume.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `index.ts` | Public barrel — re-exports `CapabilityService`, the `project*` projections, and the descriptor/error types. |
| `types.ts` | `CapabilityDescriptor`, `CapabilityControl`, `WriteScope`, `CapabilityOverrideState`, `CapabilityNotFoundError`. |
| `project.ts` | Pure projection functions (`projectBuiltin` / `projectMcp` / `projectSkills` / `projectAgents` / `projectPlugins`): loader output + settings slice → `CapabilityDescriptor[]`. No I/O. |
| `overlay.ts` | Pure tri-state overlay math: `applyOverride`, `effectiveDisabledList`, `whitelistDisabledList`, `effectiveBuiltinLists`, `bucketForKind`, `overrideFor`, `overrideTokenForId`. |
| `disabled-lists.ts` | `computeEffectiveDisabledLists` — the ONE place that folds project overrides over the global `disabledSkills`/`disabledPlugins` baseline (plus the no-repo whitelist inversion). |
| `service.ts` | `CapabilityService` — composes the projections into one list and routes `setEnabled` / `setOverride` writes. |
| `*.test.ts` | Unit tests for each of the above. |

## 公开接口 / Public API

Re-exported from the core package root (`@cjhyy/code-shell-core`) via `index.ts`:

```ts
class CapabilityService {
  constructor(deps: CapabilityServiceDeps);
  // No cwd → user/global view; with cwd → project view (descriptors gain
  // globalEnabled / projectOverride / effectiveSource, enabled reflects overlay).
  list(cwd?: string): CapabilityDescriptor[];
  // Default scope "user" (global write). scope:"project" maps on/off to a
  // tri-state override (requires cwd).
  setEnabled(id: string, on: boolean, opts?: { scope?: WriteScope; cwd?: string }): void;
  // Write a project tri-state override; "inherit" DELETES the key.
  setOverride(id: string, state: CapabilityOverrideState, opts: { scope: "project"; cwd: string }): void;
}

interface CapabilityServiceDeps {
  registry: Pick<ToolRegistry, "listToolsDetailed">;
  settings: Pick<SettingsManager,
    "get" | "saveUserSetting" | "saveProjectSetting" | "deleteProjectSetting" | "getForScope">;
  cwd: string;
  scanSkills: (cwd: string, opts?: { disabledSkills?: string[]; disabledPlugins?: string[] }) => SkillDefinition[];
  scanAgents: (cwd: string) => AgentDefinition[];   // UNFILTERED full role set
  readInstalledPlugins: () => InstalledPluginsV2;
  resolveBuiltinToolNames: (o?: { preset?: string; enabledBuiltinTools?: string[]; disabledBuiltinTools?: string[] }) => string[];
}

// Effective-disabled folding (used by engine + protocol servers):
function computeEffectiveDisabledLists(sm: SettingsManager, cwd: string | undefined): EffectiveDisabledLists;
interface EffectiveDisabledLists { disabledSkills: string[]; disabledPlugins: string[]; disabledPluginHooks: string[]; }

// Pure projections (used by the service; also exported for direct use):
function projectBuiltin(input): CapabilityDescriptor[];
function projectMcp(input): CapabilityDescriptor[];
function projectSkills(input): CapabilityDescriptor[];
function projectPlugins(input): CapabilityDescriptor[];

type CapabilityDescriptor;     // id, kind, name, description, enabled, control, + overlay fields
type CapabilityControl;        // { settingsKey, mode, token }
class CapabilityNotFoundError;
```

Also exported from `overlay.ts` for engine/host consumers (not in the barrel; import from the subpath): `effectiveDisabledList`, `effectiveBuiltinLists`, `whitelistDisabledList`.

## 怎么用 / How to use

### 1. Host: list + toggle capabilities for a settings page (real desktop wiring)

From `packages/desktop/src/main/capabilities-service.ts` — build a fresh service per call (it holds no mutable state):

```ts
import {
  CapabilityService, SettingsManager, ToolRegistry,
  scanSkills, readInstalledPlugins, resolveBuiltinToolNames,
  loadAgentDefinitionsForCwd,
} from "@cjhyy/code-shell-core";

function makeService(cwd: string): CapabilityService {
  const settings = new SettingsManager(cwd, "full");
  const preset = (settings.get() as { agent?: { preset?: string } }).agent?.preset;
  const registry = new ToolRegistry({ builtinTools: resolveBuiltinToolNames({ preset }) });
  return new CapabilityService({
    registry, settings, cwd,
    scanSkills,
    // UNFILTERED full role set so disabled roles still list and can be re-enabled.
    scanAgents: (c) => loadAgentDefinitionsForCwd(c, [], []).list(),
    readInstalledPlugins, resolveBuiltinToolNames,
  });
}

// Non-empty cwd → project view (overlay fields populated); empty → user view.
const caps = makeService(cwd).list(cwd || undefined);

// User-scope toggle (global write):
makeService(cwd).setEnabled(id, true, { scope: "user", cwd });
// Project-scope tri-state ("inherit" clears the override):
makeService(cwd).setOverride(id, "on", { scope: "project", cwd });
```

### 2. Engine / protocol server: fold the effective disabled lists before the MCP merge

From `engine.ts` and `cli/agent-server-stdio.ts` — every consumer MUST fold through here so "project on overrides global off" holds everywhere (the bug this extraction fixed: raw `settings.disabledPlugins` was leaking past the overlay into the plugin-MCP merge):

```ts
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core";

const { disabledPlugins } = computeEffectiveDisabledLists(
  new SettingsManager(sessionCwd, "full"),
  sessionCwd,
);
// feed disabledPlugins into mergePluginMcpServers, run-time skill filtering, etc.
```

## 注意 / Gotchas

- **`list()` must receive the FULL, unfiltered skill/agent set.** `scanSkills(cwd, {})` and `scanAgents` are called with no disabled filter on purpose — passing an already-filtered set drops disabled entries entirely, leaving the UI no way to re-enable them.
- **Two distinct scopes, easily confused.** `SettingsManager`'s read scope (`"isolated" | "project" | "full"`) is the disk-READ layer; `WriteScope` (`"user" | "project"`) is where a capability *write* lands (user → global `settings.json`, project → `capabilityOverrides`). Hosts use read scope `"full"` so `list()` reflects the user-level toggles `setEnabled` writes back.
- **`setEnabled` default scope is `"user"` (back-compat).** Old callers passing no `opts` get a global write unchanged. `scope:"project"` requires a `cwd`.
- **`"inherit"` is never persisted.** `setOverride(id, "inherit", …)` *deletes* the key; absence of a key === inherit. Unknown/garbage override values are also treated as inherit, so a corrupt config never makes every capability vanish.
- **Builtin overrides must land in BOTH lists.** Builtin tools resolve from an allow/deny pair (`preset ∪ enabled − disabled`), so `effectiveBuiltinLists` writes `on` to enabled + removes from disabled (and vice versa). Skills/plugins/agents are a single denylist by contrast.
- **no-repo conversation scope INVERTS skills/plugins to a whitelist.** When `cwd === noRepoDir()`, `computeEffectiveDisabledLists` uses `whitelistDisabledList` (default-all-off, only explicit `"on"` survives). agent/mcp/builtin are NOT inverted.
- **`computeEffectiveDisabledLists` never throws** — any read error falls back to empty lists (matching the old `Engine.readDisabledLists` contract). Don't add try/catch around it expecting errors.
- **MCP `record-flag` writes never conjure a server.** Toggling an MCP server that isn't in `mcpServers` is a no-op (it won't create the record).
- **`new CapabilityService` requires `cwd === noRepoDir()` knowledge only inside the fold** — the service itself is pure-ish and stateless; rebuild it freely. Core changes here require a **core rebuild** before the desktop/tui `dist` imports pick them up.
- **ESM:** all imports are `.js`-suffixed ESM paths (`./service.js`, `../capability-control/overlay.js`).
