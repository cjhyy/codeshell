# docs/todo — 后续规划 / Roadmap

> 本目录收集**尚未做 / 前瞻性**的文档:产品路线规划与待实现的设计稿。
> 已落地的现状以 [`docs/architecture/11-feature-inventory.md`](../architecture/11-feature-inventory.md)(全量能力盘点)为权威;
> 历史/已完成的设计稿、审计、旧架构集见 [`docs/archive/`](../archive/)。

## 文档

| 文档 | 状态 | 说明 |
|------|------|------|
| [`roadmap.md`](roadmap.md) | 规划中 | 对标 Claude Code / OpenCode / OpenAI Codex 的分阶段产品路线(Phase 0–6),含优先级矩阵与执行顺序。注意:文内「当前状态」表多为早期写法,事实现状以 feature-inventory 为准 |
| [`workspace-profile-讨论稿.md`](workspace-profile-讨论稿.md) | 讨论中(P3,未实现) | WorkspaceProfile / 数字人:全局 Profile 库、本地安装/激活/切换、主指令 + 经验三层 + Team Board。设计锚点,非实现承诺 |
| [`worktree-session-isolation-research.md`](worktree-session-isolation-research.md) | 外部 agent 自动隔离已落地 | DriveAgent 已具备并行 per-run worktree、resume binding、include/baseRef/lock 与 keep/detach/discard；原生 `Agent` subagent isolation 仍为后续独立能力 |
| [`prompt-cache-optimization.md`](prompt-cache-optimization.md) | 规划中(未动手) | Prompt 缓存优化对标 CC:现状只 systemPrompt 一个断点、命中率不可见; 可抄清单 + 执行顺序(先做"命中率可见")。关联记忆 `project_prompt_cache_gaps` |
| [`architecture-debt.md`](architecture-debt.md) | **P0 已落地 main**(`c191bb51`),P1/P2 待排期 | 架构债路线图:P0=断循环依赖/抽 engine 类型/凭证加密边界(已并);P1=拆 index、arena builtin 可选、拆 engine.ts、拆 App.tsx、真启用 safeStorage;P2=arena 移包/state 单例/cron 测试/文档措辞。含每条正解与落地顺序。配套源码级现状见 `docs/architecture/` |
| [`core-harness-and-plugin-panels.md`](core-harness-and-plugin-panels.md) | 路线图/待排期 | core 通用 agent harness + 插件 UI 面板路线图:Phase A 工具元数据合一/PanelRegistry 可先做;Phase B/C 做 harness 纯度、CapabilityModule、coding pack 外移、index 分层;Phase D 做插件面板 v1 |
| [`session-cumulative-cache-usage-plan.md`](session-cumulative-cache-usage-plan.md) | 方案稿(未动手) | Session 级累计 cache usage:命中率按会话累计、落盘与 resume 回显、切模型清零;实现重点是 core 累加口径、renderer 信号回灌和 tooltip 文案 |
| [`mcp-http-auth-oauth-link-tech-design.md`](mcp-http-auth-oauth-link-tech-design.md) | 方案稿(未动手) | HTTP MCP 认证 UI 与 OAuth/link 凭证模型设计:认证方式单选、`oauth` credential 类型、OAuth login/logout/refresh、探测 authStatus 与 Codex 字段兼容 |
| [`smoke-automation-mock-provider.md`](smoke-automation-mock-provider.md) | v1 已落地并接入 CI | OpenAI 四场景 + Anthropic SSE、隔离 Electron harness、L1/L2 smoke、plugin sandbox e2e、xvfb CI 与根 `smoke` 入口均已完成；L3 发布产物仍后置 |
| [`im-gateway-remote-orchestration.md`](im-gateway-remote-orchestration.md) | 设计稿/方向锚点(未动手,非承诺) | IM Gateway(对标 openclaw):独立常驻进程,IM(Telegram/飞书)发指令→远程拉起隧道→手机配对入口回推 IM→手机操作。下游隧道/配对/房间全已存在(复用),纯新增 IM 控制入口。gateway 是**通道非大脑**,高阶编排委托给未来「assistant 主体」(§6 留衔接口,与整体产品形态 design 强绑)。MVP=Telegram+开关+复用隧道,方案 A 唤起 main |

## 仍准确未做的代表项

(摘自 roadmap,已 grep 源码核实仍未实现;非全量,详见各文档)

- **Arena 产品化** — Phase 1 核心差异化方向(抽包已决「暂不抽」,产品化待定)
- **`codeshell serve` HTTP 模式 + 多语言 SDK** — Phase 2
- **LSP 深度集成** — Phase 3.1(现为基础能力)
- **DAG / Topology 多 Agent 协作** — Phase 4.1
- **企业级能力** — Phase 5
- **WorkspaceProfile / 数字人** — 见上,P3 讨论稿
- **`List` 工具** — Glob/Grep 已覆盖,优先级低
- **VS Code / JetBrains 扩展** — 现有完整 Electron 桌面 App,IDE 扩展未做

## 约定

- 新的待办/前瞻设计稿往这里放,并在上表登记一行 + link。
- 一旦落地,把对应条目移出本目录:设计稿归 [`docs/archive/`](../archive/),能力登记进 [`11-feature-inventory.md`](../architecture/11-feature-inventory.md)。
