# auto-ds Composite Model — 设计文档

**作者**: maki
**日期**: 2026-05-14
**状态**: 设计草案
**目标实现工期**: 2-3 个工作日

---

## 1. 背景与动机

### 1.1 当前问题

codeshell 现在的模型选择是**全程固定一个 model**。在使用 DeepSeek 时：

- 选 `deepseek-reasoner`（即将更名为 `deepseek-v4-pro`）→ 简单任务（读文件、grep、回答事实）也走深度推理模型，**慢且贵**
- 选 `deepseek-chat`（即将更名为 `deepseek-v4-flash`）→ 复杂任务（多文件重构、调试、规划）能力不够

用户希望"简单任务用 flash，复杂任务用 pro"，但**当前架构不支持运行时切换模型**。

### 1.2 业界参考

调研了几种方案：

- **DeepSeek-TUI**（[Hmbown/DeepSeek-TUI](https://github.com/Hmbown/DeepSeek-TUI)）：启发式 + LLM 兜底的两层路由，每 turn 独立判断
- **Aider `--architect`**：架构师 model 出 plan，编辑员 model 执行 diff
- **Continue.dev Model Roles**：按用途配模型（chat / edit / autocomplete）
- **OpenRouter `auto`**：服务端用专门小模型分类
- **Claude Code 主/子 agent**：主 agent 跑业务，子 agent 用便宜模型并行干活

### 1.3 设计选择

参考 DeepSeek-TUI 的轮级路由 + Continue 的 role 配置，**但用 guardrail 替换关键词路由**——这是本方案的核心创新。

---

## 2. 核心设计

### 2.1 一句话总结

**`auto-ds` 是一个虚拟 model，对用户表现为一个普通 model 条目，对内是 `{fast: deepseek-v4-flash, pro: deepseek-v4-pro}` 的组合。flash 通过工具准入限制（看不到 Edit/Write）保证"想写文件就升级"的硬性 guardrail，避免误判。**

### 2.2 三个核心机制

#### 机制 A：启发式预选 tier（turn 开头）

```
启发式判断（无 LLM 介入）：
- 含强关键词（重构/refactor/重写/debug/调试/审计/security/architecture）→ pro
- 长度 > 500 字符 → pro
- 其余 → flash（默认）
```

不要 DeepSeek-TUI 的 Ambiguous / Decisive 两档置信度——**只用启发式，错了由机制 B 兜底**。

#### 机制 B：tool-level guardrail（硬约束）

flash tier 的 tool registry **物理上不暴露**写操作工具：

```ts
flash 可见工具: Read, Grep, Glob, Bash(只读), Task, AskUserQuestion, WebFetch, WebSearch, request_write_access
flash 不可见工具: Edit, Write, ApplyPatch, NotebookEdit
```

flash 想写文件时**根本看不到 Edit 工具的存在**，自然会调用 `request_write_access`。

#### 机制 C：turn 级 escalation（guardrail 触发）

```
turn 进行中，flash 调用 request_write_access(reason)
  → 主控 abort flash 当前流
  → 收集 flash 已完成的 tool calls + results，打包为 evidence pack
  → 重新启动当前 turn，model 切到 pro
  → pro 初始 context 包含：
      原始 user message
      [evidence pack: flash 已经读过 / grep 过的内容]
  → pro 跑完业务
  → turn 结束
```

升级**只在当前 turn 内有效**。下一个 turn 重新走机制 A，可能又回 flash。

---

## 3. 数据模型

### 3.1 Composite Model 定义

新文件 `src/llm/composite-models.ts`：

```ts
export interface CompositeTier {
  /** 真实 API model id */
  model: string;
  /** 允许使用的工具白名单。"*" 表示全部 */
  allowedTools: string[] | "*";
  /** 追加到 system prompt 末尾的片段 */
  systemPromptSuffix: string;
  /** 是否启用 thinking 模式（对 v4 模型有效）*/
  thinking?: boolean;
}

export interface CompositeModelDef {
  /** 用户在 settings 里看到的 key */
  key: string;
  label: string;
  /** 共享的 provider 配置 */
  providerKey: string;
  baseUrl: string;
  /** tier 定义 */
  tiers: {
    fast: CompositeTier;
    pro: CompositeTier;
  };
  /** 默认启发式路由函数（可被自定义覆盖）*/
  route: (ctx: RouteContext) => "fast" | "pro";
}

export interface RouteContext {
  userPrompt: string;
  /** 当前 turn 是否由 escalation 进入（true → 必须 pro）*/
  isEscalated: boolean;
}
```

### 3.2 内置 `auto-ds` 预设

```ts
export const AUTO_DS: CompositeModelDef = {
  key: "auto-ds",
  label: "DeepSeek Auto",
  providerKey: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  tiers: {
    fast: {
      model: "deepseek-v4-flash",
      allowedTools: [
        "Read", "Grep", "Glob", "Bash",
        "Task", "AskUserQuestion",
        "WebFetch", "WebSearch",
        "request_write_access",
      ],
      thinking: false,
      systemPromptSuffix: `
---
You are running as the FAST tier of auto-ds (deepseek-v4-flash).
You can read files, run searches, execute read-only shell commands.
You CANNOT modify files. If the task requires Edit/Write/Patch:
  → Call \`request_write_access\` with a brief reason.
  → The system will escalate to the PRO tier with all your findings.
Priorities:
  - Stay in FAST for read-only investigation (faster, cheaper).
  - Only escalate when actually writing.
`.trim(),
    },
    pro: {
      model: "deepseek-v4-pro",
      allowedTools: "*",
      thinking: true,
      systemPromptSuffix: `
---
You are running as the PRO tier of auto-ds (deepseek-v4-pro).
You have full tool access including Edit/Write/Patch.
If invoked via escalation, an evidence pack from the FAST tier follows the
original user message — use it instead of re-reading files.
`.trim(),
    },
  },
  route: (ctx) => {
    if (ctx.isEscalated) return "pro";
    const PRO_KEYWORDS = [
      // 中文
      "重构", "重写", "调试", "审计", "架构", "设计模式",
      // 英文
      "refactor", "rewrite", "debug", "audit", "architecture", "security",
    ];
    if (PRO_KEYWORDS.some((k) => ctx.userPrompt.toLowerCase().includes(k.toLowerCase()))) {
      return "pro";
    }
    if (ctx.userPrompt.length > 500) return "pro";
    return "fast";
  },
};
```

### 3.3 用户自定义入口

`~/.code-shell/composite-models.json`（可选）：

```json
{
  "auto-claude": {
    "label": "Claude Auto",
    "providerKey": "anthropic",
    "baseUrl": "https://api.anthropic.com/v1",
    "tiers": {
      "fast": {
        "model": "claude-haiku-4-5",
        "allowedTools": ["Read", "Grep", "Glob", "Bash", "Task", "request_write_access"]
      },
      "pro": {
        "model": "claude-sonnet-4-6",
        "allowedTools": "*"
      }
    }
  }
}
```

启动时合并到内置列表。`route` 函数走默认（关键词 + 长度），用户不可自定义路由逻辑（V1 限制，避免 ts 反序列化 funcs）。

---

## 4. 运行时架构

### 4.1 关键组件

```
┌──────────────────────────────────────────────────────────────┐
│                    Engine.run() (turn loop)                  │
│  - 检测 settings.activeKey 是否为 composite key              │
│  - 是 composite → 走 CompositeOrchestrator                   │
│  - 否 → 走原有单 model 路径                                  │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│              CompositeOrchestrator (new)                     │
│  - turn 开头调用 route() 选 tier                             │
│  - 按 tier 构造 LLMClient + 过滤 tool list + 拼 prompt       │
│  - 监听 request_write_access tool call                       │
│  - 触发时打包 evidence pack 重新调度 turn 为 pro tier        │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│         真实 LLMClient (existing, unchanged)                 │
│  - openai-compat / anthropic-style                           │
│  - 拿到的 model 是真实的 deepseek-v4-flash / -pro            │
└──────────────────────────────────────────────────────────────┘
```

**关键设计**：CompositeOrchestrator 是 turn 级别的包装器，不是 LLMClient 子类。它**控制 turn 流程**而不是**包装单次 API 调用**——这样 escalation（abort + 重发）才能干净实现。

### 4.2 escalation 流程

```
[turn N start]
  ├─ orchestrator.routeForTurn(userMessage) → "fast"
  ├─ 构造 flashClient (model=deepseek-v4-flash)
  ├─ 注入 fast tier 的 systemPromptSuffix
  ├─ 过滤 toolDefs（隐藏 Edit/Write，显示 request_write_access）
  ├─ engine.runTurnWith(flashClient, filteredTools)
  │     ├─ flash: tool_call(Read, "baz.ts")
  │     ├─ flash: tool_call(Grep, "useBaz")
  │     ├─ flash: tool_call(request_write_access, reason="…")
  │     └─ orchestrator 拦截到 request_write_access：
  │         ├─ abort 当前 stream
  │         ├─ 收集 [flash 的 tool calls + results]
  │         └─ throw EscalateSignal(evidencePack)
  ├─ 捕获 EscalateSignal
  ├─ orchestrator.routeForTurn(userMessage, isEscalated=true) → "pro"
  ├─ 构造 proClient (model=deepseek-v4-pro)
  ├─ 注入 pro tier 的 systemPromptSuffix
  ├─ engine.runTurnWith(proClient, allTools, prependedContext=evidencePack)
  │     └─ pro 跑完业务（Edit/Write 都能用）
  └─ [turn N end]
```

### 4.3 evidence pack 格式

```
<auto-ds escalation evidence>
Previous tier: deepseek-v4-flash
Reason for escalation: <flash 调用 request_write_access 时给的 reason>

Tool calls completed in the fast tier:

## Read("src/baz.ts")
<完整文件内容>

## Grep("useBaz", path="src/")
src/foo.ts:12: import { useBaz } from './baz';
src/bar.ts:8:  const baz = useBaz();
...

## Bash("ls src/")
foo.ts  bar.ts  baz.ts

</auto-ds escalation evidence>
```

作为一条 user message 追加在原 user message 之后传给 pro。pro 看到自然知道这些文件/搜索结果已经做过，直接基于这些信息写。

---

## 5. 影响面（按文件分类）

### 5.1 必须改（核心）

| 文件 | 修改内容 |
|---|---|
| `src/llm/composite-models.ts` | **新增**：内置预设 + 用户自定义合并 |
| `src/llm/composite-orchestrator.ts` | **新增**：turn 级编排 + escalation |
| `src/engine/engine.ts` | turn 入口分流：composite key → orchestrator；否则原路径 |
| `src/tool-system/registry.ts` | 加 `getToolDefinitionsFiltered(allowedTools)` |
| `src/tool-system/builtin/request-write-access.ts` | **新增**：内置 escalation 触发工具 |
| `src/prompt/composer.ts` | 支持 `systemPromptSuffix` 注入 |
| `src/cli/cost-tracker.ts` | 记录真实底层 model（flash / pro）而非 composite key |

### 5.2 需要适配（外围）

| 文件 | 修改内容 |
|---|---|
| `src/settings/schema.ts` | `models[]` 加 `isComposite?: boolean` 标记 |
| `src/cli/migrate-models.ts` | onboarding 时自动注入 `auto-ds` 预设条目（如果选了 DeepSeek） |
| `src/ui/components/StatusLine.tsx` | 显示当前 tier：`[auto-ds: flash]` / `[auto-ds: pro]` / `[auto-ds → pro escalated]` |
| `src/ui/components/ModelSelector.tsx` | composite 条目标记 "auto-routing" 图标 |
| `src/llm/client-factory.ts` | 检测 composite key → 不要直接 createLLMClient，改走 orchestrator |

### 5.3 不影响

- `src/arena/` — arena 多模型机制独立，不冲突
- `src/llm/model-fetcher.ts` — 仅缓存 API model list
- `src/session/` — transcript 记录不依赖 model 字段（但建议**加一个 `tier-switched` event** 方便追溯）

### 5.4 测试

新增：

- `tests/composite-routing.test.ts` — 路由启发式 + escalation 流程
- `tests/composite-cost-split.test.ts` — flash/pro 分别记账
- `tests/composite-prompt-injection.test.ts` — system prompt suffix 注入正确

---

## 6. 关键设计权衡

### 6.1 为什么不是"每轮先 fast 后 pro"

会让每个 turn 跑两次模型，开销翻倍。本方案是**每 turn 只跑一个 tier**，由启发式 + guardrail 决定哪个 tier，仅边界情况发生 escalation。

### 6.2 为什么不用 DeepSeek-TUI 的 LLM 路由器

DeepSeek-TUI 在 Ambiguous 灰区调用 flash 做 30 token 分类。这套有效但增加 ~500ms 延迟。本方案因为有 `request_write_access` guardrail，启发式错判会自动被 escalation 兜底——**无需 LLM 路由器**。

### 6.3 为什么不让 flash 自评能力（说 `<<NEED_PRO>>`）

模型默认不会主动认怂——会硬上、给似是而非的答案。**用工具准入做 guardrail 比 prompt 约束可靠数量级**。

### 6.4 为什么 escalation 不降级

升 pro 后这个 turn 全程 pro。下个 turn 重新走启发式，可能回 flash。**不在同一 turn 内切回**——避免 cache 双向失效 + 行为不稳定。

### 6.5 为什么用户配置不允许自定义 `route` 函数（V1）

V1 用户自定义只支持声明 tier 配置（model / allowedTools / suffix），不允许自定义 route 逻辑。理由：

- TypeScript 函数不好从 JSON 反序列化
- 默认启发式 + guardrail 已经覆盖 90% 场景
- V2 可加 `routeRules` 字段（声明式规则数组）

### 6.6 evidence pack 用文本还是结构化数据

文本。理由：

- LLM 处理文本最自然
- 简化序列化
- 调试时人工可读

代价是 token 略多，但相比 pro 重新读文件的开销，evidence pack 还是省的。

---

## 7. 实施计划

### Phase 1：核心机制（1.5 天）

**目标**：`auto-ds` 能基本工作，启发式路由 + guardrail 升级。

1. `composite-models.ts` 数据结构 + 内置预设
2. `composite-orchestrator.ts` turn 编排 + escalation
3. `request_write_access` 工具
4. `tool-system/registry.ts` 按 tier 过滤工具
5. `engine.ts` 接入 orchestrator
6. 命令行能跑通：`code-shell` 选 auto-ds → 简单问题走 flash → 改文件请求自动升 pro

### Phase 2：可观察性 + 成本（0.5 天）

1. `cost-tracker` 拆分记账
2. StatusLine 显示当前 tier
3. transcript 加 `tier-switched` event

### Phase 3：用户自定义（0.5 天，可选）

1. 读 `~/.code-shell/composite-models.json` 合并到内置
2. ModelSelector 列出 composite 条目
3. onboarding 选 DeepSeek 时自动加入 auto-ds 条目

### Phase 4：测试 + 打磨（0.5 天）

1. 三组单测
2. 真机跑几个典型 case：
   - 纯查询（应该全程 flash）
   - 重构（应该直接 pro）
   - 短问 + 后续要改（应该 flash → escalate → pro）
3. README 加一段 auto-ds 介绍

---

## 8. 风险与待定问题

### 8.1 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| flash 不知道自己处于受限模式 | 即使有 system prompt 提示也可能困惑 | system prompt 写得足够清晰；few-shot 例子 |
| escalation 后 evidence pack 太长 | 占 pro context | flash 跑前几个 tool 就 escalate；evidence pack 截断长输出 |
| flash 滥用 `request_write_access` | 简单问题也升级 | system prompt 强调"只在真要写时调用"；监控 escalation 比例 |
| DeepSeek v4 接口细节未确认 | thinking 参数怎么传？ | 实现前实际发请求探活 |

### 8.2 待定问题

1. **session 切回普通 model 时的状态**：用户中途从 auto-ds 切到 deepseek-v4-pro，正在 escalate 的状态怎么处理？建议：abort 当前 turn，下一 turn 用新 model
2. **多个 user message 排队的并发**：composite orchestrator 一次只处理一个 turn，不需要锁
3. **headless 模式（`run` / `arena`）支持吗**：V1 先只支持 REPL；headless 模式默认禁用 composite（设置层警告）

---

## 9. 不在本期范围

明确**不做**的事，避免范围蔓延：

- ❌ pro → flash 同 turn 降级
- ❌ session 级 tier 锁定（"连续 3 次都是 pro 就锁住"）
- ❌ LLM 路由器（DeepSeek-TUI 风格 30 token 分类）
- ❌ 工具粒度路由（按 tool call 切 model）
- ❌ Aider 风格双模型流水线（pro 出 plan + flash 执行）
- ❌ verify_with_flash 工具（pro 完成后让 flash 复核）

这些可以放 V2 讨论。

---

## 10. 验收标准

实施完成后，下面这些 case 应该都跑通：

| 输入 | 期望行为 | 期望 model |
|---|---|---|
| `看一下 src/foo.ts` | 直接读出来 | flash 全程 |
| `grep 一下 useFoo` | 直接 grep | flash 全程 |
| `重构 src/foo.ts 成 hook` | 关键词命中，直接 pro | pro 全程 |
| `把 foo.ts 改成 hook` | flash 启动 → Read → 想 Edit → 升级 → pro 完成 | flash → pro escalated |
| `回答 React 18 有什么新特性` | 短问，无关键词 | flash 全程 |
| `这段长 prompt 描述了 200 行需求...` | 长度 > 500，直接 pro | pro 全程 |

UI 状态栏要正确显示当前 tier，cost tracker 按真实 model 分别记账。

---

**End of Design Doc**
