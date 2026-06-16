# 子 Agent 设计对比与改进建议

> 2026-05-27 · 对比 Codex / Claude Code / OpenCode 的子 agent 机制，针对 codeshell 现状给出可落地的改进点。
> 范围：机制对比 + 具体改进建议，不含代码实现。

---

## 1. codeshell 现状速览

源码位置：`packages/core/src/tool-system/builtin/`（`agent.ts` / `agent-registry.ts` / `arena.ts` / `agent-notifications.ts` / `agent-transcript-translator.ts`）、`engine/engine.ts`、`prompt/sections/orchestration.md`。

核心事实：

- **派发**：`Agent(description, prompt, name?, maxTurns?, run_in_background?)` 工具。支持同步（阻塞父级）和后台（`run_in_background`）两种模式。同一条 LLM 消息里多个 `Agent` 调用会并行执行。
- **定义方式**：**没有 agent 定义注册表**。每次调用都是临时（ephemeral）的——`name` / `description` / `prompt` 全部是调用时传入的字符串参数。`agent-registry.ts` 只存运行时元数据（id、status、时间戳、abort handle），不存"agent 类型定义"。
- **上下文隔离**：每个子 agent 是一个全新的 `Engine` 实例（`engine.ts:563`），独立 session、独立 transcript。**只传入 prompt 文本，不继承父级 transcript**。返回时只回传最终文本（后台 agent 的完整 transcript 单独存在 registry 里供 UI 渲染）。
- **工具权限**：派发时从父级继承 `disabledBuiltinTools` / `enabledBuiltinTools`，并强制剥离 `Agent`/`AgentStatus`/`AgentCancel`（禁止嵌套）。**无法按 agent 类型定制工具集**——所有子 agent 拿到的是同一份工具。
- **模型选择**：子 agent **强制继承父级模型/endpoint**，`Agent` 工具不暴露 model 参数。
- **产物回传**：同步 → 文本字符串直接进 transcript；后台 → 完成时入 `notificationQueue`，父级 idle 时拼成 `<background-agents-completed>` XML 注入为新的 user turn。
- **arena.ts**：独立于 `Agent`，是多模型协作分析（planner → 并行研究 → 交叉评审 → 辩论 → 共识），可以为每个 participant 指定不同模型。

**现状的几个粗糙点**（来自源码观察）：

1. 子 agent 没有"类型/角色"概念，每次都要在 prompt 里重新描述同一种 worker。
2. 工具集是二元的（全开或全关），无法做"只读研究 agent"这种细粒度限制。
3. 模型不可按角色切换（无法把廉价研究任务路由到便宜模型）。
4. 子 agent 不触发生命周期 hooks（`engine.ts:231`），可观测性弱。
5. 无并发上限、无子 agent 超时，后台 agent 在内存里无界堆积。
6. 后台 agent 结果不流式，只能等完成后整块回传。

---

## 2. 三家机制对比

| 维度 | **Claude Code** | **Codex** | **OpenCode** | **codeshell（现状）** |
|---|---|---|---|---|
| **定义方式** | `.claude/agents/*.md`，YAML frontmatter + body 作为 system prompt | `.codex/agents/*.toml`，作为 spawn session 的配置层 | 配置中声明 agent，含 `mode` 字段 | 无定义文件，调用时传字符串，临时性 |
| **角色复用** | ✅ 文件级，跨项目（user-level）复用 | ✅ 文件级，个人/项目两级 | ✅ 配置级 | ❌ 每次重写 prompt |
| **派发** | LLM 按 `description` **自动委派**，或显式调用 | **仅显式请求**才 spawn | primary agent 通过 `Task` 工具调用 subagent | 显式 `Agent` 调用 |
| **上下文隔离** | 独立 context window，返回 summary | 独立 child session，**复用父级运行时 override** | subagent 独立上下文 | 独立 Engine，只传 prompt |
| **工具权限** | per-agent `tools` / `disallowedTools` 字段 | per-agent `mcp_servers`，继承 `sandbox_mode` | per-agent 工具开关 + `permission.task`（控制能调哪些 subagent） | 全局继承，无法按角色定制 |
| **模型选择** | per-agent `model`（可路由到 Haiku 省钱） | per-agent `model` + `model_reasoning_effort` | 不指定则用调用方模型 | ❌ 强制继承父级 |
| **嵌套控制** | 单 session 内，背景/team 另有机制 | `agents.max_depth`（默认 1，禁深层嵌套） | 通过 `permission.task` glob 限制 | 硬禁止嵌套 |
| **并发控制** | — | `agents.max_threads`（默认 6） | — | ❌ 无上限 |
| **结果回传** | 返回 summary 文本 | 等全部完成后**合并**返回；批处理用 `report_agent_job_result` | 返回结果 | 同步=文本/后台=XML 通知 |
| **沙箱继承** | `permissionMode` / `isolation`（worktree/远程/进程内） | 继承父级 `sandbox_mode` + approval | permission 继承 | 继承 permission mode |

**三家的设计哲学差异（一句话）：**

- **Claude Code**：声明式 + 自动委派。把"什么时候用哪个 agent"交给 LLM 读 `description` 决定，强调用 context 隔离省主线 token，用 `model` 字段做成本路由，用 `tools` 做安全约束。最贴近"团队分工"心智模型。
- **Codex**：保守 + 显式 + 可继承。只在被明确要求时 spawn，强调配置从父级继承（sandbox、reasoning effort），用 `max_depth`/`max_threads` 做硬性安全围栏。适合受控/批量场景。
- **OpenCode**：primary/subagent 双层模型。用 `mode` 区分"用户直接对话的主 agent"和"只能被程序化调用的 subagent"，用 `permission.task` glob 精确控制调用链。

---

## 3. 给 codeshell 的改进建议

按"收益/改动成本"排序，分三档。

### P0：引入 agent 定义注册表（最大短板）

现状最核心的缺失是**没有可复用的 agent 角色定义**。这是 CC / Codex / OpenCode 三家共同的基座，codeshell 缺这一层导致下面所有 per-agent 能力都无从挂载。

建议：
- 新增 `.code-shell/agents/*.md`（或 `.toml`），frontmatter 定义一个 agent 角色。`agent-registry.ts` 从"只存运行时实例"升级为"既存定义、又存运行时实例"。
- 字段对齐三家共识：`name` / `description` / `tools`（白名单或黑名单）/ `model` / `maxTurns` / `systemPrompt`（body）。
- `Agent` 工具新增可选参数 `agentType`，传入已定义角色名时加载其配置；不传则保持现在的临时模式（向后兼容）。

这一步解锁后，P1 的三项才有落点。

### P1：补齐 per-agent 能力

1. **工具白名单**（对标 CC 的 `tools` 字段）：让"只读研究 agent"只能拿 `Read/Grep/Glob/WebSearch`，"写码 agent"才有 `Edit/Write/Bash`。现状二元继承是安全短板——一个本该只做调研的子 agent 现在能改文件。

2. **per-agent 模型路由**（对标 CC `model` / Codex `model_reasoning_effort`）：在 `Agent` 工具/agent 定义里暴露 `model`，把廉价的检索/总结任务路由到便宜模型。codeshell 已经在 arena 里证明了多模型 resolve 能力（`MODEL_PRESETS`），把同一套机制接到 `Agent` 即可，不用从零做。

3. **并发上限 + 子 agent 超时**（对标 Codex `max_threads` / `max_depth`）：给后台 agent 加进程级并发上限和单 agent 超时，避免内存里无界堆积、避免同步调用卡死时父级空烧 `maxTurns`。

### P2：体验与可观测性

4. **后台 agent 结果流式化**：现状只能等完成整块回传。可参考 `agent-transcript-translator.ts` 已有的 StreamEvent→ChatEntry 翻译，把增量结果也喂给父级/UI。

5. **子 agent 生命周期 hooks**：现状 `engine.ts:231` 对子 agent 禁用了 shell hooks，可观测性弱。至少补 start/finish/error 三个事件，便于审计和调试。

6. **（可选）自动委派**：对标 CC——让 LLM 读 agent 定义的 `description` 自行决定何时委派，而不是每次显式 `Agent` 调用。这是心智模型上的提升，但要权衡可控性，建议放最后、且默认关闭。

---

## 4. 一句话总结

codeshell 的子 agent 在**运行时机制**（独立 Engine、并行、后台通知、arena 多模型）上其实不弱，**真正的短板在"定义层"**：缺少可复用的 agent 角色注册表，导致工具白名单、模型路由这些三家都标配的 per-agent 能力无处挂载。建议优先补 P0 的定义注册表，再在其上叠加 P1 的三项 per-agent 能力——改动集中、收益最大。

---

### 参考来源
- [Create custom subagents — Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [Subagents in the SDK — Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/subagents)
- [Subagents — Codex / OpenAI Developers](https://developers.openai.com/codex/subagents)
- [Agents — OpenCode Docs](https://opencode.ai/docs/agents/)
- [Config — OpenCode Docs](https://opencode.ai/docs/config/)
