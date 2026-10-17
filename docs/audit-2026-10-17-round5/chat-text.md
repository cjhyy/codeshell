# Chat 普通文本与消息投影审计（第五批）

冻结源码：`9a421b3e65d5bfe662b78062cb86bd99483a683a`。仅报告、fixture 和收据；没有产品改动或 Git mutation。审查普通文本分块、Mimi 回复投影、channel 声明和各适配器相应输入/输出路径；没有账号、平台发送、认证/权限、安全、原生操作或真实网络测试。

## CHAT-R5-01 — [P2，带 URL 按钮的回复] LINE 原生按钮投影超出平台标签和网址限制

**精确位置与当前调用者。** [line.ts:121](../../packages/chat/src/line.ts#L121) 将通用 `message.button.text/url` 原样写入 `buttons` template 的 URI action；同一 `send()` 在 113–131 行把正文和 template 放在一个 push 请求中。当前 CLI 在 [cli.ts:110](../../packages/chat/src/cli.ts#L110) 注册 `createMimiPetChat`；它在 [gateway.ts:252](../../packages/chat/src/gateway.ts#L252) 将返回按钮放到最后一个正文分块，291–312 行只按通用 80 字符标签、2048 字符 URL 验证。上游 [host-actions.ts:56](../../packages/pet/src/host-actions.ts#L56)–57 和 284–296 行的 `GatewayReply` schema 同样公开这两个上限，`rewriteGatewayReplyDef` 只改正文上限、保留按钮 schema；367–395 行的实际工具执行沿用该验证。因此 fixture 中的按钮是当前工具接受的普通结果，非注入违反内部 schema 的包。

**平台契约。** LINE 官方 [action label 规范](https://developers.line.biz/en/reference/messaging-api/#action-object-label-spec) 为非 image-carousel template 的动作标签规定最多 20 字符；官方 [URI action](https://developers.line.biz/en/reference/messaging-api/#uri-action) 规定 `uri` 最多 1000 字符。该适配器构造的是 `buttons` template。读取的是同一官方页面提供的 [Markdown 正文](https://developers.line.biz/en/reference/messaging-api/index.html.md)，动作标签表在 23057–23108 行，URI 参数在 23173–23201 行；完整主源阅读收据见 [chat-primary-contracts.json](evidence/chat-primary-contracts.json)。这里均为转述，没有复制平台文档长段。

**触发、实际与预期。** 正常 Mimi 文本回复含 21–80 字符标签，或 1001–2048 字符绝对 HTTP(S) URL。当前通用验证接受，LINE adapter 构造违反上述平台字段上限的请求。预期应按确切 LINE action 约束投影，或退化为能够投递的正文链接。测试中的 20/1000 边界控制保持有效；21/80 标签和 1001/2048 URL 均原样进入 payload；81/2049 则被通用 Gateway 验证丢弃，进一步确认问题位于通用与平台上限之间。

**影响和级别。** 当前回复的正文与无效按钮在同一个 push 请求里，不能可靠完成该次带按钮的回复；不调整 payload 的重试不能修复字段超限。按条件 P2 记录，一项投影根因合并标签与 URL 两个表现。动态证据只证明真实生产调用链生成超限请求；没有调用 LINE 验证/发送端点，没有实测平台拒绝、用户界面、永久正文丢失或真实重试。长回复的按钮只在最后一个分块，不能扩大为之前已经成功发送的分块也丢失。

**首次证据。** [fixture](evidence/chat-line-button-contract.test.ts) 调用真实 `ChatGateway.dispatch → createMimiPetChat → LineAdapter.send`。Desktop `petChat` 与 LINE `fetch` 是内存回调，transport 返回 HTTP 200 仅用于观察构造结果，不把 fake 当成平台成功验证。没有 `run()`、socket、账号、SDK 连接或服务器；默认 fetch 在首次 imports 前设为禁止网络的 callback，第一次测试 finally 恢复。全部请求始终使用显式注入 transport。同文件正常分块控制在 max 2/17/1800 下重建 Unicode/空白全文一致、分块在限内、没有孤立代理项。

**查重。** [chat-dedup.json](evidence/chat-dedup.json) 枚举并散列旧 `docs/audit-*`、`docs/review*`、`docs/archive`、`docs/refactor/_archive` 与 bug-review 文本材料，共 855 个 `.md/.json/.txt`、13,991,735 字节。精确 LINE 名称/路径及动作上限检索只有两个旧源码 inventory 命中，未找到同根因 finding。目录散列/搜索不是对全部文档逐行语义审查的宣称。

## 候选与跳过，均不计新发现

| 候选/已知项 | 本轮处置和理由 |
| --- | --- |
| DingTalk `send()` 只检查 HTTP 状态，未检查响应体业务错误 | `dingtalk.ts:106–112` 静态候选。官方 developerpedia 证明 SessionWebhook 路由，但打开的两个官方正文页均返回 0 可读内容行，未取得当前精确错误响应合约；未写 fixture、未确认平台错误或耐久性结算问题。与旧 Slack/DingTalk 入站 ACK finding 不同方向，但也没有据此增加计数。 |
| WhatsApp CTA/caption 长度 | 旧 `audit-2026-10-17/chat-data.md:31` 已列为未确认候选。本次主源 CTA 页面首次 open 返回 `Internal Error`，立即 SKIP；没有重试、浏览器/CLI fallback、fixture 或第三方镜像代替契约。旧候选保持未确认。 |
| Slack 附件 comment 的 labelled link 格式 | 当前使用通用 Markdown helper；已读 Slack 官方特殊 mrkdwn link 语法，但没有平台/解析 fixture，且 URL 仍可能自动形成可点击链接，不把标签显示差异升级为新的功能失败。 |
| WeCom 的字符/UTF-8 字节上限 | Webhook 文档限制不能直接套到当前 AI Bot WebSocket 协议；未取得确切主源合约、未写 fixture，不计发现。 |
| Slack thread、长附件名 Unicode、Telegram code fences、DeliveryQueue retry FIFO | 已有 finding/父任务给定已知，排除重复；本轮没有重复动态验证。 |
| Discord failed `editReply` 多分块实验 | **明确 SKIP**：没有读取它来继续该实验、没有 import、fixture、修 dependency 或替代方法；旧失败保持原样。 |

## 收据与覆盖限制

唯一测试命令：`node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round5/evidence/chat-line-button-contract.test.ts`。

[首次完整 stdout/stderr](evidence/chat-line-button-contract.first.log)：**3 pass / 46 expect / 0 fail / 0 skipped / Completed / exit 0**；[原始 exit](evidence/chat-line-button-contract.exit)。一次执行，无修 fixture、重跑或失败测试隐藏。3 个测试包括两类 LINE 字段边界和一个共享分块控制。

[源码 manifest](evidence/chat-source-manifest.json) 的 22 个选定源码/契约均逐字节匹配冻结 Git blob；部分适配器只定向阅读数据路径，没有声称全部分支动态覆盖。报告结论为 **1 项条件 P2**。没有验证真实平台服务端/UI、SDK网络行为、模型、入站平台 normalization 全量、所有 Markdown grammar 或长时重试；DingTalk 与 WhatsApp 均在候选/跳过表中，不计确认。哈希、测试计数与边界汇总见 [chat-receipts.json](evidence/chat-receipts.json)。
