# Code Shell Roadmap

> 基于 Arena 多模型协作分析（claude / gpt / gemini），结合代码审计修正。
> 仅聚焦框架层自有代码，不涉及上游 fork 参考代码。

---

## 项目现状

Code Shell 是一个通用 agent 编排框架，从 Claude Code CLI fork 后抽象而来。

**架构双层结构：**
- **框架层**（自有代码，~21k LOC，127 文件）：engine / arena / tool-system / preset / llm / run / session / prompt / context / hooks / skills / settings / product / logging
- **参考层**（上游 fork，~700+ 文件）：tools / hooks / components / bridge / ui / cli / buddy — 用于 feature parity 参考，不参与编译

**框架层模块成熟度：**

| 模块 | LOC | 状态 | 测试 |
|------|-----|------|------|
| engine | 1,500 | 生产可用 | 无 |
| arena | 4,900 | 高级/进化中 | 无 |
| tool-system | 4,500 | 生产可用 | 3 个测试文件 |
| run | 2,500 | 生产可用，最成熟 | 3 个测试文件 |
| skill | 4,300 | 生产可用 | 1 个测试文件 |
| llm | 830 | 生产可用 | 无 |
| session | 660 | 生产可用 | 2 个测试文件 |
| context | 850 | 生产可用 | 1 个测试文件 |
| prompt | 540 | 生产可用 | 无 |
| preset | 200 | 稳定但单薄 | 无 |
| settings | 260 | 生产可用 | 无 |
| product | 330 | WIP | 无 |
| hooks | 110 | 最小可用 | 无 |
| logging | 74 | 最小可用 | 无 |

**核心问题：21k LOC 框架只有 ~1,500 LOC 测试，覆盖率 < 10%。**

---

## Roadmap

### Phase 1：Arena Evidence-Driven 闭环（1-2 周）

> 当前 Arena 已完成 Phase 1-3（Planner + Provider + Dossier + Claim），但 cross-review 和 consensus 还没消费 claim 数据。这是当前最大的半成品。

**目标：** 让 Arena 的"取证 → 质证 → 辩论 → 裁决"闭环真正接通。

**交付物：**
- cross-review 升级为 verification-review：reviewer 拿到 claim + evidence packet + 可用工具，而非只看 report 摘要
- contested claims 进入 debate rounds，`maxDiscussionRounds` 真正生效
- adjudication 阶段：moderator 基于 evidence 做有限裁决
- consensus 基于 adjudicated claims 输出，区分 accepted / unresolved
- Arena 主链路集成测试（mock LLM，覆盖完整 pipeline）

**验收标准：**
- disputed claim 至少经过 1 轮复核
- `RequestedCheck` 能被调度执行
- 最终结果能区分已验证结论与未解决问题

---

### Phase 2：测试安全网 + API 冻结（2-3 周）

> 框架有 21k LOC 但只有 1.5k 测试。在继续加功能之前需要建立安全网。

**目标：** 核心模块测试覆盖 > 50%，Arena API 冻结。

**交付物：**
- engine/turn-loop 单元测试（mock LLM，覆盖状态机核心路径）
- arena 集成测试（4 个 golden scenarios：代码 review / PRD review / 混合讨论 / 纯讨论）
- context/compaction 补充 Tier 2 summarization 测试
- tool-system/executor 补充 timeout + abort 测试
- CI 流水线（GitHub Actions：编译检查 + 测试 + 覆盖率报告）
- Arena 公共 API 审查：精简 index.ts 导出，标记 @experimental

**验收标准：**
- engine + arena + tool-system 覆盖率 > 50%
- CI 每次 PR 自动运行
- Arena 导出的类型数合理收窄

---

### Phase 3：P0 安全与体验（2-3 周，可与 Phase 2 并行）

> TODO.md 的 P0 项：沙箱、记忆、权限持久化。

**目标：** 补齐框架安全底线和核心体验缺口。

**3a. 沙箱执行：**
- `SandboxPolicy` 类型定义
- macOS sandbox-exec 集成 PoC
- 在 `tool-system/builtin/bash.ts` 中接入沙箱
- 沙箱不可用时降级策略（强制用户确认）

**3b. 跨会话记忆：**
- 对话结束时自动提取关键记忆
- 持久化到 `~/.codeshell/memories.json`
- 新会话启动时注入相关记忆到 prompt
- 记忆合并去重

**3c. 权限持久化：**
- 权限规则持久化到 settings.json
- 路径级别权限规则
- 会话级权限缓存

**验收标准：**
- Bash 工具调用经过沙箱隔离层
- 跨 3 次会话能正确注入历史记忆
- 同一会话内相同操作不重复询问

---

### Phase 4：效率提升（3-4 周）

> TODO.md 的 P1 项。

**目标：** 减少 token 消耗，提升交互效率。

**交付物：**
- `ApplyPatch` 批量编辑工具（unified diff 格式，多文件原子修改）
- AGENTS.md 层级指令系统（层级覆盖 + .local 文件）
- 智能上下文管理增强：文件缓存去重 + 请求压缩 + 动态 token 预算

**验收标准：**
- 5 文件以上批量修改 token 消耗减少 50%+
- 嵌套目录的 AGENTS.md 正确覆盖

---

### Phase 5：框架扩展性（4-6 周）

> TODO.md 的 P2-P3 项，聚焦让框架真正"通用"。

**交付物：**
- Preset 继承/组合机制（`extends` 字段）+ 启动时验证
- LLM Provider 增强：openai-compatible 通用 provider + ModelPool 自动降级链
- 多代理增强：深度限制 / 超时控制 / 并发限制 / 角色预定义
- Guardian 子代理自动审批 PoC（轻量模型，仅效率优化非安全屏障）
- Feature Flags 系统

**验收标准：**
- terminal-coding preset 通过 extends 消除工具列表重复
- 至少 3 个 OpenAI 兼容服务通过集成测试
- ModelPool 降级有对应测试

---

### Phase 6：生产级发布（6-8 周）

**交付物：**
- Undo 系统（文件操作前自动备份，/undo 命令）
- Shell Snapshot（命令输出结构化捕获）
- 全局配置系统（YAML + 项目级覆盖）
- 测试覆盖率 > 60%
- 完整开发者文档（架构指南 / Preset 教程 / Provider 开发指南）
- npm 包发布

---

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Arena 闭环复杂度高 | claim 状态机 + 多轮辩论容易死循环或 token 爆炸 | 严格 execution limits，只对 contested claims 启动辩论 |
| 沙箱跨平台差异大 | macOS/Linux API 完全不同 | 先做 macOS PoC，抽象 SandboxPolicy 接口 |
| 测试债务积累 | 21k LOC 无测试，任何重构都是盲飞 | Phase 2 优先补核心路径测试 |
| Preset 扩展性不足 | 当前只有 1 个文件 200 行 | Phase 5 引入继承/组合/验证 |
| LLM Provider 只有 2 个 | 限制了框架的"通用"定位 | Phase 5 正式化 openai-compatible |

---

## 优势

- **RunManager 是最成熟的模块**：完整生命周期状态机 + 事件溯源 + crash recovery + 文件锁 + 心跳，测试充分
- **Tool System 架构清晰**：registry / executor / permission 三层分离，28+ builtin 工具，MCP 支持
- **Arena 设计方向正确**：Evidence-Driven 架构已走在前面（Planner → Provider → Dossier → Claim → Ledger），只需补完后半段
- **Preset 抽象干净**：domain-agnostic 内核 + preset 注入领域行为，扩展路径明确

---

## 待决问题

1. **Arena API 表面积**：当前导出了 60+ 类型，是否需要收窄为"稳定层"和"experimental 层"？
2. **上游 fork 代码的长期处置**：保留为参考？还是逐步替换后删除？
3. **产品北极星**：优先做"通用 agent 编排 SDK"还是"终端编码助手产品"？两条路线的 API 稳定性策略和文档投入完全不同。
