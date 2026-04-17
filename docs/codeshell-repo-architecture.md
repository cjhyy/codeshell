# CodeShell 当前架构与定位说明

## 1. 结论

CodeShell 当前仓库的主干，已经具备同时承担下面两种角色的能力：

- 一个面向 LLM/Agent 的通用编排框架
- 一个建立在该框架之上的终端编码助手

更准确的说法不是“它本质上是一个 coding assistant，顺便做一点编排”，而是：

> CodeShell = 通用编排内核 + `terminal-coding` 官方预设

这也是当前仓库最合理、最稳定的定位。

## 2. 它为什么可以同时做通用编排框架

当前主干并没有把“编码”硬编码进核心循环。

真正的核心层负责的是：

- 多轮 Agent turn loop
- prompt 组装
- context 管理与压缩
- session 持久化
- 工具注册与执行
- 权限控制
- MCP 接入
- 子代理、任务、计划、睡眠、定时任务等长流程能力

编码能力主要通过 preset 和工具集叠加出来，而不是写死在内核里。

当前代码里已经能看到这个分层：

- `general` preset：面向 research、automation、operations、long-running work
- `terminal-coding` preset：在通用能力上叠加 `LSP`、`NotebookEdit`、`EnterWorktree`、`Brief`、`Arena`

换句话说，CodeShell 现在更像：

```text
Agent Orchestration Core
  + General preset
  + Terminal-coding preset
```

而不是：

```text
Coding Assistant
  + 一些额外编排功能
```

## 3. 需要澄清的边界

虽然它可以作为“通用编排框架”，但这里的“通用”更适合解释为：

- 面向 LLM/Agent 的任务编排
- 工具编排
- 子代理协作
- 计划驱动执行
- MCP/外部能力接入
- 长任务运行与恢复

它目前还不应被表述成：

- 传统工作流引擎
- 分布式调度平台
- 类 Temporal / Airflow / Argo 的生产级 DAG 系统

所以更准确的产品描述应该是：

> A general-purpose AI agent orchestration framework for terminal and headless workflows.

这个定位和当前代码实现是一致的。

## 4. 当前主干架构

当前最清晰、最可信的主路径是：

```text
CLI
  -> run / repl / arena / runs
    -> protocol client/server
      -> Engine
        -> preset resolution
        -> prompt + context + session + settings
        -> tool-system
        -> llm provider
        -> ui (Ink REPL) or headless renderer
```

如果按职责拆层，可以理解成下面几层：

### 4.1 入口层

- `src/cli/`
- `src/bootstrap/`

职责：

- 启动 CLI
- 解析命令
- 做运行前 setup
- 进入 REPL 或 headless run

### 4.2 编排核心层

- `src/engine/`
- `src/protocol/`
- `src/preset/`
- `src/prompt/`

职责：

- 执行 turn loop
- 解析 preset
- 组装系统提示词
- 在 UI / headless / protocol 之间维持统一执行模型

### 4.3 运行时基础设施

- `src/context/`
- `src/session/`
- `src/settings/`
- `src/llm/`
- `src/logging/`

职责：

- 会话持久化
- token/context 管理
- 多源配置加载
- LLM provider 适配

### 4.4 工具与集成层

- `src/tool-system/`
- `src/skills/`
- `src/run/`
- `src/arena/`
- `src/services/mcp/`

职责：

- 工具注册、执行、权限控制
- skills 匹配
- 长任务运行
- 多模型讨论与审查
- MCP 集成

### 4.5 终端交互层

- `src/ui/`
- `src/ink/`

职责：

- Ink REPL
- 流式输出展示
- 输入框、状态栏、权限确认等终端体验

## 5. 目录分层建议

为了避免仓库继续“主干”和“遗留大应用层”混在一起，建议用下面的视角看目录。

### 5.1 Active Core

这些目录应该被视为当前真正的产品主干：

- `src/cli`
- `src/bootstrap`
- `src/engine`
- `src/protocol`
- `src/preset`
- `src/prompt`
- `src/context`
- `src/session`
- `src/settings`
- `src/llm`
- `src/tool-system`
- `src/ui`
- `src/ink`
- `src/run`
- `src/arena`
- `src/skills`

这些目录共同定义了“通用编排内核 + 终端交互外壳”。

### 5.2 Active Extensions

这些目录可以保留，但更适合被看作扩展能力，而不是产品身份本身：

- `src/services/mcp`
- `src/server`
- `src/remote`
- `src/git`
- `src/entrypoints/sdk`

它们有价值，但不应反过来主导项目定位。

### 5.3 Transition Or Legacy

这部分目录目前更像另一个更重的应用层、旧体系或尚未收敛的代码岛：

- `src/entrypoints/cli.tsx`
- `src/commands.ts`
- 大体量的 `src/components/`
- 大体量的 `src/screens/`
- `src/state/`
- `src/tasks/`
- 大量 `src/hooks/`
- `src/tools/`
- `src/services/tools/`
- `src/bridge/`
- `src/buddy/`

这些目录不一定都是“死代码”，但它们明显不属于当前最小可解释主路径。

比较稳妥的判断是：

- 它们可能来自更完整的桌面/富交互 CLI 体系
- 它们贡献了大量类型噪音和理解成本
- 在没有重新纳入主入口之前，不应把它们当作当前架构核心

## 6. 当前仓库健康度

从当前仓库状态看，CodeShell 主干已经具备可运行性，但全仓还没有完全收敛。

### 6.1 好消息

- `build` 可以通过
- 主 CLI 路径是连通的
- 测试大多数可以通过

这说明“当前主路径”不是概念设计，而是已经可以构建和执行。

### 6.2 风险点

- `typecheck` 还没有收敛
- 旧入口、feature-gated 路径、Bun 宏相关代码仍然很多
- `tsconfig` 里还引用了部分已不存在的文件
- 仓库里存在两套工具体系和两套 UI/应用层痕迹

这意味着：

- 运行主干已经可用
- 但仓库边界还不够清晰
- 现在最大的风险不是“主干不可行”，而是“定位清楚但代码未分层清楚”

## 7. 对外定位建议

如果这个项目继续演进，建议统一使用下面的叙述方式：

### 7.1 推荐表述

CodeShell is a general-purpose AI agent orchestration framework for terminal and headless workflows. It ships with a built-in `terminal-coding` preset for coding-focused use cases.

### 7.2 中文表述

CodeShell 是一个面向终端与无头场景的通用 AI Agent 编排框架，内置 `terminal-coding` 预设，用于提供编码助手体验。

### 7.3 不建议的表述

- “一个通用工作流平台”
- “一个类 Airflow 的执行引擎”
- “主要是 coding assistant，只是也能做编排”

这些说法要么把它说重了，要么把它说窄了。

## 8. 后续重构建议

如果后面要继续收敛仓库，优先级建议如下：

1. 明确 `core / preset / legacy` 三层边界
2. 让 `tsconfig` 和当前主干目录重新对齐
3. 为当前主路径补一份最小架构图和模块依赖说明
4. 把旧的大应用层入口从主干叙事中剥离
5. 最终让 `general` preset 成为真正的一等公民，而不是只停留在 README 的定位里

## 9. 一句话总结

CodeShell 现在最合理的理解方式是：

> 它不是“顺便支持通用编排的 coding assistant”，而是“已经具备通用编排内核的 Agent 框架，只是当前默认提供了一个 terminal-coding 预设”。
