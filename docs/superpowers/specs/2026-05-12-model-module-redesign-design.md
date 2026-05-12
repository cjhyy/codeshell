# 模型模块两层化设计（Providers + Models）

- **日期**：2026-05-12
- **范围**：`src/settings/schema.ts`、`src/llm/`、`src/cli/onboarding.ts`、`src/ui/components/ModelManager*.tsx`
- **目标**：把"凭据"和"模型选择"拆成两层，让用户配过一次 DeepSeek key 之后，加新模型只需选 provider + 从官方列表挑模型，不用再贴 key。

---

## 1. 问题陈述

当前 settings 里 `models[]` 每条都自带 `apiKey` 和 `baseUrl`。后果：

- 同一个 DeepSeek key 想挂 3 个模型 → 同一份 key 复制 3 次
- 模型清单要么靠 onboarding 里硬编码（`KNOWN_CONTEXT_WINDOWS`、`KNOWN_MAX_OUTPUT`），要么靠 build-time 拉的 OpenRouter 全量快照
- 直连 provider（DeepSeek 直连 vs OpenRouter 路由）的 key 不通用，但仓库当前没有清晰的两层模型来表达这件事
- 硬编码表跟实际窗口对不上（observed: `KNOWN_CONTEXT_WINDOWS.deepseek-chat = 1_000_000`，但 OpenRouter 快照里是 `163840`，运行时取的是后者）

## 2. 核心架构

把扁平的 `models[]` 拆成两张表，model 通过 `providerKey` 引用 provider：

```
providers[]                                models[]
─────────────                               ───────────────────────
key: "deepseek"        ◄────────────────── providerKey: "deepseek"
label: "DeepSeek"                          key: "ds-flash"
baseUrl: "https://..."                     label: "DS Flash"
apiKey: "sk-..."                           model: "deepseek-v4-flash"
kind: "deepseek"                           maxContextTokens: 1000000
                                           maxOutputTokens: 8192
```

**`kind`** 是 provider 的种类标签，决定：列表 endpoint、协议风格、auth header 格式、非 chat 模型的过滤规则。

内置 kind：`openai / anthropic / deepseek / xai / mistral / groq / google / openrouter / ollama / custom`。

**`custom`** kind 给用户兜底：手填 baseUrl、选协议、可选自定义 `modelsPath`。

## 3. 数据结构

### 3.1 Settings schema 变更（`src/settings/schema.ts`）

新增 `providers[]`：

```ts
providers: z.array(
  z.object({
    key: z.string(),                 // 唯一 ID，例 "deepseek"
    label: z.string().optional(),    // UI 显示名，缺省用 kind label
    kind: z.enum([
      "openai", "anthropic", "deepseek", "xai", "mistral",
      "groq", "google", "openrouter", "ollama", "custom",
    ]),
    baseUrl: z.string(),             // 完整 URL，含 /v1
    apiKey: z.string().optional(),   // ollama 无需
    protocol: z.enum(["openai-compat", "anthropic-style"]).optional(),
    modelsPath: z.string().optional(), // custom kind 用，默认 "/models"
  }),
).default([])
```

改造 `models[]`：

```ts
models: z.array(
  z.object({
    key: z.string(),                 // 短别名 "ds-flash"
    label: z.string().optional(),
    providerKey: z.string(),         // 引用 providers[].key
    model: z.string(),               // "deepseek-v4-flash"
    maxOutputTokens: z.number().optional(),
    maxContextTokens: z.number().optional(),
    // 兼容字段（迁移过渡用，写入新格式后清理）
    provider: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
  }),
).default([])
```

### 3.2 缓存文件（不进 settings）

路径：`~/.code-shell/cache/models/<providerKey>.json`

```json
{
  "fetchedAt": "2026-05-12T08:30:00Z",
  "providerKey": "deepseek",
  "models": [
    { "id": "deepseek-v4-flash", "contextLength": 1000000, "maxOutputTokens": 8192 },
    { "id": "deepseek-v4-pro",   "contextLength": 1000000, "maxOutputTokens": 65536 }
  ]
}
```

不放 settings 的理由：列表几十到几千条、会刷新、与用户配置正交。

**TTL**：7 天。`fetchedAt + 7d < now` 即视为过期。UI 显示"N 天前更新"+ `r` 键强制刷新。

### 3.3 Provider kind 元数据（`src/llm/provider-kinds.ts`，新文件）

```ts
export interface ProviderKindMeta {
  label: string;
  defaultBaseUrl: string;
  modelsPath: string;
  protocol: "openai-compat" | "anthropic-style" | "gemini" | "ollama";
  authHeader: (key: string) => Record<string, string>;
  chatFilter: (id: string) => boolean;
}

export const PROVIDER_KINDS: Record<string, ProviderKindMeta> = {
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
    chatFilter: (id) => !/embed|whisper|tts/i.test(id),
  },
  // 其它 kind（openai / xai / mistral / groq / google / openrouter / ollama）
  // 按上述结构补齐，baseUrl/modelsPath/protocol/authHeader/chatFilter 各项必填。
  // openai / xai / mistral / groq → openai-compat 协议，Authorization: Bearer
  // google → gemini 协议，key 走 query string
  // openrouter → defaultBaseUrl 仅作展示，fetchModelList 直接读本地快照
  // ollama → 无 authHeader，modelsPath: "/api/tags"
  openai: { /* 按上注补齐 */ },
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    modelsPath: "/models",
    protocol: "anthropic-style",
    authHeader: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
    /* ... */
  },
  xai: { /* baseUrl: https://api.x.ai/v1 */ },
  mistral: { /* baseUrl: https://api.mistral.ai/v1 */ },
  groq: { /* baseUrl: https://api.groq.com/openai/v1 */ },
  google: { /* generativelanguage.googleapis.com/v1beta, gemini 协议 */ },
  openrouter: { /* 走 src/data/openrouter-models.json 本地快照 */ },
  ollama: { /* baseUrl: http://localhost:11434, modelsPath: /api/tags */ },
  custom: { /* 没有默认 */ },
};
```

## 4. 模块拆分

### 4.1 新建文件

| 文件 | 职责 |
|---|---|
| `src/llm/provider-kinds.ts` | 内置 kind 元数据表 |
| `src/llm/provider-catalog.ts` | `ProviderCatalog` 类：load/add/update/remove/get/list |
| `src/llm/model-fetcher.ts` | `fetchModelList(provider, {refresh?})`：按 kind 调列表 endpoint，归一化、缓存读写、20s 超时 |
| `src/llm/model-cache.ts` | 缓存 IO：读/写 `~/.code-shell/cache/models/<key>.json`，`isStale(ttl)` |
| `src/cli/migrate-models.ts` | 旧 `models[]` → 新 `providers[]+models[]` 迁移；写 `.bak`；幂等 |
| `src/ui/components/AddProviderWizard.tsx` | 加 provider 向导：选 kind → 填 key →（custom 时填 baseUrl/protocol）→ 测试 `/v1/models` → 保存 |
| `src/ui/components/AddModelWizard.tsx` | 加 model 向导：选 provider → 拉缓存或刷新 → 列模型 → 选 → 起 alias → 保存 |

### 4.2 改造文件

| 文件 | 改造点 |
|---|---|
| `src/settings/schema.ts` | 新增 `providers[]`、改 `models[]` |
| `src/llm/model-pool.ts` | 加 `resolveCredentials(modelEntry, providerCatalog)`：从引用的 provider 取 baseUrl/apiKey；老 entry 自带 key 时走 fallback |
| `src/llm/client-factory.ts` | 接受 resolve 完凭据的 `LLMConfig`（接口不变） |
| `src/ui/components/ModelManager.tsx` | 改成上下两 section：Providers / Models；键位 `a` 加 provider、`A` 加 model、`r` 刷新当前 provider 模型缓存、`d` 删、`Enter` 编辑 |
| `src/cli/onboarding.ts` | 第一步加 provider（走 AddProviderWizard），第二步加 model（走 AddModelWizard）；移除 `KNOWN_MAX_OUTPUT` / `KNOWN_CONTEXT_WINDOWS` 硬编码（信息从 provider 拉的列表来），仅保留极简兜底 |
| `src/engine/engine.ts:399` | `maxTokens` 仍从 `modelEntry.maxContextTokens`；ModelPool 加载时**优先用缓存列表里的 contextLength** 填 maxContextTokens，解决"配置 1M 实际 160k"对不上的问题 |

## 5. 数据流（加一个 DeepSeek 模型）

```
ModelManager 按 A（加 model）
  ↓
AddModelWizard：读 providers[]，列已配 provider（DeepSeek ✓ / +新建）
  ↓ 用户选 DeepSeek
model-fetcher.fetchModelList("deepseek")
    ├─ 读 cache/models/deepseek.json
    ├─ 7天内 → 返回缓存
    └─ 过期/不存在 → GET https://api.deepseek.com/v1/models
        with Authorization: Bearer <key>
        ↓ chatFilter 过滤
        ↓ 写缓存
        ↓ 返回归一化列表
  ↓ UI 显示模型 + contextLength 标注
  ↓ 用户选 deepseek-v4-flash
  ↓ 起 alias（默认值为 model id 的简写，例如 deepseek-v4-flash → "v4-flash"；用户可改，唯一性冲突时拒绝）
  ↓
settings.models[].push({key, providerKey:"deepseek", model:"deepseek-v4-flash", maxContextTokens:1000000})
  ↓
ModelPool.register(entry)
```

## 6. 迁移策略

启动时 `migrateOldModels(settings)`：

1. 若 `providers[]` 非空或 `models[]` 所有条目都已有 `providerKey` → 跳过（幂等）
2. 否则遍历旧 `models[]`，按 `(provider, baseUrl, apiKey)` 三元组去重，为每个唯一组合生成 `providers[]` 条目：
   - `key` 自动派生（例 `deepseek`、`openai-2`），冲突时加序号
   - `kind` 按 baseUrl 模式匹配（含 `deepseek.com` → `deepseek`，含 `anthropic.com` → `anthropic`，其它 OpenAI-兼容 → `openai`，匹配不上 → `custom`）
3. 改写每条 `models[]`：填上 `providerKey`，清空 `apiKey/baseUrl/provider`
4. 写 `settings.json.bak` → 写新 settings
5. 失败时不动 settings，日志告警，新代码兼容旧 schema 继续跑

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| 加 provider 时 `/v1/models` 401 | UI 提示 "key 无效"，不保存 |
| 加 provider 时网络错/超时（20s） | 允许保存（离线场景），列表暂空，提示稍后刷新 |
| 加 model 时缓存空且拉取失败 | 降级到"手动输入 model id" |
| custom baseUrl 拼错 | 同 401 / 网络错处理 |
| Ollama 端口拒接 | "Ollama 似乎未启动"，附 `ollama serve` 提示 |
| OpenRouter 刷新 | 不走网络，读 `src/data/openrouter-models.json` 快照；UI 提示"由 build 同步" |
| 删 provider 时还有 model 引用 | 阻止删除，列出引用方 |
| 迁移失败 | 不写新 settings，告警，旧 schema 继续可用 |

## 8. 测试（Bun test）

| 文件 | 覆盖 |
|---|---|
| `tests/provider-catalog.test.ts` | add/update/remove/get；删被引用 provider 抛错 |
| `tests/model-fetcher.test.ts` | mock fetch：DeepSeek/OpenAI/Anthropic/Ollama/Gemini 各跑一遍归一化；7天缓存命中/失效；超时降级 |
| `tests/migrate-models.test.ts` | 旧→新：三元组去重、自动起 provider key、写 .bak、幂等 |
| `tests/model-pool-resolve.test.ts` | `resolveCredentials` 优先 providerCatalog；fallback 到老 entry 自带 key |

UI 组件（ModelManager / 两个 Wizard）不做单元测试，沿用现有 `.tsx` 不测策略。

## 9. YAGNI — 明确不做

- ❌ provider 清单本身"去网上拉"（没这种全网注册表）
- ❌ 同一 provider 多 key 轮询/负载均衡
- ❌ 模型列表远程订阅/推送
- ❌ `openrouter-models.json` 由 build-time 改 runtime 拉
- ❌ 老 `apiKey` 字段双轨制长期保留（迁移完一次性切，旧字段仅为读旧文件 optional 存在）

## 10. 实施顺序建议（不约束细节）

1. schema + provider-kinds + provider-catalog + model-cache + model-fetcher（数据层）
2. migrate-models（兼容）
3. model-pool resolveCredentials（接入）
4. AddProviderWizard + AddModelWizard + ModelManager 改造（UI）
5. onboarding 改造
6. engine.ts 用缓存 contextLength 修 1M 误判
7. 测试
