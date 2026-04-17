# Code Shell Roadmap

> 最后更新：2026-04-16

## 当前状态

Code Shell 是一个通用 agent 编排框架，核心模块包括：

- **Engine** — 对话循环 + LLM 交互（支持多 provider）
- **Tool System** — 工具注册、执行、权限管理，内置 20+ 工具（Read/Write/Edit/Glob/Grep/Bash/Arena/LSP/REPL 等）
- **Preset System** — agent 预设系统（当前内置 `terminal-coding`）
- **Arena** — 多模型协作分析（review/discussion/planning 三种模式）
- **UI** — 基于 Ink (React for CLI) 的终端 UI

---

## Phase 1: 稳定与完善（短期，1-2 个月）

| 方向 | 具体项 |
| --- | --- |
| **Bug 修复** | 修复 Arena render 路径中 `section.items` 崩溃问题；清理 git status 中的未跟踪文件（`providers/`、`lenses/`、`tools/` 等半成品） |
| **Arena 加固** | 完成 evidence-driven architecture 重构（已有设计文档 `docs/arena-evidence-driven-architecture.md`）；稳定 `digest-builder`、`ledger`、`claim-registry`、`planner` 等新模块 |
| **测试覆盖** | 为 engine、tool-system、arena 核心路径补充单元测试；目标覆盖率 > 60% |
| **文档** | 完善 README、架构文档、tool 开发指南 |

## Phase 2: 扩展能力（中期，3-5 个月）

| 方向 | 具体项 |
| --- | --- |
| **Preset 生态** | 新增 `devops`、`data-analysis`、`writing` 等预设；支持用户自定义 preset（从配置文件加载） |
| **MCP 深度集成** | 完善 MCP server 连接管理；支持动态发现和热加载 MCP 工具 |
| **多模型路由** | 支持按任务类型自动选择最优模型；实现 cost/latency/quality 的智能权衡 |
| **持久化与记忆** | 会话历史持久化；跨会话的项目上下文记忆；向量化代码库索引 |
| **Sub-agent 增强** | 支持命名 agent 间的消息传递和协作（已有 `SendMessage` 基础）；支持 agent 工作流编排 |
| **Worktree 工作流** | 完善 git worktree 隔离开发流程；支持自动 PR 创建和 diff review |

## Phase 3: 平台化（长期，6-12 个月）

| 方向 | 具体项 |
| --- | --- |
| **Plugin 系统** | 设计插件 API，支持第三方开发工具、preset、UI 组件 |
| **Remote Agent** | 完善 `RemoteTrigger` 能力；支持分布式 agent 执行和结果聚合 |
| **Web UI** | 在 Ink CLI 基础上提供可选的 Web 界面（共享 engine 层） |
| **团队协作** | 共享配置、共享 preset、团队级 MCP server 管理 |
| **可观测性** | Agent 执行 trace、token 用量统计、性能监控 dashboard |
| **安全加固** | 沙箱化工具执行；细粒度权限策略；审计日志 |

---

## 技术债务（持续）

- 清理 `restored-src/` 中的遗留代码，完成功能迁移后移除
- 统一错误处理模式（当前 arena 中有多处 undefined 安全问题）
- 优化 context window 管理，减少 token 浪费
