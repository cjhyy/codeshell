# CodeShell

CodeShell is a general-purpose AI agent orchestration framework for terminal and headless workflows.

It now ships with built-in presets:

- `general`: a domain-agnostic orchestrator for research, automation, operations, and long-running tasks
- `terminal-coding`: a coding-focused terminal assistant built on top of the same core engine

The important part is that the core is no longer tied to software engineering. The turn loop, context management, permissions, MCP integration, hooks, tasks, cron, and sub-agents stay generic; coding behavior is expressed as a preset.

## Features

### Core engine

- Turn-based agent loop with streaming output
- Context compaction and session persistence
- Permission-gated tool execution
- Hook pipeline and MCP integration
- Task tracking, sub-agents, sleep, and cron tools for long-running workflows

### Presets

- `general` for orchestration-heavy work
- `terminal-coding` for terminal-native code editing and code navigation
- Configurable prompt and built-in tool selection through settings or the programmatic API

### Terminal UX

- Interactive REPL built with Ink
- Headless `run` mode for one-shot execution
- Session resume and cost tracking

## Quick start

```bash
# Default CLI preset: terminal coding assistant
npx @cjhyy/code-shell

# Run the same framework as a general orchestrator
npx @cjhyy/code-shell --preset general

# One-shot execution with the general preset
npx @cjhyy/code-shell run --preset general "Create a long-running research plan and track it with tasks"
```

## Programmatic API

```ts
import { Engine } from "@cjhyy/code-shell";

const generalEngine = new Engine({
  llm: {
    provider: "openai",
    model: "gpt-4.1",
    apiKey: process.env.OPENAI_API_KEY,
  },
  preset: "general",
});

const codingEngine = new Engine({
  llm: {
    provider: "openai",
    model: "gpt-4.1",
    apiKey: process.env.OPENAI_API_KEY,
  },
  preset: "terminal-coding",
});
```

### Subpath imports

Pull only what you need:

```ts
import { RunManager, FileRunStore } from "@cjhyy/code-shell/run";
import { Arena, IterativeArena }     from "@cjhyy/code-shell/arena";
import { defineProduct }             from "@cjhyy/code-shell/product";
```

## Configuration

CLI preset selection:

```bash
npx @cjhyy/code-shell --preset general
npx @cjhyy/code-shell --preset terminal-coding
```

Settings-based configuration:

```json
{
  "agent": {
    "preset": "general",
    "enabledBuiltinTools": ["LSP"],
    "disabledBuiltinTools": ["WebSearch"],
    "appendSystemPrompt": "Prefer long-horizon planning and keep task state updated."
  }
}
```

Supported `agent` settings:

- `preset`
- `enabledBuiltinTools`
- `disabledBuiltinTools`
- `customSystemPrompt`
- `appendSystemPrompt`

## Built-in presets

| Preset | Purpose | Extra tools |
|------|------|------|
| `general` | General orchestration, research, automation, long-running work | Core orchestration tools only |
| `terminal-coding` | Terminal coding assistant | `EnterWorktree`, `ExitWorktree`, `NotebookEdit`, `LSP`, `Brief` |

## Built-in tools

The framework keeps a broad orchestration toolbox available, including:

- File tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`
- Execution tools: `Bash`, `PowerShell`, `REPL`
- Coordination tools: `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskOutput`, `Agent`, `SendMessage`, `Sleep`
- Planning/runtime tools: `EnterPlanMode`, `ExitPlanMode`, `CronCreate`, `CronDelete`, `CronList`
- Discovery/integration tools: `ToolSearch`, `Skill`, `MCPTool`, `ListMcpResources`, `ReadMcpResource`
- Coding-only preset extras: `EnterWorktree`, `ExitWorktree`, `NotebookEdit`, `LSP`

## Architecture

```text
User / CLI / SDK
  -> Engine
    -> Preset resolution (prompt + default tools + default permission shortcuts)
    -> TurnLoop
      -> ModelFacade
      -> ToolExecutor
      -> ContextManager
      -> Hooks / MCP / Tasks / Sessions
```

Design principles:

- Core first: orchestration engine stays domain-agnostic
- Presets over hardcoding: coding behavior lives in configuration
- Secure by default: permission-gated actions and explicit approval flow
- Long-running ready: tasks, cron, sleep, and sub-agents are first-class

## Further Reading

- [CodeShell 当前架构与定位说明](docs/codeshell-repo-architecture.md)

## Project structure

```text
src/
├── cli/              # CLI entrypoints and terminal UI
├── context/          # Context compaction and window management
├── engine/           # Turn loop orchestration
├── hooks/            # Hook chain
├── llm/              # Model providers
├── preset/           # Built-in agent presets
├── prompt/           # Prompt composition
├── session/          # Session persistence and memory
├── tool/             # Tool registry, execution, permissions, MCP
└── index.ts          # Public API exports
```

## Development

```bash
bun install
bun run build
bun run tsc --noEmit
```

`bun run tsc --noEmit` currently reports many pre-existing repo-wide issues outside the preset/framework changes, so treat typecheck as a global health signal rather than a clean gate for just this slice.

## Acknowledgments

The `ApplyPatch` tool (`src/tool-system/builtin/apply-patch/`) is adapted from
[OpenAI Codex `codex-rs/apply-patch`](https://github.com/openai/codex/tree/main/codex-rs/apply-patch),
licensed under the Apache License 2.0. See `NOTICE.md` and `LICENSE-codex` in
that directory for details, including the intentional behavioral divergence
where our applier rolls back partial writes on failure.
