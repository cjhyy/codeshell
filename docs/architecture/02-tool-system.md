# 02 · Tool System

> How a model's tool call becomes a guarded, executed action. Source-mapped against `packages/core/src/tool-system/`.

## 1. The shape of the layer

Every capability the agent has — reading a file, running a shell command, spawning a sub-agent, calling an MCP server — flows through one pipeline: **registry → executor → permission/path gates → execute → result**. The executor is the single choke point; nothing bypasses it.

| File | Role | ~LOC |
|------|------|------|
| `registry.ts` | `ToolRegistry` — registration, timeout defaults, abort-signal cascade, execution dispatch | ~194 |
| `executor.ts` | `ToolExecutor` — the full per-call lifecycle (plan-mode, hooks, permission, path policy, execution) | ~671 |
| `permission.ts` | `PermissionClassifier` + the three approval backends, rule matching, Bash chained-command guard | ~1,032 |
| `path-policy.ts` | Declarative sensitive-path detection, workspace containment, approval caching | ~592 |
| `mcp-manager.ts` | `MCPManager` — MCP server connect, tool discovery, header/env building, image spillover | ~638 |
| `sandbox/index.ts` | OS-level sandbox backends (seatbelt / bwrap / off) | ~291 |
| `browser-bridge.ts` | Driver-agnostic browser-automation contract | ~342 |
| `context.ts` | `ToolContext` — the services bag injected into every tool | ~326 |
| `builtin/index.ts` | The `BUILTIN_TOOLS` registration table (60+ tools) + guards | ~767 |

## 2. The end-to-end path

```
LLM emits tool_use(name, args)
   │
ToolExecutor.executeSingle(call)            executor.ts:116
   ├─ abort fast-path (signal.aborted?)     :128  → return immediately, skip everything
   ├─ capability gates                      :142  → disabledBuiltins / allowedMcpServers → reject
   ├─ plan-mode gate                        :167  → only read-only tools; Bash write-scan
   ├─ input validation (schema)             :192
   ├─ pre_tool_use hook                     :205  → may rewrite args / ask / deny (never upgrade to allow)
   ├─ path-policy enforcement               :246  → classify each target path; ask or deny
   ├─ investigation guard                   :294  → soft reminders on redundant reads
   ├─ permission classification             :308  → rules → safe patterns → allowlist → default
   │    └─ on_permission_check hook         :320  → may downgrade only
   ├─ on_tool_start hook                    :371
   ├─ ToolRegistry.executeTool(...)         registry.ts:85   ← actual handler runs here
   ├─ on_tool_end / post_tool_use hooks     :445 / :453
   └─ file_changed hook (Write/Edit)        :478
   │
returns ToolResult → becomes a tool_result content block
```

Inside `ToolRegistry.executeTool` (`registry.ts:85`): look up the tool (`ToolNotFoundError` if missing), resolve the timeout (per-call > tool's declared > `DEFAULT_TOOL_TIMEOUT_MS` 120 s), build a child `AbortController` chained to the parent signal **and** the timeout, inject `__signal` into args so long-running tools (Agent, Arena, Bash) can poll cancellation, then `Promise.race([executor(...), abortPromise])`. The result is normalized to a uniform `ToolResult` (string, or `{contentBlocks}` for images, or `{result, sandbox}` for Bash).

## 3. Invariants that make this safe

1. **The executor is the only entry point.** Permission, path-policy, and plan-mode checks are never bypassed because every tool — builtin or MCP — goes through `executeSingle`.

2. **Error boundary: the executor never throws.** Exceptions (including a hallucinated `ToolNotFoundError`) are caught and returned as a `ToolResult` error so the model can retry or switch tools — a bad tool name doesn't kill the turn. (See the memory note on the executor error boundary: only paths that *bypass* the executor — host callbacks, fire-and-forget, hook emits — need their own try/catch.)

3. **Hooks can only tighten, never loosen (A1 hardening).** `pre_tool_use` and `on_permission_check` hooks may downgrade a decision or request confirmation, but a hook returning `"allow"` over a classifier `"deny"`/`"ask"` is rejected (`clampHookDecision`, `executor.ts:41`). Only the classifier rules and the user can grant `allow`. Reason: project-defined hooks must not be able to skip the project's own permission rules.

4. **Abort-first ordering.** Checks run cheapest-and-most-lethal first: abort fast-path → capability gates → validation → path policy (fail-closed on credentials) → permission → execute. Already-cancelled branches return instantly without running hooks or the handler.

5. **Cascading cancellation.** The `AbortSignal` flows Engine → Executor → Registry → handler, so a user Stop cancels all in-flight tools at once.

## 4. Permission system (`permission.ts`)

`PermissionClassifier.classify(toolName, args)` resolves a `"allow" | "deny" | "ask"` decision by checking, in order: session rules → user rules → Bash safe-read patterns (`classifyBashCommand`) → preset allowlist → the tool's `permissionDefault`.

Three approval backends sit behind the classifier's `ask`:

- **`HeadlessApprovalBackend`** — `approve-all` / `deny-all` / `approve-read-only`. No user; used by automation/cron.
- **`AutoApprovalBackend`** — fast-path: low risk → approve, high → deny/delegate, medium + `isSafeOperation()` → approve common patterns.
- **`InteractiveApprovalBackend`** — prompts the user, caches grants at **session** (in-memory) or **project** scope (persisted to `.code-shell/settings.local.json`, atomic write). Serializes duplicate prompts while one is pending.

### Operation-scoped, not tool-scoped
A grant keys on the *operation*, not just the tool name (`buildProjectRule`, `permission.ts:351`):
- Bash grants are **head-scoped**: approving `git status` stores `argsPattern: {command: "^git(\\s|$)"}` — covers all `git …`.
- File-tool grants are **path-scoped**: `"file"` → exact file, `"dir"` → directory + subtree.

### The chained-command guard
`ruleMatches` (`permission.ts:403`) runs `scanShellCommand` on a Bash grant before honoring it: if the command has multiple statements (`;`, `&&`, `||`), a pipe, redirection, or substitution, the head-grant **does not apply** and the user is re-prompted. This is why `git status && rm -rf /` can't ride a `git` grant. (See the memory note on chained-command bypass — any new Bash-authorization path must reuse `scanShellCommand` and reject multi-segment/dangerous commands.)

## 5. Path policy (`path-policy.ts`)

A second, independent gate (distinct from the permission classifier) that classifies file-tool target paths. `classifyPath(absPath, operation)` **realpaths both sides** (so an in-repo symlink can't escape the workspace — see the memory note on `path-containment` realpath), then:
- Sensitive **file** patterns (`.env*`, `id_rsa*`, `*.pem`, bare `secret`/`credentials`/`token`, etc.) → write = `deny`, read = `ask`. Source files like `authController.ts`/`token-counter.ts` are explicitly **not** treated as credentials.
- Sensitive **dir** patterns (`.ssh`, `.aws`, `.config/gcloud`, `.code-shell`, `.claude`, `.gnupg`, `.kube`, `.docker`).
- In-workspace → `allow`; outside → `ask`.

Approvals cache by directory prefix at session/project scope. Escape hatch: `CODESHELL_PATH_POLICY=off` (logged once). Array args (e.g. `GenerateImage.referenceImages`) are enforced element-by-element, filtering out `http(s)` URLs.

## 6. MCP integration (`mcp-manager.ts`)

`MCPManager` connects to external MCP servers (auto-detecting stdio vs. streamable-http via `inferTransportType`), discovers their tools, and registers them in the **same** `ToolRegistry` — so MCP tools inherit the identical permission/path/sandbox gates as builtins. Notable helpers:
- `buildStdioEnv` / `buildHttpHeaders` — env and header construction, including `bearerTokenEnvVar`, `credentialRef`, and `envHeaders`. (The MCP-auth-error memory note: probe code must reuse `buildHttpHeaders` or it misreports 401s.)
- `spillMcpImage` — persists oversized base64 images to `~/.code-shell/mcp_images/` (8 MB cap per server/tool), returning a one-line reference.
- `wrapMcpOutput` — wraps server output in an `<mcp-result … trust="untrusted">` marker so the model treats it as data, not instructions (prompt-injection defense).

## 7. Sandbox (`sandbox/index.ts`)

Bash commands can be wrapped in an OS sandbox: **seatbelt** (macOS, native), **bwrap** (Linux bubblewrap), or **off**. `auto` picks the available backend and warns once if none. `defaultSandboxConfig` makes the workspace + tmp writable, denies reads to cloud-cred dirs, and leaves network open (denying it breaks npm/git). **Windows has no backend → `auto` degrades to off** (confirmed in the Windows-port work). Note the deliberate split: the sandbox denies *reads* of credentials; denying sensitive *writes* is the path-policy layer's job.

## 8. The builtin tools (`builtin/index.ts`)

`BUILTIN_TOOLS` is the registration table; each entry declares `permissionDefault`, `isReadOnly`, `isConcurrencySafe`, optional `pathPolicy`, and `timeoutMs`. By category:

- **File**: `Read`, `Write`, `Edit`, `ApplyPatch`, `Glob`, `Grep`, `ViewImage`, `NotebookEdit`
- **Shell**: `Bash`, `PowerShell`, `REPL` + background companions `BashOutput`, `KillShell`, `ListShells`
- **Web/Media**: `WebSearch`, `WebFetch`, `GenerateImage`, `GenerateVideo`
- **Agent/multi-model**: `Agent`, `AgentStatus`, `AgentCancel`, `AgentSendInput`, `Arena`
- **Coordination/planning**: `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `ToolSearch`, `Skill`, `CompleteGoal`, `TodoWrite`
- **MCP/integration**: `MCPTool`, `ListMcpResources`, `ReadMcpResource`, `UseCredential`, `InjectCredential`
- **Automation/external**: `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`, `DriveAgent`, `DriveClaudeCode`
- **Dev/workspace**: `Config`, `LSP`, `Brief`, `EnterWorktree`, `ExitWorktree`, `EditModelCatalog`
- **Memory**: `MemoryList`, `MemoryRead`, `MemorySave`, `MemoryDelete`
- **Browser**: `browser_observe`, `browser_act`, `browser_navigate`
- **Utility**: `Sleep`, `AddMarketplace`

`ApplyPatch` is adapted from OpenAI Codex's `apply-patch` (Apache-2.0), with the intentional divergence that ours rolls back partial writes on failure.

### Two gotchas worth internalizing
- **Add a builtin tool = change two places.** A tool must be in both `BUILTIN_TOOLS` *and* the preset whitelist (`GENERAL_BUILTIN_TOOLS` in [05](05-presets-prompt-hooks-skills.md)) — `ToolRegistry.registerBuiltins(selectedNames)` silently drops anything not whitelisted, so the model gets "Tool not found" even though the executor exists. (This has recurred repeatedly — see the memory notes on the BUILTIN_TOOLS/preset-whitelist bug.)
- **Tool guards hide tools when unusable.** `BUILTIN_TOOL_GUARDS` filters out e.g. `WebSearch`/`GenerateImage` when no API key, and `UseCredential`/`InjectCredential` when the credential store is empty — "quiet when empty."

Two cross-cutting robustness rules apply to every tool author here: external network/MCP calls must carry a timeout **and** the run signal (`AbortSignal.any([userSignal, AbortSignal.timeout(N)])`), and numeric args fed to `slice`/`setTimeout`/counts must guard `> 0` rather than just `|| default` (see the memory notes on external-call-timeout and non-positive-numeric-arg footguns).

## 9. Where to read next
- The preset whitelist that decides which builtins are visible: [05 · Presets, prompt, hooks, skills](05-presets-prompt-hooks-skills.md)
- MCP servers shipped by plugins: [07 · Plugins, capabilities, credentials, memory](07-plugins-capabilities-credentials-memory.md)
- The `Agent`/`Arena`/`Drive*` tools' deeper machinery: [06](06-long-running-orchestration.md), [08](08-arena-and-integrations.md)
