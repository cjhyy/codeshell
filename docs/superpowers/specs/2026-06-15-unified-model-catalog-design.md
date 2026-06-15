# 统一模型接入方案 — 设计稿 (Unified Model Catalog)

> 日期:2026-06-15 ｜ 状态:**已拍板,待写实现计划**
> 上游:`docs/superpowers/specs/2026-06-11-model-catalog-design.md`(Catalog v1,仅 image/video)
> 缘起:原 TODO「连接页 ModelSection 深度重排」经用户拍板升级为「文本+图+视频统一模型接入架构」。
> 关联记忆:[[project_unified_model_catalog_design]]、[[project_model_catalog]]、[[project_connections_ui_overhaul]]。

---

## 0. 一句话

把现在**两套不相通**的模型接入(LLM 走 `providers[]/models[]` + 硬编码 `KIND_META`;图/视频走 Catalog v1)**统一成一套** Catalog 驱动的数据模型:文本/图/视频共用一个 `CatalogEntry` 结构,靠 `tag` 分类、靠「哪家公司」分组;**每个模型的参数能力(reasoning 档位/size/quality/…)以数据形式声明在 catalog 里,一份声明同时驱动连接页控件渲染 + 注入工具描述**;用户/以后 AI 加一条 catalog → 连接页自动渲染出添加表单 → 填(或复用)key → 就能用。

---

## 1. 背景:现状是两套割裂的数据模型

| | **LLM(文本)** | **图 / 视频** |
|---|---|---|
| 数据模型 | `settings.providers[]`(凭证)→ `models[]`(实例),**两级** | core `BUILTIN_CATALOG` + `user.json` → `settings.imageGen/videoGen.providers[]`,**单级** |
| 元数据位置 | renderer 硬编码 `KIND_META` / `RECOMMENDED_MODELS` | core catalog(集中、可被 user.json 扩展) |
| 模型集 | 无限(fetch /models + 推荐 + 手填) | 有限(`modelPresets`) |
| key 复用 | 无(每 model 各自覆盖) | `apiKeyRef`(跨实例借用) |
| 默认 | `activeKey`(模型粒度)+ `auxModelKey` | `defaultProvider`(实例粒度) |
| UI | `ModelSection.tsx`(1896 行,provider→models 折叠卡片) | `GenConnectionsPanel`(单层实例卡片,共享 `connUi.tsx`) |

**Catalog v1 设计文档(§1⑤)当时明确「文本不纳入」。** 本设计推翻这条,把文本收进同一套 catalog。

### 现成可复用的基建(不从零写)

- **`packages/core/src/model-catalog/`** — `CatalogEntry` + `getMergedCatalog()`(内置 ∪ user.json,同 id 用户覆盖)+ `findCatalogEntry()`。本设计扩展它。
- **`packages/core/src/llm/capabilities/`** — `rules.ts` 按 `(kind, modelId)` 匹配 → `Capability` → 投影成 `ReasoningControl`(`effort`/`budget`/`toggle`/`adaptive`);**UI 只 `switch(control.kind)` 不 branch provider**。这正是「按模型决定渲染什么控件」的现成范式,本设计把它的**数据**搬进 catalog(见 §4)。
- **`effectiveApiKey()`**(`generate-image.ts`)— `apiKeyRef` 解引用,本设计推广到统一实例。
- 运行时 `getImageProvider/getVideoProvider` 的 `adapterKind` switch + 各 adapter 类 — **全部不动**,catalog 只声明指向。

---

## 2. 业界调研结论(支撑设计决策)

来源:deep-research(`wf_5f94e760-567`,23 源 → 103 claim → 22/25 对抗验证通过)。

1. **凭证 vs 参数分层是业界谱系**:Vercel AI SDK 分得最彻底(凭证在 provider 实例、参数走 middleware,一实例派生多模型别名);LiteLLM 默认混居但提供 `credential_list` + `litellm_credential_name` **命名引用**复用(官方目的:密钥轮转 + 去重)。→ **印证我们 `apiKeyRef` 按名引用的方向。**
2. **能力即数据**:OpenRouter `/api/v1/models` 的 `supported_parameters` + 统一 `reasoning` 对象(`effort` 枚举 **或** `max_tokens` 数值,二选一互斥,跨 provider 归一化)。→ **对应我们 `ParamSpec`。**
3. **无完整先例**:没有任何一家做到「一份声明式 catalog 同时驱动 UI 控件渲染 + 注入工具描述」——OpenRouter 把「支持哪些参数」(机器可读)与「参数 type/range/enum」(人读文档)分两处。→ **我们要做的是有价值的新设计;参数声明这块得自己合并,但有 `capabilities` 范式打底。**
4. **关键洞察(推翻裸 modelId 全局匹配)**:OpenRouter 自己做了归一化,**同一 modelId 经不同接入(OpenRouter vs 官方),参数 schema 不同**。→ **参数能力必须绑在「接入模板」上(per-entry-per-model),不能按裸 modelId 全局匹配。**
5. **caveat**:这些枚举随模型漂移(Claude 4.7+ 改 `output_config.effort`)。→ **参数数据应可编辑,而非用测试锁死。**

---

## 3. 数据模型(核心)

三层,**模板/实例分离**(沿用 Catalog v1 分法,推广到文本):

```
┌─ 模板层(catalog)= "能配哪些" ───── 独立文件,不在 settings ─┐
│  内置:  core BUILTIN_CATALOG          (随 app)                    │
│  用户/AI: ~/.code-shell/model-catalog.user.json                  │
│          扩 tag 含 text;每条 = 一家公司的一种接入模板            │
└──────────────────────────────────────────────────────────────┘
            ↓ 用户在连接页"挑模板 → 添加 → 填/复用 key"
┌─ 实例层 = "配了哪些" ───────────────── 留 settings.json ────┐
│  settings.modelConnections[]  (统一替代 providers/models/imageGen)│
└──────────────────────────────────────────────────────────────┘
```

### 3.1 公司接入层 — `CatalogEntry`(扩展现有)

```ts
interface CatalogEntry {
  id: string;                          // "openai" / "openrouter" / "anthropic" / "fal-video"
  tag: "text" | "image" | "video";    // ← 扩了 text;UI 据此分区
  adapterKind: string;                 // 运行时适配器:"openai"|"anthropic"|"google"|"fal"
  protocol?: "openai-compat" | "anthropic-style";  // 文本客户端协议
  shape?: "generic-sync" | "fal-queue";            // 仅文档/未来用(沿用 v1)
  displayName: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel?: string;
  signupUrl?: string;                  // "获取 key" 链接
  needsKey?: boolean;                  // ollama 等本地 = false
  test?: boolean;                      // 连接页是否给"测试"按钮(image=true)
  modelPresets?: ModelPreset[];        // 该接入下推荐/已知模型,各带参数 schema
}
```

### 3.2 模型能力层 — `ModelPreset` + `ParamSpec`(本设计的心脏)

参数能力**绑在 entry 的 modelPreset 上**(per-entry-per-model),解决「OpenRouter 归一化后参数与官方不同」:

```ts
interface ModelPreset {
  value: string;                 // modelId,如 "gpt-5.5"
  label?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  params?: ParamSpec[];          // 这个模型支持哪些参数(没声明 = 无可调参数)
}

// 一个【通用】结构,无特殊判断 —— reasoning 不再是专门 variant,
// 它就是 control=enum(OpenAI effort 档位)还是 control=number(Anthropic budget)的区别。
interface ParamSpec {
  name: string;                  // "reasoning" / "size" / "quality" / "temperature" / ...
  label?: string;                // UI 控件标签(留空用 name)
  control: "enum" | "number" | "toggle" | "text";
  options?: string[];            // control=enum:["low","medium","high","xhigh"]
  min?: number;                  // control=number
  max?: number;
  default?: string | number | boolean;
  doc?: string;                  // 自然语言:这个参数干什么/怎么用 → 拼进 paramsDoc 注入工具描述
  wire?: WireSpec;              // 可选:该参数落到请求体的哪个字段(归一化差异在此表达)
}

// wire 描述「UI/逻辑层的 paramValue」如何映射到「实际请求体字段」。
// reasoning 在 OpenAI 落 reasoning_effort、在 Anthropic 落 thinking.budget_tokens —
// 同名参数、不同落点,由 wire 表达,避免引擎里写死 if (kind===...)。
interface WireSpec {
  field: string;                 // 请求体字段名,如 "reasoning_effort" / "thinking.budget_tokens"
  // 形态由 adapter 决定;最小版只需 field,复杂映射后续按需扩。
}
```

**渲染 + 注入两用**(业界没有的合并):
- **连接页控件**:遍历选中 model 的 `params[]`,`switch(control)` 渲染 4 种控件(下拉/数字/开关/文本框)。UI 只认 `control`,不认公司。
- **工具描述注入**:每个已配实例,把其 model 的 `params[].doc` 拼成参数说明,注入 `GenerateImage/GenerateVideo`(及文本聊天的相关工具)描述 → agent 知道传什么。

**例**:
- `gpt-5.5` 的 OpenAI entry preset:`params: [{name:"reasoning", control:"enum", options:["low","medium","high","xhigh"], default:"medium", wire:{field:"reasoning_effort"}}]`
- `gpt-4o`:`params: []`(无 reasoning)→ 连接页不渲染思考控件。
- `claude-opus-4-x`(≤4.5):`params:[{name:"reasoning", control:"number", min:1024, default:4096, wire:{field:"thinking.budget_tokens"}}]`
- `gemini-2.5-flash-image`:`params:[{name:"size",control:"enum",options:[...]},{name:"quality",control:"enum",options:[...],doc:"该后端忽略 quality"}]`

### 3.3 实例层 — `ModelInstance`(留 settings,统一替代三套)

```ts
// settings.modelConnections[] —— 替代 providers[]/models[]/imageGen.providers/videoGen.providers
interface ModelInstance {
  id: string;                    // 用户取的唯一名:"my-gpt5" / "fal-seedance"
  catalogId: string;             // 指向 CatalogEntry(回取 adapterKind/protocol/params)
  tag: "text" | "image" | "video";  // 冗余自 catalog,方便按 tag 查/分区
  model: string;                 // 选中的 modelId(来自 entry.modelPresets[].value)
  baseUrl?: string;              // 覆盖 catalog 默认
  apiKey?: string;               // 直填
  apiKeyRef?: string;            // 或:命名引用另一实例的 key(凭证按公司复用)
  paramValues?: Record<string, unknown>;  // 用户为该实例选的参数值:{ reasoning: "high" }
}

// 默认指向(按 tag 各一个),替代 activeKey / defaultProvider
settings.defaults: {
  text?: string;                 // = 某 instance id(替代 activeKey)
  image?: string;
  video?: string;
  auxText?: string;              // 后台任务模型(替代 auxModelKey)
}
```

**分工**:「能选什么」在 catalog(`params`),「选了什么」在实例(`paramValues`)。

---

## 4. 内置数据来源:rules.ts → catalog 种子

现有 `capabilities/rules.ts` 已有一份带 vendor 文档出处的能力知识(reasoning/vision/rejectedParams/maxOutputTokens)。**一次性导入**成内置 catalog 的 `params`(可写脚本生成),导入后其归宿 = **可编辑的 catalog 数据**(用户/AI 可改 user.json)。

**不再用测试锁死参数数据**(用户决策):catalog 本质是数据,数据该可被改/填/AI 生成;研究 caveat 印证这些枚举一直漂移,锁死是错的方向。`rules.ts` 的运行时投影逻辑(`reasoningControlFor` → control 形状)仍可保留作为「实例运行时把 paramValues 落请求体」的执行器,但**数据源头变成 catalog**。

> 待实现计划细化:导入脚本的形态(一次性生成 builtin.ts vs 运行时读)、rules.ts 投影逻辑保留多少。

---

## 5. UI(renderer):底层一套,文本可单独渲染

**底层一套**(同一份 catalog + 同一实例模型 + 同一 `resolveInstance`);**UI 层文本可有自己的渲染分支**(用户明确:文本特殊可单独渲染)。

- **图/视频**:沿用 `GenConnectionsPanel` + `connUi.tsx` 单层实例卡片(已迁 shadcn,42ff471),数据源换成统一 catalog/实例。
- **文本**:`ModelSection` 重做——不再 provider→models 两级折叠,改为「catalog 模板挑选 → 实例卡片」,参数控件由 `params[]` 数据驱动(`switch(control)`)。复用 `connUi` 共享底座。
- **添加流程**:`[+ 添加]` → 按 tag 列 catalog 模板(`getMergedCatalog()` 过滤)→ 选模板 + 选 model(modelPresets)→ 一卡建好(baseUrl/默认参数来自模板)→ 填/复用 key → 保存。
- **移除**:fetch /models、连接页手填任意 modelId、「列表外模型参数回退链」——连接页**只渲染 catalog 里有的模型**。没的模型 → 让 AI 查文档生成 catalog / 用户改 user.json(见 §7)。

---

## 6. 运行时消费:统一解析器

```
resolveInstance(id):
  inst = settings.modelConnections.find(id)
  entry = findCatalogEntry(catalog, inst.catalogId, fallback=adapterKind)
  adapter = pickAdapter(entry.adapterKind)          // 复用现有 switch,不动
  apiKey  = inst.apiKey ?? resolve(inst.apiKeyRef)  // effectiveApiKey 推广
  preset  = entry.modelPresets.find(inst.model)
  request = applyParams(inst.paramValues, preset.params)  // 按 wire 落请求体
  toolDoc = preset.params.map(p => p.doc)           // 注入工具描述
```

文本/图/视频**同一个 `resolveInstance`**,只是 `adapterKind` 不同 → 真正「底层一套」。各能力入口(聊天、GenerateImage、GenerateVideo)都走它。

---

## 7. AI 辅助加 catalog — 本轮留口,不实现

用户构想:chat 里说「我要用 XX 家的图片生成模型」→ AI 搜文档 → 抽取地址/modelId/参数/paramsDoc → 写一条 catalog → 用户即可在连接页添加使用。

**本轮只做底座**:catalog 数据可数据化、user.json 可被程序安全写入(校验 + 幂等)。**搜索/抽取/AI 写入工具留到下一期**。数据结构(§3)已为它设计——`ParamSpec` 是声明式、可被 AI 生成。

---

## 8. 不做 / YAGNI

- ❌ 向后兼容旧 `providers[]/models[]/imageGen/videoGen` 手填数据(产品未发布,用户:「不管」)。
- ❌ fetch /models(价值低,只给裸 id)。
- ❌ 连接页手填任意 modelId(自加戏的回退链)。
- ❌ reasoning 特殊 variant(统一进通用 `ParamSpec`)。
- ❌ 用测试锁死参数数据(catalog 是活数据)。
- ❌ AI 自动搜索/写 catalog 的实现(本轮只留口)。
- ❌ 远程 catalog 更新、audio tag、重命名现有 adapter(沿用 v1 的 YAGNI)。

---

## 9. 验收

1. 连接页文本/图/视频三类都能「挑模板 → 添加 → 填/复用 key → 设默认」,UI 同一套底层。
2. 选 `gpt-5.5` 实例,连接页自动渲染 reasoning 4 档下拉;选 `gpt-4o` 不渲染——纯由 catalog `params` 数据驱动,无 UI 硬编码。
3. 某实例 `apiKeyRef` 指向另一实例,保存后落盘,运行时解析到被引用的 key。
4. 已配实例的 `params[].doc` 出现在 `GenerateImage/GenerateVideo`(及文本工具)描述里。
5. 用户在 `model-catalog.user.json` 加一条 `tag=text` 模板(带 params)→ 连接页文本组出现它,零 UI 代码改动,加完即可配、控件按 params 自动渲染。
6. core `tsc` + 相关 test 过;desktop `tsc --noEmit` + `build:renderer` 过。

---

## 10. 开放问题(写实现计划时定)

1. **rules.ts 导入形态**:一次性生成内置 catalog vs 运行时把 rules 投影合进 catalog。
2. **wire 映射的复杂度边界**:最小版只需 `field`;Anthropic 嵌套字段(`thinking.budget_tokens`)、二选一互斥(effort vs budget)等复杂映射做到哪。
3. **`paramValues` 的校验**:实例存的值是否对照 `params` 校验(枚举越界/范围),还是宽松透传。
4. **文本 UI 分支与 connUi 的复用边界**:文本卡片多大程度共用 `connUi`。
