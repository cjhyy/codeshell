# Core Read-Only Review - 2026-07-08

Scope: `packages/core/` only. Reviewed the engine/turn-loop hot path, tool registry/execution, settings, credentials, MCP manager, compaction/context management, protocol session lifecycle, safe-spawn/background shells, hooks, and session storage. No code changes were made.

Summary: 10 findings: 2 critical, 6 major, 2 minor.

## 🔴 Critical

### `packages/core/src/settings/manager.ts:595` - project settings can smuggle dangerous fields through `__proto__`

Problem: `parseConfigFile` returns parsed settings objects without recursively rejecting prototype keys (`packages/core/src/settings/manager.ts:547-555`). `merge` then assigns arbitrary keys into a normal object (`packages/core/src/settings/manager.ts:583`, `packages/core/src/settings/manager.ts:595-597`); assigning `__proto__` mutates the merged object's prototype. The untrusted-project gate only deletes explicit top-level dangerous fields from the source object (`packages/core/src/settings/manager.ts:255-260`), so a project file can put `permissions`, `hooks`, `env`, or `mcpServers` under `__proto__` and bypass the strip. `validateSettings` accepts the polluted object (`packages/core/src/settings/schema.ts:594-600`) and materializes inherited fields; the engine then consumes settings hooks (`packages/core/src/engine/engine.ts:506-524`), permission rules (`packages/core/src/engine/engine.ts:3003-3011`), and shell env (`packages/core/src/engine/engine.ts:3332-3345`).

Impact: An untrusted repository can bypass workspace-trust filtering and inject execution-affecting settings, including shell hooks or permission allow rules. That can turn "open this repo" into arbitrary command execution once a matching hook/tool path is reached.

Suggested fix: Sanitize parsed config recursively before merge, rejecting or dropping `__proto__`, `prototype`, and `constructor` everywhere. Build merge results with `Object.create(null)` or a safe structured clone, and skip forbidden keys in `merge`. Change the trust gate to use own-property checks and add regression tests for a project settings file containing `{"__proto__":{"hooks":[...],"permissions":{"rules":[...]}}}` with `projectTrusted=false`.

### `packages/core/src/credentials/use-credential-tool.ts:194` - approved credentials are persisted and logged as plaintext tool output

Problem: `UseCredential` returns token/link secrets directly to the model as JSON (`packages/core/src/credentials/use-credential-tool.ts:191-194`). The turn loop persists every tool result unchanged (`packages/core/src/engine/turn-loop.ts:1015-1021`), and `Transcript.appendToolResult` writes that `result` into `transcript.jsonl` (`packages/core/src/session/transcript.ts:89-102`, `packages/core/src/session/transcript.ts:235-238`). Verbose LLM request logging also records subsequent prompts after only image sanitization (`packages/core/src/engine/model-facade.ts:55-65`, `packages/core/src/engine/model-facade.ts:150-159`), and the session recorder records tool outputs (`packages/core/src/logging/session-recorder.ts:303-324`).

Impact: The credential store's disk encryption/approval gate is bypassed after first use: secrets land in plaintext transcripts, debug logs, and future prompt history. Any log collection, session export, or local file read can recover the credential.

Suggested fix: Mark `UseCredential` results as sensitive. Keep the raw secret only in the minimal in-memory channel needed for the next tool call, but redact transcript events, verbose recorder entries, UI streams, and future persisted history. Prefer returning a scoped lease/handle, temp file, or env binding that is not model-visible plaintext, and add redaction tests for transcripts and verbose logs.

## 🟠 Major

### `packages/core/src/credentials/inject-credential-tool.ts:81` - `InjectCredential` ignores engine settings scope

Problem: `UseCredential` maps `settingsScope` to credential scope (`packages/core/src/credentials/use-credential-tool.ts:125-140`) and resolves/list credentials with that scope (`packages/core/src/credentials/use-credential-tool.ts:159-165`). `InjectCredential` does not: it reads auto-approve from `new SettingsManager(cwd, "full")` (`packages/core/src/credentials/inject-credential-tool.ts:81-84`), checks availability with `new CredentialStore(cwd).listMasked()` (`packages/core/src/credentials/inject-credential-tool.ts:91-94`), and resolves with `new CredentialStore(cwd).resolve(id)` (`packages/core/src/credentials/inject-credential-tool.ts:118`). This conflicts with the engine contract that credential tools narrow disk reads by `settingsScope` (`packages/core/src/engine/engine.ts:3414-3418`). The dynamic `UseCredential` description also lists full-scope credentials because `dynamicToolDefFor` calls `useCredentialToolDefFor(guardCwd)` (`packages/core/src/engine/dynamic-tool-defs.ts:39-40`), and that helper uses default full-scope listing (`packages/core/src/credentials/use-credential-tool.ts:65-73`).

Impact: A project-scoped or isolated engine can see or inject host user credentials/cookies, and can inherit host `credentialUse.autoApprove`. This is especially risky because browser injection has persistent side effects in the user's browser session.

Suggested fix: Thread `settingsScope` into `InjectCredential` availability, dynamic tool descriptions, auto-approve reads, and credential resolution. Use the same `credentialScope(ctx?.settingsScope)` policy as `UseCredential`. For browser injection, pass a scoped credential payload/lease to the host or include scope in the callback so the host cannot re-resolve a broader credential by id.

### `packages/core/src/tool-system/mcp-manager.ts:518` - discovered MCP tools drop the abort signal

Problem: Directly discovered MCP tools are registered with an executor that only accepts `args` and calls `client.callTool(...)` without SDK request options (`packages/core/src/tool-system/mcp-manager.ts:518-522`). The generic `MCPTool` path does forward the run signal (`packages/core/src/tool-system/builtin/mcp-tools.ts:37-44`, `packages/core/src/tool-system/mcp-manager.ts:613-630`), so cancellation behavior differs by invocation path.

Impact: When the user stops a run, `ToolRegistry.executeTool` can return an aborted result while the underlying MCP request continues in the background until the SDK timeout/server response. That leaks resources and can allow post-cancel side effects on external MCP servers.

Suggested fix: Register discovered executors as `(args, ctx) => ...` and pass `ctx?.signal` to `client.callTool` the same way `MCPManager.callTool` does. Keep `stripInternalToolArgs(args)` so internal fields are not forwarded.

### `packages/core/src/tool-system/mcp-manager.ts:495` - failed MCP tool discovery leaves a half-connected server

Problem: `performConnect` commits the connection to `this.connections` before tool discovery (`packages/core/src/tool-system/mcp-manager.ts:495-498`). If `discoverTools` or `client.listTools()` fails, `performConnect` rejects but the connection remains in the map. Later `connect()` calls return early because `connections.has(name)` is true (`packages/core/src/tool-system/mcp-manager.ts:388-392`), even though no tools may be registered and the transport remains open.

Impact: A transient discovery failure can strand a live MCP child/socket and make the server unrecoverable for that process. If discovery partially registered tools before failure, stale partial tool registrations can also remain.

Suggested fix: Wrap post-handshake discovery in `try/catch`. On failure, close the client/transport, unregister any tools recorded for that server, delete `connections`, and rethrow. Alternatively, discover before committing the connection and keep a single cleanup path for any post-connect failure.

### `packages/core/src/tool-system/builtin/mcp-tools.ts:83` - `ListMcpResources` filters out all resources under normal MCP allowlisting

Problem: `ListMcpResources` injects the session allowlist and then filters each resource by `r.serverName ?? r.server` (`packages/core/src/tool-system/builtin/mcp-tools.ts:83-89`). `MCPManager.listResources` returns only `{ uri, name, description }` and does not attach the owning server name (`packages/core/src/tool-system/mcp-manager.ts:648-665`). The executor always injects the allowlist for `ListMcpResources` when MCP gating is active (`packages/core/src/tool-system/executor.ts:206-217`).

Impact: In the normal shared-worker/session-gated path, resource listing reports "No MCP resources available" even when connected allowed servers have resources. This breaks MCP resource discovery while trying to prevent cross-session leaks.

Suggested fix: Include `serverName: name` on every resource returned by `MCPManager.listResources`. Keep the allowlist filter for the no-server case, and add tests for both explicit-server and all-server listing with `allowedMcpServers`.

### `packages/core/src/context/manager.ts:409` - the engine hot path skips always-on context cleanup

Problem: The synchronous `ContextManager.manage()` path always deduplicates repeated file reads and masks old browser snapshots (`packages/core/src/context/manager.ts:295-314`). The turn loop calls `manageAsync()` (`packages/core/src/engine/turn-loop.ts:641-642`), but `manageAsync()` runs persistence/truncation/budgeting and then jumps directly to microcompaction (`packages/core/src/context/manager.ts:409-419`), skipping those two always-on cleanup steps. The helper functions have unit tests, but the production async path does not call them.

Impact: Actual engine turns retain stale duplicate `Read` outputs and old browser observations. That wastes context, increases compaction pressure, and can present stale DOM snapshots to the model.

Suggested fix: Mirror `manage()` by running `dedupeFileReads` and `maskOldObservations` in `manageAsync()` before microcompaction, with the same logging. Add tests that call `manageAsync()` directly and verify duplicates/old snapshots are removed.

### `packages/core/src/tool-system/mcp-manager.ts:191` - MCP image spilling has no retained-file cap or cleanup

Problem: The comments promise a per `(server, tool)` retained-image cap before garbage collection (`packages/core/src/tool-system/mcp-manager.ts:143-147`), but the implementation only caps each individual image at 8 MB (`packages/core/src/tool-system/mcp-manager.ts:174-176`) and then writes every accepted image to disk (`packages/core/src/tool-system/mcp-manager.ts:191-204`). A search of the MCP manager shows no `readdir`/unlink cleanup path.

Impact: A chatty or malicious MCP server can fill `mcp_images` over time with many sub-8-MB images. This is a disk resource leak in a hot path intended to protect the model context from large image payloads.

Suggested fix: Implement the promised GC: keep a max file count and/or total bytes per `(server, tool)` and delete oldest files after each spill. Consider session-scoped spill directories with teardown cleanup, and add tests that spill more than the cap.

### `packages/core/src/tool-system/mcp-manager.ts:168` - MCP image spills do not honor `CODE_SHELL_HOME` consistently

Problem: `spillMcpImage` resolves its default directory as `join(CODE_SHELL_HOME ?? HOME, ".code-shell", "mcp_images")` (`packages/core/src/tool-system/mcp-manager.ts:168-171`). Other core home resolvers treat `CODE_SHELL_HOME` itself as the CodeShell home (`packages/core/src/session/session-manager.ts:93-95`, `packages/core/src/session/memory.ts:112-123`). With `CODE_SHELL_HOME=/tmp/csh`, MCP images go to `/tmp/csh/.code-shell/mcp_images` while sessions and memory go to `/tmp/csh/...`.

Impact: Hosts/tests that relocate CodeShell state get MCP images in an unexpected nested directory, so cleanup, backup, and isolation logic can miss them.

Suggested fix: Centralize a `codeShellHome()` helper and use it for MCP image spills. The default should be `CODE_SHELL_HOME` when set, otherwise `join(HOME, ".code-shell")`.

## 🟡 Minor

### `packages/core/src/tool-system/path-policy.ts:174` - session approval caches are never pruned

Problem: Session-scoped path grants are stored in a process-global map (`packages/core/src/tool-system/path-policy.ts:173-174`) and populated on "allow for session" (`packages/core/src/tool-system/path-policy.ts:291-305`). The serialized path approval chains are also process-global (`packages/core/src/tool-system/path-policy.ts:600-604`, `packages/core/src/tool-system/path-policy.ts:682-683`) and retain the final resolved promise per session. Credential session-allow maps have the same lifetime (`packages/core/src/credentials/use-credential-tool.ts:109-122`, `packages/core/src/credentials/inject-credential-tool.ts:68-79`). `ChatSessionManager.close` cancels and deletes the session but does not clear these maps (`packages/core/src/protocol/chat-session-manager.ts:94-100`), and protocol close only cleans approvals/background work (`packages/core/src/protocol/server.ts:959-974`).

Impact: Long-lived workers that create many sessions retain path grants, approval-chain promises, and credential allow sets indefinitely. The main risk is memory growth; if a logical session id is reused, stale approvals could also apply unexpectedly.

Suggested fix: Expose cleanup functions such as `clearPathPolicySession(sessionId)` and `clearCredentialSessionApprovals(sessionId)`, delete resolved `askChains` entries in `finally`, and call cleanup from explicit session close and any worker/session teardown path.

### `packages/core/src/runtime/background-shell.ts:139` - background shell artifacts use a different home layout under `CODE_SHELL_HOME`

Problem: `bgShellsRoot()` computes `join(CODE_SHELL_HOME ?? HOME, ".code-shell", "bg-shells")` (`packages/core/src/runtime/background-shell.ts:139-142`). Session and memory managers treat `CODE_SHELL_HOME` as the final CodeShell home directory, not the parent of `.code-shell` (`packages/core/src/session/session-manager.ts:93-95`, `packages/core/src/session/memory.ts:112-123`).

Impact: With `CODE_SHELL_HOME=/tmp/csh`, background shell pidfiles/logs land under `/tmp/csh/.code-shell/bg-shells` while sessions land under `/tmp/csh/sessions`. Orphan recovery still uses the same wrong helper, but external cleanup and state isolation that remove `/tmp/csh/bg-shells` will miss the actual files.

Suggested fix: Use the same central `codeShellHome()` helper as sessions/memory, and make `bgShellsRoot()` return `join(codeShellHome(), "bg-shells")`.

## Verification Notes

- Session id path traversal appears fixed in the current tree: public session entry points validate ids with `assertSafeSessionId` before joining paths (`packages/core/src/session/session-manager.ts:61-84`, `packages/core/src/session/session-manager.ts:156`, `packages/core/src/session/session-manager.ts:465-500`).
- Safe-spawn/Bash process lifecycle looked hardened for this pass: foreground shell commands run through `safeSpawnShell`, use process-group termination for shell mode, cap output, and clean abort listeners (`packages/core/src/runtime/safe-spawn.ts:142-168`, `packages/core/src/runtime/safe-spawn.ts:199-213`, `packages/core/src/runtime/safe-spawn.ts:235-267`).
- MCP stdio environment inheritance was checked and not raised: when `buildStdioEnv` returns `undefined`, the MCP SDK supplies its own small default allowlist rather than full `process.env` (`node_modules/.bun/@modelcontextprotocol+sdk@1.29.0/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:64-70`).
- Protocol cancellation of pending approvals is covered for Stop/close paths (`packages/core/src/protocol/server.ts:721-729`, `packages/core/src/protocol/server.ts:2234-2247`); the remaining approval issue above is stale session-scoped caches, not hanging pending approval promises.
