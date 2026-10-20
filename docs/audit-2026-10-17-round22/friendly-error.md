# Engine 错误提示与额度分类

冻结点 `ab258c3f534b19014b2ed85da3111649f166ab86`。本批新增 **1 个 P3：ERROR-R22-01**。这是错误原因和处理建议被丢失的问题；没有执行真实额度耗尽、账号、SDK 请求或模型重试。

## ERROR-R22-01：额度耗尽的 HTTP 429 被无条件包装成临时限流

普通触发条件是 OpenAI-compatible SDK 返回 `APIError`，`status === 429`，而具体原因是余额耗尽或支出/使用额度到达上限。当前 [OpenAI 官方错误说明](https://developers.openai.com/api/docs/guides/error-codes) 区分这些 429 与暂时请求限流，并要求额度类错误先处理余额或限制；单纯重试不能恢复访问。该外部合同于本批读取，具体错误形状会随 provider 改变，不能把所有 compatible endpoint 都当作 OpenAI 本站。

[OpenAI provider:1354](../../packages/core/src/llm/providers/openai.ts#L1354) 在检查任何具体错误消息或代码之前，对所有 429 直接抛 `new LLMRateLimitError("openai")`。原始 message/code/type 均未传入。实际 [异常类:28](../../packages/core/src/exceptions.ts#L28) 仅保留 `Rate limit exceeded for openai` 和 `retryAfter`。因此真实来源即使明确是 billing/quota，后续也无法利用原来的原因分类。

当错误经中间重试或 fallback 最终仍未恢复、并传播到 [TurnLoop:1193](../../packages/core/src/engine/turn-loop.ts#L1193) 的 `formatFriendlyError(err)` 时，[friendly-error:45](../../packages/core/src/engine/friendly-error.ts#L45) 将它显示为 `Rate limited by the provider.`，建议等待、降低频率或切换模型，自己的 [billing/quota 规则:69](../../packages/core/src/engine/friendly-error.ts#L69) 无机会命中。这样用户看不到需要处理额度/账单的原因。若真实 provider 本来就是临时限流，这段提示则正常。这里没有声称每次 429 都会立即显示；重试和 fallback 可能恢复，或由另一个错误取代。

另外，即使某条直接输入路径保留了 `429 insufficient_quota: check billing`，同一个 helper 的规则次序仍先选择 rate limit。这个输入形态是本批手工数据控制，未宣称已执行 SDK 的 message 格式或找到绕过包装的普通生产链；它是同一分类问题的辅助证据，不另计 bug。

实际执行的是零 runtime-import 的错误提示叶子和无 I/O 的异常类：12 个 owned 测试、25 次断言，首跑通过。包含明确 quota/credit+429 的当前错误行为、无 429 前缀的 billing 正对照、普通 rate limit 正对照，以及 timeout/network/context/5xx/unknown/format 控制。`LLMRateLimitError` 测试只直接构造实际异常类并传入实际 helper，未执行 provider 包装函数；两者的连接来自上述静态源码。通过的 characterization 断言记录现状，不表示缺陷已修复。

[首跑原始日志](evidence/root-friendly.first.raw.log) 与 [退出收据](evidence/root-friendly.first.exit.json) 在阅读结果前保存。没有运行现有混合 `friendly-error.test.ts`，其中 custody/transcript/auth case 本批仅静态阅读。没有导入 `OpenAIClient`、`LLMClientBase`、Engine、TurnLoop；没有 SDK/API/网络/账户/计费/真实重试或 timer 实验。

## 静态推论与未执行边界

[client-base:316](../../packages/core/src/llm/client-base.ts#L316) 将该异常按 rate limit 进入等待分支；额度错误可能因此进行无效重试和等待。这里只读了该选段，**没有测量次数、耗时或重试请求**，不把额外时间作为单独已验证影响。provider 的非流式和流式 catch 选段分别见 [730](../../packages/core/src/llm/providers/openai.ts#L730)、[963](../../packages/core/src/llm/providers/openai.ts#L963)，并非完整类或流式 watchdog 审查。

历史去重扫描 `docs/`、`bugs/` 下 2,232 个 Markdown/JSON 文件，含 archive，递归解析 309,994 个字符串叶子、436,035 个全标量，0 parse error。精确 quota+429/异常类组合未命中旧发现；friendly helper 命中主要为库存、架构说明和旧提案，不作为新覆盖。第二个宽搜的 429 包含行号/统计数字噪声，共 102 匹配、最多保存 100 上下文；它不是全仓语义穷尽保证。详见 [初次去重](evidence/root-dedup.json)、[补充宽搜](evidence/root-quota-dedup.json)、[判断收据](evidence/root-dedup-decisions.json)。

静态元数据导航有两处失败：早期搜索误写不存在的 `llm/client.ts`；一次 Node resolver 组合查询在 `openai/package.json` 导出解析上失败，因参数整体求值未打印任何前两个解析结果。它们都不是 Bun/产品执行失败，未证明 SDK 缺失或 Bun 无法解析。该 SDK 元数据方向直接跳过，没有重跑 resolver、读取其指示路径或替代执行 SDK。后续 helper 首跑与该 SDK 路径无依赖。终端工具的一次合并历史输出被截断，未把未显示部分算作已逐条阅读；历史计数来自完整已落盘 JSON。

本批只记录，未修改产品。源码 pin、外部合同的精简事实与元数据失败转录分别见 [source manifest](evidence/root-source-manifest.json)、[external contract](evidence/root-external-contract.json)、[metadata notes](evidence/root-metadata-notes.md)。
