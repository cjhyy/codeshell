# tool-system

**One-line role.** The tool layer of core: it registers every tool (built-in + MCP), classifies and enforces permissions + file-path policy, runs commands inside an OS sandbox, and dispatches a model's tool calls through hooks → validation → execution.

## 职责 / Responsibility

This module owns everything between "the LLM asked to run a tool" and "here is the tool result". It holds a single `ToolRegistry` (built-in tools plus MCP-server tools), and a `ToolExecutor` that takes one `ToolCall`, runs it through the gauntlet — capability/plan-mode/MCP gates, JSON-schema validation, `pre_tool_use`/`on_permission_check`/`post_tool_use` hooks, the `PermissionClassifier` (rules + Bash-safety YOLO classifier), the centralized `PathPolicy`, the investigation/task guards — and only then executes via the registry with a per-call timeout + abort cascade. It also provides the OS-level Bash `sandbox` backends, the atomic V4A `ApplyPatch` engine, and the `MCPManager` that connects to external MCP servers. Boundaries: it does **not** own the turn loop, the LLM call, or session state — `engine/` drives it and supplies a per-run `ToolContext`.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `registry.ts` | `ToolRegistry`: name→tool map + executor map; `executeTool()` applies timeout precedence, abort cascade, and normalizes results. Never throws on tool error — returns an error `ToolResult`. |
| `executor.ts` | `ToolExecutor.executeSingle()`: the full dispatch pipeline (abort/disabled/plan-mode/MCP gates → validate → hooks → path policy → permission → execute → post hooks). |
| `permission.ts` | `PermissionClassifier`, approval backends (`Headless`/`Auto`/`Interactive`), `classifyBashCommand` safety levels, session+project rule cache, `ruleMatches`, `DenialTracker`. |
| `path-policy.ts` | Pure path classifier (`classifyPath`) + `enforcePathPolicyWithApproval`: blocks/asks on sensitive or out-of-workspace file paths for Read/Write/Edit/ApplyPatch/NotebookEdit. |
| `context.ts` | `ToolContext` interface (per-Engine runtime services injected into every tool) + `AskUserFn`, `SubAgentSpawner`, `ServiceContainer`. |
| `validation.ts` | `validateToolArgs()` — JSON-schema check of tool args before execution. |
| `investigation-guard.ts` / `task-guard.ts` | Soft/hard guards: block redundant reads, nudge TODO discipline. |
| `plan-mode-allowlist.ts` | `PLAN_MODE_ALLOWED_TOOLS` — the read-only set shared by engine visibility filter and the executor. |
| `mcp-manager.ts` | `MCPManager`: connect/reconcile/disconnect MCP servers (stdio + streamable-http), register their tools into the registry, `callTool`, resources. |
| `sandbox/index.ts` | Sandbox backend selection (`resolveSandboxBackend`, `defaultSandboxConfig`); backends in `seatbelt.ts` / `bwrap.ts` / `off.ts`. |
| `builtin/index.ts` | `BUILTIN_TOOLS` array + `BUILTIN_TOOL_GUARDS`; the catalog the registry seeds from. `BuiltinToolFn` signature lives here. |
| `builtin/apply-patch/` | Atomic multi-file V4A patcher: `parser.ts`, `applier.ts`, `index.ts` (the `ApplyPatch` tool), dry-run + rollback. |
| `builtin/*.ts` | Each built-in tool (Read, Write, Edit, Bash, Glob, Grep, Agent, Skill, WebFetch, GenerateImage/Video, memory, cron, …). |

## 公开接口 / Public API

```ts
// registry.ts
class ToolRegistry {
  constructor(options?: { builtinTools?: readonly string[] }); // omit → all builtins; subset → ConfigError on unknown name
  registerTool(tool: RegisteredTool, executor?: BuiltinToolFn): void;
  unregisterTool(name: string): void;
  getTool(name: string): RegisteredTool | undefined;
  hasTool(name: string): boolean;
  getToolDefinitions(): ToolDefinition[];   // what the LLM sees
  listTools(): string[];
  executeTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal; ctx?: ToolContext },
  ): Promise<ToolResult>;                    // never throws; errors come back as { isError: true }
}
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

// executor.ts
class ToolExecutor {
  constructor(registry: ToolRegistry, permission: PermissionClassifier, hooks: HookRegistry);
  setSignal(signal?: AbortSignal): void;
  setContext(ctx: ToolContext | undefined): void;   // per-Engine services
  setInvestigationGuard(g?: InvestigationGuard): void;
  setTaskGuard(g?: TaskGuard): void;
  executeSingle(call: ToolCall): Promise<ToolResult>;
  isConcurrencySafe(toolName: string): boolean;
  resultsToMessages(calls: ToolCall[], results: ToolResult[]): Message[];
}

// permission.ts
class PermissionClassifier {
  constructor(rules: PermissionRule[], defaultMode?: PermissionMode, backend?: ApprovalBackend);
  classify(toolName: string, args): PermissionDecision;       // "allow" | "ask" | "deny"
  handleAsk(toolName: string, args, reason?): Promise<boolean>;
  reconfigure(mode, backend, rules?): void;                   // live, in-place
}
function classifyBashCommand(cmd: string): "safe-read" | "safe-write" | "unsafe" | "dangerous";
function ruleMatches(rule, toolName, args): boolean;
function getInteractiveApprovalBackend(): InteractiveApprovalBackend;
function setInteractiveApprovalFn(fn): void;
const ACCEPT_EDITS_ALLOWLIST: ReadonlySet<string>;

// path-policy.ts
function classifyPath(rawPath: string, opts: { workspaceRoot: string; operation: "read"|"write" }): PathClassification;
function enforcePathPolicyWithApproval(path: string, op: "read"|"write", ctx?: ToolContext): Promise<string | null>; // null = ok, string = block message

// sandbox/index.ts
function defaultSandboxConfig(mode?: SandboxMode): SandboxConfig;
function resolveSandboxBackend(config: SandboxConfig, cwd: string): Promise<SandboxBackend>;

// mcp-manager.ts
class MCPManager {
  constructor(registry: ToolRegistry);
  connectAll(servers: Record<string, MCPServerConfig>, owner?): Promise<void>;
  reconcile(servers: Record<string, MCPServerConfig>, owner?): Promise<void>;
  callTool(serverName, toolName, args): Promise<unknown>;
  disconnectAll(): Promise<void>;
}

// context.ts — the object Engine builds per run() and threads through everything
interface ToolContext {
  cwd: string; llmConfig: LLMConfig; toolRegistry: ToolRegistry; engine: Engine;
  planMode: boolean; permissionMode?: string;
  askUser?: AskUserFn; subAgentSpawner?: SubAgentSpawner; sandbox?: SandboxBackend;
  hooks?: HookRegistry; signal?: AbortSignal;
  disabledBuiltins?: Set<string>; allowedMcpServers?: Set<string>;
  // …plus skill/plugin allowlists, backgroundShells, shellEnv, sessionId (see file)
}
```

## 怎么用 / How to use

Real wiring from `engine/engine.ts`. Engine constructs the registry once, then per session builds the permission + executor and connects MCP:

```ts
// engine.ts — registry seeded from the active preset's builtin whitelist
this.toolRegistry =
  config.runtime?.toolRegistry ?? new ToolRegistry({ builtinTools: selectedBuiltins });

// per-session permission + executor
const permission = new PermissionClassifier(defaultRules, mode, approvalBackend);
if (approvalBackend instanceof InteractiveApprovalBackend) {
  approvalBackend.setCwd(cwd);
  approvalBackend.setOnProjectRules((rules) =>
    permission.reconfigure(mode, approvalBackend, [...rules, ...defaultRules]),
  );
}
const toolExecutor = new ToolExecutor(this.toolRegistry, permission, this.hooks);
toolExecutor.setInvestigationGuard(new InvestigationGuard());
toolExecutor.setTaskGuard(new TaskGuard(() => latestTodos));

// MCP tools register into the SAME registry (worker-shared)
this.mcpManager = new MCPManager(this.toolRegistry);
await this.mcpManager.connectAll(config.mcpServers ?? {});
```

Dispatching a single tool call inside the turn loop — set the abort signal + per-run context, then `executeSingle` does the whole pipeline and always resolves (never throws):

```ts
toolExecutor.setSignal(turnSignal);
toolExecutor.setContext(this.buildToolContext()); // cwd, sandbox, askUser, planMode, disabledBuiltins, …
const result: ToolResult = await toolExecutor.executeSingle(call);
// result.isError === true on denial / timeout / abort / not-found — feed back to the model, don't crash the turn
```

## 注意 / Gotchas

- **`executeTool`/`executeSingle` never throw on tool failure.** Denials, timeouts, aborts, and `ToolNotFoundError` all come back as a `ToolResult` with `isError: true` so a bad/hallucinated tool call can't kill the turn. Only truly unexpected errors propagate.
- **Timeout precedence:** `options.timeoutMs` > `tool.timeoutMs` (declared at registration) > `DEFAULT_TOOL_TIMEOUT_MS` (120s). Long-running tools (Agent/Arena/Bash) must declare their own `timeoutMs` or they get cut at 120s. `timeout <= 0` disables it.
- **Two independent gating layers.** Tool-permission (`PermissionClassifier`) and file path-policy (`path-policy.ts`) are separate. `bypassPermissions` mode skips **both**; `acceptEdits` is an allowlist (`ACCEPT_EDITS_ALLOWLIST`), **not** allow-all, and it does **not** authorize writes outside the workspace — path policy still runs.
- **Hooks can only downgrade.** A1 hardening: `pre_tool_use`/`on_permission_check` may tighten `allow→ask/deny` or relax to `ask`, but can never promote to `allow` (`clampHookDecision`). Only the classifier and the user grant `allow`.
- **Bash safety is metacharacter-aware, not prefix-match.** `classifyBashCommand` scans with quote/escape awareness and splits on `; && || &`; any segment failing safe-classification, or command substitution / redirection / pipe-to-shell / unclosed quote, marks the whole command `dangerous`. Don't reintroduce naive `startsWith` checks.
- **Registry is worker-shared (B1).** It can hold MCP tools registered by *other* sessions. The executor rejects calls to MCP tools whose server isn't in `ctx.allowedMcpServers`, and rejects builtins in `ctx.disabledBuiltins` — visibility filtering alone isn't enough because the model can still *name* a hidden tool.
- **Sandbox `auto` silently downgrades to `off`** when no backend is available (no seatbelt on macOS / no bwrap on Linux / Windows always); explicit `seatbelt`/`bwrap` modes *throw* `SandboxUnavailableError`. Only the spawned Bash shell is sandboxed — the Engine and file-editing tools are not.
- **Permission rules persist to `<cwd>/.code-shell/settings.local.json`** (atomic temp+rename write); session grants are in-memory and operation-scoped (keyed by tool + narrowed argsPattern) so approving `git status` never auto-allows `rm -rf`.
- **ESM + rebuild:** all imports use `.js` extensions (NodeNext). Built-in tools register from `BUILTIN_TOOLS`; adding/removing one changes the registry seed, and `tui`/`desktop` import from `dist/`, so **rebuild core** after touching this module or tests/hosts will run stale code.
- `ApplyPatch` resolves relative paths against `ctx.cwd` (not `process.cwd()`), dry-runs all hunks before writing, and rolls back on partial failure; it invalidates the `fileCache` for every touched path.
