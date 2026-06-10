# `packages/core` 模块参考手册

> 本文是 `docs/core-deep-dive.md` 的可读版索引，按模块列出：入口、内部流程、使用方式、bug/风险。范围是 `packages/core/src/**/*.ts` 非测试源码。

## 1. 顶层入口 / root

### 文件

- `src/index.ts`
- `src/types.ts`
- `src/state.ts`
- `src/exceptions.ts`
- `src/onboarding.ts`
- `src/updater.ts`
- `src/migrate-models.ts`
- `src/colorizer.ts`

### 入口

- SDK 用户从 `src/index.ts` 导入 `Engine`、`createClient`、`createServer`、`createRunManager`、tool/LLM/session 类型。
- 核心共享类型在 `types.ts`：`Message`、`ToolCall`、`ToolResult`、`StreamEvent`、`TerminalReason`、`LLMConfig` 等。
- 全局进程态在 `state.ts`，包括 session id、cwd、model override、token/cost 计数、turn timing。

### 内部流程

```text
consumer import
  → src/index.ts barrel export
  → Engine / Protocol / Run / Tool / LLM / Settings APIs
```

`state.ts` 被 Engine、ModelFacade、CostTracker、UI 兼容层间接使用。它不是 per-session object，而是 process-wide mutable state。

### 使用方式

```ts
import { Engine, createClient, createServer, createRunManager } from "@cjhyy/code-shell-core";
```

### bug / 风险

- `VERSION` 常量与 `package.json` 版本可能不一致。
- `state.ts` 是全局状态，多 Engine、多 Run、多 session 嵌入时可能串扰。
- `resetCostState()` 不清 `_modelUsage`，total 与 per-model usage 可能不一致。

## 2. Engine 模块

### 文件

- `engine/engine.ts`
- `engine/turn-loop.ts`
- `engine/model-facade.ts`
- `engine/runtime.ts`
- `engine/image-policy.ts`
- `engine/image-compression.ts`
- `engine/parse-task.ts`
- `engine/patch-orphaned-tools.ts`
- `engine/session-title.ts`
- `engine/streaming-tool-queue.ts`
- `engine/token-budget.ts`
- `engine/reactive-threshold.ts`
- `engine/tool-summary.ts`
- `engine/turn-state.ts`
- `engine/cost-store.ts`
- `engine/query.ts`

### 入口

- `new Engine(config)`
- `engine.run(task, options)`
- `TurnLoop.run(messages)`

### 内部流程

```text
Engine.run(task)
  → parse images / input policy
  → create or resume SessionManager bundle
  → append user message to Transcript
  → emit on_session_start / user_prompt_submit
  → emit session_started
  → create LLM client
  → create PermissionClassifier
  → create ToolExecutor
  → create ContextManager
  → create PromptComposer
  → connect MCP servers
  → build system prompt / tool definitions
  → create ModelFacade
  → register FileHistory hook
  → TurnLoop.run(messages)
  → on_session_end / memory pipeline / title / saveState / on_agent_end / turn_complete
```

`TurnLoop.run()`：

```text
while turns < maxTurns
  → contextManager.manageAsync
  → modelFacade.call
  → if no tool calls: on_stop then completed or continue
  → if tool calls: StreamingToolQueue → ToolExecutor → tool_result → next turn
  → if max output truncation: inject retry/continuation reminder
return max_turns/model_error/completed
```

### 使用方式

```ts
const engine = new Engine({ cwd, llm, permissionMode: "default" });
const result = await engine.run("task", { sessionId, onStream, signal });
```

### bug / 风险

- `Engine.run()` 会包装并 mutate `options.onStream`。
- TurnLoop 注释强调不应 reject，但 Engine 后置 hook/save 在 TurnLoop 外；hook 抛错可能阻断 final save。
- maxTurns 分支 TurnLoop 和 Engine 都可能 emit `turn_complete`。
- FileHistory hook 只覆盖 `Write`/`Edit`。
- fire-and-forget memory/title/tool summary 没有统一生命周期管理。
- 默认 permissionMode 为 `acceptEdits`，SDK 嵌入需显式收紧。

## 3. Protocol 模块

### 文件

- `protocol/types.ts`
- `protocol/client.ts`
- `protocol/server.ts`
- `protocol/transport.ts`
- `protocol/tcp-transport.ts`
- `protocol/chat-session.ts`
- `protocol/chat-session-manager.ts`
- `protocol/helpers.ts`
- `protocol/factories.ts`
- `protocol/redact.ts`
- `protocol/index.ts`

### 入口

- `createInProcessTransport()`
- `new AgentClient({ transport })`
- `new AgentServer({ transport, engine/chatManager })`
- `client.run({ sessionId, task })`

### 内部流程

```text
AgentClient.run
  → JSON-RPC request agent/run
  → Transport send
  → AgentServer.handleRun
      ├─ multi-session: ChatSessionManager.getOrCreate → ChatSession.enqueueTurn → Engine.run
      └─ legacy: legacyEngine.run
  → stream events as agent/streamEvent notifications
  → response RunResult
```

### 使用方式

```ts
const [serverT, clientT] = createInProcessTransport();
const server = new AgentServer({ transport: serverT, engine });
const client = new AgentClient({ transport: clientT });
await client.run({ sessionId: "main", task: "summarize" });
```

### bug / 风险

- Stdio/TCP malformed JSON 静默跳过，client pending request 可能挂住。
- AgentClient request 无 timeout。
- TCP transport 无认证，只应 localhost。
- Server 用 `any` 访问 ChatSessionManager private `sessions`。
- multi-session approval resolver 链路需要复核。

## 4. Run 模块

### 文件

- `run/RunManager.ts`
- `run/EngineRunner.ts`
- `run/FileRunStore.ts`
- `run/RunStore.ts`
- `run/RunQueue.ts`
- `run/RunLock.ts`
- `run/Heartbeat.ts`
- `run/CheckpointWriter.ts`
- `run/ArtifactTracker.ts`
- `run/RunApprovalBackend.ts`
- `run/Evaluator.ts`
- `run/factory.ts`
- `run/types.ts`
- `run/index.ts`
- `run/redirect-target.ts`

### 入口

- `createRunManager(options)`
- `RunManager.submit(input)`
- `RunManager.resume(runId, input)`
- `RunManager.cancel(runId)`

### 内部流程

```text
submit
  → create RunSnapshot queued
  → FileRunStore.create
  → emit run_created/run_queued
  → RunQueue.enqueue
  → executeRun
      → RunLock.acquire
      → Heartbeat.start
      → transition running
      → CheckpointWriter + ArtifactTracker
      → EngineRunner.execute
          → RunApprovalBackend
          → new Engine
          → in-process AgentServer/AgentClient
          → client.run → Engine.run
      → evaluator
      → completed/failed/blocked
      → cleanup
```

### 使用方式

```ts
const manager = createRunManager({ cwd, engine: { llm, headless: true } });
const run = await manager.submit({ objective: "do work", cwd });
```

### bug / 风险

- 所有非 `completed` Engine reason 都转 failed，语义粗。
- `engineConfigOverrides` 可覆盖 automation note。
- FileRunStore public API 如果接外部 id，需校验路径安全。
- JSON tmp/JSONL append 的跨进程一致性要复核。
- transition 依赖 run object 新鲜，并发 resume/cancel/execute 有 stale 风险。

## 5. LLM 模块

### 文件

- `llm/client-factory.ts`
- `llm/client-base.ts`
- `llm/providers/openai.ts`
- `llm/providers/anthropic.ts`
- `llm/model-pool.ts`
- `llm/provider-kinds.ts`
- `llm/provider-catalog.ts`
- `llm/model-fetcher.ts`
- `llm/model-cache.ts`
- `llm/capabilities/*`
- `llm/stream-watchdog.ts`
- `llm/retry.ts`
- `llm/clamp-max-tokens.ts`
- `llm/strip-vision.ts`
- `llm/stop-reason.ts`
- `llm/token-counter.ts`
- `llm/api-key-sanitize.ts`

### 入口

- `createLLMClient(config, defaults)`
- `LLMClientBase.createMessage(options)`
- `ModelPool.toLLMConfig(entry)`
- `capabilitiesFor(providerKind, model)`

### 内部流程

```text
Engine / Arena
  → createLLMClient
  → provider registry
      ├─ AnthropicClient
      └─ OpenAIClient for openai-compatible providers
  → provider.createMessage
      ├─ build request body from capability
      ├─ stream or non-stream SDK call
      ├─ parse text/reasoning/tool_calls
      └─ record usage
```

### 使用方式

```ts
const client = await createLLMClient(llmConfig, defaults);
const resp = await client.createMessage({ systemPrompt, messages, tools, stream: true });
```

### bug / 风险

- OpenAI-compatible streaming 固定 `stream_options.include_usage`，未尊重 `Capability.streamUsage`。
- ModelPool 默认 maxTokens 8192 可能让未知模型被截断。
- providerKind 错误会导致 wrong capability rule。
- CostTracker/state 双 usage 来源可能不一致。
- capability rules 需要持续跟 vendor 文档更新。

## 6. Tool System 模块

### 文件

- `tool-system/registry.ts`
- `tool-system/executor.ts`
- `tool-system/permission.ts`
- `tool-system/mcp-manager.ts`
- `tool-system/context.ts`
- `tool-system/path-policy.ts`
- `tool-system/validation.ts`
- `tool-system/plan-mode-allowlist.ts`
- `tool-system/investigation-guard.ts`
- `tool-system/task-guard.ts`
- `tool-system/sandbox/*`
- `tool-system/builtin/*`

### 入口

- `ToolRegistry.registerTool / executeTool`
- `ToolExecutor.executeSingle`
- `PermissionClassifier.classify`
- `MCPManager.connectAll / callTool`

### 内部流程

```text
ToolCall
  → ToolExecutor.executeSingle
  → plan allowlist
  → schema validation
  → pre_tool_use
  → InvestigationGuard
  → PermissionClassifier
  → on_permission_check
  → approval if ask
  → on_tool_start
  → ToolRegistry.executeTool
  → on_tool_end/post_tool_use/file_changed
  → ToolResult
```

### 使用方式

通常由 TurnLoop 间接使用；自定义工具可注册到 ToolRegistry。

### bug / 风险

- pre/on_permission hooks 不能提权，这是安全设计。
- MCP direct `callTool()` 和 registered MCP executor 图片处理不一致。
- MCP tool name 未 sanitize。
- InvestigationGuard read-only/mutating 工具集合不完整。
- acceptEdits 默认允许写类工具，需要 SDK 嵌入方知情。

## 7. Builtin Tools 模块

### 文件分组

> 仅列核心文件;`builtin/` 下截至 2026-06-10 共约 44 个文件,完整以目录为准。`send-message.ts` 已随 SendMessage/agentCoordinator 死代码删除。

- 文件/搜索/编辑：`read.ts`、`grep.ts`、`glob.ts`、`write.ts`、`edit.ts`、`notebook-edit.ts`、`worktree.ts`、`apply-patch/`、`view-image.ts`、`file-cache.ts`
- 执行环境：`bash.ts`、`powershell.ts`、`repl.ts`、`sleep.ts`、`background-shell-tools.ts`
- Web/外部：`web-fetch.ts`、`web-search.ts`、`remote-trigger.ts`、`generate-image.ts`、`generate-video.ts`、`image-providers.ts`、`video-providers.ts`
- Agent/Arena/Task：`agent.ts`、`agent-registry.ts`、`agent-notifications.ts`、`agent-output-file.ts`、`arena.ts`、`task.ts`、`plan.ts`、`brief.ts`
- MCP/LSP/Skill/Memory/Config/Cron：`mcp-tools.ts`、`lsp.ts`、`skill.ts`、`skill-prompt.ts`、`memory.ts`、`config.ts`、`cron.ts`、`add-marketplace.ts`
- 交互/目标：`ask-user.ts`、`complete-goal.ts`、`tool-search.ts`、`update-automation-memory.ts`

### 入口

- `builtin/index.ts` 的 `BUILTIN_TOOLS`
- ToolRegistry 构造时注册

### 使用方式

模型通过 provider tool call 调用。每个工具声明 schema、description、permissionDefault、isReadOnly/isConcurrencySafe。

### bug / 风险

- `CronCreate` 是持久副作用，automation run 内不应嵌套创建 automation。
- `GenerateImage` 写文件但 guard 未必视为 mutating。
- background Agent registry process-local，进程崩溃丢状态。
- FileHistory 不覆盖所有写工具。

## 8. Context 模块

### 文件

- `context/manager.ts`
- `context/compaction.ts`
- `context/tool-result-storage.ts`
- `context/token-counter.ts`

### 入口

- `ContextManager.manageAsync(messages)`
- `applyToolResultPersistence`
- `microcompact`
- `applySummaryCompaction`

### 内部流程

```text
messages
  → persist large tool results
  → truncate oversized result
  → aggregate tool result budget
  → microcompact old compactable tool results
  → summary compaction if over threshold
  → snip/window/emergency fallback
```

### 使用方式

TurnLoop 每轮模型调用前调用 `manageAsync`。

### bug / 风险

- tool-result persistence 写失败后冻结 seen，不再重试。
- `tool_use_id` 用作文件名，需保证安全。
- summary compaction 质量取决于 aux/summarizer prompt。

## 9. Session 模块

### 文件

- `session/session-manager.ts`
- `session/transcript.ts`
- `session/file-history.ts`
- `session/memory.ts`

### 入口

- `SessionManager.create/resume/saveState/fork/list`
- `Transcript.append/toMessages/repairToolResultPairs`
- `FileHistory.saveSnapshot/restore`

### 内部流程

```text
Engine.run
  → SessionManager.create/resume
  → Transcript.appendMessage(user)
  → TurnLoop appends assistant/tool_use/tool_result
  → Transcript.toMessages on resume
  → saveState terminal reason
```

### 使用方式

通常由 Engine 内部使用；Protocol query 可读 session detail。

### bug / 风险

- Transcript flush failure 被吞。
- FileHistory restore 信任 backupPath/filePath。
- FileHistory 只覆盖 Write/Edit。
- create(explicitSessionId) 不检查已有目录。

## 10. Settings / Prompt / Hooks / Plugins / Skills

### 文件

- `settings/schema.ts`、`settings/manager.ts`、`settings/disk-defaults.ts`、`settings/feature-flags.ts`、`settings/migrate-config.ts`、`settings/personalization.ts`
- `prompt/composer.ts`、`instruction-scanner.ts`、`section-loader.ts`、`section-cache.ts`
- `hooks/events.ts`、`registry.ts`、`shell-runner.ts`、`goal-stop-hook.ts`、`hook-output.ts`、`inject.ts`
- `plugins/loadPluginHooks.ts`、`pluginCommandHook.ts`、`pluginInstaller.ts`、`marketplaceManager.ts`、`varRewrite.ts`、`gitOps.ts`、`installedPlugins.ts`、`knownMarketplaces.ts`、`parseMarketplaceInput.ts`、`pluginCommandsLoader.ts`、`schemas.ts`、`types.ts`(另含 `installer/` 子目录)
- `skills/scanner.ts`、`frontmatter.ts`

### 入口

- `SettingsManager.load/getForScope/saveUserSetting/saveProjectSetting`
- `PromptComposer.buildSystemPrompt/buildUserContextMessage`
- `HookRegistry.emit/register`
- `loadPluginHooks`
- `scanSkills`

### 内部流程

```text
SettingsManager.load
  → managed/user/project/local/flags merge
  → Engine reads disabled lists/capabilityOverrides
  → PromptComposer builds system prompt + user context
  → HookRegistry receives plugin/settings/config hooks
  → Skill listing enters prompt
  → Skill tool reads full SKILL.md on demand
```

### bug / 风险

- SettingsManager 默认 project scope，入口忘传 full 会丢 user settings。
- HookRegistry updatedPrompt last-write-wins 可能让低 priority 覆盖高 priority。
- Plugin Stop → on_session_end 可能太晚；PreCompact mapped to reserved event。
- plugin PreToolUse 不能 deny，只能输出 messages。
- skills scanner cache 不看 plugin SKILL.md mtime。

## 11. Automation 模块

### 文件

- `automation/scheduler.ts`
- `automation/store.ts`
- `automation/runner.ts`
- `automation/cron-expr.ts`
- `automation/write-policy.ts`
- `automation/write-run.ts`
- `automation/index.ts`

### 入口

- `startAutomation`
- `CronScheduler.create/list/delete/loadJobs`
- `CronStore.load/save`

### 内部流程

```text
CronCreate tool
  → CronScheduler.create
  → CronStore persists job
  → timer fires
  → runner builds CronRunRequest
  → RunManager/EngineRunner executes prompt
```

### bug / 风险

- recurring prompt 必须防止 automation 内创建 automation。
- calendar schedule 需要 timezone。
- permissionLevel 应最小化。
- cross-process reload/store 一致性要小心。

## 12. Arena 模块

### 文件

- `arena/arena.ts`
- `arena/planner.ts`
- `arena/ledger.ts`
- `arena/detect-mode.ts`
- `arena/phases/*`
- `arena/strategies/*`
- `arena/tools/*`
- `arena/providers/*`

### 入口

- `new Arena(config).run(topic)`
- builtin `Arena` tool

### 内部流程

```text
Arena.run
  → planArena
  → collectEvidence
  → selectTools
  → runParticipantResearchWithDossiers
  → register claims in ArenaLedger
  → verification review
  → planning path OR debate/adjudication path
  → buildConsensus
  → optional detail expansion
```

### bug / 风险

- 多模型多阶段，成本高。
- mode detection 是 heuristic。
- concluder 不存在会 fallback。
- claim ledger 质量决定后续结论质量。

## 13. Git / LSP / Runtime / Services / Logging / Utils

### Git

- `git/worktree.ts`、`git/utils.ts`、`git/parse-log.ts`
- 用于 worktree、日志解析、git 辅助操作。
- 风险：session file-change 设计不应依赖全局 git diff。

### LSP

- `lsp/manager.ts`、`client.ts`、`servers.ts`、`root-path.ts`
- builtin LSP tool 用于 definition/references/hover/symbols。
- 风险：server 启动、root path、语言支持不稳定时要优雅降级。

### Runtime

- `runtime/safe-spawn.ts`
- 统一外部命令执行结果：ok/timeout/aborted/spawn_failed。
- 风险：所有 shell/plugin/git 调用都应走统一 spawn 语义。

### Services

- memory/orchestrator/dream/oauth/notifier/analytics/diagnostics/browser-open。
- Engine finalization fire-and-forget memory pipeline。
- 风险：后台任务丢失、错误只记录。

### Logging

- `logging/logger.ts`
- `logging/sanitize-messages.ts`
- `logging/session-recorder.ts`
- 风险：redaction 过少泄密，过多影响调试。

### Utils

- theme/format/toolDisplay/debug/env/lockfile/memoize/semver/sliceAnsi/intl/earlyInput 等。
- 风险：跨层复用，改动影响 CLI/UI/core 多处。

## 14. 总风险清单压缩版

1. VERSION 与 package.json 不一致。
2. Engine finalization hook 可阻断 saveState。
3. maxTurns 可能重复 turn_complete。
4. multi-session approval resolver 链路需复核。
5. FileRunStore id path safety。
6. OpenAI streamUsage capability 未完全生效。
7. Plugin Stop/PreCompact 映射语义问题。
8. Plugin PreToolUse 不能 deny。
9. Engine.run mutate options。
10. RunManager reason 分类粗。
11. EngineRunner overrides 可覆盖 automation note。
12. Stdio/TCP malformed JSON 静默跳过。
13. AgentClient request 无 timeout。
14. Transcript flush failure 被吞。
15. FileHistory 覆盖工具不全。
16. MCP tool name 未 sanitize。
17. MCP direct image handling 不一致。
18. HookRegistry priority/last-write-wins 反直觉。
19. SettingsManager 默认 project scope。
20. state.ts 全局状态多 session 串扰。
