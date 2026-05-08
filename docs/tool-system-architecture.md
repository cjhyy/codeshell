# Code Shell Tool System — Architecture Analysis

## Overview

The tool system at `src/tool-system/` is the extensible action framework that powers agent capabilities. It follows a **registry + executor + permission** pattern: tools are registered with schemas, execution is mediated through permission checks, and validation happens before tool invocation. MCP (Model Context Protocol) integration brings external tools into the same namespace.

```
src/tool-system/
├── registry.ts              # Central tool registry
├── executor.ts              # Tool execution orchestrator
├── permission.ts            # Permission engine
├── validation.ts            # Schema validation
├── mcp-manager.ts           # MCP server lifecycle manager
├── builtin/
│   ├── index.ts             # Barrel: all builtin tool definitions
│   ├── read.ts              # Read file
│   ├── write.ts             # Write file
│   ├── edit.ts              # String-patch file editing
│   ├── bash.ts              # Shell command execution
│   ├── glob.ts              # File glob matching
│   ├── grep.ts              # Regex search
│   ├── web-search.ts        # Web search (DuckDuckGo)
│   ├── web-fetch.ts         # Web page fetching
│   ├── arena.ts             # Multi-model Arena
│   ├── task.ts              # Task tracking
│   ├── agent.ts             # Sub-agent spawning
│   ├── ask-user.ts          # Ask user a question
│   ├── plan.ts              # Plan mode entry/exit
│   ├── file-cache.ts        # In-memory file state cache
│   ├── agent-registry.ts    # Background agent lifecycle registry
│   ├── sleep.ts             # Pause execution
│   ├── brief.ts             # Structured markdown output
│   ├── config.ts            # Read/write .code-shell/settings.json
│   ├── lsp.ts               # LSP code intelligence
│   ├── notebook-edit.ts     # Jupyter notebook cell editing
│   ├── repl.ts              # REPL code execution
│   ├── remote-trigger.ts    # Remote workflow triggers
│   ├── send-message.ts      # Inter-agent messaging
│   ├── powershell.ts        # PowerShell execution
│   ├── cron.ts              # Scheduled recurring tasks
│   ├── mcp-tools.ts         # MCP tool/resource access
│   ├── tool-search.ts       # Deferred tool schema discovery
│   ├── worktree.ts          # Git worktree isolation
│   └── skill.ts             # Custom skill/plugin system
```

---

## Core Infrastructure

### 1. `registry.ts`

| Property | Detail |
|---|---|
| **Path** | `src/tool-system/registry.ts` |
| **Lines** | ~70 |

**Exports:**
- `ToolRegistry` (class) — singleton-like registry of all user-facing tools.

**Key responsibilities:**
- Stores tool definitions keyed by `tool.name` (case-sensitive).
- Tracks metadata: which tools are builtin vs. MCP-deferred vs. MCP-discovered.
- Methods: `register(tool)`, `getTool(name)`, `listToolNames()`, `listToolsDetailed()`, `initBuiltinTools()`, `initMCPTools()`.

**Connections:**
- Consumed by `executor.ts` for tool lookup before execution.
- Imported by `builtin/index.ts` to register all builtin tools.
- Imported by `builtin/tool-search.ts` (via `setToolSearchRegistry`) for deferred tool discovery.
- Referenced in `src/types.ts` as `RegisteredTool` / `ToolDefinition` types.

**Design notes:**
- All builtin tools are static definitions (`ToolDefinition`); MCP tools start as "deferred" (name-only) then get resolved lazily via `ToolSearch`.
- The registry is not a true singleton — it's a class instantiated and passed around, but conceptually treated as the sole registry instance.

---

### 2. `executor.ts`

| Property | Detail |
|---|---|
| **Path** | `src/tool-system/executor.ts` |
| **Lines** | ~100 |

**Exports:**
- `executeToolCall(toolName, args, context)` — main execution entry point.
- `ToolExecutionContext` (interface) — context bag passed to all tool impls.

**Key responsibilities:**
1. Looks up the tool in `ToolRegistry`.
2. Calls `checkPermission(toolName, args, context)` from `permission.ts` — returns early with a refusal string if denied.
3. Calls `validateToolArgs(toolDefinition, args)` from `validation.ts` — wraps validation errors into structured error responses.
4. Dispatches to the tool's `execute` function with merged args + context.

**Connections:**
- Called from `src/engine/engine.ts` in the turn-loop when the LLM emits tool calls.
- Passes context through to every tool impl — includes `cwd`, `sessionId`, `signal` (AbortSignal for cancellation), `agentName`, `runManager`, `engine`, etc.

**Design notes:**
- The executor is intentionally thin — it's a mediator, not an orchestrator. All policy (permission, validation) lives in dedicated modules.
- Context enrichment happens here: `__cwd`, `__sessionId`, `__signal`, etc. are injected as underscore-prefixed keys so tools can access ambient state without the model needing to provide it.

---

### 3. `permission.ts`

| Property | Detail |
|---|---|
| **Path** | `src/tool-system/permission.ts` |
| **Lines** | ~130 |

**Exports:**
- `checkPermission(toolName, args, context)` → `{ allowed: boolean; reason?: string }`
- `PermissionShortcuts` (type) — preset shortcuts like `allow-read-only`, `allow-all`.

**Key responsibilities:**
1. Implements the permission decision tree:
   - If the tool is in the **always-allow** list → `allowed: true`.
   - If the tool is in the **deny** list → `allowed: false` with reason.
   - If the tool is in the **ask** list → `allowed: false` with a `reason` that triggers a UI prompt (`AskUserPrompt`).
2. Maintains per-session permission state (allowed/denied/ask sets).
3. Exposes `grantPermission(name)`, `denyPermission(name)`, `setSessionPermissions(shortcuts)` to mutate state at runtime via the `/permissions` slash command or the engine.

**Connections:**
- Called by `executor.ts` on every tool invocation.
- State mutated by `src/cli/commands/builtin/permissions-command.ts`.
- The "ask" flow ties into `src/ui/components/AskUserPrompt.tsx` — when permission returns `!allowed` with a reason, the UI intercepts and presents the user with an approve/deny dialog.

**Design notes:**
- Permission is coarse-grained (per-tool, not per-argument). There's no path-sandboxing or argument-level filtering in the core permission model — that's left to individual tool implementations (e.g., `bash.ts` can apply its own restrictions).
- The `ask` flow creates an async gap: permission returns "denied, ask user", the UI prompts, and if approved the tool is re-invoked. This is handled in the engine turn loop.

---

### 4. `validation.ts`

| Property | Detail |
|---|---|
| **Path** | `src/tool-system/validation.ts` |
| **Lines** | ~60 |

**Exports:**
- `validateToolArgs(toolDefinition, args)` → `{ valid: boolean; errors?: string[] }`

**Key responsibilities:**
1. Validates that all `required` properties from the tool's JSON Schema `inputSchema` are present in the args.
2. Validates basic type constraints for string/number/boolean/array/object.
3. Validates `enum` constraints on string properties.
4. Does **not** validate nested object schemas deeply — shallow validation only.

**Connections:**
- Called by `executor.ts` before dispatching to the tool impl.
- Used as a safety net: LLMs sometimes omit required fields or provide wrong types; this catches it before the tool impl panics.

**Design notes:**
- Intentionally lightweight — not a full JSON Schema validator. Deep validation on complex objects would require `ajv` or similar; the current approach trusts that the LLM gets types mostly right and only guards against obvious errors.
- Missing validation for `number` constraints (min/max) — only type-checked.

---

### 5. `mcp-manager.ts`

| Property | Detail |
|---|---|
| **Path** | `src/tool-system/mcp-manager.ts` |
| **Lines** | ~200 |

**Exports:**
- `MCPManager` (class, singleton pattern via `getInstance()`)
- MCP server connection lifecycle methods.

**Key responsibilities:**
1. Reads MCP server configs from `.code-shell/mcp.json` or `~/.code-shell/mcp.json`.
2. Launches MCP server processes (stdio transport) and manages their lifecycle.
3. Provides `callTool(server, tool, args)` — dispatches a tool call to the appropriate MCP server.
4. Provides `listResources(server?)` and `readResource(server, uri)` for MCP resource access.
5. Handles reconnection logic and health checking.
6. Populates the `ToolRegistry` with deferred MCP tool entries on startup.

**Connections:**
- Consumed by `builtin/mcp-tools.ts` (MCPTool, ListMcpResources, ReadMcpResource).
- Initialized during engine startup in `src/engine/engine.ts`.
- Tool schemas are lazily loaded: registered as "deferred" at startup, fully resolved when the model calls `ToolSearch` with `select:ToolName`.

**Design notes:**
- Uses the `@modelcontextprotocol/sdk` for stdio-based server communication.
- Singleton via `getInstance()` — one MCPManager per process.
- Error handling wraps server failures into readable error strings so the model can respond gracefully (e.g., "MCP server X is not connected").

---

## Built-in Tools

### Core File I/O Tools

#### 6. `builtin/read.ts` (Read)

| Property | Detail |
|---|---|
| **Lines** | ~90 |

**Exports:** `readToolDef`, `readTool(args)`

**Logic:**
- Reads files from the local filesystem at `file_path` (absolute path required by schema).
- Supports `offset` (1-based line number) and `limit` (default 2000) for partial reads.
- Uses `fileCache` (`builtin/file-cache.ts`) to avoid re-reading unchanged files within a session.
- Reads the requested lines from the cached/filesystem content and returns them with line numbers.
- Returns a hard cap on very large files to prevent context overflow.

**Connections:**
- Uses `fileCache` for session-level caching.
- Respects `args.__cwd` for workspace-relative path resolution.

**Gotchas:**
- `offset` is **1-based** (line numbers in output start at 1), matching user-facing expectations.
- Line number format: `LINE_NUMBER|CONTENT` — designed to be parseable by grep and human-readable.

---

#### 7. `builtin/write.ts` (Write)

| Property | Detail |
|---|---|
| **Lines** | ~40 |

**Exports:** `writeToolDef`, `writeTool(args)`

**Logic:**
- Creates or overwrites a file at `file_path` with `content`.
- Creates parent directories as needed (via `mkdirSync({ recursive: true })`).
- After writing, invalidates the file in `fileCache`.
- Returns a simple confirmation with byte count.

**Connections:**
- Invalidates `fileCache` so subsequent `Read` calls see the new content.

**Design notes:**
- Simplest tool in the system — intentionally no diff/merge/append options. For line-level edits, use Edit.
- No confirmation prompt for overwrites — the permission layer handles that.

---

#### 8. `builtin/edit.ts` (Edit)

| Property | Detail |
|---|---|
| **Lines** | ~110 |

**Exports:** `editToolDef`, `editTool(args)`

**Logic:**
- Performs exact string replacements in a file.
- `old_string` must match exactly (including whitespace/indentation) and must be **unique** in the file (or use `replace_all: true`).
- Uses `String.prototype.replace` for replacement; uniqueness is validated by counting occurrences before replacing.
- If `old_string` appears 0 times → error. If > 1 and `replace_all` is false → error with line numbers of all matches.
- After editing, invalidates file in `fileCache`.

**Key parameters:**
- `file_path`, `old_string`, `new_string` (required)
- `replace_all` (boolean, optional, default false)

**Design notes:**
- The "unique match" constraint is a deliberate design choice to prevent ambiguous edits — the LLM must provide enough context in `old_string` to uniquely identify the target location.
- This is the standard VSCode/Cursor/etc. edit pattern applied to an agent tool.
- Unlike `Write`, this guarantees no accidental overwrites of unrelated code.

---

### Shell & System Tools

#### 9. `builtin/bash.ts` (Bash)

| Property | Detail |
|---|---|
| **Lines** | ~50 |

**Exports:** `bashToolDef`, `bashTool(args)`

**Logic:**
- Executes a shell command via `execSync` from `node:child_process`.
- Uses the user's configured shell (from `$SHELL` env var, fallback to `/bin/sh`).
- Supports `timeout` (default 120000ms), `description` (for logging/display).
- Captures stdout + stderr and combines them into the return string.
- Timeout errors return the partial output + a timeout message.
- Respects `args.__cwd` for working directory.

**Security notes:**
- Executes directly in the user's shell — this is an `allow-bash` permission-gated tool.
- No sandboxing by default; relies on the permission system to gate access.

---

#### 10. `builtin/powershell.ts` (PowerShell)

| Property | Detail |
|---|---|
| **Lines** | ~55 |

**Exports:** `powershellToolDef`, `powershellTool(args)`

**Logic:**
- Windows/cross-platform PowerShell execution via `execSync`.
- On Windows: `powershell.exe`, on Unix: `pwsh`.
- Flags: `-NoProfile -NonInteractive -Command`.
- Same timeout/buffer pattern as Bash.

---

### Search & Discovery Tools

#### 11. `builtin/glob.ts` (Glob)

| Property | Detail |
|---|---|
| **Lines** | ~60 |

**Exports:** `globToolDef`, `globTool(args)`

**Logic:**
- Fast file pattern matching using `fast-glob`.
- Supports `**` wildcards for recursive directory matching.
- Returns file paths sorted by modification time (most recent first).
- Configurable `max_results` (default 200) and `path` (default cwd).

**Design notes:**
- Sorting by mtime is an intentional UX choice — the model often wants "latest changes" first.

---

#### 12. `builtin/grep.ts` (Grep)

| Property | Detail |
|---|---|
| **Lines** | ~140 |

**Exports:** `grepToolDef`, `grepTool(args)`

**Logic:**
- Regex-based search via `ripgrep` (`rg`) if available, falls back to `grep`.
- Supports three output modes: `files_with_matches` (default, just paths), `content` (matching lines with context), `count` (match counts).
- Parameters: `pattern`, `path`, `glob` (file filter), `context` (lines of context), `max_results` (default 50), `case_insensitive`.
- For `content` mode, formats output with `file:line:content` syntax.

**Design notes:**
- The ripgrep priority and grep fallback match how real developers search — ripgrep is much faster on large codebases.
- The three output modes let the model choose between "find which files" and "show me the lines" without requesting both.

---

#### 13. `builtin/tool-search.ts` (ToolSearch)

| Property | Detail |
|---|---|
| **Lines** | ~115 |

**Exports:** `toolSearchToolDef`, `toolSearchTool(args)`, `setToolSearchRegistry(registry)`

**Logic:**
- Discovers available tools by keyword search or exact name match.
- **Keyword mode:** scores tools by name match (weight 10), description match (weight 3), exact name match bonus (50). Returns top N.
- **Select mode:** when query starts with `select:`, does exact lookup for comma-separated names.
- This is the mechanism for lazy MCP tool schema discovery — deferred tools only have names; `ToolSearch` with `select:Name` resolves the full schema.

**Connections:**
- Requires `setToolSearchRegistry` to be called at init time (from `builtin/index.ts`).
- Outputs formatted `RegisteredTool` details (including full inputSchema).

---

### Web Tools

#### 14. `builtin/web-search.ts` (WebSearch)

| Property | Detail |
|---|---|
| **Lines** | ~120 |

**Exports:** `webSearchToolDef`, `webSearchTool(args)`

**Logic:**
- Performs web search via DuckDuckGo Instant Answer API (`api.duckduckgo.com`).
- Falls back to a `fetch`-based HTML scraper of DuckDuckGo's Lite frontend (`lite.duckduckgo.com`) when the API returns no results.
- Returns title, URL, and snippet for each result.
- Configurable `num_results` (default 10, max 20).

**Design notes:**
- Uses DuckDuckGo to avoid requiring API keys — zero-config for users.
- The API → HTML fallback pattern handles rate limiting and API inconsistencies.
- Results are deduplicated and truncated per-server limits.

---

#### 15. `builtin/web-fetch.ts` (WebFetch)

| Property | Detail |
|---|---|
| **Lines** | ~170 |

**Exports:** `webFetchToolDef`, `webFetchTool(args)`

**Logic:**
- Fetches a web page and returns its text content.
- Strips HTML tags via regex `<[^>]*>` replacement and collapses whitespace.
- Optional `headers` parameter for custom HTTP headers.
- `max_length` parameter (default 50000) truncates output.
- Handles common HTTP errors (4xx, 5xx) gracefully with descriptive error messages.
- Sets a User-Agent header identifying as `CodeShell/<version>`.

**Design notes:**
- The HTML stripping is intentionally simple (regex-based) — not a full DOM parser. This works well for documentation and article pages but may produce noisy output on complex SPAs.
- No JavaScript execution — this is a static HTML fetcher.

---

### Agent Coordination Tools

#### 16. `builtin/agent.ts` (Agent)

| Property | Detail |
|---|---|
| **Lines** | ~300 |

**Exports:** `agentToolDef`, `agentTool(args)`

**Logic:**
- Spawns a sub-agent to handle a complex task autonomously.
- Supports synchronous mode (blocks until done, default) and background mode (`run_in_background: true`).
- **Sync mode:** executes the sub-agent in the same process using the engine's run loop, returns the result string.
- **Background mode:** launches the sub-agent in a detached async context, registers it in `asyncAgentRegistry`, returns an `agent_id` immediately.
- Companion tools `AgentStatus` and `AgentCancel` query/cancel background agents via `asyncAgentRegistry`.
- Parameter: `description` (short label), `prompt` (full task), `max_turns` (default 15), `run_in_background`, `name` (for inter-agent messaging).

**Connections:**
- Uses `asyncAgentRegistry` (`builtin/agent-registry.ts`) for background agent lifecycle.
- Uses `agentCoordinator` (`src/agent/coordinator.ts`) for inter-agent messaging.
- Deeply integrated with the engine — needs `args.__engine` and `args.__runManager` from executor context.

**Design notes:**
- Sub-agents run in the same process — they're not sandboxed. All file access, network, and permissions flow through the parent agent's context.
- `max_turns` prevents runaway loops. Default 15 turns is conservative.
- Background agents' state is process-local — crashes lose them. This is documented as "same contract as Claude Code".

---

#### 17. `builtin/agent-registry.ts` (AsyncAgentRegistry)

| Property | Detail |
|---|---|
| **Lines** | ~90 |

**Exports:** `asyncAgentRegistry` (singleton instance), `AsyncAgentEntry`, `AsyncAgentStatus`

**Logic:**
- In-memory Map of `agentId` → status/result/abort handle.
- States: `running` → `completed` | `failed` | `cancelled`.
- Each entry holds an `abort()` function for cancellation.
- `reset()` method aborts all running agents (used on session cleanup).

**Connections:**
- Used by `builtin/agent.ts` for background agent spawn/cancel/status.
- Separate from `agentCoordinator` — this registry is about lifecycle, not messaging.

---

#### 18. `builtin/send-message.ts` (SendMessage)

| Property | Detail |
|---|---|
| **Lines** | ~55 |

**Exports:** `sendMessageToolDef`, `sendMessageTool(args)`

**Logic:**
- Sends a text message from one named agent to another.
- Validates target exists and is in `running` status via `agentCoordinator`.
- Automatically sets `from` to `args.__agentName` (the calling agent's name, injected by executor context).

**Connections:**
- Uses `agentCoordinator` from `src/agent/coordinator.ts`.
- Designed for multi-agent workflows where agents need to pass intermediate results.

---

#### 19. `builtin/remote-trigger.ts` (RemoteTrigger)

| Property | Detail |
|---|---|
| **Lines** | ~60 |

**Exports:** `remoteTriggerToolDef`, `remoteTriggerTool(args)`

**Logic:**
- Triggers a remote agent/workflow by writing a JSON trigger file to `~/.code-shell/triggers/`.
- The trigger file contains `id`, `name`, `prompt`, `config`, `createdAt`, `status: "pending"`.
- Intended for pickup by an external scheduler/runner (not implemented in-process).

**Design notes:**
- This is a placeholder/hook for future distributed execution — currently writes files that nothing reads.

---

### Task & Plan Tools

#### 20. `builtin/task.ts` (TaskCreate, TaskList, TaskUpdate, TaskStop, TaskGet, TaskOutput)

| Property | Detail |
|---|---|
| **Lines** | ~330 |

**Exports:** Six tool defs and six handlers.

**Logic:**
- Manages a task tracking system: tasks have id, status (`pending`/`in_progress`/`completed`/`stopped`), subject, description, activeForm, and optional dependencies.
- **TaskCreate:** creates a task with `pending` status. Accepts optional `addBlockedBy` and `addBlocks` arrays for DAG dependencies.
- **TaskUpdate:** updates status, subject, description, or dependencies.
- **TaskList:** lists all tasks with status.
- **TaskGet/Stop/Output:** CRUD operations on individual tasks.
- Tasks are stored in memory during the session (process-local).

**Design notes:**
- The task DAG (blockedBy/blocks) is stored but not actively enforced — there's no scheduler that skips blocked tasks. It's informational for the model and user.
- `activeForm` is a present-continuous string shown in spinners (e.g., "Fixing auth bug" → status line shows spinner + that text).

---

#### 21. `builtin/plan.ts` (EnterPlanMode, ExitPlanMode)

| Property | Detail |
|---|---|
| **Lines** | ~90 |

**Exports:** `enterPlanModeToolDef`, `exitPlanModeToolDef`, `enterPlanModeTool(args)`, `exitPlanModeTool(args)`

**Logic:**
- Toggles a boolean `planMode` flag in the session state (accessed via `args.__session` or similar context).
- `EnterPlanMode`: sets `planMode = true`, instructs the model to output a plan as text then call `ExitPlanMode`.
- `ExitPlanMode`: resets `planMode = false`, returns to normal execution mode.
- When plan mode is active, the engine skips non-whitelisted tool execution (only Read, Glob, Grep, WebSearch, WebFetch, TaskCreate, and ExitPlanMode are allowed during plan mode).

**Design notes:**
- Plan mode is primarily enforced in the engine's turn loop, not in the tool itself. The tool just toggles the flag.
- The UI shows a "PLAN MODE" indicator when active.

---

### User Interaction Tools

#### 22. `builtin/ask-user.ts` (AskUserQuestion)

| Property | Detail |
|---|---|
| **Lines** | ~35 |

**Exports:** `askUserToolDef`, `askUserTool(args)`

**Logic:**
- Pauses execution and presents a question to the user.
- In interactive mode: renders `AskUserPrompt` component in Ink UI, blocks until user responds.
- In headless mode (non-TTY): returns an error ("headless mode").
- Parameter: `question` (string).

**Connections:**
- Integrates with `src/ui/components/AskUserPrompt.tsx`.
- The blocking behavior is handled via an async await that resolves only when the UI component calls the resolve callback.

---

### Output & Display Tools

#### 23. `builtin/brief.ts` (Brief)

| Property | Detail |
|---|---|
| **Lines** | ~45 |

**Exports:** `briefToolDef`, `briefTool(args)`

**Logic:**
- Formats a structured message with optional title, required markdown content, and an optional status level (`info`/`success`/`warning`/`error`).
- Status levels prepend an icon: ℹ / ✓ / ⚠ / ✗.
- Output is plain markdown string — the UI renders it.

**Design notes:**
- This is a semantic formatting helper. The model could achieve the same thing by just outputting text, but using the Brief tool signals structured intent to the UI layer.

---

#### 24. `builtin/config.ts` (Config)

| Property | Detail |
|---|---|
| **Lines** | ~75 |

**Exports:** `configToolDef`, `configTool(args)`

**Logic:**
- Reads or writes `.code-shell/settings.json` in the project root.
- `read` action: returns the full JSON content.
- `write` action: sets a dot-notation key (e.g., `model.temperature`) to a value. Creates nested objects as needed.
- Auto-creates `.code-shell/` directory.

**Connections:**
- Read by the engine/model facade for configuration like model selection, temperature, etc.

---

### Development Tools

#### 25. `builtin/lsp.ts` (LSP)

| Property | Detail |
|---|---|
| **Lines** | ~155 |

**Exports:** `lspToolDef`, `lspTool(args)`

**Logic:**
- Provides Language Server Protocol operations: `goToDefinition`, `findReferences`, `hover`, `getDiagnostics`, `getSymbols`.
- Detects appropriate language server via `detectLSPServer(filePath)` from `src/lsp/servers.js`.
- Opens a document via `textDocument/didOpen`, sends requests, formats results.
- `getDiagnostics` has a 2-second await for server processing time.
- Formats symbol results with human-readable kind names.

**Connections:**
- Uses `getLSPManager()` from `src/lsp/manager.js`.
- Symbol kind mapping (1–26) covers all standard LSP symbol kinds.

---

#### 26. `builtin/notebook-edit.ts` (NotebookEdit)

| Property | Detail |
|---|---|
| **Lines** | ~150 |

**Exports:** `notebookEditToolDef`, `notebookEditTool(args)`

**Logic:**
- CRUD operations on Jupyter notebook (`.ipynb`) cells.
- Parses JSON, manipulates `cells` array, writes back.
- Supports `read`, `insert`, `replace`, `delete` actions.
- Cell types: `code`, `markdown`, `raw`.
- `read` shows a preview (first 200 chars) of each cell.
- Creates empty notebook (nbformat 4.5, Python 3 kernel) if inserting into non-existent file.

**Design notes:**
- Source is split into lines per Jupyter spec (each line in array, trailing newline except last).
- Validates `.ipynb` extension upfront.

---

#### 27. `builtin/repl.ts` (REPL)

| Property | Detail |
|---|---|
| **Lines** | ~70 |

**Exports:** `replToolDef`, `replTool(args)`

**Logic:**
- Executes code in Node (`node -e`), TypeScript (`npx tsx -e` or `bun -e`), Python (`python3 -c`), or Ruby (`ruby -e`).
- Uses `execSync` with the code passed via command-line flag.
- Configurable `timeout` (default 30000ms), `maxBuffer` of 1MB.

**Design notes:**
- TypeScript detection: checks for Bun runtime first (`globalThis.Bun`), falls back to `npx tsx`.
- Code is JSON-stringified for safe shell escaping. This prevents injection but limits to single-line-safe code.

---

#### 28. `builtin/powershell.ts` (PowerShell) — covered in Shell & System Tools

---

### Scheduling & Workflow Tools

#### 29. `builtin/cron.ts` (CronCreate, CronDelete, CronList)

| Property | Detail |
|---|---|
| **Lines** | ~65 |

**Exports:** Three tool defs and three handlers.

**Logic:**
- `CronCreate`: registers a named recurring task with `cronScheduler` from `src/cron/scheduler.js`.
- `CronDelete`: removes a cron job by ID.
- `CronList`: lists all jobs with status, schedule, run count, and last run time.
- Schedule format: `30s`, `5m`, `1h`, `1d` (simple interval, not cron syntax).

**Connections:**
- Depends on `cronScheduler` singleton.

---

### Git & Environment Tools

#### 30. `builtin/worktree.ts` (EnterWorktree, ExitWorktree)

| Property | Detail |
|---|---|
| **Lines** | ~120 |

**Exports:** `enterWorktreeToolDef`, `exitWorktreeToolDef`, `enterWorktreeTool(args)`, `exitWorktreeTool(args)`, `getActiveWorktree()`

**Logic:**
- Creates isolated git worktrees via `git worktree add` (through `src/git/worktree.js`).
- Validates slug format (alphanumeric, dots, dashes, max 64 chars).
- `EnterWorktree`: creates new branch + worktree directory, changes `process.cwd()`.
- `ExitWorktree`: removes worktree directory. `discard` action deletes the branch; `keep` preserves it for later merge.
- Global `_activeWorktree` state tracks the current worktree session.

**Connections:**
- Uses `createWorktree`, `removeWorktree`, `listWorktrees`, `validateWorktreeSlug` from `src/git/worktree.js`.
- `getActiveWorktree()` exported for engine/session to check current state.

**Design notes:**
- Only one active worktree at a time — enforced by checking `_activeWorktree` before creation.
- `process.cwd()` mutation is a global side effect that affects all subsequent relative path resolution.

---

### Skills & Extensibility

#### 31. `builtin/skill.ts` (Skill)

| Property | Detail |
|---|---|
| **Lines** | ~65 |

**Exports:** `skillToolDef`, `skillTool(args)`

**Logic:**
- Loads markdown-based skill/plugin files from `.code-shell/skills/` or `~/.code-shell/skills/`.
- Files are `.md` with optional YAML frontmatter (stripped before return).
- `$ARGUMENTS` and `{args}` placeholders in skill content are replaced with the provided args.
- Skills are essentially prompt templates — the model loads them to get specialized instructions.

**Design notes:**
- No execution — skills are text templates that augment the model's behavior by injecting prompt content.
- This is effectively a portable plugin/prompt system.

---

### MCP Integration Tools

#### 32. `builtin/mcp-tools.ts` (MCPTool, ListMcpResources, ReadMcpResource)

| Property | Detail |
|---|---|
| **Lines** | ~115 |

**Exports:** Three tool defs and three handlers.

**Logic:**
- `MCPTool`: invokes a tool on a connected MCP server. Dynamically imports `MCPManager` singleton and calls `manager.callTool(server, tool, args)`.
- `ListMcpResources`: lists resources from all or a specific MCP server.
- `ReadMcpResource`: reads a specific MCP resource by server + URI.

**Design notes:**
- Dynamic `import("../mcp-manager.js")` avoids circular dependencies during module initialization.
- Results are auto-formatted: strings returned as-is, objects JSON-stringified.

---

### File Caching

#### 33. `builtin/file-cache.ts` (FileStateCache)

| Property | Detail |
|---|---|
| **Lines** | ~48 |

**Exports:** `fileCache` (singleton instance of `FileStateCache`)

**Logic:**
- In-memory Map of `absolutePath → { content, mtimeMs }`.
- `get(filePath)`: returns cached content if mtime matches current disk mtime; otherwise invalidates and returns null.
- `set(filePath, content, mtimeMs)`: stores content with mtime.
- `invalidate(filePath)`: removes cache entry (called by Write/Edit after modification).
- `clear()`: empties cache.

**Connections:**
- Used by `builtin/read.ts` to avoid redundant file reads.
- Invalidated by `builtin/write.ts` and `builtin/edit.ts`.

**Design notes:**
- Simple and effective: mtime-based invalidation handles external edits; explicit invalidation handles in-session writes.
- No size limit — unbounded cache. Could grow large on long sessions with many files.

---

### Sleep Tool

#### 34. `builtin/sleep.ts` (Sleep)

| Property | Detail |
|---|---|
| **Lines** | ~40 |

**Exports:** `sleepToolDef`, `sleepTool(args)`

**Logic:**
- Pauses execution for `seconds` (clamped to 0.1–300).
- Respects `args.__signal` (AbortSignal) for cancellation — clears timeout on abort.
- Useful for polling workflows or waiting for external processes.

---

## Cross-Cutting Patterns & Gotchas

### 1. Context Injection (`__args`)
Executor injects underscore-prefixed keys into every tool's args:
- `__cwd` — current working directory
- `__sessionId` — session identifier
- `__signal` — AbortSignal for cancellation
- `__agentName` — name of the calling agent
- `__engine` — engine reference (for sub-agent spawning)
- `__runManager` — run manager reference
- `__session` — session object reference

These are hidden from the LLM's tool schema but available to all tool implementations.

### 2. Permission Model
- Coarse-grained: per-tool, not per-argument.
- Three states: allowed, denied, ask (with UI prompt).
- Presets (`allow-read-only`, `allow-all`) simplify session setup.
- The "ask" flow is async — tools that return "denied, ask" trigger UI interception.

### 3. Tool Categorization
- **"Safety" tools** (Read, Glob, Grep, etc.) — typically always-allowed.
- **"Write" tools** (Write, Edit, Bash) — typically require user confirmation.
- **"Meta" tools** (Agent, Task, Plan, Permissions) — special lifecycle management.
- **"External" tools** (WebSearch, WebFetch, MCPTool) — need network, typically ask.

### 4. Lazy MCP Tool Loading
MCP tools are registered as "deferred" (name-only) at startup to avoid loading potentially hundreds of tool schemas into every LLM API call. The `ToolSearch` tool provides on-demand schema discovery. This is a significant context optimization.

### 5. Process-Local State
All caches, registries, and state (file cache, agent registry, active worktree, cron scheduler, MCP connections) are process-local. Crash recovery is not implemented — this is intentional for a CLI agent tool.

### 6. Error Handling Convention
All tool implementations catch errors and return them as string messages, never throwing. This ensures the LLM always receives a response it can reason about, even on failures.

### 7. Module Loading
Some builtin tools (`mcp-tools.ts`, `remote-trigger.ts`) use dynamic `import()` to avoid circular dependencies during module initialization. This is a pragmatic pattern for tools that depend on singletons that are initialized after the tool module is loaded.
