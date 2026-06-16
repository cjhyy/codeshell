# 模型接入 Catalog — 实现设计 (v1)

> 日期：2026-06-11 ｜ 状态：**已拍板,实现中**
> 上游讨论稿：`docs/archive/model-catalog-讨论稿.md` (v0.1)
> 本文档把讨论稿的「待拍板」全部定下,并并入用户在 `/goal` 里追加的三条需求,作为实现锚点。

---

## 0. 一句话

把散在两个 renderer 文件里写死的 `ProviderMeta[]` 收敛成 **core 里一份集中的 catalog**;用户在连接页**从 catalog 挑模板 → [+ 添加] → 填(或复用)key → 设默认**,可以加任意多个图片/视频实例;catalog 每条带 `paramsDoc`,**已配实例的参数说明自动注入 GenerateImage/GenerateVideo 工具描述**,Agent 选了默认模型就知道它支持哪些参数。

---

## 1. 拍板结论(讨论稿 §8 待拍板的最终答案)

| # | 问题 | 结论 |
|---|---|---|
| ① | catalog 与 `providers[]` 关系 | **清单/实例分离**：catalog=只读模板清单(能配哪些),`imageGen/videoGen.providers[]`=已配实例(配了哪些,带 key)。 |
| ② | 用户自定义条目(B)存哪 | **独立** `~/.code-shell/model-catalog.user.json`。 |
| ③ | 语音(audio) | **本版不做**：不加 tag、不加分组、不加适配器。架构上 `tag` 字段保留枚举扩展余地,但不塑形。 |
| ④ | 通用适配器粒度 | 仅 `generic-sync`(同步) + `fal-queue`(异步)两形状,**且不重命名现有 adapter**：`adapterKind` 直接复用现有 `"openai"/"google"/"fal"` 字符串,运行时 switch 与 adapter 类全部不动。catalog 只声明哪条指向哪个已有 adapter。 |
| ⑤ | 文本(LLM)是否纳入连接页 | **不纳入**：文本配置留在模型设置页;连接页只管 image/video。 |

## 1b. /goal 追加的三条需求(本版必须满足)

1. **复用 apiKey**：添加实例时,既能填新 key,也能「复用」另一个已配实例的 key(典型：OpenAI 图片复用 OpenAI 文本的 key,或多个 fal 实例共用一把 fal key)。
2. **可加很多个**：同一 provider 可建多个实例(不同 key / 不同默认模型),各自有唯一 `id`;能设其中一个为默认。**这是相对现状的真实新能力**——现状是「一 kind 一实例」(id≡kind)。
3. **参数自描述**：catalog 每条带 `paramsDoc`(该模型支持/需要哪些参数、各家不一样);**已配实例的 paramsDoc 注入工具动态描述**,Agent 用默认模型时即知参数。

---

## 2. 数据模型

```
内置 catalog (A)   core: BUILTIN_CATALOG: CatalogEntry[]            只读,随 app
用户自定义 (B)     ~/.code-shell/model-catalog.user.json           只读模板清单(用户加的)
合并               mergeCatalog(A,B): 同 id 时 B 覆盖 A
已配实例           settings.json 的 imageGen/videoGen.providers[]   用户填了 key 的实例
```

### CatalogEntry(core 新类型)

```ts
export interface CatalogEntry {
  id: string;              // 模板 id, e.g. "openai-images" / "google-images" / "fal-video"
  tag: "image" | "video";  // 决定进哪个连接页分组(本版只这两类)
  adapterKind: string;     // 运行时 dispatch — 复用现有 "openai"/"google"/"fal"
  shape: "generic-sync" | "fal-queue";  // 仅文档/未来用;运行时仍走 adapterKind
  displayName: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel?: string;
  modelPresets?: Array<{ value: string; label?: string }>;
  signupUrl?: string;
  test?: boolean;          // 连接页是否给「测试」按钮(image=true, video=false)
  paramsDoc?: string;      // 该条目调用时支持/需要的参数说明(注入工具描述)
}
```

- catalog 落 **core**(不是 renderer):probe service(main 进程)、工具描述注入、未来宿主都要读它。
- renderer 通过 IPC `getModelCatalog()` 拿合并后的 `CatalogEntry[]`,不再硬编码 `ProviderMeta[]`。

### 实例(providers[])schema 变化

现有每条 `{ id, kind, baseUrl, apiKey?, defaultModel? }` 保留。**新增两个可选字段**(向后兼容,旧配置不受影响):

```ts
catalogId?: string;        // 这个实例由哪条 catalog 模板创建(用于回显 displayName/paramsDoc/signupUrl)
apiKeyRef?: string;        // 复用:指向另一个实例的 id,运行时取那个实例的 apiKey(此时本实例 apiKey 留空)
```

- 解析 key 时:`apiKey ?? (apiKeyRef 指向实例的 apiKey)`。在 `resolveImageProvider`/`resolveVideoProvider` 里解引用。
- `id` 不再强制等于 `kind`:多实例下 id 形如 `openai`, `openai-2`, `fal-seedance`(由 UI 生成唯一值)。

---

## 3. 运行时(core)改动

### 3.1 catalog 模块 `packages/core/src/model-catalog/`
- `types.ts`：`CatalogEntry`。
- `builtin.ts`：`BUILTIN_CATALOG`(从现 renderer 的两个数组迁来,补 `paramsDoc`/`shape`/`tag`)。
- `index.ts`：`loadUserCatalog()`(读 `~/.code-shell/model-catalog.user.json`,用 `userHome()`,zod 校验,坏文件忽略)+ `getMergedCatalog()`(A∪B,同 id B 覆盖)。

### 3.2 key 解引用(复用)
`resolveImageProvider`/`resolveVideoProvider`:取实例时,若 `apiKey` 空且有 `apiKeyRef`,在同 `providers[]` 里找 `apiKeyRef` 实例的 `apiKey`。`usable()` 判定改成「有效 key(直填或引用)且有 adapter」。

### 3.3 paramsDoc 注入工具描述(需求 3 闭环)
`generateImageToolDefFor`/`generateVideoToolDefFor` 已存在(把已配 provider 名追加进描述)。扩展:对每个已配实例,按 `catalogId`(回退 `kind`)在合并 catalog 里查 `paramsDoc`,把「实例名 → 该模型参数说明」拼进描述。多实例参数不同 → 各列一行。无 paramsDoc 的实例只列名(现有行为)。

> 不改工具 inputSchema:保持泛化 `prompt/size/quality/provider/model`(+ video 的 image/images)。paramsDoc 是给模型的**自然语言提示**,告诉它某模型还认哪些可塞进 prompt 或哪个 model 该配什么——不引入每模型独立 JSON schema(YAGNI,且工具入参是固定的)。

---

## 4. UI(renderer)改动

目标:`GenConnectionsPanel` 从「按固定 ProviderMeta[] 渲染」变成「**渲染已配实例 + 一个 [+ 添加] 入口(从 catalog 挑模板)**」。

### 4.1 数据流
- 进面板:`getModelCatalog()` 拿合并 catalog,按 `tag` 过滤本面板那类;`getSettings()` 拿 `providers[]`(已配实例)。
- 渲染:**每个已配实例一张卡**(沿用现 `GenCard` 标记/样式)+ 末尾一张「[+ 添加]」卡。
- [+ 添加] → 弹 catalog 模板选择(用 desktop 统一 `usePrompt`/`DropdownMenu`,见记忆 [[project_dialog_unification]])→ 选模板 → 生成唯一 `id`(`kind`,冲突则 `kind-2`…)→ 追加一张未配置卡(带 catalogId、默认 baseUrl/model 来自模板)。

### 4.2 复用 key(需求 1)
卡片 API Key 区加一个小切换:「填新 key」/「复用已有」。选「复用」→ 出现一个 SimpleSelect 列出同类**已填 key 的其它实例**(显示 displayName);选中即写 `apiKeyRef`、清空本实例 `apiKey`。保存/解析按 §3.2。

### 4.3 多实例 + 默认(需求 2)
- 同模板可多次 [+ 添加] → 多张卡,各唯一 id。
- 「设为默认」写 `defaultProvider = 实例 id`(已有机制)。
- 「清除」改为「删除此实例」(从 providers[] 移除该 id;若它是默认,默认顺延到下一个可用实例)。

### 4.4 兼容旧 UI 约定
现 `GenConnectionsPanel` 用的是 legacy `conn-card` CSS(非 shadcn)。本版**沿用现有卡片标记**(它已工作、改它属于 scope 外的样式迁移),只改数据层与新增「添加/复用/删除」控件——新增控件用 `@/components/ui`(Button/SimpleSelect)与 DialogProvider hooks,符合 desktop CLAUDE.md。

### 4.5 IPC
- 新增 `window.codeshell.getModelCatalog(): Promise<CatalogEntry[]>`(preload + main handler,main 调 core `getMergedCatalog()`)。
- 写回仍走现有 `writeSettings(scope, { imageGen|videoGen: { defaultProvider, providers } })`。

---

## 5. 不做 / YAGNI

- ❌ 远程 catalog 更新(讨论稿 §7)。
- ❌ audio(③)。
- ❌ 文本进连接页(⑤)。
- ❌ 重命名/重写现有 adapter 为 generic-sync/fal-queue(④:只声明指向)。
- ❌ 每模型独立 inputSchema:paramsDoc 用自然语言提示足够。
- ❌ 用户自定义条目支持怪鉴权:用户 catalog 仅限现有 adapterKind 能跑的。

## 6. 验收

1. 连接页图片组能 [+ 添加] 多个实例(含同 provider 多个),各填不同 key/model,设默认。
2. 某实例选「复用已有」指向另一实例,保存后 `apiKeyRef` 落盘,GenerateImage 用它能解析到被引用的 key。
3. catalog 条目带 `paramsDoc` → 配置后 GenerateImage/GenerateVideo 工具描述里出现该实例的参数说明。
4. 用户在 `~/.code-shell/model-catalog.user.json` 加一条同 `tag=image` 模板 → 连接页图片组 [+ 添加] 列表里出现它,零 UI 代码改动。
5. 旧配置(id≡kind、无 catalogId/apiKeyRef)照常工作。
6. core `tsc`/相关 test 过;desktop `tsc --noEmit` + `build:renderer` 过。
