# Chat 普通消息数据独立审计（2026-10-17）

冻结基线：`ab8b03f86ad38835939d4125b56bf4513cae7f15`。仅修改本报告和 `evidence/chat-*`，不修改产品代码，不执行 Git。

本轮范围：普通消息文本/Markdown 投影、长消息切分、命令解析、conversation/session 定位与附件元数据。先读了 `channel/lifecycle/media/attachments`、`notification-relay`、`gateway`、`bound-session-chat` 及 Slack/Discord/Lark/Telegram/Teams 对应数据转换。旧 audit SWC-01/02/03/04 等账号身份、队列 spool、回环已知项不重复计入。

## CHD01 — [P2] Slack thread 身份没有投影，正常线程回复发到频道顶层

- **精确位置**：`packages/chat/src/slack.ts:67-77` 将平台 event 投影为 ChannelMessage 时没有复制 `event.thread_ts`；`:134-136` 的普通消息 payload 只有 channel/text，未携带 thread_ts。`chat-gateway.ts:111` 的 reply 只传 message.target。建议审阅锚点 `slack.ts:69`。
- **调用链**：Slack `events_api` 正常 message → `SlackAdapter.run/onEvent` → `ChatGateway.dispatch` → middleware `reply` → `SlackAdapter.send` → `web.chat.postMessage`。本项目 `ChannelMessage` 已有可选 `threadId` 字段，但所有 chat adapter 数据投影当前均未使用。
- **触发/预期**：同一频道、同一用户分别在两个不同 thread 中发普通文字；应保留各自 thread 身份，reply 应在原线程。Slack 官方 [`chat.postMessage` 文档](https://docs.slack.dev/reference/methods/chat.postMessage/) 的官方搜索结果摘录说明，携带父消息的 `thread_ts` 才会成为线程回复；不携带则发到频道会话。规范链接大小写由质量复核另行查证。
- **实际/影响**：两个输入的 projected threadId 都是 undefined，两个生产 send 方法构造的 payload 都只有频道 target 和正文，没有 thread_ts；回复失去原会话定位，出现在频道顶层而不是用户正在使用的线程。还可能把同频道/同发送者的多个线程合并为同一个上游 conversation 身份，但本轮只实证 thread 信息丢失和 reply payload 错位，不扩大为真实 session 合并实测。
- **动态证据**：`evidence/chat-slack-thread.test.ts` 真实 SlackAdapter 的 run/onEvent、ChatGateway.dispatch、SlackAdapter.send；仅 socket start/disconnect 和 SDK postMessage 为内存回调，未连接或发送平台消息。`chat-slack-thread.log` 完整 guarded 收据：1 test / 5 expectations / 0 failures，原始输入 threads / 投影 / payload 落盘。
- **边界**：证明本地 production 数据转换和参数构造；没有真实 Slack 服务端/UI、账号或网络验证。参数含义来自 web 返回的官方搜索摘要/页面摘录，本分审没有成功打开此前小写 URL。这里采用 reply 的正常会话定位预期，不宣称 ChannelCapabilities 已承诺完整 Slack threads 支持。
- **已知与否**：旧 audit 10-16 六条 SWC 未包含此项；有限旧 review 按 thread_ts/Slack thread/Slack 线程/editReply 查重未找到同根因条目，日志 `chat-slack-dedup.log`（rg 1 代表无匹配）。

## CHD02 — [P3，长标签触发] 附件名按 UTF-16 生切，产生破损 Unicode 元数据

- **精确位置**：`packages/chat/src/media.ts:232` 的 `slice(0,255)`；fallback 同样位于 `:234`。`remoteAttachment` 在 `:52` 调用该 helper，`attachments.ts:61` 原样投影 name 到 bridge 元数据。
- **调用链**：adapter 的 remote file metadata → `remoteAttachment` → `safeAttachmentName` → `materializeChatAttachments` → `PetChatInputAttachment.name`。Slack/Discord/Teams/Mattermost 等 adapter 都使用这个共有 helper；本轮只动态证明共有转换，不宣称所有平台已实测。
- **正常触发条件**：长 remote/SDK 虚拟附件标签的第 255 个 UTF-16 code unit 位于 emoji 代理对中间；例子是 254 个 ASCII 字符加一个 emoji，输入为 255 个完整 Unicode codepoints。这里是附件显示标签，未声称本机 APFS 能创建该字节长度的文件名。
- **预期/实际**：受长度限制时应保留有效 Unicode 前缀；实际返回 254 个 ASCII + 单独 high surrogate `0xd83d`，在 UTF-8 编码后变成 U+FFFD 替换字符。元数据传到 bridge 前没有修复，因此正常标签被变成乱码。
- **影响**：满足边界的附件标签损坏；附件字节保持正常，不是附件正文丢失。按 P3 记录并保留长标签前提。
- **动态证据**：`evidence/chat-text-metadata.test.ts` 真实 `remoteAttachment/safeAttachmentName/materializeChatAttachments`；字节 loader 是返回 1 byte 的内存回调，fetch 若调用即抛错且没有被调用。短 Unicode 标签正常对照保持不变；同文件还验证普通分块在 max 2/17/1800 下不丢 Unicode 或空白。`chat-text-metadata.log`：2 tests / 16 expectations / 0 failures。
- **边界/已知与否**：只证明共享函数与 bridge payload 数据，不证明某个真实平台允许/返回上述长标签；没有真实平台或文件发送。旧 audit/review 按 safeAttachmentName/附件名 Unicode/filename surrogate 有限查重无命中（`chat-metadata-dedup.log`，rg 1）。

## 候选和排除

- Discord `discord.ts:108-110` interaction 分支的每次 send 都 editReply，没有按 replied 在后续切换 follow-up，长回复可能覆盖前块。首次 fixture 在测试文件顶层 import `discord.js` 时依赖解析失败，未进入生产断言，故保留静态候选；不移除 import、不加 link、不改路径、不重跑（`chat-discord-chunks.log`：0 pass / 1 fail / 1 error，无 Completed）。
- Bound Session bridge 的输入类型只携带 text，附件没有投影；查到 `docs/todo/mimi-chat-replay-2026-09-06.md:77`、`docs/todo/mimi-wechat-image-routing-2026-09-21.md:18-22` 明确说工作会话附件直达未完整实现且该修复不扩展附件支持。按已知交付限制排除，不计新增缺陷，也未为此构造验证。
- WhatsApp 的媒体 caption/interactive body 使用同一个完整 message.text，gateway 的通用 1800 字符 chunk 可能不匹配某些消息类型的平台上限。尚未取得准确主源限制证据，未执行 fixture，不计正式发现；没有用第三方资料代替官方 API 合约。

## 收据与收束

最终确认 CHD01/P2 与 CHD02/P3（后者保留长 remote/SDK 标签前提）。Discord 长 slash 回复与 WhatsApp 消息类型长度边界只保留候选，不计发现。文本切分和 channel capability 仅有有限正常对照，不宣称已穷尽所有平台/Markdown grammar。

| 首次 guarded shard | 结果 | 原始 stdout/stderr |
| --- | --- | --- |
| 自有 Slack thread 数据转换 | 1 pass / 5 expect / Completed | `evidence/chat-slack-thread.log` |
| 自有共享文本/附件 metadata | 2 pass / 16 expect / Completed | `evidence/chat-text-metadata.log` |
| 既有 `channel.test.ts` 纯 baseline | 2 pass / 58 expect / Completed | `evidence/chat-channel-baseline.log` |
| 自有 Discord 长回复 | import 阶段 0 pass / 1 fail / 1 error，无 Completed；业务断言未执行 | `evidence/chat-discord-chunks.log` |

完整成功的 3 个 shard 合计 **5 tests / 79 expectations / 0 failures / 0 skipped tests**。另有 1 个首次依赖失败的 shard：不能计成完成测试或已验证覆盖；原始失败日志保留，没有重跑、修 import、安装依赖或改变路径。

所有测试均用 `node scripts/run-bun-test-shard.mjs --timeout 30000`，首次 stdout/stderr 即 redirect 至各自日志。没有真实 HTTP/socket、账号/认证/权限、模型、真实平台消息发送或 Git 操作；主源文档仅只读浏览。本轮结束后不再预计执行 fixture。

## 验证边界和跳过

- 不运行认证/权限/攻防、真实外网、真实账号或真实平台发送。测试只允许纯函数、自有 tmp、假适配器/假平台回调；均使用 guarded runner 且首次 stdout/stderr 重定向留存。
- 一次辅助跨范围搜索包含未匹配 `packages/desktop/src/main/bound-session*`，zsh no matches / exit 1；该搜索跳过，未修支架/变路径重试，不作为发现证据。
- 质量复核直开原小写 `https://docs.slack.dev/reference/methods/chat.postmessage` 返回 404；原页不可达，已跳过。本分审此前只有官方搜索结果摘录，未成功打开该错误 URL；本次仅把引用改为复核查证的规范大小写 URL，没有重新打开或新增实验。
