# docs/todo — 后续规划 / Roadmap

> 本目录收集**尚未做 / 前瞻性**的文档:产品路线规划与待实现的设计稿。
> 已落地的现状以仓库根的 [`docs/feature-inventory.md`](../feature-inventory.md)(全量能力盘点)为权威;
> 历史/已完成的设计稿、审计、旧架构集见 [`docs/archive/`](../archive/)。

## 文档

| 文档 | 状态 | 说明 |
|------|------|------|
| [`roadmap.md`](roadmap.md) | 规划中 | 对标 Claude Code / OpenCode / OpenAI Codex 的分阶段产品路线(Phase 0–6),含优先级矩阵与执行顺序。注意:文内「当前状态」表多为早期写法,事实现状以 feature-inventory 为准 |
| [`workspace-profile-讨论稿.md`](workspace-profile-讨论稿.md) | 讨论中(P3,未实现) | WorkspaceProfile / 数字人:全局 Profile 库、本地安装/激活/切换、主指令 + 经验三层 + Team Board。设计锚点,非实现承诺 |
| [`prompt-cache-optimization.md`](prompt-cache-optimization.md) | 规划中(未动手) | Prompt 缓存优化对标 CC:现状只 systemPrompt 一个断点、命中率不可见;含 CC 真实做法(扒自 sourcemap)+ 可抄清单 + 执行顺序(先做"命中率可见")。关联记忆 `project_prompt_cache_gaps` |

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
- 一旦落地,把对应条目移出本目录:设计稿归 [`docs/archive/`](../archive/),能力登记进 [`feature-inventory.md`](../feature-inventory.md)。
