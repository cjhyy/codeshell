# 从 CodeShell 看懂 Agent Harness：一个可运行智能体系统的 6 个核心部件

这个系列用 CodeShell core 作为主案例，讲清楚一个 Agent Harness 应该如何设计。目标读者是想自己设计 agent harness 的工程师，以及希望建立完整 agent 架构心智模型的开发者。

## 系列文章

1. [什么是 Harness Agent：从 LLM Call 到 Deep Research，再到可运行系统](./01-what-is-harness-agent.md)
2. [Agent 的主循环：从用户输入到多轮工具调用](./02-agent-turn-loop.md)
3. [工具系统：Agent 能做事之前，必须先学会被约束](./03-tool-system.md)
4. [上下文、会话与记忆：Agent 的脑容量不是 prompt 长度](./04-context-session-memory.md)
5. [协议与宿主：为什么 Core 不应该绑死在一个 UI 里](./05-protocol-and-hosts.md)
6. [从 CodeShell core 抽象出 Harness Agent 设计清单](./06-harness-agent-checklist.md)

## 写作约定

- 每篇围绕一个核心问题展开。
- 不做源码逐行解析，而是用 CodeShell core 的真实模块和链路作为案例。
- 每篇配一张图，帮助读者先建立结构感。
- 读完系列后，读者应该能自己设计一个 agent harness 架构。

## CodeShell core 映射

- 主循环：`Engine` / `TurnLoop` / `ModelFacade`
- 工具执行：`ToolRegistry` / `ToolExecutor` / `PermissionClassifier` / `PathPolicy` / `Sandbox`
- 上下文与状态：`ContextManager` / `Transcript` / `SessionManager` / `Memory`
- 宿主协议：`AgentClient` / `AgentServer` / `Transport` / `StreamEvent`
- 生产化能力：`RunManager` / `Automation` / `Hooks` / `Plugins` / `Services`
