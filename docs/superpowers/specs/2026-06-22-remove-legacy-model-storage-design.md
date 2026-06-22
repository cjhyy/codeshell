# 删除 legacy 模型存储 · 全量切换统一 Catalog

**日期**: 2026-06-22
**状态**: 设计 / 待 review
**触发**: GLM-5.2 配好凭证仍报错 → 根因是 worker bootstrap 读 legacy `settings.model.name`(脏值 `glm-5.2[1m]`),而非统一 catalog。暴露了 legacy 模型存储与统一 catalog 双轨并存、boot path 仍读 legacy 的结构性问题。

---

## 1. 背景与问题

代码库里存在**两套并列的模型存储**:

| | Legacy(待删) | 统一 Catalog(保留) |
|---|---|---|
| 实例数组 | `settings.models[]` + `settings.providers[]` | `settings.modelConnections[]` + `settings.credentials[]` |
| 选中项 | `settings.activeKey` | `settings.defaults.{text,image,video,auxText}` |
| 顶层镜像 | `settings.model.{provider,name,apiKey,baseUrl,maxTokens,temperature}` | — |
| 辅助模型 | `settings.auxModelKey` | `settings.defaults.auxText` |
| 回退链 | `settings.fallbackModelKeys`(TODO,死功能) | — |

**统一 catalog 已 95% 接管**:desktop Connections 页(`TextConnectionsPanel.tsx`)只写统一 catalog;engine 解析时 `defaults.text` 优先级高于 `activeKey`;text/image/video 三模态运行时都读 modelConnections。

**但 legacy 仍在多处承重**,且**没有单一的 `settings → LLMConfig` 解析器** —— 每个 boot path 各自手写:

```typescript
const llmConfig = {
  provider: settings.model.provider,
  model: settings.model.name,      // ← 这里读到脏值 glm-5.2[1m]
  apiKey: settings.model.apiKey ?? "",
  baseUrl: settings.model.baseUrl,
  maxTokens: settings.model.maxTokens,
};
```

这一模式重复出现在:`agent-server-stdio.ts:99`、`agent-server-tcp.ts:45`、`automation-host.ts:106`、`dream-service.ts:65`、TUI `repl.ts:123` / `run.ts` / `runs.ts` / `main.ts`。

**本次目标**:删除所有 legacy 模型字段,所有 boot path 改走统一 catalog 的**单一共享解析器**,并写一次性脚本迁移现有用户数据。

---

## 2. 范围(已与用户拍板)

| 决策点 | 结论 |
|---|---|
| 删除程度 | **全删** legacy + 写迁移 |
| 删除字段 | `model.*` / `models[]` / `providers[]` / `activeKey` / `auxModelKey` / `fallbackModelKeys` |
| 迁移方式 | **一次性脚本**(只转用户本机,不进 migrate-config.ts) |
| TUI | **一并改**(repl / run / runs / arena / main) |
| onboarding | **重写**成写 `modelConnections` / `credentials` / `defaults` |
| aux 模型 | 走 `defaults.auxText` |

**不在本次范围**:
- 通用 param `wire` 映射(目前只有 reasoning 接线,其余 paramValues 不下发 —— 独立工作)
- builtin catalog 用 rules.ts 数据填充
- AI 辅助生成 catalog 的 skill

---

## 3. 架构:单一共享解析器

### 3.1 新增 `resolveLLMConfigForTag`

核心是抽出一个所有 boot path 共用的纯函数,放在 core(建议 `packages/core/src/engine/resolve-llm-config.ts`):

```typescript
/**
 * settings + tag + 可选偏好实例 id → 可直接用的 LLMConfig。
 * text 走 modelEntriesFromConnections → ModelPool.toLLMConfig;
 * 选择优先级:preferredId → defaults[tag] → 首个可用实例。
 * 返回 null 表示该 tag 下没有任何可用连接(调用方据此报明确错误)。
 */
export function resolveLLMConfigForTag(
  settings: ValidatedSettings,
  tag: "text",                 // 本次只处理 text;image/video 已有独立 resolver
  preferredInstanceId?: string,
): LLMConfig | null;
```

实现复用现成零件(全部 production-ready,无需重写):
- `getMergedCatalog()` → catalog
- `modelEntriesFromConnections(modelConnections, credentials, catalog)` → `ModelEntry[]`
- 构造一个临时 `ModelPool`,`register` 这些 entry → `toLLMConfig(entry)`

**谁用 resolver、谁用 Engine seed —— 关键澄清**:

- `new Engine({ llm })` 的所有调用方(agent-server stdio/tcp、automation-host、dream-service)目前手搓 `llm` 当**种子**,Engine ctor 里的 `populateModelPoolFromSettings` 随后会用统一 catalog **重写** `config.llm`。问题在于种子是脏 legacy 值,且重写在某些时序下没盖住(本次 bug)。
  - **改法**:这些调用方改用 `resolveLLMConfigForTag(settings,"text",settings.defaults?.text)` 产出种子。种子从此就是统一 catalog 的正确值,与后续 pool 重写一致,消除"种子 vs 重写"的不一致窗口。
- **engine 自身** `populateModelPoolFromSettings` 删掉 legacy 分支后,继续维护长生命周期 ModelPool(支持 `/model` 热切换),走已有的 connection 注册 + `defaults.text` 解析路径 —— 不调 `resolveLLMConfigForTag`(它自有 pool)。
- **TUI 命令**(repl/run/runs)不经 Engine ctor 的部分,直接用 `resolveLLMConfigForTag` 拿 config。

即:`resolveLLMConfigForTag` 是「**种子 + 无 pool 的轻量场景**」的统一入口;engine 内部的 pool 解析是「**有热切换需求**」的场景。两者底层复用同一批零件(`modelEntriesFromConnections` / `toLLMConfig`),不会逻辑分叉。

### 3.2 aux 解析

`resolveAuxKey(settings)` 已优先读 `defaults.auxText`(删 `auxModelKey` 分支后只读它)。返回 key 后,engine 用 `pool.resolveLLMConfig(key)` 拿 config —— 已有逻辑,不动。

### 3.3 数据流(改造后)

```
settings.json
  ├─ modelConnections[] ─┐
  ├─ credentials[]       ├─→ resolveLLMConfigForTag(settings,"text",defaults.text)
  ├─ defaults.text ──────┘         │
  └─ (无 legacy 字段)               └─→ LLMConfig → LLM client
```

---

## 4. 改动清单

### 4.1 Core

| 文件 | 改动 |
|---|---|
| `settings/schema.ts` | 删 `model` / `models` / `providers` / `activeKey` / `auxModelKey` / `fallbackModelKeys` 字段定义 |
| `engine/resolve-llm-config.ts` | **新增** `resolveLLMConfigForTag`(共享解析器) |
| `engine/engine.ts:747-882` | `populateModelPoolFromSettings` 删 legacy 分支(773-799 的 `models[]` 注册、793-796 的 `providers[]` ProviderCatalog、818-835 的 `activeKey`/`model.name` fallback);只保留统一 catalog 路径 |
| `engine/aux-key.ts` | 删 `auxModelKey` fallback,只读 `defaults.auxText` |
| `engine/engine.ts` fallback | 删 `fallbackModelKeys` 消费(`resolveFallbackClients`) |
| `cli/agent-server-stdio.ts:99` | 改调 `resolveLLMConfigForTag(settings,"text",settings.defaults?.text)`;null 时抛明确错误 |
| `cli/agent-server-tcp.ts:45` | 同上 |
| `onboarding.ts:620` | `appendOnboardingResult` **重写**:写 `credentials` + `modelConnections` + `defaults.text`,不再写 legacy |

### 4.2 TUI

| 文件 | 改动 |
|---|---|
| `cli/commands/repl.ts` | 删 `settings.model.*` / `providers[]` fallback,改调共享解析器 |
| `cli/commands/run.ts` | 删 `activeKey`→`models[]` 匹配 + `model.*` fallback,改调共享解析器 |
| `cli/commands/runs.ts` | 同 run.ts |
| `cli/main.ts`(arena) | arena participants 当前按 `models[].key` 解析 → 改按 `modelConnections[].id` |
| `cli/commands/builtin/extra-commands.ts` | `/api-key` 命令若写 legacy,改写 credentials(或废弃) |
| `ui/onboarding-runner.ts` | 适配重写后的 `appendOnboardingResult` 参数 |

### 4.3 Desktop

| 文件 | 改动 |
|---|---|
| `main/automation-host.ts:106` | 改调共享解析器(text tag) |
| `main/dream-service.ts:65` | 改调共享解析器;dream 用 aux 模型 → `resolveAuxKey` + pool |
| `renderer/App.tsx:2758` | `resolveActiveKey` 的 legacy `activeKey` fallback 删除,只读 `defaults.text` |
| `renderer` 其它 | 删读 `models[]` 作为 model picker 选项的地方(改读 modelConnections) |

### 4.4 一次性迁移脚本

`scripts/migrate-legacy-models.mjs`(独立,不进 migrate-config.ts):
- 读 `~/.code-shell/settings.json`
- 对每个 legacy `models[]` 条目:生成 `credentials[]`(按 providerKey/apiKey/baseUrl 去重)+ `modelConnections[]`(tag=text,catalogId 按 provider 猜或用 "custom")
- `activeKey` → `defaults.text`;`auxModelKey` → `defaults.auxText`
- 删除 legacy 字段,备份原文件
- 幂等:已迁移(无 legacy 字段)则跳过

> 注:catalogId 映射是迁移脚本的难点 —— legacy `models[]` 没有 catalogId 概念。策略:按 `provider`/`baseUrl` 匹配 builtin catalog 的 entry id(如 `api.deepseek.com` → `deepseek`);匹配不到则建一个 user catalog 模板或标 `custom`。脚本跑完打印每条的映射结果供用户核对。

---

## 5. 错误处理(顺带修的真 bug)

当前 engine.ts:837 `if (matchKey)` **无 else**:选中的模型在 pool 里解析不到时,静默沿用 seed 阶段的空 env 兜底配置 → 抛误导性的 `OPENAI_API_KEY missing`。

改造后**强制**:`resolveLLMConfigForTag` 返回 null(无可用连接)时,各 boot path **抛明确错误**:
> `当前选中的文本模型 "<id>" 没有可用连接,请在「连接」页添加并填写凭证。`

这样"选了个没配好的模型"会给清楚提示,而非误导性的 SDK 原生报错。

---

## 6. 测试策略(TDD)

每步先写失败测试:

1. **`resolveLLMConfigForTag`** 单测:给定 settings + tag + preferredId,返回正确 LLMConfig;无连接返回 null;preferredId 不存在时回退 defaults;defaults 不存在回退首个。
2. **迁移脚本** 单测:legacy fixture → 期望的 modelConnections/credentials/defaults;幂等性;catalogId 映射。
3. **engine.populateModelPoolFromSettings** 回归:删 legacy 分支后,纯 modelConnections 的 settings 仍能解析出 active 模型。
4. **onboarding** 单测:`appendOnboardingResult` 写出的是 modelConnections/credentials/defaults,且能被 `resolveLLMConfigForTag` 解析。
5. **boot path 冒烟**:agent-server stdio seed 出的 config 模型名正确(回归本次 `glm-5.2[1m]` bug —— 脏 legacy 字段已不存在,不可能再泄漏)。
6. **schema 删字段** 后,旧 settings.json(含 legacy 字段)经 schema 解析不报错(zod 默认忽略未知字段;但要确认没有 `.strict()`)。

测试经包名走 dist → 改 core 后必 `rebuild`(项目惯例)。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| agent-server bootstrap 是 worker 第一个 client,零 fallback,改错直接全挂 | 先写 seed 冒烟测试;改完在 worktree 真机跑 desktop 验证 |
| 迁移脚本 catalogId 映射不准 → 连接解析不出 | 脚本打印映射结果让用户核对;保留备份;匹配不到标 custom 而非丢弃 |
| onboarding 重写写崩 → 首次体验全坏 | TDD;保留旧 `appendOnboardingResult` 测试改造为新形状断言 |
| 删 schema 字段后旧配置解析报错 | 确认 SettingsSchema 非 strict;迁移脚本先跑把字段清掉 |
| TUI arena 按 models[].key 解析 → 改 id 后旧 arena 配置失效 | 迁移脚本一并转 arena.participants;或 arena 暂保留宽松匹配 |
| desktop renderer 仍有读 models[] 的角落 | 改造前全仓 grep 一遍 `\.models\b` / `activeKey` 消费点 |

---

## 8. 实施顺序(建议)

1. 新增 `resolveLLMConfigForTag` + 单测(不删任何东西,纯新增)
2. 各 boot path 逐个改调它(core → desktop → TUI),每个改完跑测试
3. 重写 onboarding
4. 写迁移脚本 + 跑用户本机数据(此时 settings 转成纯统一 catalog)
5. 删 schema 的 legacy 字段 + 清理所有残留读取点
6. 全量回归 + rebuild + 真机冒烟

每步独立可验证,中途任何一步出问题都能停下来不影响已切换的部分(因为统一 catalog 路径本就并存可用)。

---

## 9. 验收标准

- [ ] `settings.json` 不再含 `model` / `models` / `providers` / `activeKey` / `auxModelKey` / `fallbackModelKeys`
- [ ] 全仓无任何代码读上述字段(grep 干净)
- [ ] 所有 boot path(agent-server / engine / TUI / automation / dream / onboarding)经统一 catalog 解析模型
- [ ] 选中未配置模型时报明确错误,非 `OPENAI_API_KEY missing`
- [ ] 迁移脚本把用户现有 8 条 models[] + 6 个 providers[] 正确转成 modelConnections/credentials,模型可正常跑
- [ ] 真机:desktop 切各模型 + 新建连接 + onboarding(若可达)全部跑通
