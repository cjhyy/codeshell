# 模型 adapter/catalog 去写死评估

**日期**: 2026-06-23
**状态**: 评估稿 / 待讨论(暂不动手)
**触发**: 用户观察「adapterKind 可以是 openai/google/fal,很多内容不需要写死,不对的 LLM 自己知道优化」—— 评估这套模型系统还能怎么减少每-provider 的写死逻辑、改成 catalog 数据驱动。

---

## 0. 一句话结论

现状的写死**不是设计成写死,而是「半成品 + 接线漏了」**:三个机制(`wire.field` 参数下发、`adapterKind` 路由、`shape` 泛型 adapter)都**已声明甚至已实现,但没接进生产代码**。接上它们,就能把「参数下发」和「provider 上车」从写死改成数据驱动。但**厂商 HTTP 契约差异**(rules.ts)是本质复杂度,不能也不该砍。

用户「让 LLM 自己优化」的直觉:
- ✅ 对**参数**(temperature 等)—— 该 catalog 数据驱动,机制已造好(`applyParams`),只差接线。
- ✅ 对**图片/视频返回**(死数据 base64)—— 该 `shape` 驱动泛型提取,省掉每家写 class。
- ❌ 对**文本对话** —— 返回是引擎控制流(工具调用/循环),rules.ts 那些(token 字段名、被拒参数、reasoning 形状)是真实厂商差异,LLM 改变不了 HTTP 契约。

---

## 1. 现状事实(2026-06-23 代码审计)

### 1.1 三模态 dispatch

| 模态 | dispatch 位置 | 注册的 kind | 未知 kind |
|---|---|---|---|
| TEXT | `llm/client-factory.ts:21-33` | anthropic, openai | **抛错** |
| IMAGE | `tool-system/builtin/image-providers.ts:222-231` | openai, google | 返回 null(不可用) |
| VIDEO | `tool-system/builtin/video-providers.ts:270-279` | fake, fal | 返回 null(不可用) |

### 1.2 三个「建好但没接」的机制

**(A) `wire.field` 参数下发 —— 90% 建好,0% 接线**
- `model-catalog/params.ts:16-29` 的 `applyParams(values, params)` 能把**任意 paramValues 按 `wire.field` 写进请求体**(支持深路径如 `thinking.type`)。测试通过。
- **但生产代码从不调用它**(全仓 grep 仅测试调用)。
- 现状只有 `reasoning` 一个参数被手工提取(`engine/model-connections-pool.ts:26-36` 的 `reasoningFromParamValues`),其它 paramValues(temperature/top_p/max_tokens/thinking_type)**全丢**。
- **后果**:catalog 给 Zhipu 声明了 temperature/top_p/max_tokens/thinking_type + wire field(builtin.ts ZHIPU_PARAMS),但用户**根本设不了** —— catalog 在「广告」没接线的参数。

**(B) `adapterKind` 对文本是死字段**
- `engine/model-connections-pool.ts:17-19` 的 `clientProvider()` **只看 protocol**(anthropic-style → anthropic,否则 openai),**忽略 adapterKind**。
- 即 catalog 写 `adapterKind: "deepseek"/"zai"/"groq"` 对文本无效,全路由到 OpenAIClient。
- 而 `client-factory` 只认 "anthropic"/"openai",填别的 kind 直接抛错。
- **矛盾**:一边忽略 adapterKind(暗示「OpenAI 兼容的都走一个 client」),一边 factory 不接受未知 kind → 新的 OpenAI 兼容 provider(groq/mistral)**无法零代码上车**。
- (image/video **会**消费 adapterKind:`gen-connections.ts` 用它选 provider —— 但那也是 switch,未知 kind 返回 null。)

**(C) `shape` 字段纯装饰**
- `model-catalog/types.ts:83` 定义 `shape: "generic-sync" | "fal-queue"`。
- catalog 里 image 用 `generic-sync`、video 用 `fal-queue`。
- **运行时零消费**(全仓 grep,从不读取)。dispatch 全靠 kind switch。
- 本应:`shape` 驱动泛型 adapter(`generic-sync` = 同步返 base64 的统一走一个泛型提取器,按 catalog 配的 JSON 路径取图),但现在每家写一个 class。

### 1.3 rules.ts 写死的(必要的本质复杂度)

`llm/capabilities/rules.ts` 按 (kind, model 正则) 硬编码厂商 HTTP 契约差异:
- token 字段名(`max_tokens` vs `max_completion_tokens`)
- 被拒采样参数集(gpt-5+ 拒 temperature/top_p 等)
- reasoning 形状(openai-effort / deepseek-thinking / anthropic-budget)+ 支持的 effort 档 + disabledEffort + echo 行为
- vision 支持、output token 上限、parallel tool calls 标志形状

**这些是真实厂商差异,LLM 无法改变 HTTP 契约 → 必须有地方声明。** 是否该从 rules.ts 迁到 catalog 是「位置」问题,不是「能否消除」问题(见 §3 讨论)。

---

## 2. 能砍 vs 不能砍

| 写死点 | 能否数据驱动 | 依据 |
|---|---|---|
| 参数下发(temperature/top_p/max_tokens/thinking) | ✅ 能,机制已造好 | `applyParams` 已实现,只差调用 |
| 未知 OpenAI 兼容 text provider 上车 | ✅ 能 | adapterKind/factory 对齐即可 |
| image/video adapter(返回是死数据) | ✅ 能(泛型化) | shape 驱动泛型提取器 |
| 文本工具调用/循环/流式解析 | ❌ 不能 | 引擎控制流,厂商结构不同需翻译 |
| rules.ts 厂商契约差异 | ⚠️ 能搬不能消 | 可从 rules.ts 迁到 catalog params,但差异本身永远要声明 |

---

## 3. 三项优化方案(按价值/风险排序)

### P1 — 接上 `applyParams`(最高价值,基础已就绪)
**做什么**:在请求构造时调用 `applyParams(connection.paramValues, preset.params)`,把结果合并进请求体。让 catalog 声明的任意参数真正下发。
**收益**:catalog 声明参数即生效,无需在 client 写死每个参数怎么发。直接解决「Zhipu 参数设不了」。
**风险/边界**:
- 要碰 client 请求构造层(openai.ts），需与现有 sampling 规则(rules.ts 的 rejectedParams）协调 —— `applyParams` 下发的参数仍要过 rejectedParams 过滤,否则给 gpt-5 发 temperature 会 400。**这是设计要点:applyParams 是「按 catalog 下发」,rejectedParams 是「按厂商契约拦截」,两者叠加。**
- ⚠️ **依赖**:`builtin.ts` 正被在途会话大改(Zhipu/OpenAI/OpenRouter catalog 扩充 + live-verify,2026-06-23 未提交)。P1 直接读这些 params,**必须等在途工作落地或协调**,否则冲突。

### P2 — adapterKind / factory 对齐(未知 provider 零代码上车)
**做什么**:
- `client-factory` 对未知但 protocol=openai-compat 的 kind,回退到 OpenAIClient(而非抛错)。
- 或 `clientProvider()` 改为认 adapterKind + protocol。
**收益**:新增 OpenAI 兼容 text provider(groq/mistral/任意)只需 catalog 条目,零代码。对齐用户「custom 该能用」诉求。
**风险**:低。但要确认 rules.ts 的 capability 回退(未知 kind 用哪套请求形状规则)—— 默认 openai 形状通常安全。

### P3 — shape 驱动泛型 image/video adapter
**做什么**:让 `shape: "generic-sync"` 走一个泛型 adapter,按 catalog 配置的请求模板 + 响应 JSON 路径(base64 在哪)提取,而非每家写 class。`fal-queue` 同理泛型化三段式轮询。
**收益**:新增图片/视频 provider 零代码(只配 catalog)。砍掉 image-providers.ts / video-providers.ts 的 per-kind class。
**风险**:中。图生图(multipart/inline_data）、轮询协议差异需要 shape 配置足够表达力;过度泛化反而难维护。需权衡「泛型配置复杂度 vs 每家一个薄 class」。**可能结论是「不值得」**(image adapter 才 ~70 行)。

---

## 4. 与现有工作的关系

- **依赖在途 builtin.ts**:P1 读 catalog params,撞别的会话正在改的 Zhipu/OpenAI catalog 扩充。**必须等其落地**。
- **关联设计稿**:`docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md`(统一 catalog 原始设计 —— wire/params 机制就是那时埋的口,P1 是兑现它)。
- **已合并**:legacy 删除(merge b1037789)—— 本评估建立在「统一 catalog 已是唯一存储」的基础上。

---

## 5. 待用户决策

1. **做哪几项?** P1(参数下发)价值最高且基础就绪,建议优先。P2 低风险中价值。P3 可能不值得(薄 class 未必比泛型配置差)。
2. **P1 时机** —— 等在途 builtin.ts(Zhipu 那批)提交后再动,避免冲突。
3. **rules.ts 要不要往 catalog 迁?** 这是更大的方向题(把厂商契约差异从 code 搬到 data)—— 收益是「加 provider 全程不碰 code」,成本是 catalog schema 要表达所有契约维度。本评估倾向:**先做 P1/P2 兑现已有机制,rules.ts 迁移留作独立大议题**,别一次吃太多。

---

## 附:关键 file:line 索引

- 参数下发机制:`packages/core/src/model-catalog/params.ts:16-29`(applyParams,未接线)
- reasoning 唯一接线:`packages/core/src/engine/model-connections-pool.ts:26-36`
- text 路由忽略 adapterKind:`packages/core/src/engine/model-connections-pool.ts:17-19`
- text client 工厂:`packages/core/src/llm/client-factory.ts:21-39`
- image dispatch:`packages/core/src/tool-system/builtin/image-providers.ts:222-231`
- video dispatch:`packages/core/src/tool-system/builtin/video-providers.ts:270-279`
- shape 定义(零消费):`packages/core/src/model-catalog/types.ts:83`
- 厂商契约写死:`packages/core/src/llm/capabilities/rules.ts:28-262`
- 采样参数过滤:`packages/core/src/llm/providers/openai.ts:294-298`
