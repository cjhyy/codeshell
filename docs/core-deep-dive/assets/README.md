# Core Deep Dive Assets

本目录存放 `docs/core-deep-dive` 系列文章可直接引用的 SVG 配图。所有图保持浅色背景、深色文字、蓝/紫/绿/橙分层，并保留英文代码标识。

## Files

| File | Size | Use |
| --- | ---: | --- |
| `core-big-picture.svg` | 1400x900 | Core 全局分层 |
| `engine-turn-loop.svg` | 1400x900 | Engine.run 与 TurnLoop |
| `context-compaction.svg` | 1400x900 | context compaction 四层策略 |
| `tool-executor-pipeline.svg` | 1600x760 | ToolExecutor 安全执行管线 |
| `llm-model-layer.svg` | 1600x860 | 模型 tag 到 provider request |
| `protocol-sessions.svg` | 1400x850 | Protocol 与 Session |
| `prompt-presets-hooks-skills.svg` | 1400x900 | preset、prompt、hooks、skills |
| `run-automation-goal.svg` | 1600x900 | RunManager、cron 与 persistent goal |
| `plugins-capabilities-memory.svg` | 1500x900 | plugins、capability-control、credentials、memory/Dream |
| `arena-integrations.svg` | 1600x900 | Arena、IterativeArena 与外部 CLI 集成 |
| `desktop-tui-hosts.svg` | 1600x900 | TUI、desktop、SDK、phone remote hosts |
| `module-map.svg` | 1600x1100 | `packages/core/src` 模块地图 |

## Markdown

```md
![CodeShell Core 全局分层](assets/core-big-picture.svg)
![Context Compaction 分层策略](assets/context-compaction.svg)
![LLM 与模型层解析链路](assets/llm-model-layer.svg)
```

## Accuracy Notes

- Protocol 是常见 host seam，但不要写成所有 `Engine.run` 都必须经过 protocol。
- Run / cron / persistent goal 可讲跨进程重启恢复；不要推广为所有后台任务都 restart-durable。
- Desktop main 在当前桌面路径主要是 broker 并持有部分服务；Engine 运行在 main spawn 的 per-session worker 中，不要写成 desktop 没有 Engine。
- Credentials 图只表达 scope gate 与文件权限保护，不表达 cookie 已加密。
