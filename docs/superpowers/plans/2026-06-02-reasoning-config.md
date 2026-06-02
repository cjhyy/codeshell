# 泛化推理强度(reasoning/thinking)配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 `thinking` 从二元 `"enabled"|"disabled"` 升级为富结构 `ReasoningSetting`(off / effort档位 / 二元on / budget数字),core 出 `reasoningControlFor(kind,model)` 描述符让 UI 按模型渲染对应控件,去掉运行时 `"medium"` 硬编码读真实档位,并补上 Anthropic 完全缺失的 thinking 实现。

**Architecture:** 复用 capability-control 范式 —— `rules.ts` 已识别 6 种 ReasoningShape 并已分别翻译各家请求体(OpenAI 平铺 / OpenRouter 嵌套 / DeepSeek thinking),本计划在其上加 ① settings 富结构 `ReasoningSetting`、② `reasoningControlFor` 描述符(core→UI 的「该渲染什么控件」)、③ 运行时读真实档位、④ Anthropic client 补实现。翻译层基本不动。

**Tech Stack:** TypeScript (bun)、Zod(schema)、React(ModelSection)、bun test。`@cjhyy/code-shell-core` + `@cjhyy/code-shell-desktop`。

**关键决策(写于 plan,执行时遵守):**
- **xhigh 加进 `ReasoningEffort`**:`rules.ts:30-31` 注释明确 gpt-5.5 支持 `xhigh`,但 `capabilities/types.ts:15` 的 `ReasoningEffort` 不含它 —— P0 Task 1 补上,否则 effort 下拉给不出 gpt-5.5 的最高档。
- **直接改旧值,不留迁移**:未发布。`thinking: z.enum(["enabled","disabled"])` 直接替换成 `reasoning: ReasoningSettingSchema`。现有 `~/.code-shell/settings.json` 若有 `thinking` 字段需手动改(当前活跃的 gpt-5.5 条目没配,零影响)。
- **`thinking` → `reasoning` 改名**:内部统一用 `reasoning: ReasoningSetting`。这会穿透 schema / llm/types / model-pool / openai.ts / protocol。旧 `options.thinking` 全删。

**已核实落点(行号以实际为准):**
- `settings/schema.ts:118`(provider)、`:149`(model)—— `thinking: z.enum(["enabled","disabled"]).optional()`。
- `llm/types.ts:31` —— `CreateMessageOptions.thinking?: "enabled"|"disabled"`;LLMConfig 也有 thinking(`openai.ts:165` 读 `this.config.thinking`)。
- `model-pool.ts:71`(entry.thinking)、`:265-268`(toLLMConfig 透传)。
- `openai.ts:165`(取 thinking)、`:210`(参数类型)、`:244-281`(buildRequestBody switch,含 `:260-265` medium 硬编码、`:269-272` openrouter 分支)。
- `capabilities/types.ts:15`(ReasoningEffort)、`:25-42`(ReasoningShape 6 kind)。
- `capabilities/rules.ts:45`(gpt-5.5 `disabledEffort:"none"`)、`:69`(gpt-5..5.4 无 disabledEffort)、其余各家见 spec §1.1。
- `anthropic.ts` —— **零 reasoning/thinking 处理**(grep 空)。
- `ModelSection.tsx` —— 无 thinking UI。

**约束:** 每 Phase 独立 build+test 绿。保留 `openai-reasoning-effort-drop.test.ts`(gpt-5.5+tools 自愈)。忽略 2 个预存 typecheck error(`write-policy.test.ts` CronPermissionLevel、`openai-reasoning-effort-drop.test.ts` OpenAI.APIError)。改 core 必 rebuild。subagent 别动 git(commit 由主控做)。

---

## File Structure

| 文件 | 责任 | Phase |
|---|---|---|
| `packages/core/src/llm/reasoning-setting.ts` | **新**:`ReasoningSetting` 类型 + `ReasoningSettingSchema`(Zod)+ `normalizeReasoning()`(兼容空值)+ 默认值常量 | P0 |
| `packages/core/src/llm/reasoning-setting.test.ts` | 上面的单测 | P0 |
| `packages/core/src/llm/capabilities/types.ts:15` | `ReasoningEffort` 加 `"xhigh"` | P0 |
| `packages/core/src/llm/capabilities/reasoning-control.ts` | **新**:`ReasoningControl` 类型 + `reasoningControlFor(kind,model)` 纯函数 | P0 |
| `packages/core/src/llm/capabilities/reasoning-control.test.ts` | 描述符单测(每个 ReasoningShape 一例) | P0 |
| `packages/core/src/settings/schema.ts:118,149` | `thinking: z.enum(...)` → `reasoning: ReasoningSettingSchema.optional()` | P0 |
| `packages/core/src/llm/types.ts:31` | `CreateMessageOptions.thinking` → `reasoning?: ReasoningSetting`;LLMConfig 同 | P0 |
| `packages/core/src/llm/model-pool.ts:71,265` | entry.reasoning + toLLMConfig 透传 reasoning | P0 |
| `packages/core/src/llm/providers/openai.ts:165,210,244` | 读 `options.reasoning ?? config.reasoning`;buildRequestBody 按 ReasoningSetting 真实档位发,去掉 medium 硬编码 | P0 |
| `packages/core/src/llm/providers/anthropic.ts` | 实现 `anthropic-budget`(`{thinking:{type:"enabled",budget_tokens}}`)+ `anthropic-adaptive`(自动,不发 disable) | P1 |
| `packages/core/src/llm/providers/anthropic.test.ts`(若有则改,无则建) | anthropic reasoning 单测 | P1 |
| `packages/desktop/src/renderer/settings/ModelSection.tsx` | 每个 model 加「思考」控件,按 `reasoningControlFor` 渲染 | P2 |
| `packages/core/src/llm/providers/openai.ts`(openrouter 分支) | OpenRouter 透传 `max_tokens`/`enabled` | P3 |

---

# Phase P0 — core 富结构 + 描述符 + 去硬编码

## Task 1: `ReasoningEffort` 加 xhigh

**Files:** Modify `packages/core/src/llm/capabilities/types.ts:15`

- [ ] **Step 1:** 把 `export type ReasoningEffort = "minimal" | "low" | "medium" | "high";` 改为:

```typescript
/**
 * OpenAI-style reasoning effort levels — shared by several vendors.
 * `xhigh` is gpt-5.5+ only (which also drops `minimal`); see rules.ts.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
```

- [ ] **Step 2:** `cd packages/core && bunx tsc --noEmit 2>&1 | grep -vE "write-policy.test|reasoning-effort-drop.test"` → 应无输出(加宽 union 不破现有窄用法)。
- [ ] **Step 3: Commit**(主控)

---

## Task 2: `ReasoningSetting` 类型 + Zod schema + normalize

**Files:**
- Create: `packages/core/src/llm/reasoning-setting.ts`、`reasoning-setting.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/src/llm/reasoning-setting.test.ts
import { describe, test, expect } from "bun:test";
import {
  ReasoningSettingSchema,
  normalizeReasoning,
  type ReasoningSetting,
} from "./reasoning-setting.js";

describe("ReasoningSettingSchema", () => {
  test("accepts each mode", () => {
    const cases: ReasoningSetting[] = [
      { mode: "off" },
      { mode: "on" },
      { mode: "effort", effort: "high" },
      { mode: "budget", budgetTokens: 4096 },
    ];
    for (const c of cases) expect(ReasoningSettingSchema.parse(c)).toEqual(c);
  });
  test("rejects unknown mode", () => {
    expect(() => ReasoningSettingSchema.parse({ mode: "nope" })).toThrow();
  });
  test("rejects effort without a valid level", () => {
    expect(() => ReasoningSettingSchema.parse({ mode: "effort", effort: "ultra" })).toThrow();
  });
  test("accepts xhigh effort", () => {
    expect(ReasoningSettingSchema.parse({ mode: "effort", effort: "xhigh" })).toEqual({
      mode: "effort",
      effort: "xhigh",
    });
  });
});

describe("normalizeReasoning (back-compat for legacy enabled/disabled)", () => {
  test("undefined → undefined", () => {
    expect(normalizeReasoning(undefined)).toBeUndefined();
  });
  test('legacy "enabled" → {mode:"on"}', () => {
    expect(normalizeReasoning("enabled" as any)).toEqual({ mode: "on" });
  });
  test('legacy "disabled" → {mode:"off"}', () => {
    expect(normalizeReasoning("disabled" as any)).toEqual({ mode: "off" });
  });
  test("a ReasoningSetting object passes through", () => {
    expect(normalizeReasoning({ mode: "effort", effort: "low" })).toEqual({
      mode: "effort",
      effort: "low",
    });
  });
});
```

- [ ] **Step 2:** `cd packages/core && bun test src/llm/reasoning-setting.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```typescript
// packages/core/src/llm/reasoning-setting.ts
/**
 * ReasoningSetting — the rich, normalized reasoning/thinking config that
 * replaces the old binary `thinking: "enabled"|"disabled"`.
 *
 *  - off    : no thinking (openai-effort → disabledEffort; deepseek → type:disabled; openrouter → exclude)
 *  - on     : binary "thinking on" for deepseek-thinking / zai (no effort levels)
 *  - effort : openai-effort / openrouter — pick a level
 *  - budget : anthropic-budget — explicit thinking token budget
 *
 * `normalizeReasoning` accepts the legacy "enabled"/"disabled" strings so any
 * lingering caller/config still works (mapped to on/off).
 */
import { z } from "zod";
import type { ReasoningEffort } from "./capabilities/types.js";

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const ReasoningSettingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("on") }),
  z.object({ mode: z.literal("effort"), effort: z.enum(REASONING_EFFORTS) }),
  z.object({ mode: z.literal("budget"), budgetTokens: z.number().int().positive() }),
]);

export type ReasoningSetting = z.infer<typeof ReasoningSettingSchema>;

/** Coerce legacy "enabled"/"disabled" or an object into a ReasoningSetting. */
export function normalizeReasoning(
  raw: ReasoningSetting | "enabled" | "disabled" | undefined,
): ReasoningSetting | undefined {
  if (raw == null) return undefined;
  if (raw === "enabled") return { mode: "on" };
  if (raw === "disabled") return { mode: "off" };
  return raw;
}

/** Effort to send when a model wants "thinking on" but the user picked no level. */
export const DEFAULT_EFFORT: ReasoningEffort = "medium";
```

- [ ] **Step 4:** `cd packages/core && bun test src/llm/reasoning-setting.test.ts` → PASS。
- [ ] **Step 5: Commit**(主控)

---

## Task 3: `reasoningControlFor` 描述符

**Files:**
- Create: `packages/core/src/llm/capabilities/reasoning-control.ts`、`reasoning-control.test.ts`

> **依赖** Task 1/2。**先 Step 0**:读 `capabilities/index.ts`(或导出 `capabilitiesFor` 的文件)确认 `capabilitiesFor(kind, model): Capability` 的真实签名/导出名;读 `rules.ts` 的各家 `disabledEffort` 以写准 effort options。

- [ ] **Step 0: 调研**

Run: `grep -rn "export function capabilitiesFor\|export.*capabilitiesFor" packages/core/src/llm/capabilities/`
确认 `capabilitiesFor` 的签名(参数顺序 kind/model)与导出位置。记下返回的 `Capability.reasoning`(ReasoningShape)。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/src/llm/capabilities/reasoning-control.test.ts
import { describe, test, expect } from "bun:test";
import { reasoningControlFor } from "./reasoning-control.js";

describe("reasoningControlFor", () => {
  test("gpt-5.5 (openai-effort, disabledEffort none) → effort control without minimal, with xhigh", () => {
    const c = reasoningControlFor("openai", "gpt-5.5");
    expect(c.kind).toBe("effort");
    if (c.kind === "effort") {
      expect(c.options).not.toContain("minimal");
      expect(c.options).toContain("xhigh");
      expect(c.options).toContain("high");
    }
  });

  test("gpt-5 (openai-effort, default) → effort control with minimal..high, no xhigh", () => {
    const c = reasoningControlFor("openai", "gpt-5");
    expect(c.kind).toBe("effort");
    if (c.kind === "effort") {
      expect(c.options).toContain("minimal");
      expect(c.options).not.toContain("xhigh");
    }
  });

  test("deepseek-v4 (deepseek-thinking) → toggle control", () => {
    expect(reasoningControlFor("deepseek", "deepseek-v4").kind).toBe("toggle");
  });

  test("glm-4.6 (zai deepseek-thinking) → toggle control", () => {
    expect(reasoningControlFor("zai", "glm-4.6").kind).toBe("toggle");
  });

  test("claude-opus-4-5 (anthropic-budget) → budget control with min", () => {
    const c = reasoningControlFor("anthropic", "claude-opus-4-5");
    expect(c.kind).toBe("budget");
    if (c.kind === "budget") expect(c.min).toBeGreaterThanOrEqual(1024);
  });

  test("claude 4.6+ (anthropic-adaptive) → adaptive control", () => {
    expect(reasoningControlFor("anthropic", "claude-sonnet-4-6").kind).toBe("adaptive");
  });

  test("openrouter model → effort control (minimal..high, no xhigh)", () => {
    const c = reasoningControlFor("openrouter", "openai/gpt-5");
    expect(c.kind).toBe("effort");
    if (c.kind === "effort") expect(c.options).not.toContain("xhigh");
  });

  test("a non-reasoning model (deepseek-reasoner / claude-3) → none", () => {
    expect(reasoningControlFor("deepseek", "deepseek-reasoner").kind).toBe("none");
  });
});
```

> 模型名按 `rules.ts` 真实匹配的样例填(Step 0 / spec §1.1 核对:claude-4.x budget 用 `claude-opus-4-5`,adaptive 用 `claude-sonnet-4-6`)。

- [ ] **Step 2:** `cd packages/core && bun test src/llm/capabilities/reasoning-control.test.ts` → FAIL。

- [ ] **Step 3: 写实现**

```typescript
// packages/core/src/llm/capabilities/reasoning-control.ts
/**
 * reasoningControlFor — projects a model's ReasoningShape into "what control
 * the UI should render". The UI never branches on provider; it switches on
 * ReasoningControl.kind. Mirrors the capability-control descriptor pattern.
 */
import type { ProviderKindName } from "../provider-kinds.js";
import type { ReasoningEffort } from "./types.js";
import { capabilitiesFor } from "./index.js"; // ← confirm real export in Step 0

export type ReasoningControl =
  | { kind: "none" }
  | { kind: "toggle"; default: boolean }
  | { kind: "effort"; options: ReasoningEffort[]; default: ReasoningEffort }
  | { kind: "budget"; min: number; default: number }
  | { kind: "adaptive" };

const FULL_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
// gpt-5.5+: drops "minimal", adds "xhigh" (signalled by disabledEffort === "none").
const GPT55_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export function reasoningControlFor(
  kind: ProviderKindName,
  model: string,
): ReasoningControl {
  const cap = capabilitiesFor(kind, model);
  const r = cap.reasoning;
  switch (r.kind) {
    case "none":
      return { kind: "none" };
    case "deepseek-thinking":
      return { kind: "toggle", default: true };
    case "anthropic-adaptive":
      return { kind: "adaptive" };
    case "anthropic-budget":
      return { kind: "budget", min: r.minBudgetTokens, default: Math.max(r.minBudgetTokens, 4096) };
    case "openrouter-reasoning":
      // OpenRouter normalizes to minimal..high (no xhigh passthrough).
      return { kind: "effort", options: FULL_EFFORTS, default: "medium" };
    case "openai-effort": {
      // disabledEffort === "none" is the gpt-5.5+ signal (no minimal, has xhigh).
      const isGpt55 = r.disabledEffort === "none";
      const options = isGpt55 ? GPT55_EFFORTS : FULL_EFFORTS;
      return { kind: "effort", options, default: "medium" };
    }
  }
}
```

> ⚠️ `openai-effort` 的 gpt-5.5 判定用 `disabledEffort === "none"` 作为代理信号(spec §4.2 的约定)。若 Step 0 发现 Mistral magistral 也用 `disabledEffort:"none"` 但 options 不同(只 `high|none`),在此分支额外按 model 正则细分;否则保持。Mistral 的 effort 选项偏窄是已知边缘,P0 先按上面通用处理,P3 可细化。

- [ ] **Step 4:** `cd packages/core && bun test src/llm/capabilities/reasoning-control.test.ts` → PASS。（断言因真实 capabilitiesFor 行为微调,但 kind 判定不应削弱。）
- [ ] **Step 5: Commit**(主控)

---

## Task 4: settings schema → reasoning 富结构

**Files:** Modify `packages/core/src/settings/schema.ts:118,149`

- [ ] **Step 1:** schema.ts 顶部 import:`import { ReasoningSettingSchema } from "../llm/reasoning-setting.js";`
- [ ] **Step 2:** provider 级(`:118`)把:
```typescript
          thinking: z.enum(["enabled", "disabled"]).optional(),
```
改为:
```typescript
          /**
           * Default reasoning/thinking setting for this provider's models.
           * Rich shape: {mode:"off"|"on"} | {mode:"effort",effort} |
           * {mode:"budget",budgetTokens}. Per-model `reasoning` wins.
           */
          reasoning: ReasoningSettingSchema.optional(),
```
- [ ] **Step 3:** model 级(`:149`)同样把 `thinking: z.enum(...)` 改为 `reasoning: ReasoningSettingSchema.optional()`(注释改成 per-model override)。
- [ ] **Step 4:** `cd packages/core && bunx tsc --noEmit 2>&1 | grep -vE "write-policy.test|reasoning-effort-drop.test"` —— 会暴露 model-pool 等处仍读 `entry.thinking` 的 error,这些在 Task 5 修。本步只确认 schema 自身无语法错。
- [ ] **Step 5: Commit**(主控,与 Task 5 一起 commit 更稳——见 Task 5)

---

## Task 5: model-pool + llm/types + openai.ts 全链路 thinking→reasoning

**Files:** Modify `model-pool.ts:71,265`、`llm/types.ts:31`、`openai.ts:165,210,244-281`

> **依赖** Task 2/4。这是把二元 thinking 全链路替换成 ReasoningSetting 的核心 Task。**先 Step 0** 读三个文件确认当前 thinking 流向。

- [ ] **Step 0: 调研**

Run: `grep -n "thinking" packages/core/src/llm/types.ts packages/core/src/llm/model-pool.ts packages/core/src/llm/providers/openai.ts`
列出所有 thinking 读写点。

- [ ] **Step 1: llm/types.ts** —— `CreateMessageOptions.thinking?: "enabled"|"disabled"`(`:31`)改为:
```typescript
  /** Reasoning/thinking setting for this call. Overrides LLMConfig.reasoning. */
  reasoning?: import("./reasoning-setting.js").ReasoningSetting;
```
并把 LLMConfig 里的 `thinking?: ...`(若存在)改为 `reasoning?: ReasoningSetting`。

- [ ] **Step 2: model-pool.ts** —— `entry.thinking`(`:71`)改为 `entry.reasoning?: ReasoningSetting`;`toLLMConfig`(`:265-268`)把 thinking 透传改为 reasoning 透传:
```typescript
      ...(entry.reasoning ?? fromCat?.reasoning
        ? { reasoning: entry.reasoning ?? fromCat?.reasoning }
        : {}),
```
（import `ReasoningSetting`;`fromCat` 的类型也加 `reasoning?`。）

- [ ] **Step 3: openai.ts 取值** —— `:165` `const thinking = options.thinking ?? this.config.thinking;` 改为:
```typescript
      const reasoning = options.reasoning ?? this.config.reasoning;
```
并把传递链(`:169/184/185/210`)的 `thinking` 参数改为 `reasoning: ReasoningSetting | undefined`。

- [ ] **Step 4: openai.ts buildRequestBody switch** —— 把 `:244-281` 整段按 ReasoningSetting 真实档位重写(去掉 medium 硬编码):

```typescript
    // Reasoning shape — translate the user's ReasoningSetting to the wire shape.
    const reasoningBody: Record<string, unknown> = {};
    if (reasoning && reasoning.mode !== "off") {
      switch (cap.reasoning.kind) {
        case "deepseek-thinking":
          // Binary on/effort-irrelevant: any non-off means thinking on.
          reasoningBody.thinking = { type: "enabled" };
          break;
        case "openai-effort":
          if (!this._dropReasoningEffort) {
            reasoningBody.reasoning_effort =
              reasoning.mode === "effort" ? reasoning.effort : "medium";
          }
          break;
        case "openrouter-reasoning":
          reasoningBody.reasoning =
            reasoning.mode === "effort" ? { effort: reasoning.effort } : { effort: "medium" };
          break;
        case "anthropic-budget":
        case "anthropic-adaptive":
        case "none":
          break; // OpenAI client doesn't serve Anthropic; none = no knob.
      }
    } else if (reasoning && reasoning.mode === "off") {
      // Explicit OFF: each shape's "don't think" wire form.
      switch (cap.reasoning.kind) {
        case "deepseek-thinking":
          reasoningBody.thinking = { type: "disabled" };
          break;
        case "openai-effort":
          if (!this._dropReasoningEffort) {
            reasoningBody.reasoning_effort = cap.reasoning.disabledEffort ?? "minimal";
          }
          break;
        case "openrouter-reasoning":
          reasoningBody.reasoning = { effort: "minimal", exclude: true };
          break;
        default:
          break;
      }
    }
```
然后请求体里 `...reasoning` 改成 `...reasoningBody`(把原来叫 `reasoning` 的局部变量名改掉以免和参数撞)。

- [ ] **Step 5:** `cd packages/core && bunx tsc --noEmit 2>&1 | grep -vE "write-policy.test|reasoning-effort-drop.test"` → 无输出(全链路类型打通)。
- [ ] **Step 6:** `cd packages/core && bun test 2>&1 | tail -10` → core 测试无新增回归(尤其 `openai-reasoning-effort-drop.test.ts` 仍绿:gpt-5.5+tools 自愈逻辑没动)。若该测试因 `thinking` 改名而引用旧字段,更新它用 `reasoning: {mode:"effort",effort:"medium"}`(语义等价于旧的 enabled→medium)。
- [ ] **Step 7: Commit**(主控,Task 4+5 合并为一个「全链路改名」commit)

---

## Task 6: P0 build + 收尾

- [ ] **Step 1:** `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun run build 2>&1 | tail -8` → core+tui exit 0。
- [ ] **Step 2:** `bun test 2>&1 | tail -8` → 无新增回归(对比基线:#3/#4 完成后那 ~15 个预存 protocol/desktop fail 数不变)。
- [ ] **Step 3: Commit**(主控)P0 完成。

---

# Phase P1 — Anthropic client 补 thinking 实现

## Task 7: anthropic.ts 实现 anthropic-budget + anthropic-adaptive

**Files:** Modify `packages/core/src/llm/providers/anthropic.ts`;Test `anthropic.test.ts`(无则建)

> **依赖** P0。**先 Step 0**:读 `anthropic.ts` 的 buildRequestBody / createMessage,确认 ① 它怎么拿 capability(`capabilitiesFor`?)② 请求体在哪组装 ③ 它怎么读 reasoning(P0 后应是 `options.reasoning ?? config.reasoning`,但 anthropic.ts 可能还没接 —— 若没接,P0 Task 5 只改了 openai.ts,anthropic 这里要补上读取)。

- [ ] **Step 0: 调研** `grep -n "capabilit\|reasoning\|thinking\|buildRequest\|createMessage\|budget" packages/core/src/llm/providers/anthropic.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/src/llm/providers/anthropic.test.ts (追加或新建)
import { describe, test, expect } from "bun:test";
// Test the request-body builder for thinking. If anthropic.ts exposes a
// buildRequestBody-like method, call it directly; otherwise assert via a
// thin seam. Confirm the real entry in Step 0 and adapt.

describe("anthropic reasoning (P1 — was completely unimplemented)", () => {
  test("anthropic-budget model with {mode:budget} sends thinking:{type:enabled,budget_tokens}", () => {
    // Pseudocode — bind to the real builder discovered in Step 0:
    //   const body = buildBodyFor("claude-opus-4-5", { mode:"budget", budgetTokens: 8000 });
    //   expect(body.thinking).toEqual({ type:"enabled", budget_tokens: 8000 });
    expect(true).toBe(true); // replace with the real assertion in Step 0/3
  });

  test("anthropic-adaptive model (claude 4.6+) does NOT send a disable field", () => {
    //   const body = buildBodyFor("claude-sonnet-4-6", { mode:"off" });
    //   expect(body.thinking).toBeUndefined(); // adaptive: can't disable; just omit
    expect(true).toBe(true);
  });
});
```

> ⚠️ 这个测试是骨架——Step 0 必须发现 anthropic.ts 的真实可测接缝(是否有可单测的 buildRequestBody)。**若没有可测接缝**,P1 的验证退化为:实现 + 跑全量 anthropic 既有测试无回归 + 手动核对请求体日志,并在 commit 里注明「无单测接缝,逻辑由 X 覆盖」。不要造脆弱 mock。

- [ ] **Step 2:** 跑确认 FAIL（或骨架 PASS 但未实现真逻辑）。
- [ ] **Step 3: 实现** —— 在 anthropic.ts 请求体组装处,按 capability.reasoning.kind 加:
  - `anthropic-budget` + `reasoning.mode==="budget"` → `body.thinking = { type: "enabled", budget_tokens: reasoning.budgetTokens }`(clamp 到 `minBudgetTokens`)。
  - `anthropic-budget` + `reasoning.mode==="on"` → 用 `minBudgetTokens` 或一个合理默认(如 4096)。
  - `anthropic-budget` + `reasoning.mode==="off"` 或无 → 不发 thinking 字段。
  - `anthropic-adaptive` → 永不发 thinking 字段(spec:发 `type:"enabled"` 会 400;adaptive 自动)。
  - 读 reasoning:`options.reasoning ?? this.config.reasoning`(对齐 openai.ts)。
- [ ] **Step 4:** 跑测试 + `bunx tsc` → PASS / 无新 error。
- [ ] **Step 5: Commit**(主控)

---

# Phase P2 — ModelSection UI

## Task 8: ModelSection 渲染 reasoning 控件

**Files:** Modify `packages/desktop/src/renderer/settings/ModelSection.tsx`(+ 可能的 preload/RPC 暴露 reasoningControlFor)

> **依赖** P0(reasoningControlFor 存在)。**先 Step 0**:读 ModelSection.tsx 的 model entry 表单 + 它怎么读写 settings(window.codeshell.updateSettings)+ 它怎么拿到 provider kind/model。确认 `reasoningControlFor` 能否在 renderer 直接 import(core 是否对 renderer 暴露;若不能,需经 preload RPC,照现有 listCapabilities 模式加一个 `reasoningControl(kind,model)` 端点)。

- [ ] **Step 0: 调研** 读 ModelSection.tsx 全文 + 找 reasoningControlFor 的可达路径(直接 import vs RPC)。
- [ ] **Step 1+:** 按 Step 0 结论分解:① 拿到当前 model 的 ReasoningControl;② 按 kind 渲染:`toggle`→开关、`effort`→下拉(options)、`budget`→数字输入(min)、`adaptive`→只读「自动」标签、`none`→不渲染;③ 选择写入 `models[].reasoning`(ReasoningSetting),走现有 updateSettings 链路。
- [ ] 测试:ModelSection 有测试惯例则加(参考同目录 *.test.tsx);UI 测试若仅 renderToStaticMarkup 能力有限,至少断言控件按 kind 出现。
- [ ] **Build:** `bun run --filter '@cjhyy/code-shell-desktop' typecheck`(desktop 有独立 typecheck/build,根不覆盖 —— 见 memory `project_extensions_ui`)。
- [ ] **Commit**(主控)

> P2 的具体 React 代码待 Step 0 摸清 ModelSection 真实结构后,由执行该 Task 的 subagent 按本仓 UI 惯例写(本 plan 不预写 JSX 骨架,因 ModelSection 结构复杂、预写易错;Step 0 调研后即可精确实现)。

---

# Phase P3 —(可选)OpenRouter max_tokens/enabled 透传

## Task 9: openrouter-reasoning 支持 max_tokens / enabled

**Files:** Modify `openai.ts` 的 openrouter-reasoning 分支(P0 Task 5 重写过的那段)

- [ ] 若 ReasoningSetting 将来要支持「按 token 数控 OpenRouter reasoning」,在此分支把 `{mode:"budget",budgetTokens}` 映射成 `{reasoning:{max_tokens:budgetTokens}}`。当前 ReasoningSetting 的 budget 仅 anthropic 用,OpenRouter 主要走 effort —— **P3 视实际需要再做,非必须**。spec §7 P3 标了「可选」。
- [ ] 若做:加测试 + commit。若不做:在 TODO 注明 P3 deferred。

---

## Self-Review

**Spec coverage(对 spec §3-§7):**
- §3 schema 富结构 ReasoningSetting:Task 2(类型/schema)+ Task 4(settings)✓
- §3 reasoningControlFor 描述符:Task 3 ✓
- §3 去 medium 硬编码读真实档位:Task 5 Step 4 ✓
- §4.1 ReasoningSetting 四态:Task 2 ✓(`off/on/effort/budget`)
- §4.2 映射规则(各 ReasoningShape→Control):Task 3 ✓
- §5 用户场景(ds-pro toggle / gpt effort / OR effort / claude budget/adaptive):Task 3 测试逐条覆盖 ✓
- §6 运行时改动:Task 5 ✓
- Anthropic 补实现(spec §1.3 #3 bug):Task 7(P1)✓
- xhigh(spec 多处提到 gpt-5.5):Task 1 ✓
- §7 P2 UI:Task 8 ✓;§7 P3:Task 9(可选)✓

**Placeholder scan:** Task 3/5/7/8 的 Step 0 是有意调研(capabilitiesFor 签名、anthropic 可测接缝、ModelSection 结构以真实代码为准)。Task 7/8 的具体实现因依赖调研结果,给了明确的行为规格 + 决策点而非臆造代码 —— 这是 plan 对「未知接口」的正确处理,不是占位符。Task 1-5 含完整代码。

**Type consistency:** `ReasoningSetting`/`ReasoningSettingSchema`/`normalizeReasoning`/`REASONING_EFFORTS`/`ReasoningControl`/`reasoningControlFor`/`DEFAULT_EFFORT` 命名贯穿一致。`reasoning`(字段名)替换 `thinking` 全链路统一。

**已知风险:**
- `thinking → reasoning` 改名穿透多文件,P0 Task 4+5 之间存在中间 tsc-error 态(同 #3 的做法,合并 commit 收口)。
- `openai-reasoning-effort-drop.test.ts` 可能引用旧 `thinking` 字段 → Task 5 Step 6 更新它(保留自愈逻辑本身)。
- ModelSection(P2)结构未预读全 → Task 8 Step 0 必须先摸清;UI 代码留给执行 subagent 按惯例写。
- Mistral magistral 的 effort 选项偏窄(high|none)→ P0 按通用 effort 处理,P3 可细化(已在 Task 3 标注)。
