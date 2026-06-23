# P1 通用参数下发(applyParams 接线)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans。步骤用 `- [ ]` 勾选。

**Goal:** 让 catalog 声明的非-reasoning 参数(temperature/top_p/max_tokens/thinking_type 等,带 `wire.field`)真正下发到 LLM 请求体 —— 接通已实现但零调用的 `applyParams`,贯通 connection→ModelEntry→LLMConfig→请求体三层,且过 rejectedParams 过滤。

**Architecture:** `modelEntriesFromConnections` 调 `applyParams(paramValues, preset.params)` 算出请求体片段(extraBody)→ 存进 `ModelEntry.extraBody` → `toLLMConfig` 带到 `LLMConfig.extraBody` → openai client 请求时浅合并进 body,逐键过 `cap.rejectedParams`。reasoning 保持现有专用路不动(它要按模型动态翻译,非静态搬运),但 applyParams 要**排除已被 reasoning 专用路消费的 param**,避免双重下发。

**Tech Stack:** TypeScript,bun test,monorepo(改 core,测试走 src 但 dist 消费者需 rebuild)。

**评估稿:** `docs/model-adapter-deharcoding-assessment-2026-06-23.md`

---

## 关键事实(实现前必读)

1. **`applyParams`**(`model-catalog/params.ts:16`)已实现:`(values, params[]) → body`,按 `spec.wire.field ?? spec.name` 用 `setDeep` 写(支持 `thinking.type` 深路径)。零生产调用。
2. **断点三层**:
   - `resolve.ts:67` 解析出完整 `paramValues` ✅
   - `model-connections-pool.ts:53` 只取 reasoning,其余丢 ❌
   - `ModelEntry`(`model-pool.ts:49`)无通用参数槽 ❌
   - `toLLMConfig`(`model-pool.ts:250`)不传 ❌
   - openai client `buildRequestBody`(`openai.ts:382-392`)不读 ❌
3. **请求体组装**:`openai.ts:382-392` 用 `...tokenLimit ...sampling ...reasoningBody ...service_tier ...tools`。extraBody 注入点在此。
4. **rejectedParams**:`cap.rejectedParams`(Set,来自 `capabilitiesFor`)—— 已用于 sampling(line 295)。extraBody 每键要过它。
5. **reasoning 重叠风险**:reasoning 走专用路(`reasoningFromParamValues` → `ModelEntry.reasoning` → client 动态翻译)。若 catalog 把 reasoning 也声明成普通 param,applyParams 会重复下发 → 必须在 applyParams 调用处排除 `reasoning` 这个 param name(以及任何已被专用路消费的)。
6. **改 core 必 rebuild** 供 dist 消费者;测试走 src 用 `bun test`。

---

## 文件结构

| 文件 | 改动 |
|---|---|
| `packages/core/src/llm/model-pool.ts` | `ModelEntry` 加 `extraBody?: Record<string,unknown>`;`toLLMConfig` 透传到 `LLMConfig` |
| `packages/core/src/types.ts` | `LLMConfig` 加 `extraBody?: Record<string,unknown>` |
| `packages/core/src/engine/model-connections-pool.ts` | 调 `applyParams`(排除 reasoning param)→ 填 `ModelEntry.extraBody` |
| `packages/core/src/llm/providers/openai.ts` | `buildRequestBody` 注入 `extraBody`,逐键过 `rejectedParams` |
| 各自 `.test.ts` | 新增/扩展测试 |

> Anthropic client 暂不接(本次只做 openai-compat 路径,覆盖绝大多数自定义 provider;anthropic 参数下发是独立小项,留 TODO)。

---

## Task 1: ModelEntry + LLMConfig 加 extraBody 字段

**Files:** `model-pool.ts`、`types.ts`、`model-pool.ts` 的 toLLMConfig 测试

- [ ] **Step 1: 写失败测试** —— `packages/core/src/llm/model-pool.test.ts` 加(或新建):

```typescript
import { describe, it, expect } from "bun:test";
import { ModelPool } from "./model-pool.js";

describe("ModelPool.toLLMConfig extraBody passthrough", () => {
  it("carries entry.extraBody into LLMConfig", () => {
    const pool = new ModelPool([]);
    const entry = { key: "k", provider: "openai", model: "m", apiKey: "x", baseUrl: "u", extraBody: { temperature: 0.7, top_p: 0.9 } };
    pool.register(entry as never);
    const cfg = pool.toLLMConfig(entry as never);
    expect(cfg.extraBody).toEqual({ temperature: 0.7, top_p: 0.9 });
  });
  it("omits extraBody when entry has none", () => {
    const pool = new ModelPool([]);
    const entry = { key: "k2", provider: "openai", model: "m", apiKey: "x", baseUrl: "u" };
    pool.register(entry as never);
    const cfg = pool.toLLMConfig(entry as never);
    expect(cfg.extraBody).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/core && bun test src/llm/model-pool.test.ts`

- [ ] **Step 3: 加字段** —
  - `types.ts` 的 `LLMConfig` 接口加:`/** Catalog-driven extra request-body fields (temperature/top_p/etc), already wire-mapped. Merged into the request, each key filtered by the model's rejectedParams. */ extraBody?: Record<string, unknown>;`
  - `model-pool.ts` 的 `ModelEntry` 接口加同样的 `extraBody?: Record<string, unknown>;`
  - `toLLMConfig`(line 263 起的 return）加:`...(entry.extraBody && Object.keys(entry.extraBody).length > 0 ? { extraBody: entry.extraBody } : {})`

- [ ] **Step 4: 跑确认通过** — 2 pass。

- [ ] **Step 5: 提交** — `git commit -m "feat(core): ModelEntry/LLMConfig 加 extraBody 字段(catalog 参数下发承载)"`

---

## Task 2: applyParams 接进 modelEntriesFromConnections

**Files:** `model-connections-pool.ts`、`model-connections-pool.test.ts`

- [ ] **Step 1: 写失败测试** — `packages/core/src/engine/model-connections-pool.test.ts` 加:

```typescript
// 用一个 catalog 条目带 params(temperature/top_p/thinking_type 各有 wire.field),
// connection.paramValues 给具体值 + reasoning,验证:
//  - 非-reasoning 参数进 entry.extraBody(按 wire.field)
//  - reasoning 仍走 entry.reasoning(不重复进 extraBody)
import { describe, it, expect } from "bun:test";
import { modelEntriesFromConnections } from "./model-connections-pool.js";

const catalog = [{
  id: "zhipu", tag: "text", adapterKind: "openai", protocol: "openai-compat",
  defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-5.2",
  modelPresets: [{ value: "glm-5.2", label: "GLM-5.2", params: [
    { name: "reasoning", control: "enum", wire: { field: "reasoning_effort" } },
    { name: "thinking_type", control: "enum", wire: { field: "thinking.type" } },
    { name: "temperature", control: "number", wire: { field: "temperature" } },
    { name: "top_p", control: "number", wire: { field: "top_p" } },
  ] }],
}] as never;
const creds = [{ id: "z-key", catalogId: "zhipu", apiKey: "k", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }] as never;

describe("modelEntriesFromConnections flows non-reasoning params to extraBody", () => {
  it("maps paramValues to extraBody via wire.field, reasoning stays separate", () => {
    const conns = [{ id: "z", catalogId: "zhipu", tag: "text", model: "glm-5.2", credentialId: "z-key",
      paramValues: { reasoning: "high", thinking_type: "enabled", temperature: 1, top_p: 0.95 } }] as never;
    const [e] = modelEntriesFromConnections(conns, creds, catalog);
    // reasoning 走专用路
    expect(e.reasoning).toEqual({ mode: "effort", effort: "high" });
    // 非 reasoning 进 extraBody,按 wire.field(深路径 thinking.type)
    expect(e.extraBody).toEqual({ thinking: { type: "enabled" }, temperature: 1, top_p: 0.95 });
    // reasoning 不重复出现在 extraBody
    expect(e.extraBody?.reasoning_effort).toBeUndefined();
  });
  it("no params → no extraBody", () => {
    const conns = [{ id: "z2", catalogId: "zhipu", tag: "text", model: "glm-5.2", credentialId: "z-key" }] as never;
    const [e] = modelEntriesFromConnections(conns, creds, catalog);
    expect(e.extraBody).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/core && bun test src/engine/model-connections-pool.test.ts`

- [ ] **Step 3: 实现** — 在 `modelEntriesFromConnections`(line 42-67)的 entry 构造里:

```typescript
import { applyParams } from "../model-catalog/params.js";
// ...
const reasoning = reasoningFromParamValues(inst.paramValues);
// 通用参数下发:把 paramValues 按 preset.params 的 wire.field 映射成请求体片段。
// 排除 reasoning —— 它走 entry.reasoning 专用动态翻译路(按模型形状),
// 若也在 params 里声明,跳过避免双重下发。
const passthroughParams = (preset?.params ?? []).filter((p) => p.name !== "reasoning");
const extraBody = applyParams(inst.paramValues ?? {}, passthroughParams);
const e: ModelEntry = {
  key: inst.id,
  provider: clientProvider(entry),
  model: resolved.model,
  baseUrl: resolved.baseUrl,
  ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
  ...(preset?.maxContextTokens !== undefined ? { maxContextTokens: preset.maxContextTokens } : {}),
  ...(preset?.maxOutputTokens !== undefined ? { maxOutputTokens: preset.maxOutputTokens } : {}),
  ...(reasoning !== undefined ? { reasoning } : {}),
  ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
};
```

> 注:`applyParams` 已 `import` 路径 `../model-catalog/params.js`。确认 `ParamSpec` 类型已被引用(reasoningFromParamValues 的签名可能没用到,需新加 import)。`preset.params` 的类型来自 catalog types。

- [ ] **Step 4: 跑确认通过** — 2 pass + 原有测试不回归。

- [ ] **Step 5: 提交** — `git commit -m "feat(core): modelEntriesFromConnections 调 applyParams 下发非-reasoning 参数到 extraBody"`

---

## Task 3: openai client 注入 extraBody 并过 rejectedParams

**Files:** `openai.ts`、`openai` client 测试

- [ ] **Step 1: 写失败测试** — 找 openai client 的 buildRequestBody 测试(`grep -rln "buildRequestBody" packages/core/src`);若无则在 `packages/core/src/llm/providers/openai.test.ts` 加。测两点:extraBody 注入 body;被 rejectedParams 拒的键被剔除。

```typescript
// 伪代码骨架——按现有 openai client 测试夹具调整:
// 1. config.extraBody = { temperature: 1, top_p: 0.95, thinking: { type: "enabled" } }
//    model 是普通 openai-compat(rejectedParams 空)→ body 应含全部三项
// 2. model 是 gpt-5(rejectedParams 含 temperature)→ body 不含 temperature,但含 top_p? 
//    (注:gpt-5 也拒 top_p,用一个只拒 temperature 的 cap 测,或断言 temperature 被剔)
```

实现前先读现有 openai client 测试怎么构造 client + 调 buildRequestBody(是否私有需通过 createMessage 间接测),按夹具风格写。

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现** — `openai.ts` buildRequestBody return(382-392):
  - 在组装前算过滤后的 extraBody:
  ```typescript
  // Catalog-driven passthrough params (temperature/top_p/etc, already wire-mapped
  // by applyParams). Filter each key by rejectedParams so we never send a field
  // the model rejects (e.g. temperature to gpt-5) — same contract as `sampling`.
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(this.config.extraBody ?? {})) {
    if (cap.rejectedParams.has(k)) continue;
    extra[k] = v;
  }
  ```
  - return 里加 `...extra`,**放在 `...sampling` 之后、`...reasoningBody` 之前**(或末尾靠前),使显式的 tokenLimit/sampling/reasoning 形状**优先**于 extraBody(避免 extraBody 的 temperature 覆盖 client 的 sampling 逻辑 —— 实际上若用户在 catalog 配了 temperature,应以 catalog 为准?**设计决策见下**)。

> **细节决策**:extraBody 的 temperature vs client 的 sampling.temperature 谁赢?
> - sampling.temperature 来自 `options.temperature ?? this.temperature`(运行时/默认)。
> - extraBody.temperature 来自 catalog 用户配置。
> - **用户在连接里显式配的 temperature 应该赢** → extraBody 放在 sampling 之后覆盖它。但这会让 clientDefaults.temperature 失效于该模型 —— 可接受(用户明确配了)。
> - reasoningBody 必须赢过 extraBody 里任何 reasoning_effort(虽已在 Task2 排除 reasoning param,双保险)→ extraBody 放 reasoningBody 之前。
> - **顺序建议**:`...tokenLimit, ...sampling, ...extra, ...reasoningBody, ...service_tier, ...tools`

- [ ] **Step 4: 跑确认通过 + rebuild** — `cd packages/core && bun test src/llm/ && bun run build`

- [ ] **Step 5: 提交** — `git commit -m "feat(core): openai client 注入 catalog extraBody,逐键过 rejectedParams"`

---

## Task 4: 端到端验证 + 回归

- [ ] **Step 1: 全量** — `cd packages/core && bun run build && bun test src/`(报数,0 fail)
- [ ] **Step 2: typecheck** — core/tui/desktop 三包 `bunx tsc --noEmit`(desktop 容许预存 cdp 错)
- [ ] **Step 3: 端到端 sanity** — 用真实 settings(zhipu 连接带 paramValues)跑 resolveLLMConfigForTag,确认 LLMConfig.extraBody 含 temperature/top_p/thinking.type(脚本验证,不发真请求)。
- [ ] **Step 4: 提交收尾**

---

## Self-Review 结果

- **Spec 覆盖**:applyParams 接线(T2)+ 承载(T1)+ 下发过滤(T3)+ 验证(T4)。reasoning 不动 ✅(T2 排除 reasoning param)。rejectedParams 叠加 ✅(T3)。
- **占位符**:T3 测试是骨架(标注"按夹具调整")—— 因 openai client 测试构造方式需实现时读现有夹具确认,非凭空。其余步骤代码完整。
- **类型一致**:`extraBody?: Record<string, unknown>` 在 ModelEntry/LLMConfig 一致;`applyParams(values, params)` 签名与 params.ts 一致;`passthroughParams` filter 排除 reasoning 与 reasoningFromParamValues 消费的对齐。
- **风险**:anthropic client 不接(留 TODO,openai-compat 覆盖绝大多数);extraBody 覆盖 sampling.temperature 是有意(用户显式配置优先)。
