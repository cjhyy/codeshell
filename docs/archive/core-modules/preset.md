# preset

**One-line role.** Built-in agent presets that bundle a default prompt, a built-in-tool whitelist, and safe permission shortcuts so the engine can stay domain-agnostic.

## 职责 / Responsibility

A preset is the "personality bundle" the engine resolves at construction: which prompt sections to assemble, which built-in tools are allowed (the whitelist that `ToolRegistry` filters `BUILTIN_TOOLS` against), whether to inject git status, and which tools are auto-allowed by default. The module ships two built-ins (`general`, `terminal-coding`) and lets external repos add their own via `registerPreset`. It deliberately does *not* register or implement tools, render prompts, or enforce permissions — it only declares names and rules that the engine, prompt composer, and capability-control service consume.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `index.ts` | The entire module: preset type, two built-in preset definitions, tool/permission sets, and the resolve/register/list functions. |
| `preset-builtin-tools.test.ts` | Regression test asserting every preset's `builtinTools` names exist in `BUILTIN_TOOLS`, and that any preset offering `Bash` also offers `BashOutput`/`KillShell`/`ListShells`. |

## 公开接口 / Public API

Re-exported from the package root (`code-shell`) via `src/index.ts`.

```ts
interface AgentPreset {
  name: AgentPresetName;
  label: string;
  description: string;
  promptSections: readonly string[];   // section filenames without .md, e.g. "base"
  injectGitStatus: boolean;
  builtinTools: string[];              // the whitelist
  defaultPermissionRules: PermissionRule[];
}

type AgentPresetName = "general" | "terminal-coding" | (string & {});

const AGENT_PRESET_NAMES: readonly ["general", "terminal-coding"];
const BUILTIN_AGENT_PRESETS: Record<AgentPresetName, AgentPreset>;
const DEFAULT_AGENT_PRESET: AgentPresetName;   // "general"
const DEFAULT_CLI_PRESET: AgentPresetName;     // "terminal-coding"

// throws "Unknown agent preset ..." for an unregistered name; no arg → default
function resolveAgentPreset(name?: string): AgentPreset;

// joins the preset's section .md files into one system prompt
function buildPresetSystemPrompt(preset: AgentPreset): string;

// preset whitelist, then enabled[] added, then disabled[] removed
function resolveBuiltinToolNames(options?: {
  preset?: string;
  enabledBuiltinTools?: string[];
  disabledBuiltinTools?: string[];
}): string[];

function registerPreset(preset: AgentPreset): void;   // add a custom preset
function listPresetNames(): string[];                 // built-in + custom
```

## 怎么用 / How to use

**Engine construction** (`engine/engine.ts`) — resolve the preset, then turn its whitelist (plus per-project tri-state overrides) into the registry's allowed tool names:

```ts
this.preset = resolveAgentPreset(config.preset);
const builtinLists = effectiveBuiltinLists(/* ...project overlay... */);
this.toolRegistry = new ToolRegistry({
  builtinTools: resolveBuiltinToolNames({
    preset: this.preset.name,
    enabledBuiltinTools: builtinLists.enabledBuiltinTools,
    disabledBuiltinTools: builtinLists.disabledBuiltinTools,
  }),
});
```

**Prompt composition** (`prompt/composer.ts`) — the resolved preset drives both git-status injection and the behavior sections:

```ts
const preset = this.options.preset ?? resolveAgentPreset();
if (!preset.injectGitStatus) return "";        // buildSystemContext
// ...elsewhere, the "behavior" section:
return buildPresetSystemPrompt(preset);
```

**Registering a custom preset** (`product/define.ts` builds one from a product contract, then):

```ts
registerPreset({
  name: "data-pipeline",
  label: "Data Pipeline Orchestrator",
  description: "Manages ETL workflows.",
  promptSections: ["base", "orchestration"],
  injectGitStatus: false,
  builtinTools: ["Read", "Write", "Bash", "Glob", "Grep", "Agent"],
  defaultPermissionRules: [{ tool: "Read", decision: "allow" }],
});
```

## 注意 / Gotchas

- **The whitelist is load-bearing.** `registerBuiltins` filters `BUILTIN_TOOLS` by the preset's `builtinTools`. If a tool the model can legitimately call (e.g. `BashOutput` after `Bash(run_in_background=true)`) is missing from the whitelist, it never registers and the model hits "Tool not found", killing the turn. Whenever you add a new built-in tool, add it to the preset(s) — the test in `preset-builtin-tools.test.ts` guards this.
- **The frozen-set trap.** The engine builds the registry's builtin set once at construction. A mid-session project override can only *hide* (`off`) a builtin from a turn's tool list, not *add* one — newly force-enabled (`on`) builtins not already in the frozen set need a session restart to appear.
- **Permission rules ≠ tool inclusion.** `defaultPermissionRules` only pre-allows tools; gated writes like `MemorySave`/`MemoryDelete` are intentionally left out so the tool's own `permissionDefault: "ask"` still prompts the user. Adding a tool to `builtinTools` does not auto-allow it.
- **`resolveAgentPreset` throws** on an unknown name (listing available presets) — callers passing user/config strings should expect that.
- **Custom presets live in a process-local `Map`.** `registerPreset` is in-memory and not persisted; a host must call it during startup before the engine resolves the preset name.
- **`promptSections` are filenames** (without `.md`) under `src/prompt/sections/`, resolved by `loadSections`. A typo silently yields a missing section, not a build error.
