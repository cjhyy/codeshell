# 第 8 章 · 修复方案(基于 ch01–ch07 已核实的问题)

> 本章只收 **已回原文复核确认** 的问题,给可落地方案。每条:根因 → 方案 → 风险 → 测试。
> 复核记录见每条"已核实"行。未复核的疑点(死代码、重复实现等整洁项)归到 §C,不在本次修复主线。

优先级:🔴 正确性 bug(会产出错误结果/请求失败) · 🟡 浪费/语义不清(不报错但有代价) · 🟢 整洁。

> **状态(2026-05-29):A 组 + B 组全部完成,均走 TDD(先红后绿)。** `packages/core` 测试 140 pass / 0 fail(新增 25 个回归测试),typecheck/eslint(0 error)通过。
> 另从既有日志调研记忆 [[project-llm-retry-maxtokens-bugs]] 补做了 **A5**(4xx 重试守卫对包装错误失效)。
> root `tests/` 有 5 个**预先存在**的失败(buildStreamItems 渲染、sub-agent resync、SettingsManager 迁移、desktop 通知守护进程、git sentinel),位于本次未改动的文件(engine.ts/settings 的他人未提交 WIP、TUI),与本批修复无关 —— 见文末"预存失败"。

---

## A. 🔴 正确性修复(建议优先)

### A1 · OpenAI 流式 `stopReason` 恒为 `"stop"`,max_tokens 续写永不触发 ✅ 已修复(2026-05-29)

> **状态:已修复 + 测试通过。** 改动:
> - 新增 `llm/stop-reason.ts`(`isTruncatedStop`:接受 `"length"`+`"max_tokens"`)+ `stop-reason.test.ts`。
> - `llm/providers/openai.ts`:`streamMessage` 捕获 `finish_reason`(在 `!delta` 早返回前)并回填 `stopReason`(不再硬编码 `"stop"`)。
> - `engine/turn-loop.ts`:续写判定与内层 break 都改用 `isTruncatedStop`(不再只比 `"max_tokens"`)。
> - 回归测试:`openai-stream-stop.test.ts`、`turn-loop-continuation.test.ts`。TDD 全程先红后绿;115 core 测试无回归,typecheck/lint(0 error)通过。

- **已核实**:`openai.ts:441` 流式返回硬编码 `stopReason: "stop"`;`finish_reason` 仅在 `:406` emit 给 onChunk,不回填返回值。`turn-loop.ts:364` 续写依赖 `response.stopReason === "max_tokens"` → 流式路径(主路径)下截断回复**不续写、直接当完整答案**。`LLMResponse.stopReason` 是 `string`(types.ts:366),续写比的是 OpenAI finish_reason 字面量 `"max_tokens"`。
- **方案**:`streamMessage` 累积最后一个 chunk 的 `finish_reason`(handleChunk 里已能看到 `chunk.choices[0].finish_reason`),用一个 `let lastFinishReason` 捕获,返回时 `stopReason: lastFinishReason ?? "stop"`。与非流式 `processChoice`(:476 已用 `choice.finish_reason`)对齐。
- **风险**:低。只是补上本该有的字段。需确认 OpenAI 截断时 finish_reason 确为 `"length"`(OpenAI 用 `"length"`,**不是 `"max_tokens"`!**)→ **turn-loop:364 的比较值对 OpenAI 也是错的**:OpenAI=`"length"`,Anthropic=`"max_tokens"`。所以 A1 要连带修 turn-loop 的判断:`stopReason === "max_tokens" || stopReason === "length"`(或归一化)。
- **测试**:`openai.ts` 流式单测,mock 一个以 `finish_reason:"length"` 收尾的 chunk 流,断言返回 `stopReason==="length"`;turn-loop 单测,mock 一个返回 `length` 的 model,断言触发续写。
- **改动**:`llm/providers/openai.ts`(捕获+回填)、`engine/turn-loop.ts:364`(判断兼容 length)。

### A2 · model 切换是 worker 全局,串台(已有专题 `../session-isolation-state.md`)✅ 已修复(止血+去毒)
> **状态:已修复。** `protocol/chat-session.ts` 新增 `requestModelSwitch(key)`(idle 立即切、busy 挂起到 run 边界,finally 里 flush `pendingModel`);`protocol/server.ts` handleConfigure 的 per-session 分支接上 `s.requestModelSwitch(params.model)`。回归测试 `chat-session-model.test.ts`(2 例:idle 立即 / busy 延迟到 run 边界)。
> 注:这同时落地了去毒方向(run 进行中不动正在用的 client,挂起到边界),前端需带 sessionId 调 configure(协议字段 model 早已存在)。完整 max_tokens 兜底见 A3。
- **已核实**:`server.ts:454` handleConfigure 的 per-session 分支只处理 planMode/permissionMode,无 model;model 仅在全局分支(`:485 switchModel`)。前端 `configure({model})` 不带 sessionId → 全局 → 改共享 `activeKey`。
- **方案**(对齐专题 §8.4,按已有 planMode/permissionMode 的 per-session 模式):
  1. **止血**:server.ts 把 `model` 加进 `:454` 的 per-session 分支(`s.engine.switchModel(params.model)`),前端切模型带上 sessionId。保留全局分支作兜底/新 session 默认。
  2. **去毒**:`switchModel` 已"只换 config.llm 不重建 client",但 client 是 `run()` 局部变量、构造时锁死旧上限(ch03 确认 readonly maxTokens)。本身在 per-run 重建已隔离 —— 真正残留只在"同 run 内切换"。给 `switchModel` 加 run-state 闸(busy 时挂起到 run 边界)。
  3. **max_tokens 兜底**(配合 A3)。
- **风险**:中。涉及前端协议变更(configure 带 sessionId)。建议止血(1)单独一个 PR,去毒(2)单独评估。
- **测试**:回归测试 —— 两 session,A 切 deepseek、B 保持 gpt,断言 B 的 run 请求 model/maxTokens 不被 A 污染(对应专题 §8.4 第 6 条)。

### A3 · max_tokens 查不到时仍发送(384000 致命的最后一环)✅ 已修复(改为钳制)
> **状态:已修复(采用钳制法,比省略更稳)。** 依据日志记忆 [[project-llm-retry-maxtokens-bugs]] Bug B:384000 来自 `maxOutputTokens` 被复制,不是缺失 → 钳制更对症。新增 `llm/clamp-max-tokens.ts`(`clampMaxTokens(requested, cap)`)+ Capability 新增可选 `maxOutputTokens`;gpt-5.5 规则填 `maxOutputTokens: 128_000`;`openai.ts buildRequestBody` 用 `clampMaxTokens(value, cap.maxOutputTokens)`。回归测试 `clamp-max-tokens.test.ts`、`capabilities/max-output.test.ts`、`providers/openai-max-tokens-clamp.test.ts`(384000→128000)。无 cap 的模型仍原样发送(不破坏现状)。
- **已核实**:ch03 — OpenAI `buildRequestBody` 永远发 tokenLimit(`:213`,无省略分支);`maxTokens = options.maxTokens ?? this.maxTokens`,`this.maxTokens = config.maxTokens ?? 8192`(client-base:47)。`toLLMConfig` 的 `maxTokens = entry.maxOutputTokens ?? 8192`(model-pool:264)。即新模型没填 maxOutputTokens → 8192(安全),384000 只在"切换不重建+旧值残留"时出现,A2 修了主因。但 **方向 C(查不到省略字段)仍未实现**,作为纵深防御值得加。
- **方案**(Codex 方向 C):让 maxTokens 全链可缺省 —— `LLMConfig.maxTokens?: number`,client-base 不再 `?? 8192`;OpenAI buildRequestBody 在 maxTokens 为 undefined 时**省略** tokenLimit 字段(交端点默认)。**Anthropic 侧 max_tokens 必填**,保留保守默认(如 4096/8192)。
- **风险**:中。需确认所有调用方对 undefined maxTokens 的容忍;Anthropic 必填不能省。
- **测试**:断言 DeepSeek(无 maxOutputTokens)→ gpt-5.5 切换后,OpenAI 请求体无 max_tokens 字段或 ≤ gpt-5.5 上限;Anthropic 请求体仍有 max_tokens。

### A4 · turn-loop `turnLoop.run` 抛错时 saveState 被跳过(session 卡在 "active")✅ 已修复
> **状态:已修复。** `engine/turn-loop.ts` 的 `run` 把整个 while 循环包进 try/catch:scaffolding(manageAsync/hook/guard)抛错时 patchOrphanedToolUses + emit error + 返回 `{reason:"model_error"}`,不再向上抛。回归测试 `turn-loop-error-safety.test.ts`(manageAsync 抛错 → run 不 reject、返回 model_error)。
- **已核实**:ch01 — engine.ts `result = await turnLoop.run(messages)` 在 try 内(:1379),但 step20-22 的 recordSessionEnd/saveState(status)/session_end 在 try **外**;finally 只 unregister goal hook。若 turnLoop.run 抛(而非返回 reason),磁盘 status 停在 step6 写的 "active"。
- **待确认一点**:turn-loop.run 内部所有错误路径都是 `return {reason}` 还是会抛?读 ch02:ContextLimitError/model_error 都 `return`,但 `callModelWithFallback` 之外、`contextManager.manageAsync`/hook emit 抛错会冒泡。所以**确有抛出可能**。
- **方案**:把 step20-22 收尾(saveState status + session_end hook + recordSessionEnd)移进 `finally`,或给 turnLoop.run 包 try/catch 兜成 `{reason:"model_error"}`。倾向后者(turn-loop 永不向上抛,统一返回 reason),更符合"executeTool 永不抛"的既有约定。
- **风险**:低-中。要确保兜底 reason 正确、abort 仍能区分。
- **测试**:mock manageAsync 抛错,断言 engine.run 返回 + state.json status 非 "active"。

### A5 · 4xx 不重试守卫对包装后的 provider 错误失效(来自 [[project-llm-retry-maxtokens-bugs]] Bug A)✅ 已修复
> **状态:已修复。** `openai.ts handleApiError` 把 SDK 错误包成 `new LLMError(msg, "openai", {status})`,status 落在 `FrameworkError.details.status` 而非顶层 `.status`;`client-base.ts isClientError` 只读顶层 → 每个被包装的 400/401/404 都被重试 3×(~9s)再 fallback 再重试。改 `isClientError` 同时读 `details.status`,并 export 之。回归测试 `client-error.test.ts`(raw status / 包装 LLMError / 429 不算 / 5xx 不算 / 无 status)。
> 注:这是日志实测的高频错误链(`llm.request.fail`→`llm.retry`→`llm.exhausted`),不在原 ch08 但同属 LLM 路径正确性,顺手做掉。

---

## B. 🟡 浪费 / 语义修复

### B1 · tool 定义双发(system prompt 散文 + tools 字段)✅ 已修复(方案 b 瘦身)
> **状态:已修复。** `prompt/composer.ts` 的 `tool_definitions` section 改为只列 `### name` + 一行描述,删掉 `Parameters: {schema}` 转储(schema 仍由 provider 的原生 tools 字段携带)。回归测试 `composer-tool-listing.test.ts`(断言含 name/desc、不含 `Parameters:`/`file_path`)。每请求省下所有工具 schema 的一份重复。
- **已核实**:`composer.ts:149` 无条件把每个工具 name+desc+**完整 JSON schema** 拼进 system prompt;同时 client 经 `convertTools` 传 `tools` 字段(ch03)。无 behavior prompt 依赖这个 section(grep 无引用)。**每请求工具 schema 发两遍**,几十工具 ×2 是数 k–数十 k token 冗余/请求,且 Anthropic 只 cache system(ch03)→ 散文版进了 cache 反而固化浪费。
- **方案**(三选一,需用户定):
  - (a) **删 `tool_definitions` section**,完全依赖结构化 `tools` 字段(模型原生理解 function calling)。最省。风险:某些弱模型可能依赖散文列举?需评估目标模型。
  - (b) **瘦身**:section 只列 `name + 一行 desc`,不含 schema(schema 在 tools 字段)。保留"可读清单"语义,省掉 schema 重复。
  - (c) 保留,加注释说明为何双发(若确有依赖)。
- **风险**:中(影响所有请求的 prompt 形状,需跑一轮模型行为验证)。
- **测试**:断言 buildSystemPrompt 不含 `Parameters:`(方案 b/a);token 计数对比。

### B2 · reactive compaction `% 2000 === 0` 几乎永不触发 ✅ 已修复
> **状态:已修复。** 新增 `engine/reactive-threshold.ts`(`crossedReactiveThreshold(acc, lastBucket)`,跨 2000 桶才触发一次);`turn-loop.ts` 的 wrappedStream 用它替换 `% 2000` 判定。回归测试 `reactive-threshold.test.ts`。仍是 warning-only(真压缩在 turn 间),本次只让探测条件生效。
- **已核实**:`turn-loop.ts:684` 条件 `streamingResponseTokens % 2000 === 0`,而 streamingResponseTokens 由 `+= ceil(len/4)` 累加,几乎不可能恰为 2000 整数倍 → warning 基本不触发(且触发也只 warn 不压缩)。
- **方案**:改成"跨过下一个 2000 阈值"判定:维护 `lastReactiveCheckBucket`,`if (Math.floor(streamingResponseTokens/2000) > lastReactiveCheckBucket) { lastReactiveCheckBucket = ...; check }`。
- **风险**:低。本就只是 warning。
- **测试**:turn-loop 单测喂 text_delta 累加过 2000,断言 shouldReactiveCompact 被调。
- **注**:这只是让 warning 生效;reactive compaction 本身不压缩(设计如此,真压缩在 turn 间)。若要它真有用需更大改动,本次只修"条件失效"。

### B3 · hook `emit` decision 合并 last-write-wins,语义不明 ✅ 已修复(取最严)
> **状态:已修复(方案 a)。** `hooks/registry.ts` 的 emit 合并改为 `stricterDecision`(deny > ask > allow):任一 handler 想拦就拦,低优先级 handler 不能把 deny 放松成 allow。与 executor 的 clampHookDecision「只许降级」取向一致。回归测试 `decision-merge.test.ts`。
- **已核实**:`registry.ts:58` `aggregated.decision = result.decision`(无条件覆盖)。priority 降序遍历 → 高 priority 先跑、低 priority 后覆盖 → **低 priority 实际赢**,与"高优先"直觉相反。plugin(80)的 decision 被 SDK(0)覆盖。
- **方案**(二选一):
  - (a) **取最严**:deny > ask > allow,合并时取 rank 最高(最严)的,语义清晰(任一 hook 想拦就拦)。与 ch04 clampHookDecision"只许降级"的安全取向一致。**推荐**。
  - (b) 保持 last-write-wins 但文档化为"低 priority = 最终决定权",并在注释明确。
- **风险**:中(改权限合并语义,需确认现有 hook 行为不被破坏)。
- **测试**:两个 hook 一 deny 一 allow,断言合并结果 = deny(方案 a)。

---

## C. 🟢 整洁项 / 偏正确性(部分已做,2026-05-29)

**✅ 已做(偏正确性,低风险):**
- ✅ **plan-mode 白名单 ×2 drift**(原归整洁,实为行为 bug)→ 抽 `tool-system/plan-mode-allowlist.ts`(`PLAN_MODE_ALLOWED_TOOLS`),engine.ts(模型可见过滤)与 executor.ts(执行闸)共用。修掉 drift:之前 engine 显示 Task* 但 executor block、executor 放行 TodoWrite 但 engine 不显示。回归测试 `plan-mode.test.ts`(5 例)。
- ✅ **`forceCompact` 的 `require()`**(engine.ts)→ 改静态 `import { estimateTokens }`(ESM 包内混 CJS,纯 ESM 运行时 require 可能未定义 → /compact 崩)。
- ✅ **`validateToolArgs` 注释 "Zod-based" + 未用的 `z` import** → 改正注释(说明只校验 required+顶层 primitive,非完整 JSON-Schema)、删 `import {z}`。

**✅ 死代码删除(用户确认外部引用无需 care,全删):**
- `executeToolsOverlapped`(turn-loop,私有,被 StreamingToolQueue 取代,零调用)→ 删。
- `executeAll`(executor,public,唯一调用方是上面的 dead 方法)→ 删。连带清理 turn-loop 不再用的 `ToolCall`/`ToolResult` import。
- `deduplicateToolCalls` + `recordToolResult` + `hashCall` + `toolCallHashes`(ContextManager,public,工具调用去重缓存,从未接线 —— 实际去重靠 InvestigationGuard)→ 整套删。连带删 `tests/registry.test.ts` 里测它的 "deduplicates tool calls" 用例。
  注:executor.ts 里的 `recordToolResult`(import 自 logging/session-recorder)是同名但**完全不同**的活函数,未动。

**⏸ 仍未做(纯整洁/需产品决策):**
- **重复实现收敛**(token 估算 ×3 / orphan 修复 ×3 / 并发调度 ×3 / Bash 只读判定 ×2)→ 大范围重构,churn 大、回归面广;且 Bash 只读 ×2 是 executor(plan)vs permission(YOLO 分级)两套**意图不同**的判定(一个判"能否在 plan 跑",一个判"要不要 ask"),未必该合并。**建议单独立项,逐个带测试收敛。**
- **散落硬编码常量**(maxContextTokens 200_000 / maxTokens 8192)→ 纯 cosmetics,跨多文件 churn,价值低,**暂缓**。
- **`persistActiveModel` 忽略 settingsScope 写死 home**(ch01)→ **可能是有意的**(activeKey 本就是"用户全局当前选择")。需产品意图确认,非 bug,**暂缓**。

**注**:`src/` 是平行的 legacy bundled tree(独立代码库),本批只改 `packages/core/src/`;`dist/` 是构建产物,不手改。

---

## 建议执行顺序

1. **A1**(流式 stopReason + length 判断)—— 独立、低风险、纯 bug,先做。
2. **A4**(turn-loop 不向上抛)—— 独立、低风险。
3. **A2 止血(model per-session)**—— 有专题背书,但碰协议,单独 PR。
4. **A3(max_tokens 可省略)**—— 配合 A2,纵深防御。
5. **B2 / B3** —— 低风险语义修复。
6. **B1(tool 双发)**—— 需模型行为验证,谨慎,放后。
7. **C** —— 整洁,有余力再做。

> 每条都缺测试(core 无 turn-loop/openai/composer/compaction 测试),修复时**先补回归测试再改**(TDD),尤其 A 组。

---

## 已落地清单(2026-05-29)

新增/改动文件:
- 新增:`llm/stop-reason.ts`、`llm/clamp-max-tokens.ts`、`engine/reactive-threshold.ts`。
- 改动:`llm/providers/openai.ts`(流式 finish_reason 回填 + max_tokens 钳制)、`llm/client-base.ts`(isClientError 读 details.status + export)、`llm/capabilities/{types,rules}.ts`(maxOutputTokens)、`engine/turn-loop.ts`(isTruncatedStop + 错误兜底 + reactive 阈值)、`hooks/registry.ts`(stricterDecision)、`prompt/composer.ts`(tool listing 瘦身)、`protocol/chat-session.ts`(requestModelSwitch)、`protocol/server.ts`(per-session model)。
- 新增回归测试 8 个文件 / 25 例。

验证:`bun test packages/core/` = **140 pass / 0 fail**;`bun run typecheck` 干净;eslint 改动文件 0 error。

## 预存失败(与本批无关,位于未改动文件)

root `tests/` 在本会话开始前即有 5 个失败(他人未提交 WIP):
- `buildStreamItems`(TUI 流渲染,×2)
- `sub-agent model resync`(engine.ts activeKey 重同步)
- `SettingsManager — legacy models[] migration`
- desktop 通知守护进程离线(环境依赖)、git sentinel(环境依赖)

均不在本次改动的文件内,未触碰。**注意:工作树里存在大量他人未提交修改**(engine.ts 的 auxClientCache 等);本次操作中误用 `git stash` 一度引入 build-consensus.ts 冲突,已手工解决(取 upstream 较新版)、stash 已 drop、index 已 `git reset` 清理,工作树内容完整保留。
