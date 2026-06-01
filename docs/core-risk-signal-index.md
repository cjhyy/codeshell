# Core 风险信号逐文件索引

- 扫描文件数：290
- 有风险关键词命中的文件数：208

| 文件 | 风险关键词计数 |
|---|---|
| `agent/agent-definition-registry.ts` | `join(`×1 |
| `agent/agent-definition.ts` | `exec`×1, `throw new Error`×4 |
| `arena/arena.ts` | `exec`×2, `throw new Error`×1 |
| `arena/context/context-tools.ts` | `catch {`×3, `join(`×4, `exec`×19, `timeout`×1 |
| `arena/digest-builder.ts` | `join(`×2 |
| `arena/iterate/convergence.ts` | `timeout`×1 |
| `arena/iterate/formats/index.ts` | `join(`×5 |
| `arena/iterate/iterative-arena.ts` | `throw new Error`×3 |
| `arena/iterate/parse.ts` | `catch {`×3, `exec`×1 |
| `arena/iterate/phases/argue.ts` | `exec`×2 |
| `arena/iterate/phases/tournament.ts` | `throw new Error`×1 |
| `arena/iterate/tools/web-tools.ts` | `exec`×1 |
| `arena/lenses/index.ts` | `join(`×2 |
| `arena/phases/adjudication.ts` | `join(`×3 |
| `arena/phases/debate-rounds.ts` | `join(`×2 |
| `arena/phases/participant-research.ts` | `join(`×1, `exec`×2 |
| `arena/phases/planning-detail-expansion.ts` | `exec`×2 |
| `arena/planner.ts` | `as any`×2, `catch {`×1, `exec`×2 |
| `arena/providers/docs.ts` | `catch {`×2, `join(`×1 |
| `arena/providers/git.ts` | `catch {`×1, `join(`×4, `exec`×4, `timeout`×1 |
| `arena/providers/index.ts` | `join(`×2, `timeout`×6 |
| `arena/providers/repo.ts` | `catch {`×5, `join(`×4, `exec`×5, `timeout`×3 |
| `arena/render/session.ts` | `join(`×11 |
| `arena/render/terminal.ts` | `join(`×16 |
| `arena/strategies/discussion.ts` | `join(`×2 |
| `arena/strategies/lens-wrapper.ts` | `join(`×20 |
| `arena/strategies/planning.ts` | `join(`×9 |
| `arena/strategies/review.ts` | `join(`×4 |
| `arena/strategies/utils.ts` | `catch {`×6, `join(`×18, `throw new Error`×2 |
| `arena/types.ts` | `exec`×2, `timeout`×1 |
| `automation/cron-expr.ts` | `throw new Error`×4 |
| `automation/index.ts` | `exec`×1, `throw new Error`×1 |
| `automation/runner.ts` | `exec`×7, `acceptEdits`×1, `permissionMode`×3 |
| `automation/scheduler.ts` | `catch {`×4, `exec`×19, `throw new Error`×1 |
| `automation/store.ts` | `writeFileSync`×2, `renameSync`×2, `join(`×1 |
| `automation/write-policy.ts` | `join(`×1, `exec`×1, `acceptEdits`×1, `permissionMode`×5 |
| `automation/write-run.ts` | `catch {`×1 |
| `capability-control/service.ts` | `throw new Error`×2 |
| `cli/agent-server-stdio.ts` | `spawn`×2, `exec`×1, `permissionMode`×2, `TODO`×2, `timeout`×1 |
| `cli/agent-server-tcp.ts` | `permissionMode`×3 |
| `cli/graceful-shutdown.ts` | `catch {`×1 |
| `context/compaction.ts` | `join(`×4 |
| `context/tool-result-storage.ts` | `catch {`×2, `writeFileSync`×2, `join(`×2 |
| `cost-tracker.ts` | `join(`×1 |
| `data/openrouter-sync.ts` | `timeout`×3 |
| `engine/engine.ts` | `catch {`×8, `writeFileSync`×3, `renameSync`×2, `join(`×7, `spawn`×10, `exec`×9, `bypassPermissions`×4, `acceptEdits`×8, `permissionMode`×24, `TODO`×1, `fire-and-forget`×1, `timeout`×4 |
| `engine/image-compression.ts` | `catch {`×2 |
| `engine/image-policy.ts` | `join(`×1 |
| `engine/parse-task.ts` | `exec`×2 |
| `engine/patch-orphaned-tools.ts` | `exec`×3 |
| `engine/session-title.ts` | `catch {`×1 |
| `engine/streaming-tool-queue.ts` | `exec`×16, `throw new Error`×1 |
| `engine/tool-summary.ts` | `join(`×1, `exec`×2, `fire-and-forget`×1 |
| `engine/turn-loop.ts` | `catch {`×2, `join(`×2, `spawn`×1, `exec`×7 |
| `exceptions.ts` | `exec`×1, `timeout`×3 |
| `git/utils.ts` | `catch {`×3, `exec`×8, `timeout`×10, `throw new Error`×2 |
| `git/worktree.ts` | `catch {`×5, `join(`×2, `exec`×9, `timeout`×8, `throw new Error`×3 |
| `hooks/events.ts` | `spawn`×1, `exec`×6 |
| `hooks/goal-stop-hook.ts` | `catch {`×1 |
| `hooks/hook-output.ts` | `spawn`×2 |
| `hooks/inject.ts` | `join(`×1 |
| `hooks/registry.ts` | `exec`×2 |
| `hooks/shell-runner.ts` | `catch {`×4, `spawn`×4, `exec`×2, `timeout`×8 |
| `index.ts` | `spawn`×1, `exec`×3 |
| `llm/capabilities/types.ts` | `stream_options`×1, `include_usage`×1 |
| `llm/client-base.ts` | `timeout`×4, `AbortController`×1 |
| `llm/client-factory.ts` | `join(`×1 |
| `llm/model-cache.ts` | `catch {`×1, `writeFileSync`×2, `join(`×3 |
| `llm/model-fetcher.ts` | `join(`×1, `timeout`×3 |
| `llm/model-pool.ts` | `join(`×1, `timeout`×1, `throw new Error`×1 |
| `llm/provider-catalog.ts` | `join(`×1, `throw new Error`×3 |
| `llm/providers/anthropic.ts` | `as any`×4, `timeout`×2 |
| `llm/providers/openai.ts` | `as any`×5, `catch {`×3, `join(`×3, `timeout`×9, `stream_options`×1, `include_usage`×1 |
| `llm/retry.ts` | `timeout`×1 |
| `llm/stream-watchdog.ts` | `timeout`×2 |
| `logging/logger.ts` | `catch {`×4, `appendFileSync`×2, `join(`×4, `spawn`×1, `exec`×1 |
| `logging/session-recorder.ts` | `catch {`×4, `appendFileSync`×3, `join(`×10, `exec`×1, `permissionMode`×3 |
| `lsp/client.ts` | `catch {`×2, `spawn`×2, `throw new Error`×2 |
| `lsp/manager.ts` | `catch {`×2, `exec`×2, `timeout`×1 |
| `onboarding.ts` | `as any`×7, `catch {`×8, `writeFileSync`×5, `renameSync`×2, `join(`×11 |
| `plugins/gitOps.ts` | `join(`×3, `spawn`×4, `timeout`×5 |
| `plugins/installedPlugins.ts` | `catch {`×1, `writeFileSync`×2, `join(`×1 |
| `plugins/installer/codex/convertAgents.ts` | `exec`×1 |
| `plugins/installer/codex/convertMcp.ts` | `join(`×1 |
| `plugins/installer/codex/convertSkills.ts` | `join(`×3 |
| `plugins/installer/detectFormat.ts` | `join(`×1 |
| `plugins/installer/install.ts` | `writeFileSync`×4, `renameSync`×2, `join(`×8 |
| `plugins/installer/installFromSource.ts` | `writeFileSync`×2, `join(`×2 |
| `plugins/installer/list.ts` | `catch {`×1, `join(`×1 |
| `plugins/installer/loadPluginAgents.ts` | `join(`×1 |
| `plugins/installer/loadPluginMcp.ts` | `catch {`×2, `join(`×2 |
| `plugins/installer/parseSource.ts` | `exec`×1 |
| `plugins/installer/paths.ts` | `join(`×3 |
| `plugins/installer/update.ts` | `join(`×2 |
| `plugins/knownMarketplaces.ts` | `catch {`×1, `writeFileSync`×2, `join(`×1 |
| `plugins/loadPluginHooks.ts` | `catch {`×1, `join(`×1, `timeout`×5 |
| `plugins/marketplaceManager.ts` | `catch {`×1, `join(`×3 |
| `plugins/parseMarketplaceInput.ts` | `catch {`×1 |
| `plugins/pluginCommandHook.ts` | `catch {`×4, `spawn`×5, `exec`×1, `timeout`×6 |
| `plugins/pluginCommandsLoader.ts` | `catch {`×1, `join(`×2 |
| `plugins/pluginInstaller.ts` | `catch {`×3, `join(`×5 |
| `plugins/varRewrite.ts` | `catch {`×5, `writeFileSync`×3, `join(`×3 |
| `preset/index.ts` | `join(`×1, `throw new Error`×1 |
| `product/define.ts` | `join(`×1, `exec`×3, `acceptEdits`×2, `permissionMode`×3 |
| `product/types.ts` | `exec`×2 |
| `prompt/composer.ts` | `catch {`×2, `join(`×3, `exec`×4, `timeout`×3 |
| `prompt/instruction-scanner.ts` | `catch {`×3, `join(`×12, `exec`×2, `timeout`×1 |
| `prompt/section-loader.ts` | `join(`×2, `throw new Error`×1 |
| `protocol/chat-session-manager.ts` | `as any`×2, `permissionMode`×1 |
| `protocol/chat-session.ts` | `AbortController`×3 |
| `protocol/client.ts` | `permissionMode`×1 |
| `protocol/factories.ts` | `permissionMode`×4 |
| `protocol/helpers.ts` | `exec`×1 |
| `protocol/server.ts` | `as any`×3, `catch {`×2, `join(`×1, `spawn`×1, `exec`×1, `bypassPermissions`×2, `acceptEdits`×2, `permissionMode`×12, `timeout`×3, `AbortController`×2, `throw new Error`×11, `No pending approval`×2 |
| `protocol/tcp-transport.ts` | `catch {`×1 |
| `protocol/transport.ts` | `catch {`×1, `spawn`×1 |
| `protocol/types.ts` | `bypassPermissions`×1, `permissionMode`×4 |
| `remote/bridge.ts` | `catch {`×1, `spawn`×10, `throw new Error`×1 |
| `run/ArtifactTracker.ts` | `exec`×1 |
| `run/CheckpointWriter.ts` | `join(`×1, `exec`×2 |
| `run/EngineRunner.ts` | `exec`×9, `acceptEdits`×1, `permissionMode`×4, `timeout`×1 |
| `run/Evaluator.ts` | `join(`×1 |
| `run/FileRunStore.ts` | `writeFileSync`×2, `appendFileSync`×2, `renameSync`×2, `join(`×20, `throw new Error`×1 |
| `run/Heartbeat.ts` | `catch {`×4, `writeFileSync`×2, `join(`×2, `exec`×1 |
| `run/RunApprovalBackend.ts` | `exec`×2, `timeout`×4 |
| `run/RunLock.ts` | `catch {`×3, `join(`×2, `exec`×2, `timeout`×1 |
| `run/RunManager.ts` | `join(`×1, `exec`×24, `timeout`×1, `AbortController`×2, `throw new Error`×5 |
| `run/RunQueue.ts` | `exec`×6 |
| `run/factory.ts` | `join(`×1, `exec`×3, `acceptEdits`×2, `permissionMode`×3 |
| `run/types.ts` | `exec`×1 |
| `runtime/safe-spawn.ts` | `catch {`×5, `spawn`×25, `exec`×2, `timeout`×13 |
| `services/analytics.ts` | `catch {`×1, `appendFileSync`×2, `join(`×3 |
| `services/auto-dream.ts` | `catch {`×1, `writeFileSync`×2, `join(`×6 |
| `services/browser-open.ts` | `exec`×2 |
| `services/diagnostics.ts` | `catch {`×1, `appendFileSync`×2, `join(`×3 |
| `services/dream-consolidation.ts` | `exec`×3 |
| `services/extract-memories.ts` | `as any`×4, `catch {`×1, `join(`×2 |
| `services/memory-orchestrator.ts` | `exec`×1 |
| `services/notifier.ts` | `catch {`×1, `join(`×1, `exec`×5, `timeout`×3 |
| `services/oauth.ts` | `join(`×1, `exec`×3, `timeout`×3, `throw new Error`×2 |
| `services/session-memory.ts` | `catch {`×2, `writeFileSync`×2, `join(`×5 |
| `session/file-history.ts` | `catch {`×4, `writeFileSync`×2, `join(`×4 |
| `session/memory.ts` | `catch {`×6, `writeFileSync`×3, `renameSync`×3, `join(`×18 |
| `session/session-manager.ts` | `catch {`×7, `writeFileSync`×3, `renameSync`×2, `join(`×13 |
| `session/transcript.ts` | `catch {`×2, `writeFileSync`×2, `appendFileSync`×2 |
| `settings/manager.ts` | `catch {`×4, `writeFileSync`×4, `renameSync`×3, `join(`×8, `throw new Error`×1 |
| `settings/schema.ts` | `exec`×1, `bypassPermissions`×1, `acceptEdits`×1, `timeout`×1 |
| `skills/frontmatter.ts` | `catch {`×2, `join(`×1 |
| `skills/scanner.ts` | `catch {`×2, `join(`×5 |
| `state.ts` | `as any`×8 |
| `tool-system/builtin/agent-notifications.ts` | `as any`×2, `catch {`×2, `join(`×4 |
| `tool-system/builtin/agent-registry.ts` | `catch {`×3 |
| `tool-system/builtin/agent-transcript-translator.ts` | `as any`×7 |
| `tool-system/builtin/agent.ts` | `join(`×6, `spawn`×22, `exec`×1, `fire-and-forget`×1, `timeout`×12, `AbortController`×2, `throw new Error`×1 |
| `tool-system/builtin/apply-patch/applier.ts` | `catch {`×3, `join(`×2, `throw new Error`×7 |
| `tool-system/builtin/apply-patch/index.ts` | `join(`×2 |
| `tool-system/builtin/apply-patch/parser.ts` | `join(`×1 |
| `tool-system/builtin/arena.ts` | `catch {`×1, `join(`×4, `exec`×2, `throw new Error`×1 |
| `tool-system/builtin/ask-user.ts` | `exec`×2 |
| `tool-system/builtin/bash.ts` | `spawn`×7, `exec`×2, `timeout`×9 |
| `tool-system/builtin/config.ts` | `writeFileSync`×2, `join(`×2 |
| `tool-system/builtin/cron.ts` | `join(`×1, `exec`×1 |
| `tool-system/builtin/edit.ts` | `join(`×2 |
| `tool-system/builtin/file-cache.ts` | `catch {`×1 |
| `tool-system/builtin/generate-image.ts` | `join(`×2 |
| `tool-system/builtin/glob.ts` | `catch {`×1, `join(`×1 |
| `tool-system/builtin/grep.ts` | `join(`×3, `exec`×5, `timeout`×2 |
| `tool-system/builtin/index.ts` | `exec`×44, `timeout`×5 |
| `tool-system/builtin/lsp.ts` | `as any`×2, `join(`×2 |
| `tool-system/builtin/mcp-tools.ts` | `join(`×1 |
| `tool-system/builtin/memory.ts` | `join(`×2 |
| `tool-system/builtin/notebook-edit.ts` | `writeFileSync`×2, `join(`×2, `exec`×2 |
| `tool-system/builtin/plan.ts` | `join(`×1 |
| `tool-system/builtin/powershell.ts` | `join(`×1, `spawn`×4, `exec`×3, `timeout`×7 |
| `tool-system/builtin/read.ts` | `join(`×1 |
| `tool-system/builtin/remote-trigger.ts` | `writeFileSync`×2, `join(`×2, `exec`×3 |
| `tool-system/builtin/repl.ts` | `as any`×1, `join(`×2, `spawn`×5, `exec`×5, `timeout`×7 |
| `tool-system/builtin/send-message.ts` | `join(`×1, `spawn`×1 |
| `tool-system/builtin/skill-prompt.ts` | `join(`×2 |
| `tool-system/builtin/sleep.ts` | `exec`×2 |
| `tool-system/builtin/task.ts` | `spawn`×2 |
| `tool-system/builtin/tool-search.ts` | `join(`×3 |
| `tool-system/builtin/web-fetch.ts` | `catch {`×2, `join(`×1, `timeout`×4 |
| `tool-system/builtin/web-search.ts` | `catch {`×1, `join(`×1, `throw new Error`×3 |
| `tool-system/context.ts` | `spawn`×10, `exec`×2, `permissionMode`×1 |
| `tool-system/executor.ts` | `join(`×3, `exec`×13 |
| `tool-system/investigation-guard.ts` | `join(`×1 |
| `tool-system/mcp-manager.ts` | `catch {`×2, `join(`×7, `exec`×2, `TODO`×1, `timeout`×5, `throw new Error`×6 |
| `tool-system/path-policy.ts` | `catch {`×1, `acceptEdits`×4 |
| `tool-system/permission.ts` | `catch {`×2, `writeFileSync`×1, `renameSync`×1, `exec`×1, `bypassPermissions`×4, `acceptEdits`×5 |
| `tool-system/plan-mode-allowlist.ts` | `exec`×6 |
| `tool-system/registry.ts` | `join(`×1, `exec`×11, `timeout`×16, `AbortController`×2 |
| `tool-system/sandbox/bwrap.ts` | `spawn`×1 |
| `tool-system/sandbox/index.ts` | `catch {`×3, `spawn`×2, `exec`×4 |
| `tool-system/sandbox/seatbelt.ts` | `catch {`×1, `writeFileSync`×2, `join(`×4, `spawn`×1, `exec`×6 |
| `tool-system/task-guard.ts` | `join(`×1 |
| `tool-system/validation.ts` | `catch {`×1 |
| `types.ts` | `spawn`×2, `exec`×3, `bypassPermissions`×1, `acceptEdits`×1, `fire-and-forget`×1, `timeout`×8 |
| `updater.ts` | `catch {`×17, `writeFileSync`×3, `join(`×5, `spawn`×5, `exec`×5, `timeout`×2 |
| `utils/earlyInput.ts` | `catch {`×1 |
| `utils/env.ts` | `as any`×2, `catch {`×2, `join(`×8, `exec`×2, `timeout`×3 |
| `utils/envUtils.ts` | `join(`×3, `throw new Error`×1 |
| `utils/execFileNoThrow.ts` | `as any`×1, `spawn`×3, `exec`×13, `timeout`×3 |
| `utils/format.ts` | `join(`×1 |
| `utils/intl.ts` | `catch {`×1 |
| `utils/sliceAnsi.ts` | `exec`×1 |
| `utils/systemTheme.ts` | `exec`×2 |
| `utils/toolDisplay.ts` | `join(`×1 |
