# 推理强度配置设计：泛化的「思考」描述符 + 富结构 settings

> 日期：2026-06-02
> 目标仓：`~/Documents/个人学习/代码学习/codeshell`
> 模块落点：`packages/core/src/llm/capabilities/`（已存在，扩展）、`packages/core/src/settings/schema.ts`、`packages/core/src/llm/providers/`、`packages/desktop/src/renderer/settings/ModelSection.tsx`
> 关联范式：`docs/superpowers/specs/2026-05-29-capability-control-design.md`（描述符 + 路由器，同一思路）

## 0. 一句话

底层（`capabilities/rules.ts` + 各 provider）**已经认识 6 种推理形态、已经会翻译各家的请求体字段**，但卡在两处：① settings 只能存 `"enabled"|"disabled"` 二元开关，存不下「档位 / budget」；② 运行时把 `enabled` 硬编码压成 `"medium"`（`openai.ts:264`）。本设计在**已有的翻译能力之上**加一层 **`ReasoningControl` 描述符**——core 告诉 UI「这个模型该渲染什么控件、有哪些档位」，UI 照着渲染，**不再懂任何 provider 细节**。settings 的 `thinking` 字段从枚举升级为富结构联合。**翻译层（rules + 请求体组装）基本不动，只去掉那行硬编码。**

> 决策（2026-06-02，用户确认）：
> - 范围：**先只产出本设计文档**；落地分阶段。
> - Anthropic 的 thinking 当前在 client 里**根本没实现**（配了也无效）——本次**一并修**。
> - 向后兼容：**直接改旧值**（尚未发布），不保留 `"enabled"/"disabled"` 兼容分支、不写迁移逻辑。

## 1. 现状（已对照代码核实）

### 1.1 各家「思考」能力全表

`capabilities/rules.ts` 已按 provider kind 把模型映射到 6 种 `ReasoningShape`（`capabilities/types.ts`）。**翻译差异已封装好**——同样是 gpt，OpenAI 原生发平铺 `reasoning_effort`、OpenRouter 发嵌套 `{reasoning:{effort}}`，core 已分别处理。

| Provider | 模型匹配 | reasoning 形态（kind） | 真实能配的档位 | 关闭时的值 | 请求体字段 | rules.ts |
|---|---|---|---|---|---|---|
| **OpenAI** | `gpt-5.5+` | `openai-effort`（`disabledEffort:"none"`） | `low / medium / high / xhigh`（无 minimal） | `none` | `reasoning_effort`（平铺） | 35–53 |
| **OpenAI** | `o*` / `gpt-5.0~5.4` | `openai-effort` | `minimal / low / medium / high` | `minimal` | `reasoning_effort`（平铺） | 56–73 |
| **DeepSeek** | `deepseek-v4` | `deepseek-thinking` | **开 / 关**（二元） | disabled | `{thinking:{type}}` | 76–87 |
| **DeepSeek** | `deepseek-reasoner` | `none` | 固定推理，不可调 | — | — | 88–97 |
| **Z.AI** | `glm-4.5+` | `deepseek-thinking` | **开 / 关** | disabled | `{thinking:{type}}` | 100–109 |
| **Anthropic** | `claude-4.6+` | `anthropic-adaptive` | 自适应，**无开关** | 不可关 | （client 未实现 ❌） | 115–126 |
| **Anthropic** | `claude-4.0~4.5` | `anthropic-budget`（`minBudgetTokens:1024`） | budget token 数 | 不发字段 | `{thinking:{type,budget_tokens}}`（client 未实现 ❌） | 127–138 |
| **Anthropic** | `claude-*`（兜底） | `none` | 无推理 | — | — | 139–150 |
| **Gemini** | `gemini-2.5+` | `openai-effort` | `minimal / low / medium / high` | minimal | 内部映射到 `thinkingConfig` | 152–164 |
| **OpenRouter** | 任意底层模型 | `openrouter-reasoning` | `minimal / low / medium / high` | `{effort:minimal, exclude:true}` | `{reasoning:{effort,max_tokens?,exclude?}}` | 171–193 |
| **xAI Grok** | `grok-4.3` | `openai-effort`（`disabledEffort:"low"`） | `low / medium / high`（无 minimal） | `low` | `reasoning_effort`（平铺） | 195–206 |
| **Mistral** | `magistral` | `openai-effort`（`disabledEffort:"none"`） | `high / none`（仅两档） | `none` | `reasoning_effort`（平铺） | 208–217 |
| **Groq** | `gpt-oss*` / `qwen3*` | `openai-effort` | `minimal / low / medium / high` | minimal | `reasoning_effort` + `max_completion_tokens` | 219–230 |

### 1.2 OpenAI 原生 vs OpenRouter（用户特别问的差异）

| 维度 | OpenAI 原生 | OpenRouter |
|---|---|---|
| 字段格式 | `reasoning_effort: "high"`（平铺） | `reasoning: { effort: "high" }`（嵌套对象） |
| 模型名 | `gpt-5.5` | `openai/gpt-5.5`（带前缀） |
| 输出 token 字段 | `max_completion_tokens` | `max_tokens` |
| 关思考 | 发 `disabledEffort` 值（gpt-5.5 用 `none`） | 发 `{effort:"minimal", exclude:true}` |
| gpt-5.5 的 `xhigh` 档 | 支持 | **不透传**（OR 只到 high） |

**关键结论**：同是 gpt，原生和 OR 确实是两套字段格式，但 `rules.ts` 已按 `kind`（`openai` vs `openrouter`）分流到 `openai.ts:250-265`（平铺）和 `openai.ts:267-272`（嵌套）。**翻译已经做好了，缺的只是让用户选档位这一层。**

### 1.3 三处堵点（本设计要解的）

| # | 堵点 | 位置 | 后果 |
|---|---|---|---|
| 1 | `thinking` schema 只有 `enum(["enabled","disabled"])` | `settings/schema.ts:110`（provider）、`:141`（model） | 存不下 `high`/`xhigh`/budget 数字 |
| 2 | 运行时硬编码 `enabled → "medium"` | `openai.ts:264` | 即便想发 high 也发不出去；gpt-5.5 的 xhigh 永远用不到 |
| 3 | Anthropic client 完全没实现 thinking | `providers/anthropic*.ts` | `anthropic-budget` / `anthropic-adaptive` 配了**无效**（潜在 bug） |
| 4 | ModelSection 没有任何 thinking UI 控件 | `ModelSection.tsx` | 用户在界面上根本配不了 |

## 2. 为什么用「描述符」而不是给每家加字段

这正是 `capability-control` 那套范式的复用：**core 已经知道每个模型属于哪种 reasoning 形态，就让 core 吐出「这个模型能配什么」的只读描述符，UI 照着渲染对应控件。** UI 不需要 `if (provider === "openai") ... else if (deepseek) ...`——那样每加一家就要改 UI。

> 两条不变量（对齐 capability-control 设计）：
> 1. **翻译层基本不动**：`rules.ts` 的形态识别、`openai.ts` 的请求体组装继续用；只去掉 `:264` 那行 `"medium"` 硬编码，改成读 config 真实档位。
> 2. **`ReasoningControl` 是算出来的视图，不是新真相源**。真相是 `rules.ts` 的 capability + settings 里用户存的值。每次按需投影。

## 3. 方案

```
        ┌──────────────────────────────────────────────────────┐
 读 ►   │  reasoningControlFor(kind, model) : ReasoningControl   │  ← 新增纯函数，读 rules.ts 的 capability
        │   → { kind:"toggle"|"effort"|"budget"|"adaptive"|none}│
        └───────────────┬──────────────────────────────────────┘
                        │ UI 照 control.kind 渲染开关 / 下拉 / 数字框
                        ▼
        ┌──────────────────────────────────────────────────────┐
 写 ►   │  settings.models[].reasoning : ReasoningSetting (富结构)│  ← schema 升级
        └───────────────┬──────────────────────────────────────┘
                        │ 运行时读真实档位（不再硬编码 medium）
                        ▼
        ┌──────────────────────────────────────────────────────┐
        │  openai.ts / anthropic.ts buildRequestBody             │  ← 翻译层（已存在，微调）
        │   openai-effort   → reasoning_effort: <effort>         │
        │   openrouter      → reasoning: { effort: <effort> }    │
        │   deepseek-think  → thinking: { type: on?enabled:dis } │
        │   anthropic-budget→ thinking:{type:enabled,budget} ★新 │
        └──────────────────────────────────────────────────────┘
```

### 3.1 分层落点

| 放哪 | 放什么 |
|---|---|
| `packages/core/src/settings/schema.ts` | `thinking: z.enum(...)` → `reasoning: ReasoningSettingSchema`（富结构联合）。provider 级 + model 级各一处。**直接替换旧字段**（未发布，不留兼容） |
| `packages/core/src/llm/capabilities/`（已存在） | 新增 `reasoningControlFor(kind, model): ReasoningControl` 纯函数 + 类型。读 `rules.ts` 既有 capability，映射成「UI 该渲染什么控件」 |
| `packages/core/src/llm/providers/openai.ts` | `:264` 去掉 `"medium"` 硬编码 → 读 config 的 `reasoning.effort`；`disabled`/`off` 仍走 `disabledEffort`。openrouter 分支同理 |
| `packages/core/src/llm/providers/anthropic*.ts` | **新实现** `anthropic-budget`（发 `thinking:{type:"enabled", budget_tokens:N}`）与 `anthropic-adaptive`（自动开，不发可关字段） |
| `packages/core/src/llm/model-pool.ts` | `toLLMConfig()`（`:265-268`）把 `reasoning` 富结构透传进 `LLMConfig` |
| `packages/core/src/llm/types.ts` | `CreateMessageOptions` / `LLMConfig` 的 `thinking` → `reasoning: ReasoningSetting` |
| `packages/desktop/src/renderer/settings/ModelSection.tsx` | 每个 model 加一个「思考」控件，按 `reasoningControlFor` 返回的 `kind` 渲染：toggle / 下拉 / 数字框 / 「自动」灰条 |
| preload / main settings-service | 无需改——`reasoning` 随 model patch 走现有 `settings:set` 链路即可 |

## 4. 类型

### 4.1 settings 里存什么（富结构）

```typescript
// settings/schema.ts —— 直接替换旧的 thinking: z.enum(["enabled","disabled"])
export type ReasoningSetting =
  | { mode: "off" }                                                      // 关思考
  | { mode: "effort"; effort: ReasoningEffort }                          // openai-effort / openrouter 系
  | { mode: "on" }                                                       // deepseek-thinking 开（二元的「开」）
  | { mode: "budget"; budgetTokens: number };                           // anthropic-budget
// adaptive（claude 4.6+）不存——无可配项，运行时恒为「自动」

// ReasoningEffort 沿用 capabilities/types.ts:15，gpt-5.5 的 "xhigh" 已在该枚举内
```

> 说明：`deepseek-thinking` 的「关」复用 `{mode:"off"}`、「开」用 `{mode:"on"}`，不另造二元枚举——这样 `off` 在所有形态里语义统一（UI 的「关」永远写 `{mode:"off"}`）。

### 4.2 core 告诉 UI 渲染什么（描述符）

```typescript
// capabilities/reasoning-control.ts（新）
export type ReasoningControl =
  | { kind: "none" }                                                     // 不渲染控件（claude-3.x、deepseek-reasoner…）
  | { kind: "toggle"; default: boolean }                                 // DeepSeek/Z.AI → 开关
  | { kind: "effort"; options: ReasoningEffort[]; default: ReasoningEffort } // OpenAI/Gemini/xAI/Mistral/Groq/OR → 下拉
  | { kind: "budget"; min: number; default: number }                    // Anthropic 4.0~4.5 → 数字输入
  | { kind: "adaptive" };                                                // Claude 4.6+ → 只显示「自动」灰条

export function reasoningControlFor(
  kind: ProviderKind,
  model: string,
): ReasoningControl;   // 内部调 capabilitiesFor(kind, model)，按 reasoning.kind 映射
```

**映射规则**（`reasoning.kind` → `ReasoningControl`）：

| capability `reasoning.kind` | `ReasoningControl` | options 来源 |
|---|---|---|
| `none` | `{kind:"none"}` | — |
| `deepseek-thinking` | `{kind:"toggle", default:true}` | — |
| `openai-effort` | `{kind:"effort", options, default}` | 由 `disabledEffort` 反推可用档位：gpt-5.5 去掉 `minimal`、加 `xhigh`；mistral 仅 `[high]`；默认四档。`default` = `medium`（不可用则取最近档） |
| `anthropic-budget` | `{kind:"budget", min:1024, default:4096}` | `min` = `minBudgetTokens` |
| `anthropic-adaptive` | `{kind:"adaptive"}` | — |
| `openrouter-reasoning` | `{kind:"effort", options:[minimal,low,medium,high], default:medium}` | OR 不支持 xhigh，固定四档 |

## 5. 满足用户的两个具体场景

- **切到 `ds-pro`**：`reasoningControlFor("deepseek","deepseek-v4-pro")` → `{kind:"toggle"}` → UI 显示「思考 开/关」开关。写 settings：开 = `{mode:"on"}`，关 = `{mode:"off"}`。请求体 `thinking:{type:"enabled"|"disabled"}`。
- **切到 `gpt`（原生）**：`{kind:"effort", options:[low,medium,high,xhigh]}`（gpt-5.5）→ UI 显示档位下拉。请求体平铺 `reasoning_effort:"high"`。
- **切到 OpenRouter 上的 gpt**：同样 `{kind:"effort"}`（但 options 只到 high）→ UI 无感，core 自动发嵌套 `{reasoning:{effort:"high"}}`。
- **切到 `claude-sonnet-4.6`**：`{kind:"adaptive"}` → UI 显示灰色「自动思考（不可调）」。
- **切到 `claude-opus-4.5`**：`{kind:"budget", min:1024}` → UI 显示 budget 数字输入。请求体 `thinking:{type:"enabled", budget_tokens:N}`。

## 6. 运行时改动（去硬编码）

`openai.ts:240-281` 当前：

```typescript
if (thinking) {
  // openai-effort: enabled→"medium"（硬编码）, disabled→disabledEffort
  reasoning.reasoning_effort =
    thinking === "disabled" ? (cap.reasoning.disabledEffort ?? "minimal") : "medium";
}
```

改为读富结构（示意）：

```typescript
const r = options.reasoning ?? this.config.reasoning;   // ReasoningSetting | undefined
if (r && r.mode !== "off") {
  switch (cap.reasoning.kind) {
    case "openai-effort":
      this._dropReasoningEffort ||
        (body.reasoning_effort = r.mode === "effort" ? r.effort : "medium");
      break;
    case "openrouter-reasoning":
      body.reasoning = { effort: r.mode === "effort" ? r.effort : "medium" };
      break;
    case "deepseek-thinking":
      body.thinking = { type: "enabled" };   // off 已被外层短路
      break;
  }
} else if (r?.mode === "off") {
  // 各形态的「关」：openai-effort 发 disabledEffort；deepseek 发 type:"disabled"；openrouter 发 exclude:true
}
```

`anthropic*.ts` 新增 `anthropic-budget` / `anthropic-adaptive` 分支（当前完全缺失）——这是把场景 ④⑤ 真正接通。`_dropReasoningEffort` 那个 sticky-flag 自愈逻辑（gpt-5.5 + tools 撞 400 自动降级，`openai.ts:752-760`）保持不动。

## 7. 落地阶段（建议，本次仅文档）

1. **P0 · schema + 描述符 + 去硬编码**（core，TDD）：`ReasoningSetting` 替换旧枚举；`reasoningControlFor` + 映射表 + 单测（每个 provider kind 一例）；`openai.ts` 去 medium 硬编码。
2. **P1 · Anthropic 补实现**：`anthropic-budget` / `anthropic-adaptive` 请求体 + 单测（修当前 bug）。
3. **P2 · ModelSection UI**：按 `control.kind` 渲染四种控件，读写 `models[].reasoning`。
4. **P3（可选）**：把 OpenRouter 的 `max_tokens`/`enabled` 透传补全（注释说支持但代码只用了 effort/exclude）。

## 8. 风险与回归

- **直接改旧值**：现有 `~/.code-shell/settings.json` 里若有 `thinking:"enabled"/"disabled"` 字段，升级后 schema 不再认——需在改 schema 的同一 PR 里手动改掉那条配置（未发布，无外部用户）。当前 `openai-gpt-5.5` 条目**没配 thinking**，零影响。
- **gpt-5.5 + tools 自愈**：`openai-reasoning-effort-drop.test.ts` 必须继续绿；改请求体组装时保留 `_dropReasoningEffort` 短路。
- **Echo 契约**：`when-tools` 回传约定（`openai.ts:513-610`）不在本设计范围，别动。
```
