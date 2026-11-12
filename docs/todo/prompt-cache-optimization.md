# Prompt 缓存优化 — 对标 Claude Code

> 状态:步骤 1–4 已落地;GPT-5.6 Responses API 迁移与线上命中率验收仍待专项推进。2026-06-26 整理,2026-09-02 更新。
> 2026-11-12 补充第五、六节:把历次修复抽象成一个统一模型,并列出按该模型尚未满足的部分。**新增或修改会进入请求的内容前,先读第五节。**
> 背景:codeshell 当前缓存覆盖面极窄,且命中率不可见。本稿记录 CC 的真实做法
> (扒自 CC sourcemap)、codeshell 现状差距、以及分步计划。
> 关联记忆 `project_prompt_cache_gaps`。

## 一、优化前基线(历史记录)

> 本节保留用于解释当时的低命中率；当前实现以第四节为准。

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

| CC 做法                                   | codeshell 现状                            | 可抄性                               |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------ |
| 命中率可见 + 修 OpenAI cached_tokens 字段 | 字段读错、无上报                          | ⭐ **先做**(没数据无法验证其他改动)  |
| tools 整体当稳定块 + 动态工具追加尾部     | tools 完全没缓存                          | ⭐ 高(仅 Anthropic 有效)             |
| messages 末尾固定挂 1 个断点              | messages 没断点                           | 高,但仅 Anthropic 有效、需避坑(见下) |
| 静态/动态分离(system 内部分块)            | system 单块;时间/memory 已在 user message | 中                                   |
| 粘性锁定动态开关                          | 未审计有无易变量进前缀                    | 中                                   |
| 破坏检测系统                              | 无                                        | 低(运维级,可选)                      |

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
4. ✅ **统一缓存层 + 模型差异化策略**:
   - 新增 provider-neutral 的 `llm/prompt-cache.ts`,统一产出会话亲和键、缓存策略与
     system/tools/stable-history/rolling-history 语义断点；供应商仅负责 wire translation。
   - GPT-5.6+ 走 explicit caching(`prompt_cache_key`、30m TTL、最多 3 个显式断点)；
     较早 OpenAI 模型保留自动缓存,但增加稳定的会话亲和键。
   - Anthropic direct 使用 system/tools/稳定历史/滚动历史 4 个断点；OpenRouter Claude
     使用 3 个断点,避免超过供应商预算。
   - 其他 OpenAI-compatible 模型采用 provider-managed 策略,不发送未知字段,但共享
     append-only prompt 布局。
   - 动态上下文不再每轮从历史中删除后搬到末尾；仅在真正压缩/重写上下文时重新布局,
     避免每次工具循环都破坏前缀。(2026-11-12 复核:这只在同一个 run 内成立。跨 run 时旧的
     动态上下文仍被拿走,见第六节。)
   - OpenRouter/兼容网关若 400 拒绝 GPT-5.6 显式字段,客户端会粘性降级到自动缓存并重试；
     affinity key 若也不支持再单独关闭。
   - 统一缓存 key 使用会话 ID 的 SHA-256 摘要,不向供应商暴露原始 session ID。
5. ⏳ **后续验收/协议升级**:用真实长会话对不同模型分别采集 cache read/write/input,
   按第二轮开始的稳态命中率验收；评估将原生 OpenAI 工具工作流迁移到 Responses API,
   以便进一步复用服务端 conversation state。该迁移涉及流式事件与工具调用协议,不与本轮
   Chat Completions 缓存修复混做。

> ⚠️ 缓存断点打错位置会**负优化**(贵价 cache write 却永不命中)。
> 整体顺序铁律:**先可见,再优化**;盲调缓存 = 浪费。

## 五、缓存模型(2026-11-12)

历次修复都是"发现一处改写,挪一次位置"。本节给出它们共同遵守的模型,之后的改动按这个模型判断,不再逐个打补丁。模型里的每一条都有实测依据:本机 9 天会话统计和 OpenRouter 探针(`prompt-cache-probes-20261112/`)。

### 5.1 缓存是"前缀 + 存档点"

一次请求是一串内容:工具表、系统提示、消息。厂商在这串内容的若干位置留下**存档点**。新请求只能从"它之前的内容与上次逐字节相同"的最远一个存档点接着读,这之后的部分全部按原价重新计费。

存档点只有三种(探针在 `gpt-6.1-sol` 和 `claude-sonnet-5` 上验证,读取不是"最长公共前缀"):

1. 系统段末尾。
2. 显式断点。
3. 上一次请求的完整末尾。

### 5.2 三个量

| 量 | 含义 | 目标 |
|---|---|---|
| 分叉点 | 新请求与上次请求第一处不同的位置 | 尽量靠后:最好只在末尾 |
| 恢复点 | 分叉点之前最远的存档点 | 尽量贴近分叉点 |
| 损失 | 恢复点之后的全部 token × (原价 − 缓存价) | 最小 |

所有优化只做两件事:**不让分叉点提前**(别动已经发出去的内容),以及**让恢复点靠近分叉点**(断点放对位置)。

### 5.3 四种变化

| 变化 | 例子 | 分叉点 | 结论 |
|---|---|---|---|
| 末尾追加 | 新的用户消息、工具结果 | 末尾 | 不花钱,唯一推荐的方式 |
| 中间插入或拿走 | 每个 run 拿走旧的动态上下文;往顶部加一个工具 | 被动的位置 | 其后全丢 |
| 原地改写 | 旧浏览器快照换占位符、重复 Read 去重、图片换占位符、微压缩 | 被改的那条消息 | 其后全丢 |
| 表示变化 | 同一条消息这次带断点(数组形式)、下次不带(字符串形式) | 那条消息 | 内容没变也会丢(Claude 线路实测) |

### 5.4 请求的三层

| 层 | 内容 | 允许的变化 |
|---|---|---|
| 头部 | 工具表、系统提示、首条用户上下文 | 压缩之间不变 |
| 账本 | 用户消息、助手消息、工具调用与结果、宿主注入的上下文和提醒 | 只在末尾追加 |
| 末尾 | 本次请求新增的内容 | 随意 |

越不变的越靠前。一条内容发出去之后发现过期了,追加一条更正,不回头改。

### 5.5 五条规则

1. **发出去的不动。** 两次摘要压缩之间,已经发给模型的内容不改、不挪、不删。
2. **变化用追加表达。** 技能、记忆、状态、日期、指令文件变了,追加"新增 / 更新 / 移除",不重发整块,也不替换旧块。
3. **改写要攒批。** 确实需要回头改写旧消息(省 token)时,先登记,只在三种时机一次做完:摘要压缩时;缓存已过期时(免费);或者划算时,即 `省下的 token × 缓存价 × 预计剩余请求数 > 恢复点之后的 token × (原价 − 缓存价)`。
4. **断点放在定型线上,表示不随断点变。** 断点预算用在:头部末尾、**最早一条将来还可能被改写的消息之前**(没有这类消息时放在本 run 开始处)、上一次请求末尾。文本内容统一以数组形式发送,不因为有没有断点而换表示。
5. **每次断开都要能归因。** 诊断要能指出分叉点是哪条消息、属于哪一类变化;测试里未登记的前缀变化直接失败。

写入时就能决定的处理(大结果落盘换预览、截断)不算改写,不受规则 3 约束。安全要求的即时脱敏例外,但要计入诊断。

### 5.6 对照 Codex 与 Claude Code

两家都是这个模型:环境、权限、技能、指令文件作为普通历史条目落盘,恢复时原样回放;变化以 delta 条目追加;只有压缩时改写历史。本机会话文件可见 Codex 一个 521 次请求的会话里 `developer` 消息只有 6 条,Claude Code 的技能列表在 transcript 里只有 1 条。

## 六、按模型对照的现状(2026-11-12)

损失数字是本机最近 9 天工作会话的统计,全部来自 `gpt-6.1-sol` 线路。

| 改写源 | 变化类型 | 违反的规则 | 9 天损失 | 状态 | 文档 |
|---|---|---|---|---|---|
| `ToolSearch` 往顶部加工具;工具按资格显隐 | 中间插入 | 1 | 约 3.1M(33 次,读取归零) | 11-11 已修 | `prompt-cache-append-only-tool-discovery-20261111.md` |
| 每个 run 拿走旧的动态上下文 | 中间拿走 | 1、2 | 约 21M(133 次 run 首次请求,0 次完整命中;其中约 7.5M 是缓存过期,救不回来) | 未修。PR#316 把"全丢"降为"丢上一个 run 的全部" | `prompt-cache-cross-run-context-ledger-20261112.md` |
| 旧浏览器快照折叠 | 原地改写 | 3 | 约 5.6M(34 次,单次最多 31 万 token) | 未修 | 同上 |
| 图片换占位符、重复 Read 去重、微压缩 | 原地改写 | 3 | 约 0.3M 可归因 | 未修 | 同上 |
| 断点有无改变消息表示 | 表示变化 | 4 | 未统计(Claude 线路,探针发现) | 未修 | 同上 |
| 首条用户上下文里的日期、指令文件每个 run 重算 | 原地改写 | 1、2 | 未分离出 | 未修,优先级低 | 同上 |
| hook 提醒每个 run 重复注入且不落盘 | 末尾追加,但重复 | 2 | 不破坏缓存;每个 run 多约 1.7–1.9k token | 未修 | 同上 |
| 诊断只跟踪头部 | — | 5 | 这次两类问题都被记成"没有变化" | 未修 | 同上 |
| 辅助调用(记忆提取等)零命中 | 不属于本模型:每次都是全新前缀 | — | 证据会话里未缓存量超过主循环 | 另行立项 | 同上第 8 节 |

探针对三个设计点的验证(被测请求的缓存读取量占上一次 prompt 的比例):

| 设计点 | 现状 | 改后 |
|---|---|---|
| 旧动态上下文留原位、只追加变化 | 43%–45% | 100%(Claude 线路还需要规则 4 的统一表示) |
| 旧快照不折叠 | 36%–37% | 100% |
| 改写点之前放断点 | 36%–38% | 约 70% |

修复顺序见 `prompt-cache-cross-run-context-ledger-20261112.md` 第 4 节:先扩展诊断,再把回溯改写改为攒批,然后上下文落盘。

