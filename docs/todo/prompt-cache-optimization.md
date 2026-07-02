# Prompt 缓存优化 — 对标 Claude Code

> 状态:步骤 1(命中率可见)+ 步骤 2(tools 断点)+ 步骤 3(messages 末尾断点)已落地;步骤 4 待整体设计。2026-06-26 整理,2026-07-02 更新。
> 背景:codeshell 当前缓存覆盖面极窄,且命中率不可见。本稿记录 CC 的真实做法
> (扒自 CC sourcemap)、codeshell 现状差距、以及分步计划。
> 关联记忆 `project_prompt_cache_gaps`。

## 一、codeshell 现状(已核实)

- **只有一个缓存断点**:Anthropic provider 在 systemPrompt 末尾挂了一个
  `cache_control: ephemeral`(`packages/core/src/llm/providers/anthropic.ts:187, 234`)。
- **messages 数组零断点**:73 个工具定义 + 全量对话历史 + memory 注入全裸跑。
  turn-loop 是累积式 `messages.push`,`buildMessages` 只剥 vision、不截断,
  **每轮全量重发历史**(promptTokens 实测从 27k 累积涨到 50k+)。
- **OpenAI 命中没采对**:`openai.ts:250` 读的是 `response.usage?.cacheReadTokens`,
  但 OpenAI 真实字段是 `usage.prompt_tokens_details.cached_tokens` → 几乎永远 undefined。
  反直觉点:OpenAI 缓存是**自动**的(无需手动标记),gpt-5.5 很可能一直在命中,
  只是 codeshell 读错字段**看不见**。
- **命中率完全不可见**:`llm.request` 日志只有 promptTokens/completionTokens/totalTokens,
  无 cacheRead;cost-tracker 的 cacheReadTokens 是进程内累加,无落盘无 UI。

## 二、CC 的做法(扒自 CC sourcemap,带出处)

### 断点布局:3 处,不平均撒
- **System prompt**:按内容**分块**挂(静态/动态分离),非整块一个。
- **Tools 数组**:**整体当一个稳定块**,不单独挂标记;动态工具(Advisor/MCP)
  **追加在尾部**,开关工具只churn尾巴、不破前缀(`services/api/claude.ts:1387`)。
  deferred tools 从缓存键计算里**过滤掉**,工具发现不破缓存(claude.ts:1460)。
- **Messages 历史**:**永远只挂 1 个**,且固定打**最后一条消息的最后一个 content block**
  (`markerIndex = messages.length - 1`,claude.ts:3089);排除 thinking 块(claude.ts:588)。
  注释强调一个请求挂 2 个反而坏事(KV page eviction)。

### 历史断点:固定最后一条,**不滚动**(反直觉)
前缀本来就稳定,断点放末尾 = 声明"到此为止全缓存"。下一轮历史变长,
断点自然移到新末尾,新增部分成为下次的缓存写入。无需手动滚动。

### 静态/动态分离(省 token 核心)
system prompt 埋边界标记 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`(`utils/api.ts:362`):
边界前(规则等不变内容)→ 缓存;边界后(当前时间、session 特定)→ 不缓存。
→ 把易变内容**刻意放到断点之后**,前缀永远稳定。
(codeshell 已歪打正着做对一半:`Today's date` + memory 在一条独立 user message 里,
天然在 system cache 块之外,见 `composer.ts:88`。)

### 粘性锁定防中途失效
任何进缓存键的动态开关(fast/afk mode、TTL 资格)一旦开启就**整个 session 锁定**
(claude.ts:1405, 393)。中途翻转 = 缓存键变 = ~20K token 白烧。

### 断点预算:最多 4 个
API 限制 4 个 cache_control。CC 标准用 2-3 个(system 1 + message 1,
全局缓存模式下 system 拆 2-3 块),留余量(`yoloClassifier.ts:1100`)。

### 命中率上报 + 破坏检测
- 命中率 = `cache_read / (cache_read + cache_creation + input)`(`forkedAgent.ts:653`)。
- 专门的 `promptCacheBreakDetection.ts`:请求前 hash 记录 system/tools/config,
  响应后对比 cache_read_tokens 暴跌(>5% 且 >2000 token)就诊断哪个因素破了缓存并打点。

## 三、codeshell 可抄清单 + 优先级

| CC 做法 | codeshell 现状 | 可抄性 |
|---|---|---|
| 命中率可见 + 修 OpenAI cached_tokens 字段 | 字段读错、无上报 | ⭐ **先做**(没数据无法验证其他改动) |
| tools 整体当稳定块 + 动态工具追加尾部 | tools 完全没缓存 | ⭐ 高(仅 Anthropic 有效) |
| messages 末尾固定挂 1 个断点 | messages 没断点 | 高,但仅 Anthropic 有效、需避坑(见下) |
| 静态/动态分离(system 内部分块) | system 单块;时间/memory 已在 user message | 中 |
| 粘性锁定动态开关 | 未审计有无易变量进前缀 | 中 |
| 破坏检测系统 | 无 | 低(运维级,可选) |

### messages 断点的坑(动手前必读)
1. 挂在最后一条 message 的**最后一个 content block**,且排除 thinking 块,否则 400/不生效。
2. 别破坏 tool_result 紧邻 tool_use 的配对不变量(见记忆 `project_compaction_toolpair_invariant`)。
3. cache_control 是"写缓存",首次比普通 input 贵 25%;短对话可能 write 成本 > 收益。
4. **仅对 Anthropic 有效**。主力跑 gpt-5.5(OpenAI)时挂断点无用——OpenAI 自动缓存,
   该做的是修字段不是挂断点。

## 四、建议执行顺序

1. ✅ **命中率可见**(最小、低风险、立刻有用):修 `openai.ts` 字段名为
   `prompt_tokens_details.cached_tokens`(`cachedTokensOf`)+ 在 `llm.request` 日志 emit
   cacheRead/cacheCreation + `cacheHitRate` 助手(model-facade.ts,带测试)。
   **已做:提交 `a7f81610`。**
2. ✅ **tools 缓存**(Anthropic):`convertTools` 只给**最后一个**工具挂
   `cache_control: ephemeral`,让整段 tools 数组成为缓存前缀(CC 同做法:一个标记非逐工具)。
   stream + 非 stream 两路共用 `convertTools` 故同时生效。测试 `anthropic-tools-cache.test.ts`。
   **已做(本次)。** 动态工具追加尾部暂未做(当前 tools 顺序稳定即可)。
3. ✅ **messages 末尾断点**(Anthropic):`buildMessages` 末尾 post-pass 给
   **最后一条 message 的最后一个 content block** 挂 `cache_control: ephemeral`。
   string content 先提升为单个 text block 承载;跳过 thinking/redacted_thinking 块(会 400);
   只标注不重排,tool_use/tool_result 配对不变量不动。测试 `anthropic-history-cache.test.ts`。
   **已做(本次)。** 断点固定末尾不滚动——历史变长时"最后一条"自然右移,新尾巴成为下次写入。
   当前 cache_control 用量 = system 1 + tools 1 + history 1 = 3,在 API 上限 4 之内。
4. 静态/动态分离、粘性锁定、破坏检测 → 进记忆系统/性能专项整体设计,别零敲碎打。

> ⚠️ 缓存断点打错位置会**负优化**(贵价 cache write 却永不命中)。
> 整体顺序铁律:**先可见,再优化**;盲调缓存 = 浪费。
