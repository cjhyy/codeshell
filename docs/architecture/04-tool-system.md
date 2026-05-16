# Tool System

## Purpose

The tool system is CodeShell's main extension and safety boundary. It turns model-produced `ToolCall` objects into real side effects while enforcing validation, permission policy, hooks, timeouts, cancellation, transcript recording, and guard rails.

## Main Components

| Component | Source | Role |
|---|---|---|
| Tool registry | [`registry.ts`](../../src/tool-system/registry.ts) | Stores built-in, custom, and MCP tools; exposes definitions to the model; executes named tools |
| Tool executor | [`executor.ts`](../../src/tool-system/executor.ts) | Owns per-call flow: plan-mode filter, schema validation, hooks, guards, permission, execution, logging |
| Permission classifier | [`permission.ts`](../../src/tool-system/permission.ts) | Applies explicit rules, bash risk heuristics, approval backends, runtime bypass, denial tracking |
| Tool context | [`context.ts`](../../src/tool-system/context.ts) | Per-Engine dependency container for cwd, LLM config, model pool, AskUser, sub-agent spawner, sandbox |
| Built-ins | [`builtin/`](../../src/tool-system/builtin) | File tools, shell tools, orchestration tools, skills, MCP wrappers, LSP, Arena, worktree, cron |
| MCP manager | [`mcp-manager.ts`](../../src/tool-system/mcp-manager.ts) | Connects MCP servers and registers discovered tools/resources |
| Sandbox | [`sandbox/`](../../src/tool-system/sandbox) | Shell execution isolation backends |
| Guards | [`investigation-guard.ts`](../../src/tool-system/investigation-guard.ts), [`task-guard.ts`](../../src/tool-system/task-guard.ts) | Prevent unproductive repeated reads and stale task state |

## Tool Call Path

```mermaid
sequenceDiagram
  participant Model
  participant Loop as TurnLoop
  participant Queue as StreamingToolQueue
  participant Exec as ToolExecutor
  participant Perm as PermissionClassifier
  participant Reg as ToolRegistry
  participant Tool as Tool implementation

  Model->>Loop: tool calls
  Loop->>Queue: enqueue calls
  Queue->>Exec: executeSingle(call)
  Exec->>Exec: plan mode + arg validation
  Exec->>Exec: pre_tool_use hook
  Exec->>Exec: investigation/task guard checks
  Exec->>Perm: classify(tool,args)
  Perm-->>Exec: allow / ask / deny
  Exec->>Perm: handleAsk if needed
  Exec->>Reg: executeTool(name,args,ctx)
  Reg->>Tool: executor(args, ToolContext)
  Tool-->>Reg: string result
  Reg-->>Exec: ToolResult
  Exec->>Exec: on_tool_end + post_tool_use hooks
  Exec-->>Loop: ToolResult
```

## Built-In Tool Families

The built-in registry is defined in [`src/tool-system/builtin/index.ts`](../../src/tool-system/builtin/index.ts).

| Family | Tools |
|---|---|
| Files and search | `Read`, `Write`, `Edit`, `ApplyPatch`, `Glob`, `Grep` |
| Execution | `Bash`, `PowerShell`, `REPL` |
| Web | `WebSearch`, `WebFetch` |
| User and coordination | `AskUserQuestion`, `Agent`, `AgentStatus`, `AgentCancel`, `SendMessage`, `Sleep` |
| Planning/tasks | `EnterPlanMode`, `ExitPlanMode`, `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskStop`, `TaskGet`, `TaskOutput` |
| Configuration and discovery | `Config`, `ToolSearch`, `Skill` |
| MCP | `MCPTool`, `ListMcpResources`, `ReadMcpResource` |
| Coding preset extras | `EnterWorktree`, `ExitWorktree`, `NotebookEdit`, `LSP`, `Brief`, `Arena` |
| Scheduling/remote | `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger` |

## Concurrency Model

Tools declare `isConcurrencySafe` and `isReadOnly` in built-in registration.

- Concurrency-safe tools can be launched immediately and in parallel.
- Unsafe tools are queued and drained sequentially.
- `StreamingToolQueue` preserves original result order for deterministic transcripts.
- Long-running tools can override the default 120s timeout. `Bash` is set to 1 hour, `Agent`/`Arena` to 30 minutes, and `AskUserQuestion` has no timeout.

## Permission Model

Permission decisions are:

- `allow`: execute immediately;
- `ask`: route through an approval backend;
- `deny`: return an error result to the model.

Primary modes:

| Mode | Behavior |
|---|---|
| `default` | Use explicit rules, then ask for uncertain operations |
| `acceptEdits` | Allows common edits and safe writes; asks for risky bash |
| `dontAsk` | Denies asks instead of prompting |
| `bypassPermissions` | Allows all classifier checks, with startup safety checks |
| `auto` | Heuristic auto-approval with fallback |
| `plan` | Exposes and allows mostly read-only planning tools |

Project-scoped interactive approvals are persisted to `.code-shell/settings.local.json`.

## Plan Mode

Plan mode is enforced in two places:

- Engine filters exposed tool definitions to read-only/planning-safe tools.
- ToolExecutor blocks write or unsafe calls that slip through.

Read-only Bash can still be allowed in plan mode, but mutation tools are blocked with a clear model-facing error.

## MCP Integration

`MCPManager` connects configured servers, discovers tools, and registers each as:

```text
mcp_<serverName>_<toolName>
```

MCP tools currently default to `ask`, are considered concurrency-safe, and return text extracted from MCP content arrays. Resource listing and reading are exposed through built-in MCP resource tools.

## Adding a Built-In Tool

1. Create `src/tool-system/builtin/<name>.ts` with a `ToolDefinition` and executor.
2. Export it through `src/tool-system/builtin/index.ts`.
3. Set metadata: `permissionDefault`, `isReadOnly`, `isConcurrencySafe`, and `timeoutMs` if needed.
4. Add it to the appropriate preset in [`src/preset/index.ts`](../../src/preset/index.ts).
5. Add tests in `tests/tools.test.ts` or a focused new test file.
6. If it changes permissions or context behavior, add permission/context tests.

## Common Debug Anchors

- Tool not visible to model: check preset tool list and `ToolRegistry` constructor.
- Tool called but denied: check explicit rules, bash classifier, permission mode, and persisted local settings.
- Tool hangs: check `timeoutMs`, abort propagation, and sandbox backend.
- Tool result huge or missing: check `ContextManager` persistence/truncation and transcript `tool_result` entries.
