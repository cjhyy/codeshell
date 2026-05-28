# Core Quality & Security Iteration Plan

Date: 2026-05-27
Status: Draft
Scope: `packages/core`

## 1. Background

`packages/core` has grown from a low-level library into a full agent runtime. It now contains engine orchestration, tool execution, permissions, LLM providers, protocol server/client, settings, plugins, hooks, skills, session/context management, run/product abstractions, arena workflows, memory, services, git helpers, updater, and onboarding support.

The module is functionally rich and already supports complex agent behavior. However, the current review shows that capability growth has outpaced security hardening, test coverage, and boundary cleanup. The next iteration should focus on stabilizing the core before adding more features.

Overall review score: **6.5 / 10**.

## 2. Goals

This iteration aims to improve core reliability, security, and maintainability without changing the user-facing product direction.

Primary goals:

1. Close high-priority security gaps in protocol, plugins, git helpers, session IDs, logging, and file-path handling.
2. Establish a consistent path safety model for file tools.
3. Add regression tests for the highest-risk core paths.
4. Start reducing `Engine` responsibility without a large rewrite.
5. Clarify extension trust boundaries for plugins, hooks, skills, MCP, and LSP.

Non-goals:

- Redesign the whole engine.
- Replace the storage layer with a database.
- Rework the full UI protocol.
- Add major new product features.
- Fully solve sandboxing for every tool in one pass.

## 3. Current Assessment

### 3.1 Strengths

- `llm` provider/model/capability layering is clear and reusable.
- `context` has mature compaction ideas, especially tool-result persistence and prompt-cache stability.
- `run` provides a solid foundation for product-level orchestration.
- `product` and `preset` match the intended architecture: engine stays generic, product behavior is expressed through presets and adapters.
- `safe-spawn` has strong process lifecycle handling.
- `settings` scope design (`isolated`, `project`, `full`) is a good security foundation.

### 3.2 Weaknesses

- `Engine` is too large and mixes runtime, product, UI stream, memory, tool, permission, and session responsibilities.
- Several security boundaries are inconsistent or incomplete.
- Critical modules have little or no direct test coverage.
- Many modules rely on sync IO and module-level mutable state.
- Extension mechanisms are powerful but do not yet have a clear trust model.

## 4. Module Scores

| Module | Score | Notes |
|---|---:|---|
| Engine | 6.5 | Feature-rich but over-centralized. |
| Context | 7 | Strong compaction design; needs tests and lower side effects. |
| Prompt | 6.5 | Good preset direction; too coupled to git/env/fs/memory. |
| Session | 6 | Simple JSONL model; path and consistency risks. |
| Tool system | 7 | Good execution chain; weak file path policy. |
| MCP | 6.5 | Conservative defaults; untrusted output boundary missing. |
| Protocol | 5.5 | Multi-session direction is good; control-plane security is weak. |
| safe-spawn | 8 | Strong subprocess lifecycle management. |
| Sandbox | 6.5 | Useful for Bash; does not cover file tools. |
| LSP | 4.5 | Useful prototype; weak process safety and protocol parsing. |
| Settings | 7 | Good scope model; safety warnings and schema strictness need work. |
| LLM | 8 | One of the strongest modules. |
| Plugins | 6 | Functional; supply-chain and uninstall risks. |
| Hooks | 6.5 | Good lifecycle model; shell execution boundary is weak. |
| Skills | 7 | Simple and practical; trust/size/symlink controls needed. |
| Logging | 6.5 | Structured logs; generic secret redaction missing. |
| Run | 7 | Good orchestration skeleton; persistence/concurrency tests needed. |
| Product/Preset | 7 | Correct direction; global registry side effects. |
| Arena | 7 | Ambitious and coherent; complex and under-tested. |
| Memory | 6.5 | Useful scope model; slug/frontmatter/concurrency issues. |
| Cron | 4 | In-memory scheduler; not production-grade yet. |
| Git | 4.5 | Useful helpers; shell-string command construction is risky. |
| State | 5 | Migration compatibility value; global mutable state limits reuse. |
| Updater/Onboarding | 6.5 | Practical; still product-level logic inside core. |

## 5. Priority Workstreams

## Workstream A: Security P0 Fixes

### A1. Stop protocol config secret leakage

Problem:

`protocol` config queries may expose raw API keys and provider credentials.

Target behavior:

- Never return raw `apiKey`, `Authorization`, provider tokens, or secret headers from protocol query responses.
- Return only derived fields such as `hasApiKey`, `apiKeyPreview`, or redacted strings.

Acceptance criteria:

- A test proves `query("config")` does not include a raw API key.
- Nested provider credentials and headers are redacted.
- Existing UI still has enough information to render provider/model status.

Suggested tests:

- `protocol/server config query redacts llm.apiKey`
- `protocol/server config query redacts provider headers`
- `protocol/server config query returns hasApiKey`

### A2. Harden plugin uninstall path handling

Problem:

`installed_plugins.json` can contain an arbitrary `installPath`. Uninstall currently risks deleting paths outside the plugin cache.

Target behavior:

- Plugin uninstall must only delete real paths under the plugin cache root.
- It must refuse to delete the cache root itself, its parent, or any path outside the cache.

Acceptance criteria:

- `realpath` containment check before deletion.
- Malicious `installPath` values are rejected.
- Normal uninstall still works.

Suggested tests:

- uninstall rejects `/`, home, project root, and `..` escapes.
- uninstall accepts valid plugin cache child.
- uninstall does not follow symlink outside cache.

### A3. Replace unsafe Git shell construction

Problem:

`git/utils.ts` and parts of `git/worktree.ts` use `execSync` with string interpolation for branch names, file paths, PR URLs, and messages.

Target behavior:

- Use `execFileSync` or `spawn` with argument arrays.
- No user-controlled string should be interpolated into a shell command.

Acceptance criteria:

- Git helper functions pass malicious branch/file/PR URL tests without command injection.
- Behavior remains compatible with paths containing spaces, quotes, and non-ASCII characters.

Suggested tests:

- `gitCheckout` with malicious branch does not execute injected command.
- `getGitDiff` handles file path with spaces/quotes.
- `ghPrComments` treats PR URL as an argument, not shell text.

### A4. Validate session IDs

Problem:

Session APIs join `sessionId` into filesystem paths. Invalid IDs could cause path traversal.

Target behavior:

- Session IDs must be a safe basename.
- Reject absolute paths, slashes, backslashes, `..`, empty strings, and unexpected characters.

Acceptance criteria:

- `SessionManager.create`, `resume`, `exists`, and related path builders use one shared validator.
- Tests cover traversal and valid IDs.

Suggested tests:

- reject `../../x`, `/tmp/x`, `a/b`, `a\\b`, `..`, and empty ID.
- accept generated IDs and explicit safe IDs.

### A5. Add generic log secret redaction

Problem:

Logging and diagnostics can persist raw secrets if callers pass settings, provider configs, headers, env, or errors containing tokens.

Target behavior:

- Logger applies recursive redaction before writing structured logs.
- Diagnostics and in-memory errors use the same redaction path.

Acceptance criteria:

- Redact keys matching `apiKey`, `authorization`, `x-api-key`, `token`, `password`, `secret`, and similar names.
- Redact `Bearer ...` strings.
- Redact URL query parameters such as `key`, `token`, `api_key`.

Suggested tests:

- nested object secrets are redacted.
- arrays of headers/env values are redacted.
- normal non-secret fields remain readable.

## Workstream B: Unified File Path Policy

Problem:

Bash sandboxing and permissions have improved, but file tools still operate directly on host paths. `Read`, `Grep`, `Glob`, `Write`, `Edit`, `ApplyPatch`, and `NotebookEdit` need consistent path rules.

Target design:

Introduce a shared `PathPolicy` module used by file-like tools and permission classification.

Initial policy:

1. Workspace/project paths are allowed according to the current permission mode.
2. Paths outside the workspace require explicit ask unless already approved by a specific rule.
3. Sensitive paths default to ask or deny:
   - `~/.ssh`
   - `~/.aws`
   - `~/.config/gcloud`
   - `~/.code-shell`
   - `.env`, `.env.*`
   - private keys and token files
4. `acceptEdits` cannot bypass path policy.
5. Symlinks should be resolved before final decision where practical.

Acceptance criteria:

- File read/write tools consult `PathPolicy`.
- Workspace-outside writes require approval.
- Sensitive path reads are not silently allowed.
- Existing normal project edits continue to work.

Suggested tests:

- `Read` sensitive path triggers ask/deny.
- `Write` outside workspace is not auto-approved under `acceptEdits`.
- `Edit` inside workspace still works under expected permission mode.
- symlink-to-sensitive-path is handled safely.

## Workstream C: Extension Trust Boundaries

### C1. Hooks hardening

Problem:

Shell hooks can execute arbitrary commands and inject model-visible context. Hook output is not strongly validated or size-limited.

Target behavior:

- Shell hook stdout/stderr have byte caps.
- HookResult is parsed through a runtime schema.
- Project hooks require workspace trust or an explicit enablement path.
- Hook-injected content is marked with source and trust level.

Acceptance criteria:

- Malformed hook JSON is safely rejected.
- Oversized hook output is truncated or rejected.
- Hook messages cannot silently become trusted system instructions.

### C2. Plugin supply-chain hardening

Problem:

Plugin install and hook execution assume installed plugins are trusted. `sha` exists in metadata but is not enforced.

Target behavior:

- If plugin metadata declares `sha`, clone result must match it.
- Install UI/CLI must communicate that plugin hooks can execute commands.
- Plugin hook output should follow the same caps/schema as shell hooks.

Acceptance criteria:

- sha mismatch fails install.
- plugin hook output is capped.
- disabled plugin hides hooks, commands, and skills consistently.

### C3. MCP output trust boundary

Problem:

MCP tool/resource output is external content and may contain prompt injection. It is currently returned too directly.

Target behavior:

- MCP output is wrapped or annotated as untrusted external content.
- MCP resource reads are permission-gated or trust-level aware.
- MCP server stdio startup has a clear trust model.

Acceptance criteria:

- Tool result formatting distinguishes MCP external content.
- Tests cover prompt-injection-like MCP output.

### C4. LSP process trust boundary

Problem:

LSP tools are marked read-only/allow, but starting a language server is external process execution.

Target behavior:

- First start of an LSP server requires approval or a trust policy.
- LSP process env is filtered.
- LSP protocol parsing uses byte-accurate `Content-Length` handling.

Acceptance criteria:

- Multi-byte LSP responses parse correctly.
- LSP server startup is not silently treated as pure read-only.

## Workstream D: Core Test Coverage

Add tests before larger refactors. Priority test targets:

1. Protocol config redaction.
2. Plugin uninstall containment.
3. Git helper command injection resistance.
4. Session ID validation.
5. Logger recursive redaction.
6. File `PathPolicy` behavior.
7. HookResult schema and large output.
8. LSP multi-byte protocol parsing.
9. Transcript resume and orphaned tool repair.
10. ContextManager compaction idempotency.
11. RunManager submit/cancel/recover/approval timeout.
12. Permission classifier Bash bypass cases.

Recommended test style:

- Keep tests close to modules under `packages/core/src/**`.
- Use Bun test runner.
- Prefer focused unit tests for safety logic.
- Avoid depending on global user config or real home directory.
- Use temporary directories for filesystem tests.

## Workstream E: Engine Boundary Cleanup

Problem:

`Engine` is overloaded. A full rewrite is risky, so this iteration should extract only low-risk seams.

Phase 1 extraction candidates:

1. `SessionCoordinator`
   - session create/resume
   - transcript path setup
   - session metadata

2. `PromptRuntimeBuilder`
   - prompt composer setup
   - user/system context collection
   - preset resolution glue

3. `StreamEventAdapter`
   - convert core events to UI/product stream events
   - isolate ctx bar/task panel/dock-specific shaping

Phase 2 candidates:

1. `PermissionCoordinator`
2. `SubAgentSpawner`
3. `MemoryPipelineRunner`
4. `RunScopedHookRegistry`

Acceptance criteria for Phase 1:

- `Engine.run()` gets smaller without changing behavior.
- New classes/functions have unit tests or narrow integration tests.
- No product-visible behavior changes.
- No broad rename/refactor mixed with security fixes.

## Workstream F: State and IO Cleanup

Problem:

Core uses sync IO and global state in several places. This is acceptable for some CLI paths but limits reuse in server/worker/multi-session contexts.

Initial improvements:

1. Keep sync IO where changing it would be too invasive, but isolate it behind small adapters.
2. Avoid adding new module-level mutable state.
3. Add reset/test helpers for global registries where needed.
4. Use injected dependencies for clock, filesystem, logger, and telemetry in new code.

Targets:

- `state.ts`
- `preset` global registry
- `analytics`
- `diagnostics`
- `session-memory`
- `memory` state writes
- `context` tool result persistence

## 6. Proposed Execution Order

### Task 1: Protocol secret redaction

- Add redaction helper if one does not already exist.
- Apply it to config query response.
- Add protocol tests.

### Task 2: Plugin uninstall containment

- Add plugin cache root containment helper.
- Validate real paths before deletion.
- Add uninstall safety tests.

### Task 3: Git command safety

- Convert git helpers from shell strings to arg arrays.
- Add injection/path tests.

### Task 4: Session ID validation

- Add shared session ID validator.
- Apply to create/resume/exists/path builders.
- Add traversal tests.

### Task 5: Logger redaction

- Add recursive secret redaction.
- Apply to logger, diagnostics, and in-memory errors.
- Add redaction tests.

### Task 6: PathPolicy MVP

- Implement shared path classifier.
- Wire into file tools and permission classification.
- Add tests for workspace, outside workspace, and sensitive paths.

### Task 7: Hook/plugin output hardening

- Add HookResult schema.
- Add stdout/stderr caps.
- Mark hook content source/trust.
- Add tests.

### Task 8: MCP/LSP trust improvements

- Mark MCP output as untrusted.
- Gate or annotate MCP resource reads.
- Fix LSP byte parsing.
- Add tests.

### Task 9: Engine Phase 1 extraction

- Extract `SessionCoordinator`.
- Extract `PromptRuntimeBuilder`.
- Extract `StreamEventAdapter`.
- Keep behavior unchanged.

### Task 10: Run/context/session regression tests

- Add tests around transcript recovery.
- Add context compaction idempotency tests.
- Add RunManager lifecycle tests.

## 7. Risks and Mitigations

### Risk: Security changes break existing workflows

Mitigation:

- Start with tests that encode expected safe behavior.
- Add clear approval prompts rather than hard-denying ambiguous cases.
- Keep compatibility escape hatches explicit and logged.

### Risk: Engine extraction becomes a large refactor

Mitigation:

- Extract only one seam at a time.
- No behavior changes in extraction commits.
- Request code review after each extraction task.

### Risk: PathPolicy causes too many prompts

Mitigation:

- Start with sensitive paths and outside-workspace writes.
- Keep normal in-workspace edits smooth.
- Add telemetry/logging for policy decisions during development.

### Risk: Tests are brittle due to global state

Mitigation:

- Add test reset helpers where necessary.
- Use isolated temp directories.
- Avoid relying on real user home or global settings.

## 8. Definition of Done

This iteration is complete when:

1. Protocol config no longer leaks secrets.
2. Plugin uninstall cannot remove paths outside plugin cache.
3. Git helpers no longer interpolate user inputs into shell commands.
4. Session IDs are validated before filesystem use.
5. Logger/diagnostics apply generic secret redaction.
6. File tools use an initial shared path policy.
7. Hooks/plugin hooks have output caps and runtime result validation.
8. MCP output is marked as untrusted external content.
9. LSP parser handles byte-length content correctly.
10. At least the priority security tests pass under `bun test`.
11. `Engine.run()` has at least one low-risk responsibility extracted with behavior preserved.

## 9. Verification Plan

Run targeted tests first:

```bash
bun test packages/core/src/protocol
bun test packages/core/src/plugins
bun test packages/core/src/git
bun test packages/core/src/session
bun test packages/core/src/logging
bun test packages/core/src/tool-system
bun test packages/core/src/hooks
bun test packages/core/src/lsp
```

Then run broader checks:

```bash
bun test
bun run lint
```

Notes:

- `bun run typecheck` has known pre-existing repo errors and should not be treated as a clean gate unless those are separately addressed.
- Build uses `sync-models`, so `bun run build` may fetch model metadata from OpenRouter.

## 10. Suggested Commit Structure

Use conventional commits:

1. `fix(protocol): redact secrets from config query`
2. `fix(plugins): constrain uninstall paths to plugin cache`
3. `fix(git): avoid shell interpolation in git helpers`
4. `fix(session): validate session ids before path use`
5. `fix(logging): redact secrets in structured logs`
6. `feat(tool-system): add file path policy`
7. `fix(hooks): validate hook results and cap output`
8. `fix(mcp): mark external MCP output as untrusted`
9. `fix(lsp): parse content length by bytes`
10. `refactor(engine): extract session coordination`
11. `test(core): cover run context and transcript recovery`

## 11. Open Questions

1. Should `PathPolicy` default to ask or deny for sensitive reads?
2. Should project hooks require workspace trust before any execution?
3. Should LSP server startup be governed by the same permission system as Bash?
4. Should MCP stdio server startup require a separate approval from MCP tool invocation?
5. Should `Engine` continue emitting UI-shaped events, or should a protocol adapter own those mappings?
6. Should cron remain experimental/in-memory, or become a persisted run-scheduler built on `RunManager`?

## 12. Recommended Next Step

Start with Task 1 through Task 5 as a security-hardening batch. They are small, high-impact, and testable. After those land, introduce `PathPolicy` as the first cross-cutting behavior change, then proceed to extension trust hardening and Engine extraction.
