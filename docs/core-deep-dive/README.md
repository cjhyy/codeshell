# CodeShell Core 深度解析

这是一组面向程序员的中文系列文章，用来深入浅出地解释 `packages/core` 的设计：它不是一个写死的 coding agent，而是一个通用 Agent 编排内核；coding 行为主要通过 preset、工具白名单、权限规则和提示词配置叠加出来。

## 推荐阅读：v2 长文版

v2 是推荐入口：篇数更少、内容更深，每篇围绕一个完整的架构切面展开，并配有 `gpt-image-2.0` 生成的技术插图。

1. [Core as Agent Harness：为什么 CodeShell Core 是通用 Agent 编排内核](v2-01-core-as-agent-harness.md)
2. [Engine 与 TurnLoop 深潜：一次任务如何变成状态机](v2-02-engine-turn-loop-deep-dive.md)
3. [Tool System 与安全边界深潜：模型能力为什么必须过统一管线](v2-03-tool-system-security-deep-dive.md)
4. [Model、Prompt、Context、Memory 深潜：从模型调用到长期上下文系统](v2-04-model-context-memory-deep-dive.md)
5. [Protocol、Hosts 与 Long-running Orchestration 深潜：多宿主复用与长任务边界](v2-05-protocol-hosts-orchestration-deep-dive.md)

## 拆分阅读：v1 模块短文版

v1 保留为模块化参考：每篇更短，适合按源码目录快速查阅。

1. [Core 全景：一个通用 Agent 编排内核如何分层](01-core-overview.md)
2. [Engine 与 Turn Loop：一次任务如何变成多轮模型-工具循环](02-engine-turn-loop.md)
3. [Tool System：模型能力为什么必须经过统一安全管线](03-tool-system.md)
4. [LLM 与模型层：如何把模型连接变成可控的 provider client](04-llm-model-layer.md)
5. [Protocol 与 Sessions：为什么 UI 不直接绑死 Engine](05-protocol-and-sessions.md)
6. [Presets、Prompt、Hooks、Skills：行为如何由配置组合出来](06-presets-prompt-hooks-skills.md)
7. [Run、Automation、Goal：长任务如何被调度和恢复](07-run-automation-goal.md)
8. [Plugins、Capabilities、Credentials、Memory：运行时扩展与记忆](08-plugins-capabilities-credentials-memory.md)
9. [Arena 与 Integrations：多模型协作和外部 Agent 编排](09-arena-and-integrations.md)
10. [TUI Host：终端 UI 如何嵌入 Core](10-tui-host.md)
11. [Desktop / Mobile Host：桌面、手机和浏览器控制如何接入 Core](11-desktop-mobile-host.md)
12. [模块地图与回顾：从源码目录反推架构边界](12-module-map-and-recap.md)

## 配图素材

配图位于 [assets/](assets/)，均为可直接被 Markdown 引用的 SVG。素材说明见 [assets/README.md](assets/README.md)。

核心图：

- [core-big-picture.svg](assets/core-big-picture.svg)
- [engine-turn-loop.svg](assets/engine-turn-loop.svg)
- [tool-executor-pipeline.svg](assets/tool-executor-pipeline.svg)
- [protocol-sessions.svg](assets/protocol-sessions.svg)
- [llm-model-layer.svg](assets/llm-model-layer.svg)
- [context-compaction.svg](assets/context-compaction.svg)
- [prompt-presets-hooks-skills.svg](assets/prompt-presets-hooks-skills.svg)
- [run-automation-goal.svg](assets/run-automation-goal.svg)
- [plugins-capabilities-memory.svg](assets/plugins-capabilities-memory.svg)
- [arena-integrations.svg](assets/arena-integrations.svg)
- [desktop-tui-hosts.svg](assets/desktop-tui-hosts.svg)
- [module-map.svg](assets/module-map.svg)

## 准确性边界

这组文章刻意避免几个容易误导的绝对化说法：

- 不说“所有 `Engine.run` 都必须经过 protocol seam”；主要交互路径会走 protocol，但 SDK、子 Agent、部分 host utility 可以直接嵌入 Engine。
- 不说“所有后台任务都跨进程重启可恢复”；RunManager / cron definitions / goal 状态有持久化边界，普通后台 shell、in-flight 子进程和模型流不能泛化成 restart-durable。
- 不说“desktop main 绝不运行 Engine”；更准确的说法是桌面聊天主路径由 main 管理 worker 执行，renderer 保持 thin client，而 main 也有少量服务性路径会接触 core 能力。
- 不把 CodeShell Core 写成 coding agent；它是通用编排内核，coding 是 preset 和工具配置叠加出的行为。

## 写作规划

`00-writing-plan.md` 是生成这组文章前的规划文件，保留用于后续维护和扩写。