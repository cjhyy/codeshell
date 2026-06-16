# product

**One-line role.** Assembles a domain-specific agent application ("product") on top of CodeShell by composing a preset (brain) + adapter (hands) + contract (quality) into a ready-to-run `RunManager`.

> Note: despite a common assumption, this module is **not** about product/version/branding constants. It is the public factory for building bespoke agent products (e.g. a security-audit agent, a docs writer) from external repos.

## 职责 / Responsibility

This module defines the contract an external repo implements to turn CodeShell into a concrete agent application, and the single `defineProduct()` call that materializes it. The three-layer model is: **Preset** (system prompt + tool set + permission defaults), **Adapter** (custom tools, MCP servers, tool enable/disable, extra permission rules, hooks), and **Contract** (evaluators, default tags/metadata, turn/token limits, concurrency). `defineProduct()` registers the preset, builds an evaluator, collects custom tools, and wires a fully configured `RunManager`. It does not run the agent itself — the caller drives the returned `manager` via `submit`/`resume`/`cancel`.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `index.ts` | Public barrel — re-exports `defineProduct` plus all product types. Also re-exported from `packages/core/src/index.ts`. |
| `types.ts` | The three-layer contract: `ProductPreset`, `ProductAdapter`, `ProductContract`, the composed `ProductDefinition`, and `CustomTool`. |
| `define.ts` | `defineProduct()` implementation plus its runtime/result types (`ProductRuntimeOptions`, `ProductInstance`). |

## 公开接口 / Public API

```ts
// The one function consumers call.
function defineProduct(
  definition: ProductDefinition,
  runtime: ProductRuntimeOptions,
): ProductInstance;

// What you describe (definition):
interface ProductDefinition {
  preset: ProductPreset;     // required
  adapter?: ProductAdapter;
  contract?: ProductContract;
}

interface ProductPreset {
  name: string;
  label: string;
  description: string;
  sections?: string[];        // reuse builtin prompt sections, e.g. ["base","orchestration"]
  customPrompt?: string;      // full custom system prompt (takes precedence over sections)
  appendPrompt?: string;      // appended after the main prompt
  injectGitStatus?: boolean;  // default false
}

interface ProductAdapter {
  tools?: CustomTool[];
  mcpServers?: Record<string, MCPServerConfig>;
  enableTools?: string[];     // add to builtin defaults
  disableTools?: string[];    // remove from builtin defaults
  permissionRules?: PermissionRule[];  // applied on top of defaults (higher priority)
  hooks?: EngineHookConfig[];
}

interface ProductContract {
  evaluator?: Evaluator | Evaluator[]; // array is auto-composed
  defaultTags?: string[];
  defaultMetadata?: Record<string, unknown>;
  maxTurns?: number;            // default 30
  maxContextTokens?: number;    // default 200_000
  concurrency?: number;         // default 1
}

interface CustomTool {
  definition: RegisteredTool;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// Runtime wiring (NOT part of the product definition):
interface ProductRuntimeOptions {
  llm: LLMConfig;               // required
  permissionMode?: PermissionMode; // default "acceptEdits"
  cwd?: string;                 // default process.cwd()
  runsDir?: string;             // default ~/.code-shell/runs
  sessionStorageDir?: string;
}

// What you get back:
interface ProductInstance {
  manager: RunManager;          // ready for submit/resume/cancel
  preset: AgentPreset;          // the registered preset
  customTools: CustomTool[];    // tools registered by the adapter
}
```

## 怎么用 / How to use

Build a product and drive it via the returned `RunManager` (based on the canonical example in `define.ts`):

```ts
import { defineProduct } from "code-shell";

const { manager, preset } = defineProduct(
  {
    preset: {
      name: "security-audit",
      label: "Security Audit Agent",
      description: "Scans repos for OWASP top 10 vulnerabilities.",
      sections: ["base", "orchestration"],
      appendPrompt: "You are a security expert. Focus on...",
    },
    adapter: {
      tools: [myCustomScanTool],
      enableTools: ["Read", "Glob", "Grep", "Bash"],
      permissionRules: [{ tool: "Bash", decision: "ask" }],
    },
    contract: {
      evaluator: new SecurityEvaluator(),
      defaultTags: ["security"],
      maxTurns: 50,
    },
  },
  {
    llm: { provider: "openai", model: "...", apiKey: "..." },
  },
);

// Drive the agent — submit returns a RunSnapshot.
await manager.submit({ objective: "Audit auth module for SQL injection" });
```

A minimal product (preset only, no custom tools/evaluator) still works — adapter and contract are optional and fall back to sensible defaults:

```ts
const { manager } = defineProduct(
  {
    preset: {
      name: "docs-writer",
      label: "Docs Writer",
      description: "Writes developer documentation.",
    },
  },
  { llm: myLlmConfig },
);

await manager.submit({ objective: "Document the auth module", cwd: "/repo" });
```

## 注意 / Gotchas

- **`defineProduct()` has a global side effect:** it calls `registerPreset()` with `preset.name`. Names must be unique across the process — reusing a name re-registers/overrides it. The `name` is cast to `AgentPreset["name"]`, so it bypasses the built-in preset-name union typing.
- **Base tool set is hardcoded.** Every product starts from `Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Agent, ToolSearch, TodoWrite`; `enableTools` adds to this set and `disableTools` removes from it. There is no way to start from an empty set.
- **Default permission rules are baked in** (`Read/Glob/Grep/AskUserQuestion/ToolSearch/TodoWrite` → `allow`). Your `adapter.permissionRules` are appended *after* these (higher priority), but the allow-list above always exists — notably `Write`/`Edit`/`Bash` are **not** auto-allowed and rely on `permissionMode` (default `"acceptEdits"`) or your own rules.
- **Defaults to override:** `maxTurns` 30, `maxContextTokens` 200_000, `concurrency` 1, `permissionMode` "acceptEdits", `runsDir` `~/.code-shell/runs` (uses `homedir()` directly, not a test-isolated home).
- **`customPrompt` beats `sections`.** If both are set, the full custom prompt wins; `sections` is ignored. When neither preset `sections` nor `customPrompt` is given, sections default to `["base", "orchestration"]`.
- **ESM only:** the module and its imports use `.js` extensions in source (`./types.js`, `../run/RunManager.js`). It is consumed via the package root export `code-shell`.
- **This module does not execute or persist by itself** — it only constructs the `RunManager` (backed by a `FileRunStore` at `runsDir`). Lifecycle (`submit`/`resume`/`cancel`) and event handling are the caller's responsibility.
