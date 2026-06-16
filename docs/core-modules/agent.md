# agent

**One-line role.** Parses sub-agent role definitions from Markdown files (YAML frontmatter + body) into runtime `AgentDefinition` objects, and merges multiple source directories (user / plugin / project) into a single lookup registry.

## 职责 / Responsibility

This module owns the on-disk format for reusable sub-agent roles ("agent types") and the rules for turning a directory of `*.md` files into an in-memory registry the engine can query. It defines the `AgentDefinition` shape, a pure parser/serializer pair (no filesystem access), and a registry class that loads/merges directories with last-dir-wins precedence and disabled-name filtering. It deliberately does **not** decide directory order or policy (that lives in `loadAgentDefinitionsForCwd` in the engine), and it does **not** spawn or run agents (that's the `Agent` builtin tool in `tool-system/builtin/agent.ts`).

## 文件 / Files

| File | Purpose |
| --- | --- |
| `agent-definition.ts` | The `AgentDefinition` interface + pure `parseAgentDefinition` / `serializeAgentDefinition` functions. No FS access. |
| `agent-definition-registry.ts` | `AgentDefinitionRegistry` class: reads dirs of `*.md`, parses each, merges with last-dir-wins + override tracking, filters disabled names. The only file in the module that touches `node:fs`. |
| `agent-definition.test.ts` | Parser/serializer round-trip and validation tests. |
| `agent-definition.skills.test.ts` | Tests for `skills:` frontmatter normalization (list vs comma string). |
| `agent-definition-registry.test.ts` | Registry merge/override/disabled-filter tests. |

## 公开接口 / Public API

Re-exported from the package root (`packages/core/src/index.ts`):

```ts
// agent-definition.ts
interface AgentDefinition {
  name: string;              // role key, matched against Agent({ agent_type })
  description: string;       // human-facing "when to use"
  model?: string;            // ModelPool key; undefined → inherit parent
  maxTurns?: number;         // turn cap; undefined → caller/default
  tools?: string[];          // tool allowlist; undefined → inherit parent
  skills?: string[];         // skill allowlist; undefined → inherit; [] → none
  systemPrompt: string;      // Markdown body → child Engine appendSystemPrompt
  source?: "project" | "user" | "plugin";          // runtime-only, never serialized
  filePath?: string;                                // runtime-only
  override?: boolean;                               // shadows a lower-priority same-named def
  shadowedSources?: Array<"project" | "user" | "plugin">; // runtime-only, drives UI override warning
}

// Pure. `sourceName` is used only in error messages. Throws on missing
// frontmatter, invalid YAML, or missing/empty name/description.
function parseAgentDefinition(raw: string, sourceName: string): AgentDefinition;

// Inverse of parse. Omits unset optional fields; never writes runtime-only metadata.
function serializeAgentDefinition(def: AgentDefinition): string;
```

```ts
// agent-definition-registry.ts
interface AgentSourceDir { dir: string; source: "project" | "user" | "plugin"; }

class AgentDefinitionRegistry {
  readonly warnings: string[];                       // one entry per skipped malformed file
  static loadFromDir(dir: string): AgentDefinitionRegistry;            // back-compat, project source, no disabled filter
  static loadFromDirs(dirs: AgentSourceDir[], disabled: string[]): AgentDefinitionRegistry;
  has(name: string): boolean;
  get(name: string): AgentDefinition | undefined;
  list(): AgentDefinition[];
}
```

## 怎么用 / How to use

**1. Load a registry for a cwd (the engine's path).** `loadAgentDefinitionsForCwd` (in `engine/engine.ts`) is the real entry point — it encodes the precedence policy via dir order and delegates the mechanism to this module:

```ts
import { AgentDefinitionRegistry, type AgentSourceDir } from "../agent/agent-definition-registry.js";

// Increasing priority; loadFromDirs is last-dir-wins.
const dirs: AgentSourceDir[] = [
  { dir: `${home}/.code-shell/agents`, source: "user" },     // lowest
  ...pluginAgentDirs(disabledPlugins),                       // baseline
  { dir: `${cwd}/.code-shell/agents`, source: "project" },   // highest — repo agent wins
];
const registry = AgentDefinitionRegistry.loadFromDirs(dirs, disabledAgents);
```

The engine caches the result per `(cwd, disabledKey)` and hands it to tool context as `ctx.agentDefinitions`.

**2. Resolve an agent_type against the registry** (the `Agent` builtin tool, `tool-system/builtin/agent.ts`):

```ts
const available = registry?.list().map((d) => d.name) ?? [];
const def = registry?.get(resolvedType);   // undefined → unknown role
```

**3. Serialize a converted definition to disk** (Codex agent import, `plugins/installer/codex/convertAgents.ts`):

```ts
import { serializeAgentDefinition } from "../../../agent/agent-definition.js";

const md = serializeAgentDefinition({
  name: raw.name.trim(),
  description: raw.description.trim(),
  systemPrompt: body,
  ...(raw.model ? { model: raw.model.trim() } : {}),
});
```

## 注意 / Gotchas

- **`undefined` vs `[]` for `tools`/`skills` is load-bearing.** `undefined` means "inherit the parent's full set"; an empty array means "none". `normalizeNameList` returns `undefined` (not `[]`) for absent/unusable fields so the inherit default survives. `tools:`/`skills:` accept both a YAML list and a comma/whitespace string.
- **Parser is pure; only the registry touches the filesystem.** `parseAgentDefinition` never reads files — pass it raw text plus a `sourceName` (used only in error messages). All `node:fs` access lives in `agent-definition-registry.ts`.
- **Malformed files are skipped, not fatal.** `loadFromDirs` catches per-file parse errors, pushes them onto `registry.warnings`, and keeps going — one bad role file must not break the whole agent system. Check `.warnings` if a role silently went missing.
- **Last-dir-wins is mechanism, not policy.** The registry merges in the order it's given; the project>plugin>user precedence is entirely the caller's dir ORDER. Don't bake precedence into the registry — change `loadAgentDefinitionsForCwd` instead. `override`/`shadowedSources` are filled in during the merge to drive the UI "this project overrides your user version" warning.
- **Disabled names are filtered after the merge**, so a user override of a disabled name is still removed.
- **Runtime-only metadata never round-trips.** `source`, `filePath`, `override`, `shadowedSources` are set by the registry at load time and are deliberately not written by `serializeAgentDefinition`.
- **Directory scan is non-recursive** and only matches `*.md`. Loading uses synchronous `node:fs` (`readdirSync`/`readFileSync`); avoid calling it on a hot path in the main process.
- This is a TS source module compiled to `dist`; hosts importing from `@code-shell/core` need a core rebuild to pick up changes.
