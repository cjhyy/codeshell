# 第 3 章 · LLM 层

> 覆盖:`llm/client-base.ts`、`client-factory.ts`、`model-pool.ts`、`providers/openai.ts`(769)、`providers/anthropic.ts`、`capabilities/{index,rules,types}.ts`
> 这一层把"模型身份 + 跨模型旋钮"翻译成各家 wire 格式,并用 capability 表吸收 per-(provider,model) 的请求形状差异。与 [`../session-isolation-state.md`](../session-isolation-state.md) §5 强相关。

---

## 1. 职责

- `LLMClientBase`:抽象基类,持 model 身份 + 旋钮(只读)、usage 统计、`withRetry` 退避策略。
- `createLLMClient`(factory):provider 名 → client 类,惰性注册 anthropic/openai。
- `ModelPool`:运行时模型注册表(key→entry),`switch/get/toLLMConfig`,context window 解析。
- `OpenAIClient`:服务**所有** OpenAI 兼容端点(OpenAI/DeepSeek/OpenRouter/Z.AI/xAI/Mistral/Groq/Gemini-compat/Ollama/custom),靠 capability 表分流。
- `AnthropicClient`:Anthropic 直连,带 prompt caching(`cache_control: ephemeral`)。
- `capabilities/`:纯函数 `capabilitiesFor(kind, model)`,RULES 表 first-match-wins。

## 2. 关键类型 / 入口

- `LLMConfig`(纯身份:provider/model/apiKey/baseUrl/maxTokens/thinking/providerKind) vs `ClientDefaults`(temperature/timeout/retryMaxAttempts/imageDetail)。
- `LLMClientBase` 字段全 `readonly`(13-17):`maxTokens = config.maxTokens ?? 8192`,`temperature ?? 0.3`,`timeout ?? 120_000`,`retryMaxAttempts ?? 3`。
- `Capability`(types.ts 82-102):`supportsVision / tokenLimitField / rejectedParams / reasoning / echoReasoning / parallelToolCalls / streamUsage`。`DEFAULT_CAPABILITY`(109)保守默认。
- `ModelEntry`(model-pool.ts 49):`key/label/provider/model/baseUrl/apiKey/maxOutputTokens/maxContextTokens/providerKey/thinking`。

## 3. 逻辑主线

### 3.1 client 构造 + 重试(client-base)

- 构造期把 config + defaults 拍进 readonly 字段,调 `initClient()`(两个 provider 都惰性,真 client 首次 getter 才建)。
- `withRetry`(73):`ContextLimitError` 直接上抛;`LLMRateLimitError` 等 `retryAfter` 或 `attempt*2` 秒;`isClientError`(4xx 非 429)立即上抛**不重试**(避免烧 9s 退避);其它指数退避(上限 30s)。
- `recordUsage`:`recordUsage===false` 跳过(辅助调用);否则累加 + 触发 `static onUsage`(CLI 在 main.ts 装,喂 cost tracker)。

### 3.2 ModelPool

- `register/withBuiltinDefaults`:无 maxContextTokens 时按内置表补(目前只有 DeepSeek V4 → 1M)。
- `reloadCachedContextWindows`(125):对缺 maxContextTokens 且有 providerKey 的 entry,按 ① provider 的 /v1/models 缓存 → ② OpenRouter 快照(`vendor/id`)→ ③ 200k 兜底 填充。用户显式填的不覆盖。
- `toLLMConfig`(243):**热切换的核心**。entry → 纯 LLMConfig;`maxTokens = entry.maxOutputTokens ?? 8192`;`thinking` entry 覆盖 catalog;带上 `providerKind` 给 capability 层用。**kindToClientProvider:除 anthropic 外全 collapse 成 openai**(factory 只注册这两个)。

### 3.3 OpenAIClient 的请求装配(buildRequestBody, 198)

这是吸收形状差异的核心:
- **tokenLimit**:`_forceMaxCompletionTokens(sticky) || cap.tokenLimitField==="max_completion_tokens"` → `max_completion_tokens`,否则 `max_tokens`。值 = `options.maxTokens ?? this.maxTokens`。
- **sampling**:`temperature` 仅在 `!rejectedParams.has("temperature")` 时发。
- **reasoning**(228):按 `cap.reasoning.kind` 分流 —— `deepseek-thinking`(top-level `thinking:{type}`)/`openai-effort`(`reasoning_effort`,disabled→`disabledEffort ?? minimal`)/`openrouter-reasoning`(`reasoning:{effort,exclude}`)/anthropic 系跳过。
- **buildMessages**(481):`stripVisionFromHistory`(非视觉模型剥历史图片,防 model switch 后 `image_url` 400);reasoning echo 三态(`when-tools` 回填空占位 / `never` 剥除 / `optional` 透传);tool_result 拆成独立 `role:"tool"` 消息;空 assistant(无 content 无 tool_calls)丢弃防 400。
- **handleApiError**(676):`APIUserAbortError` 原样上抛(ESC 取消);400 含 `max_tokens`+`max_completion_tokens` → 翻 `_forceMaxCompletionTokens` sticky;context_length → `ContextLimitError`;OpenRouter 401 "Provider returned error" 给详细提示。

### 3.4 AnthropicClient

- system prompt 带 `cache_control: ephemeral`(prompt caching)。
- `max_tokens` **必发**(`options.maxTokens ?? this.maxTokens`,无省略分支)—— 与 OpenAI 不同。
- `buildMessages`:tool 角色 → user;tool_result/image/tool_use 转 Anthropic block 形;空 blocks 消息丢弃。
- 流式用 SDK 的 `stream.on("text"/"contentBlock"/"inputJson")` + `finalMessage()`。

### 3.5 capabilitiesFor(纯函数)

- 遍历 RULES,`kind` 匹配 + `match.test(model)` first-win,merge 到 DEFAULT(rejectedParams 深拷贝 Set 防 mutate)。无匹配 → DEFAULT 副本。

## 4. 逻辑理顺问题

- ⚠️ **§session-isolation §4.3 的 384000 根因在这层确认存在**:`maxTokens` 是 `readonly`(client-base 13),构造时 `config.maxTokens ?? 8192` 锁死。`toLLMConfig` 里 `maxTokens = entry.maxOutputTokens ?? 8192`(model-pool 264)。所以**新模型若没填 maxOutputTokens → 走 8192**(安全),问题只在**切换不重建 client**时旧值残留(engine.ts switchModel 只换 config.llm 不重建 run() 局部 llmClient)。本章证实:`toLLMConfig` 这层是对的(per-entry 现算),漏洞在 Engine 复用旧 client。调研建议方向 C(查不到省略字段)在 **OpenAI 这层尚未落地**:`buildRequestBody` **永远发** tokenLimit(213,无省略分支)。Anthropic 同样永远发(必填)。**即:止血方向 C 还没实现。**

- ⚠️ **`_forceMaxCompletionTokens` / `_capability` / `_client` 是 per-model sticky 状态挂在 client 实例上**(openai.ts 116/144/111),正是 §session-isolation §5 列的残留字段。本章确认:由于 model 不变 mid-client,这些缓存在单 client 生命周期内**正确**;危险仅在"换 config 不换实例"(Engine 复用 llmClient)时才暴露 —— 而 OpenAI client 没有 reset 这些字段的方法,印证"切换=整体重建 client"是唯一安全路径。

- ❓ **`toLLMConfig` 的 `provider` 解析顺序**(257):`entry.provider || kindToClientProvider(fromCat?.kind) || "openai"`。若 entry.provider 是空串 `""`(populateModelPoolFromSettings 里 `provider: m.provider ?? ""`,engine.ts 426),`""` 是 falsy → 落到 catalog kind。OK。但**若 entry.provider 填了一个 factory 不认识的值**(如 `"deepseek"`),`createLLMClient` 会抛 `Unknown LLM provider`。即:settings.models[].provider 必须是 `"openai"`/`"anthropic"` 字面,不能填 kind。**这是个隐式契约,容易踩坑** —— 用户直觉会填 `provider: "deepseek"`。需确认 settings 写入路径是否归一。

- ❓ **`isClientError` 把所有 4xx(非 429)当不可重试**(client-base 154)。但 401 "Provider returned error"(OpenRouter 路由后端禁 function calling)其实换个模型可恢复 —— 当前直接上抛不重试是对的(重试同样失败),但**用户视角**只看到一次错误。OK,只是记录这条 4xx 一刀切的范围。

- ❓ **OpenAI 流式 `stopReason` 硬编码 `"stop"`**(openai.ts 441),不读 `finish_reason`。而非流式 `processChoice` 读 `choice.finish_reason`(476)。**流式路径永远返回 `stopReason:"stop"`** —— TurnLoop 的 `max_tokens` 续写分支(ch02 §3.1,`response.stopReason === "max_tokens"`)在 OpenAI **流式**下**永不触发**(因为流式总是 "stop")。handleChunk 里有 `finish_reason` 但只 emit 给 onChunk,没回填到返回的 `stopReason`。**这是个真 bug 候选:OpenAI 流式被 max_tokens 截断时,TurnLoop 收不到信号、不续写。** 需确认是否有意(也许靠 watchdog/usage 兜底)。

- ❓ **Anthropic `cache_control` 只打在 system prompt 上**(anthropic.ts 86),没打在 messages 的稳定前缀(如 tool defs 已在 system 里?tools 单独传)。CC 的 prompt caching 一般还会 cache tools + 历史前缀。**当前只 cache system** —— cache 命中率可能不如预期。需确认是否刻意(tools 走 `tools` 字段,Anthropic 对 tools 的 cache 需另设 cache_control)。

- ❓ **OpenAI 流式 `usage` 依赖 `stream_options:{include_usage:true}`**(268),但若某 OpenAI-compat 代理不支持 include_usage,`streamUsage` capability 字段(`include-usage-flag`/`auto`)**在 OpenAI client 里没被读**。`buildRequestBody` 无条件加 `include_usage`(268,只看 stream),`cap.streamUsage` 实际未生效。**capability 字段定义了却没用** —— 记录为未接线。

- ❓ **DEFAULT_CAPABILITY `supportsVision: false`**(110)。无规则匹配的模型(如自建/未知 custom)默认无视觉 → Engine.run 的视觉闸(ch01 §3 step1)会拒图。对真支持视觉的小众模型是误拒。可接受(保守),记录。

- ❓ **`countTokens`(token-counter.ts)被流式逐 chunk 调用**(openai 369/anthropic 161)算 `tokens` 字段。若 countTokens 是真 tokenizer(非 char/4),逐 delta 调用可能有性能开销。需第 X 章读 token-counter 确认实现(估计是廉价估算)。

- ❓ **factory 只注册 anthropic/openai,`registerProvider` 是公共 API**(index.ts export)。第三方注册自定义 provider 后,`toLLMConfig` 的 `kindToClientProvider` 仍只产出这两个名 —— 自定义 provider 必须靠 `entry.provider` 显式命中。两条路径(kind 派生 vs entry.provider)对自定义 provider 的协作关系不清晰,记录。
