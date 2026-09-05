# GPT 缓存失效排查：断点保留、工具消息与动态块移位

日期：2026-09-06（Asia/Singapore，UTC+8）。

后续进展：下文保留排查时的原始证据。修复及新实验见 `gpt-cache-optimization-2026-09-06.md`：工具断点问题已收窄到当前路由的 explicit-only 模式；hybrid 模式已通过连续工具轮及重建客户端的真实请求验证。

范围：当前 CodeShell GPT 缓存抽象、实际安装包、9 月 4–5 日运行日志，以及当前配置的 OpenRouter `openai/gpt-5.6-sol` 路由。未修改产品代码、设置或安装包。

## 结论与证据强度

发现三个问题：

1. **GPT 显式缓存每次只保留当前断点，丢失上一请求的滚动断点。** 源码、离线 wire 和真实合成请求共同验证。保留上一条用户消息断点后，读取量精确增加了上一请求写入的 token 数。
2. **当前 OpenRouter → OpenAI GPT-5.6-sol 路由没有为工具消息上的断点建立可复用缓存。** 非流式和流式／默认工具选择两组真实合成请求均复现。用户消息边界可正常写入、读取。无法从客户端实验进一步判定问题发生在 OpenRouter 转换还是上游处理，不能外推到所有 GPT 或原生 OpenAI。
3. **首次持久化或截断新工具结果时，也可能移动已经发送过的动态上下文。** 触发条件是 ContextManager 改变消息对象；未改写的新结果会走原数组返回路径。即使所有已发送历史内容都未改变，新结果持久化也会使旧动态块移到末尾。真实 ContextManager + TurnLoop 离线复现成立，与生产日志中一次 91.1% → 9.6% 的下降高度吻合。

现有统一缓存层已接线，但缺少可复用断点的生命周期管理；同时，当前路由的工具断点实际行为与接口预期存在差异。Skills 列表是否缩短不是本轮结论的前提。

## 1. 实际运行版本已经包含缓存层

- 正在运行 `/Applications/code-shell.app`，版本 0.9.5。
- `app.asar` 修改时间：2026-09-04 08:53:50 +0800。
- 主进程启动于 9 月 4 日 17:37，实际 agent 进程来自该安装包内的 `@cjhyy/code-shell-core/dist/cli/agent-server-stdio.js`。
- 安装包内以下四份文件与当前 core 构建产物 SHA-256 完全一致：
  - `dist/llm/prompt-cache.js`
  - `dist/llm/providers/openai.js`
  - `dist/engine/turn-loop.js`
  - `dist/engine/engine.js`
- 生产日志明确记录 `cacheStrategy: openai-explicit`，无需先升级安装包才能排查。

安装包没有完整 Git commit 身份，因此只确认上述缓存代码一致，不推断整包对应某个精确提交。仓库残留的 0.9.4 打包目录不是当前正在运行的 0.9.5 安装包。

## 2. 旧断点丢失：内容不变也无法复用刚写入的边界

代码位置：

- `packages/core/src/llm/prompt-cache.ts:115`：GPT-5.6 路径选择 `mode: explicit`。
- `packages/core/src/llm/providers/openai.ts:1193`：每次仅选择 system、stable-history、`messages.length - 1`。

离线使用真实 OpenAIClient 构造连续三个请求。忽略 marker 及单文本包装差异后，R2 完整包含 R1，R3 完整包含 R2；内容前缀没有变化。然而标记位置为：

| 请求 | 标记位置 | 上次滚动断点 |
| --- | --- | --- |
| R1 | 0、1、2 | — |
| R2 | 0、1、4 | 2 消失 |
| R3 | 0、1、6 | 4 消失 |

不能仅凭 JSON string 与 text-block array 的包装不同宣布缓存失效；本次结论来自断点位置及服务端 usage 对照。

### 真实非流式对照

同一模型、路由、缓存键、固定工具定义和完整追加历史；输入只有人工生成的无业务内容文本。固定 `tool_choice: none`，最大输出 64 tokens。以下 token 数均来自原始返回 usage。

| 请求 | 变化 | 输入 | 缓存读取 | 缓存写入 |
| --- | --- | ---: | ---: | ---: |
| R1 | 写入初始用户尾部 | 4,850 | 0 | 4,775 |
| R2 | 当前实现：移除旧尾部标记，只标记新尾部 | 4,869 | 2,808 | 1,986 |
| R3 | 保留 R2 的用户尾部断点，再标记新尾部 | 4,888 | 4,794 | 19 |

`R3.read = R2.read + R2.write = 2808 + 1986 = 4794`。

这直接验证保留旧边界能够读回刚写入的历史。命中率由 R2 的 57.7% 到 R3 的 98.1%，不是由裁剪内容获得。

## 3. 当前路由的工具消息断点没有产生可复用缓存

同一非流式序列继续：

| 请求 | 变化 | 输入 | 缓存读取 | 缓存写入 |
| --- | --- | ---: | ---: | ---: |
| R4 | 保留旧用户边界，在新增大段工具结果末尾标记 | 6,613 | 4,813 | 0 |
| R5 | 保留该工具边界，在后续用户消息标记 | 6,632 | 2,808 | 3,749 |

R4 的新增工具尾部没有写入；R5 仍保留该工具标记，却不能读取它。仅保留上一条工具断点不足以解决当前路由的问题。

### 流式与默认工具选择复核

另建合成前缀，使用生产同类的 `stream: true`、`stream_options.include_usage: true`，省略 `tool_choice`，保留固定工具定义。未执行任何工具。

| 请求 | 断点位置 | 输入 | 缓存读取 | 缓存写入 |
| --- | --- | ---: | ---: | ---: |
| S1 | system、固定用户历史、工具结果尾部 | 5,292 | 0 | 2,884 |
| S2 | 保留工具边界，追加一个用户消息边界 | 5,314 | 2,884 | 2,427 |
| S3 | 保留 S2 用户边界，再追加用户消息 | 5,333 | 5,311 | 19 |

`S3.read = S2.read + S2.write = 2884 + 2427 = 5311`，命中率 99.587%。

S1 只写固定前缀，S2 不能读取工具尾部，S3 可以读取之前用户边界。由此排除了“只是非流式”或“只是 tool_choice:none”的解释。

### 能确定和不能确定的范围

- 配置实际请求地址为 `https://openrouter.ai/api/v1/chat/completions`；模型为 `openai/gpt-5.6-sol`；响应 provider 为 `OpenAI`。
- 使用真实 OpenAI SDK 加本地 fetch 拦截，也确认 SDK 不会删除工具消息中的 `prompt_cache_breakpoint`。
- OpenAI 官方 Chat Completions schema 允许工具文本块带此字段；不能声称协议本来就不支持。
- 未直接测试原生 OpenAI，也未观测 OpenRouter 转发给上游的请求，不能进一步归责于哪一侧。
- 用户消息边界的兼容办法已证明可行，但合成的“继续”消息尚未在真实 Agent 行为评测中验收，不能直接无条件投产。

## 4. 新工具结果处理会重排旧前缀

代码位置：`packages/core/src/engine/turn-loop.ts:584`。

`restoreVolatileAfterContextManagement()` 以对象身份判断 ContextManager 是否修改了任何消息；一旦修改，就返回：

```ts
return [...managedStable, ...volatile];
```

这里没有区分“真正改写已发送历史”和“处理尚未发送的新工具结果”。

真实方法的离线复现使用 1M 窗口，无需触发摘要或压力压缩：

```text
此前请求：task → dynamic → 已发送历史
新结果：追加一个 60k 字符工具结果
处理后：task → 已发送历史 → 新工具调用 → 新结果文件引用 → dynamic
```

所有已发送的非动态内容完全未改，却从原 dynamic 位置开始破坏原有前缀。

```json
{
  "case": "fresh_tool_result_persisted",
  "firstChangedPriorMessage": 1,
  "dynamicIndexBefore": 1,
  "dynamicIndexAfter": 4,
  "newResultPersisted": true,
  "priorNonDynamicBytesUnchanged": true
}
```

### 对应生产时点

会话 `P-CHqi0i2-kttG7h`，`~/.code-shell/logs/engine-2026-09-04.log`。以下为本地时间：

| 时点 | 事件 | 输入 | 缓存读取 | 比率 |
| --- | --- | ---: | ---: | ---: |
| 17:40:08 起 | 多次调用持续读取固定长历史 | 271,491 起 | 256,193 | 首次约94.4% |
| 17:43:59 | 持久化前最后一次 GPT 请求 | 281,085 | 256,193 | 91.1% |
| 17:44:00 | 新 Grep 结果 61,894 字符，触发 per-result-cap 持久化 | — | — | — |
| 17:44:15 | 下一次 GPT 请求 | 282,065 | 27,131 | 9.6% |
| 后续三次 | 读取量仍停在系统前缀 | 282,376–282,986 | 27,131 | 约9.6% |

日志行：10818（下降前）、10827（持久化）、10832（下降后）。system/tools/config/scope 指纹相同，工具数量同为60。这个时点没有摘要、microcompact 或新的 browser mask 日志。

移位机制高度吻合第一次骤降。它也使原来位于用户消息上的 stable-history 边界落到工具消息上；结合当前路由的工具断点行为，可以解释之后没有迅速恢复长历史缓存的现象。生产请求体未完整留存，因此这一步关联不是逐字节的生产 wire 证明。

另一段新版本日志（9 月 5 日 `ClLhDxOjWkIHd-gI`，第64–187行）显示：输入从49,423增长到55,174，连续12次 cacheRead 都是33,931，system/tools/config/scope不变。这种读取量停滞的现象与滚动断点无法写入／复用吻合，不能用“Skills每轮变化”解释。

## 5. 为什么现有检查没有发现

`packages/core/src/engine/prompt-cache-diagnostics.ts:233` 在当前 cacheRead 大于64时直接返回 updated。因此256,193降到27,131这种巨大损失不会触发其 drop 告警。

另外：

- 指纹只覆盖 system、tools、config、scope，不覆盖消息历史的首个变化位置。
- 没有识别“cacheRead恒定而prompt持续增长”。
- 现有缓存测试验证单次请求有三个标记，没有验证下个请求能读回上次新写入的边界。
- ContextManager与volatile还原的组合测试没有保护“仅处理新结果时，已发送前缀必须保持”。

相关已有测试通过，并不反证这些跨请求问题。

## 6. 修复建议与验收

按局部修改推进，沿用当前缓存抽象：

1. **管理可复用断点的生命周期。** 保留上一成功请求中仍有效的边界，再增加当前写入边界；真正改写历史时，只淘汰首个变化位置之后的边界。区分不同 provider 的读边界／新写入限制。
2. **为当前路由验证可生效的工具轮缓存边界。** 已证实工具后用户边界可写入、保留后可读取。可评估局部兼容策略或其他模式，但不能只补回工具 marker 就宣布修复。
3. **仅处理新尾部时保持旧动态块位置。** 新工具结果持久化／截断应在首次发送前完成，不应因此重排已经发送的前缀。
4. **补两类诊断。** cacheRead相对大幅下降，以及稳定前缀不变时cacheRead长时间停滞；记录消息首个变化位置、实际断点角色和位置、有效缓存策略。

验收至少包含：连续工具调用、旧用户与工具边界保留、新大结果首次落盘、真实历史压缩、流式／非流式，以及当前OpenRouter路由。生产目标应比较稳态缓存读取的增长和总成本；99.6%是本次合成样例结果，不是所有业务请求的保证。

次要问题：持久化状态会恢复已被browser mask折叠的旧preview，随后再次mask；最终文本相同但对象不同，仍可反复移动dynamic。已离线复现，未把它归为上述生产时点的原因。GPT-6模型名称未进入显式策略也存在，但不是这里GPT-5.6日志的原因。

## 7. 复现与成本

本轮临时脚本（只使用合成内容）：

- `/tmp/codeshell-cache-prefix-audit.ts`：真实ContextManager／TurnLoop前缀复现。
- `/tmp/codeshell-gpt-cache-wire-audit.ts`：连续请求断点位置对照。
- `/tmp/codeshell-gpt-cache-fetch-audit.ts`：真实SDK到fetch的字段保留。
- `/tmp/codeshell-gpt-cache-live-audit.ts`：五次非流式真实请求。
- `/tmp/codeshell-gpt-cache-stream-audit.ts`：三次流式真实请求。

真实请求结果已附在同目录 `gpt-cache-live-evidence-2026-09-06.json`，只含状态、断点角色、usage和耗时，不含凭据、用户消息或项目资料。

共8次真实合成请求，响应usage.cost合计 **US$0.0537991**。没有改生产配置或执行模型返回的工具调用。

参考：

- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [OpenRouter Explicit prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching#explicit-prompt-caching)
