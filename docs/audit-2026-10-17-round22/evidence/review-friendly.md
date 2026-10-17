# Independent review: friendly-error / ERROR-R22-01

审查者 `session_title_round22`，冻结点 `ab258c3f534b19014b2ed85da3111649f166ab86`。结论：保留 1 个窄范围 P3 ERROR-R22-01；没有新增问题、候选或测试。独立复核只读源码、作者 fixture/raw/收据/去重统计与官方页面，没有运行产品、守卫测试、SDK resolver、SDK import、provider、网络 API、账户、重试或 Engine。

普通触发成立的条件是官方 OpenAI HTTP 429 原因属于余额或额度类，并由当前 OpenAI SDK APIError 分支接收。独立重读 [OpenAI 官方错误说明](https://developers.openai.com/api/docs/guides/error-codes) 的 987–1013 选段，确认同一 HTTP 状态同时覆盖临时限流与余额/支出/使用额度，后者需先纠正额度。这里只保存简短事实和判断，不是整页或工具响应存档；首次 open 的页面导航部分也未被当成已读全部内容。该合同只支持 OpenAI 文档场景，不能泛化所有 compatible endpoint。

源码 [openai.ts:1354](../../../packages/core/src/llm/providers/openai.ts#L1354) 的 429 分支在读取 message/code/type 之前无条件替换为实际 `LLMRateLimitError`；[exceptions.ts:28](../../../packages/core/src/exceptions.ts#L28) 没有保留 billing 原因。这是与手工构造“429 insufficient_quota”字符串不同的生产来源证据。实际测试只构造该轻量异常并交给实际 friendly helper；fixture 的其它带状态前缀输入只是 owned characterization，没有证明 SDK message 格式。源证据与官方合同足以支持“原因丢失、建议错误”的 P3；不需要恢复已跳过的 SDK 元数据路径，也没有声称实际包装函数已执行。

我额外只读 client-base.ts:333–377，确认最终 `throw lastError`；只读 TurnLoop:2107–2226，确认中间有非流式 fallback。初稿“错误继续进入 TurnLoop”的表述过于直接，已向作者提出精确化。作者已改为最终仍未恢复并传播到 TurnLoop 时才适用，并明确中间可能恢复或换成另一错误。当前稿满足这一限制。重试次数、等待时间、真实错误最终展示都没有动态观察，不支持额外耗时或账单影响断言。

元数据核验：14 个作者 source pins 对照冻结 Git blob 与当前文件 SHA 全部一致；这只证明文件字节，不宣称所有文件都完整语义审查。首次 raw 的 SHA 为 `742699bd682db2b595e7cf8d4471d774bc6b9dd2429a72e4486f04613b87c035`，与 exit receipt 相同，日志明确 12 pass / 0 fail / 25 expect、Completed shard、0 skipped，exit 0，1 attempt / 0 rerun。fixture 导入实际 friendly-error 与 exceptions，未导入 SDK/Client/Engine，既有混合 custody/transcript/auth 套件未跑。没有新增运行或修复重跑。

作者 [artifact receipt](root-artifact-receipt.json) 的 15 个文件 bytes/hash 均独立核真；16 个本地 Markdown 链接存在且行号不越界。最终作者报告 SHA `2e9b0dea1b69853e2512649469623dfb9b345e5cfa5d4c9b71d5a4e73f85c291`，收据 SHA `de26884db5d84c252b88baddfefb9eec1b1ff95c6a5458b143e878df27450784`。收据不含本审查文件，属于作者交付时点。去重 JSON 的 targeted 47/0/10、补充 429 总 102/仅保留 100、localized 5 与决定稿一致；有数值噪声，不能声称语义穷尽或未保留上下文均已逐条阅读。

没有阻断项。已记录的 Node package export 元数据失败仍为 SKIP，0 SDK/Bun 尝试，不是依赖缺失或 Bun 解析失败证明；本审查没有访问其失败路径、替代解析或补验 SDK。
