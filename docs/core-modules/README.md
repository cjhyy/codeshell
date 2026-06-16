# codeshell core — 模块文档总览

core 是无界面的引擎包(`@cjhyy/code-shell-core`),被 tui 与 desktop 两个宿主共享。整套代码约 32 个模块、~64k LOC。整体大致按层次铺开:最外层是 **protocol/transport**(进程边界的线协议与传输);往里 **engine** 驱动整个 turn loop;每一轮真正干活的是 **tool-system + llm + context**;**session/run** 负责落盘与生命周期持久化;**settings/capability-control/prompt** 负责配置与裁剪;**plugins/skills/hooks/credentials/model-catalog** 负责扩展能力;最上层是 **arena/automation/remote** 这类更高级的功能特性。

## 如何阅读 / Reading order

新人建议按这个顺序读,先把主干吃透再看扩展:

1. **engine** — 入口与 turn loop,理解一轮对话怎么跑起来
2. **tool-system** — 工具如何注册、分发、过权限
3. **llm** — 模型适配与流式
4. **session** — 状态怎么落盘与恢复
5. **settings** — 配置怎么加载与热重载

## 模块清单 / Module list

- **[engine](./engine.md)** — turn loop, session orchestration, the heart that drives a conversation
- **[tool-system](./tool-system.md)** — tool registry/dispatch, permission + path policy, builtin tools, sandbox, apply-patch, MCP
- **[llm](./llm.md)** — LLM provider adapters (anthropic/openai/...), capabilities, token counting, streaming watchdog
- **[arena](./arena.md)** — multi-agent debate/research arena: ledger, claims, challenges, phases, strategies
- **[protocol](./protocol.md)** — wire protocol: RPC server/client, transports (in-process/stdio/tcp), event streaming
- **[session](./session.md)** — session bundle, transcript, session-manager (create/fork/load/save)
- **[run](./run.md)** — RunManager, checkpoint writer, artifact tracker — headless/automation run lifecycle
- **[settings](./settings.md)** — settings schema, load + hot-reload, layered merge
- **[context](./context.md)** — context-window manager: compaction, tool-result truncation, token budget
- **[plugins](./plugins.md)** — plugin/skill installer + loader, format detection (CC vs Codex), installed_plugins.json
- **[automation](./automation.md)** — cron scheduler + store for scheduled/headless tasks
- **[hooks](./hooks.md)** — hooks pipeline: shell-runner, event dispatch, user+project+plugin hook concatenation
- **[capability-control](./capability-control.md)** — capability folding: disabled-lists, project overrides, the capability service
- **[model-catalog](./model-catalog.md)** — model catalog (built-in + user.json), instances, apiKeyRef, paramsDoc
- **[credentials](./credentials.md)** — credential storage/resolution (cookie bridge, permission token, credentialRef)
- **[prompt](./prompt.md)** — system-prompt assembly: composer + sections (markdown), personalization injection
- **[preset](./preset.md)** — tool preset/whitelist definitions
- **[skills](./skills.md)** — skill frontmatter parsing + discovery
- **[git](./git.md)** — git helpers used by tools/run
- **[logging](./logging.md)** — logger, spans, log layout (ui-ink + engine buckets)
- **[lsp](./lsp.md)** — language-server integration helpers
- **[services](./services.md)** — shared services wired into the engine
- **[runtime](./runtime.md)** — runtime config + per-turn refresh/hot-reload plumbing
- **[utils](./utils.md)** — shared utilities (lockfile, fs helpers, etc.)
- **[remote](./remote.md)** — remote/mobile control bridge
- **[review](./review.md)** — code-review helper used by /review
- **[cli](./cli.md)** — core CLI entry helpers
- **[product](./product.md)** — product/version/branding constants
- **[data](./data.md)** — bundled JSON data assets + loaders
- **[agent](./agent.md)** — agent definition parsing (agent frontmatter → runtime)
- **[external-agents](./external-agents.md)** — external agent registration glue
- **[cron](./cron.md)** — cron expression helpers

## 约定 / Conventions

这套文档以「怎么用」为导向,不是逐行源码注释。每个模块文档都用同一套小节布局:**职责 / 文件 / 公开接口 / 怎么用 / 注意**,方便横向对照查阅。

注意:core 是预编译包,tui 走 dist 导入。改动 core 源码后,必须重新构建才能让 tui 侧拿到变化:

```sh
bun run --filter '@cjhyy/code-shell-core' build
```
