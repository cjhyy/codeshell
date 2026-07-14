# CodeShell Core v2 Image Manifest

本目录存放 v2 长文配图 PNG。图片基于 `docs/core-deep-dive/REWRITE-PLAN.md` 中的 19 个 AI image prompt 生成，统一风格为 technical editorial illustration / clean futuristic systems diagram / dark navy background / cyan-purple-amber highlights。

## 生成概况

- 生成状态：已生成 19/19。
- 生成方式：内置 image generation，按用户要求使用 gpt-image-2.0 路径。
- 保存目录：`docs/core-deep-dive/assets/v2/`。
- 尺寸：横图 `1536x1024`，竖图 `1024x1536`。
- 失败项：无。

## 图片清单

| File                                             | 对应 v2 文章                                   | 用途                                                                              | Prompt 摘要                                                                                                                                                | 建议插入位置                               |
| ------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `v2-01-llm-call-to-harness.png`                  | `v2-01-core-as-agent-harness.md`               | 解释从单次 LLM call 到 agent loop，再到受控 agent harness 的演进。                | Three stages: LLM Call (prompt/model/response), Agent Loop (model/tools/result), Agent Harness (host/engine/turn loop/executor/context/transcript/policy). | “最小循环，以及它为什么还不够”小节开头。   |
| `v2-01-core-runtime-layers.png`                  | `01-core-as-agent-harness.md`                  | 把 CodeShell Core 展示为分层运行时，而不是工具集合。                              | Central CodeShell Core with Engine, Turn Loop, Tool System, Context, Session, Protocol, Hosts.                                                             | 介绍 CodeShell Core 的整体分层时。         |
| `v2-01-presets-not-hardcoding.png`               | `v2-01-core-as-agent-harness.md`               | 说明通用 core、可选 capability 与 host 在组合根形成运行时，coding 不内置在 core。 | Generic Core + Coding Capability + Host → Composed Runtime; capability contributes tools/preset/prompt/dynamic context.                                    | “机制与策略如何在仓库中分开”小节。         |
| `v2-02-engine-run-five-stages.png`               | `02-engine-turn-loop-deep-dive.md`             | 展示 `Engine.run` 的五阶段装配流程。                                              | Engine.run as assembly line: validate input, session setup, build dependencies, TurnLoop, terminate/persist.                                               | 讲 `Engine.run` 是装配器时。               |
| `v2-02-turn-loop-state-machine.png`              | `02-engine-turn-loop-deep-dive.md`             | 展示 `TurnLoop.run` 的循环状态机。                                                | Circular TurnLoop with pre-check, context manage, model stream, tool decision, tool execute, final answer, stop hook.                                      | 拆解一轮 turn loop 之前。                  |
| `v2-02-context-compaction-tiers.png`             | `02-engine-turn-loop-deep-dive.md`             | 纵向展示 context compaction Tier 0-3。                                            | Four stacked compaction tiers with rising token pressure rail.                                                                                             | 上下文压缩分层小节。                       |
| `v2-02-goal-steering-stop-hooks.png`             | `02-engine-turn-loop-deep-dive.md`             | 区分 step-gap steering、goal judge、budget backstop。                             | Agent loop with Steering Queue, Goal Judge, Budget Backstop overlays.                                                                                      | 讲 steering 与 goal stop-hook 的控制面时。 |
| `v2-03-tool-executor-choke-point.png`            | `03-tool-system-security-deep-dive.md`         | 展示 ToolExecutor 是所有工具调用的单一收口。                                      | Incoming tool calls funnel into ToolExecutor, then schema/hooks/path policy/permission/sandbox/registry gates.                                             | 工具系统主链路开头。                       |
| `v2-03-permission-path-sandbox-layers.png`       | `03-tool-system-security-deep-dive.md`         | 解释 permission、path policy、sandbox 三层边界不同职责。                          | Agent action through shields: Permission, Path Policy, Sandbox; shell/file/credential/workspace icons.                                                     | 安全边界分层小节。                         |
| `v2-03-approval-backends-hosts.png`              | `03-tool-system-security-deep-dive.md`         | 说明 `ask` 通过 ApprovalBackend 适配不同宿主。                                    | ApprovalBackend hub connected to terminal, desktop, phone, headless policy; allow/ask/deny chips.                                                          | Approval backend 与宿主解耦小节。          |
| `v2-03-mcp-untrusted-output.png`                 | `03-tool-system-security-deep-dive.md`         | 说明 MCP 工具进入同一管线，输出以 untrusted result 包装。                         | External MCP servers enter same tool pipeline; amber untrusted result wrapper before model.                                                                | MCP 集成与 prompt injection 防护小节。     |
| `v2-04-model-resolution-capabilities.png`        | `04-model-context-memory-deep-dive.md`         | 展示模型 tag 到 provider request 的解析与 capabilities 数据表。                   | Model tag through settings, catalog, ModelPool, LLMConfig, provider client, capabilities rules.                                                            | 模型适配/差异即数据小节。                  |
| `v2-04-prompt-cache-dynamic-context.png`         | `04-model-context-memory-deep-dive.md`         | 解释 prompt 缓存前缀与 dynamic context 的断点。                                   | Prompt timeline split by cache breakpoint: stable system prefix and dynamic context.                                                                       | Prompt/preset/skills 小节。                |
| `v2-04-context-transcript-memory-layers.png`     | `04-model-context-memory-deep-dive.md`         | 纵向展示 Context Window、Transcript Log、Persistent Memory 三层。                 | Three stacked layers: Context Window, Transcript Log, Persistent Memory, arrows to model.                                                                  | “Agent 的脑容量不是 prompt 长度”核心段落。 |
| `v2-04-dream-consolidation-cycle.png`            | `04-model-context-memory-deep-dive.md`         | 展示 Dream consolidation 是受限清理回路。                                         | Dream Consolidation cycle: collect, dedupe, merge, prune, improve descriptions; dream scope guardrails.                                                    | Memory/Dream 小节。                        |
| `v2-05-protocol-host-topology.png`               | `05-protocol-hosts-orchestration-deep-dive.md` | 展示多宿主通过 protocol seam 连接 shared core。                                   | Protocol Seam connects TUI, desktop renderer, phone remote, SDK, automation to shared core.                                                                | 介绍 protocol seam 总览时。                |
| `v2-05-desktop-mobile-worker-topology.png`       | `05-protocol-hosts-orchestration-deep-dive.md` | 展示桌面三进程、手机遥控与 CDP bridge。                                           | Electron main broker, per-session core worker, thin React renderer, phone remote, CDP bridge.                                                              | 桌面/手机宿主小节。                        |
| `v2-05-run-cron-goal-orchestration.png`          | `05-protocol-hosts-orchestration-deep-dive.md` | 展示 RunManager、Cron、Persistent Goal 与 durable state 边界。                    | Long-running orchestration with durable state around snapshots, transcript, heartbeat, job specs.                                                          | 长任务编排与 durable 边界小节。            |
| `v2-05-platform-extensions-arena-driveagent.png` | `05-protocol-hosts-orchestration-deep-dive.md` | 展示平台化扩展：plugins/skills、Arena、external CLI orchestration。               | CodeShell Platform Core with arcs for plugins/skills, multi-model Arena, Claude/Codex black-box workers.                                                   | 平台化能力与系列收尾段落。                 |

## Markdown 引用示例

```md
![从 LLM Call 到 Agent Harness](assets/v2/v2-01-llm-call-to-harness.png)
![Engine.run 五阶段装配流程](assets/v2/v2-02-engine-run-five-stages.png)
![ToolExecutor 单一安全收口](assets/v2/v2-03-tool-executor-choke-point.png)
```
