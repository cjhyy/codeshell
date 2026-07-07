## Core Engine Review

### Strengths (file:line specific)
- `packages/core/src/settings/manager.ts:65-118` hardens dotted setting writes against prototype-pollution segments and inherited-object descent before `Config`/settings writes use them.
- `packages/core/src/plugins/installer/sourcePath.ts:18-60` adds relative-path, realpath, and symlink-escape checks for marketplace/plugin source subpaths.
- `packages/core/src/run/ids.ts:1-25`, `packages/core/src/run/FileRunStore.ts:38-50`, and `packages/core/src/run/RunManager.ts:182-190` add path-segment validation and resume/cancel serialization for run IDs.
- `packages/cdp/src/driver.ts:55-75` rejects non-absolute and non-http(s)/`about:blank` browser navigation URLs before `Page.navigate`.
- `packages/core/src/git/worktree.ts:148-151` uses argv-based git invocation for `worktree add`, and `packages/core/src/git/worktree.ts:287-289` refuses to delete non-`worktree/` branches.
- `packages/core/src/tool-system/mcp-manager.ts:294-303`, `packages/core/src/tool-system/mcp-manager.ts:332-353`, and `packages/core/src/protocol/chat-session-manager.ts:90-91` improve shared MCP pool ownership so one session's reload/close does not unexpectedly tear down another session's servers.

### Critical (Must Fix Before Tag)
- `packages/core/src/tool-system/builtin/worktree.ts:249-256` trusts `args.__sessionId` before `ctx.sessionId`, while `packages/core/src/tool-system/validation.ts:37-40` explicitly permits undeclared extra fields and `packages/core/src/tool-system/registry.ts:127-132` only injects `__signal`. A model/tool caller can provide `__sessionId` and make `EnterWorktree`/`ExitWorktree` operate on another session's persisted workspace; `packages/core/src/tool-system/builtin/worktree.ts:198-205` can then detach/discard that other session's worktree. Use only trusted `ctx.sessionId`, or strip all model-supplied `__*` fields before trusted injection.
- `packages/core/src/tool-system/builtin/config.ts:35-38` still trusts model-supplied `args.__cwd` for project settings reads/writes. Because `Config` has no path policy and extra fields are accepted, a tool call can target another repo or `$HOME/.code-shell/settings.json` by setting `__cwd`, then write dangerous settings such as permissions/env/hooks. Change `Config` to accept `ctx?: ToolContext` and use `ctx.cwd`; do not consume `__cwd` from raw args.

### Important (Should Fix Before Tag)
- `packages/core/src/tool-system/builtin/worktree.ts:38-43` marks `slug` as a deprecated alias, but the schema still requires `target`. Since validation runs before `enterWorktreeTool()` reaches the fallback at `:51-52`, old `{slug:"..."}` callers now fail. Make the schema accept either `target` or `slug`, or remove the claimed compatibility.
- `packages/core/src/tool-system/builtin/worktree.ts:272-293` allows a session to attach to an existing worktree by branch/path, and tests cover shared attachment, but `ExitWorktree` removes it at `:198-205` without checking other session owners. The owner metadata exists in `packages/core/src/git/worktree.ts:403-423`; use it before `detach`/`discard` or one session can strand another with a missing workspace root.
- `packages/core/src/session/session-manager.ts:350-351` treats any existing path as a valid worktree resume cwd. A file, symlink, or non-git directory at the old worktree path will be accepted and fail later in engine/tool setup. Check `statSync(...).isDirectory()` and ideally verify it is still the expected git worktree/branch.
- `packages/core/src/run/RunApprovalBackend.ts:74-96` exposes a waiting approval through `onApprovalNeeded()` before `pendingApproval` is installed, while `packages/core/src/run/RunManager.ts:229-234` ignores `handle.resolveApproval()`'s boolean. A fast subscriber/automation resume can transition the run back to running before the backend has a resolver, after which the backend installs a pending approval that can hang until timeout. Install the resolver before making the approval externally resumable, or reject/rollback when `resolveApproval()` returns false.

### Minor (Nice to Have)
- `packages/core/src/protocol/server.ts:1885-1892` says goal AskUser arms a shared 5-minute timeout, but `:1914` uses `GOAL_ASKUSER_TIMEOUT_MS` (10 minutes). Update the comment.
- `packages/core/src/cc-orchestrator/external-agent-session-store.ts:94-120` uses synchronous lock polling, and `:138-147` can block the event loop for up to 5 seconds. This is called from DriveAgent completion/foreground recording; prefer an async lock/write queue.
- `packages/core/src/plugins/installer/sourcePath.ts:12-16` enforces strict-child containment, so marketplace `source: "."` or git-subdir `path: "."` would be rejected even though the schema accepts arbitrary relative string paths. If root-level plugin sources are intentionally unsupported, document/test that; otherwise allow equal-to-root for copy sources.

### Assessment (Ready to tag? No)
The session/workspace work removes the old process-global worktree state, but the new implementation crosses a trust boundary by reading hidden `__sessionId`/`__cwd` values from model-controlled tool args. Those are release-blocking because they enable cross-session workspace mutation and out-of-workspace settings writes. After stripping/trusting internal fields correctly, also fix the shared-worktree removal guard and resume validation before tagging.
