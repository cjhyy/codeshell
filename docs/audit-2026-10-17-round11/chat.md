# Chat 普通文本、附件元数据与通知进度审查（第十一批）

冻结源码：`b8b776d56e5982e59b18de0262d5c49367746625`。本批只写报告、fixture 与证据，没有产品代码或 Git mutation。范围为 shared splitter、普通 Markdown 投影、channel 能力、附件元数据与内存通知进度；适配器只定向读取普通数据转换。未向平台或任何人发消息。

## CHAT-R11-01 — P3：通知进度首次读取失败被缓存，后续自动重试不再读取已恢复的 store

**位置与正常入口。** [notification-progress.ts:187](../../packages/chat/src/notification-progress.ts#L187) 的 `ensureLoaded()` 用 `loadTask ??=` 缓存首次加载 Promise；拒绝后没有清除。每次 `begin()` 在 [116 行](../../packages/chat/src/notification-progress.ts#L116) 都先等待同一 Promise。长期存活的通知 handler 在 [notification-relay.ts:97](../../packages/chat/src/notification-relay.ts#L97) 创建一个 progress 实例、在 123 行开始事件。CLI 的 [cli.ts:116](../../packages/chat/src/cli.ts#L116) 和 Desktop [im-gateway-service.ts:565](../../packages/desktop/src/main/im-gateway-service.ts#L565) 都只构造一次 File store/handler 后交给 watcher；两处明确显示“Desktop 通知等待重试”。File store [69–71 行](../../packages/chat/src/notification-progress.ts#L69) 将非 ENOENT 读取错误上抛，正常的读取 API 失败可以进入这个分支。

**契约与触发。** [DesktopControlClient.watchEvents:188](../../packages/chat/src/desktop-control-client.ts#L188) 顺序处理通知，只有 handler 成功才推进事件 cursor；[212–218 行](../../packages/chat/src/desktop-control-client.ts#L212) 在错误后等待并再次轮询。暂时读取错误消失后，该循环应能重新尝试加载进度，继续原事件。当前第一次 `store.load()` 拒绝会使后续重试一直等待那个已拒绝的 Promise，直到 handler 被重建。

**实际证据。** [首次 fixture](evidence/chat-progress-load.test.ts) 执行真实 `NotificationDeliveryProgress`、`createDesktopNotificationHandler` 和 `DesktopControlClient.prototype.watchEvents` 方法，仅用内存 store、fake adapter 和 page/sleep 回调：store 的第一次 load 抛模拟暂时读取错误，之后任何实际 load 都能成功。实际 watcher 处理同一事件重试 3 次，得到同一错误对象，`load=1`、`send=0`、轮询 cursor 为 `[0,0,0]`。测试在第 3 次错误后主动 abort，不声称执行了无限重试。完全相同的 store 交给新 handler 后第二次 load 成功，原事件发送 1 次。

**控制与影响边界。** 初次正常 load 的 watcher 控制只有 1 次 load/1 次 send、无 error；同一 progress 实例的 save 暂时失败可通过 `flush()` 恢复，表明问题限定首次读取 Promise。动态证据支持同一 handler 的自动恢复受阻；未诱发真实磁盘 EIO/EMFILE，不推断发生频率、OS 行为、账号平台接收或 UI。cursor 仍停在原事件，新 handler 能处理，因此不称永久丢失；同一 watcher 的后续通知会静态地排在该事件后面，未动态演练多个生产 outbox 事件。

**查重。** [所有历史清单](evidence/chat-all-history-dedup.json) 枚举全部 1601 个旧 docs/bugs MD 与 parsed JSON，含 archive/_archive 和普通命名文档，35 个路径/精确 helper 相关文件，0 parse error；未找到通知首次 load rejected Promise 同根因记录。早先 [audit/review 命名子集](evidence/chat-dedup.json) 为 1111 个文件、94 个宽关键词相关文件，另有 [进度专项检索](evidence/chat-progress-dedup.json)；两次关键词范围不同，匹配数量不可相减当成新发现。新增匹配的普通设计/roadmap 只描述现有通知进度复用，没有这个初始化拒绝缓存的既有 finding。旧通知结果映射、DeliveryQueue FIFO/ACK、LINE 上限、Slack thread 与 Unicode 附件名不重复计入。检索/散列不是宣称逐行审查过全部旧文档。

## 候选与跳过

| 项目 | 处置与证据限制 |
| --- | --- |
| CHAT-R11-C1，普通 Markdown button URL/标签转义 | [lifecycle.ts:14](../../packages/chat/src/lifecycle.ts#L14) 仅转义标签 `]`，URL 原样放入括号；合法 URL 含不配对括号、标签含反斜杠时的确切平台渲染仍未证明。官方 Mattermost 文档 open 无可读正文，官方源码树首次 fetch 被拒，立即 SKIP，未写产品 fixture、下载或换 parser 验证。只列静态候选。 |
| WeCom 字符/字节上限旧候选 | 阅读官方 AI Bot SDK README 后只能确认它另述 replyStream 20480-byte 限制，不能套到当前 sendMessage。未测试，不新增候选或确认。见 [主源收据](evidence/chat-primary-contracts.json)。 |
| Discord editReply 多 chunk/import 失败方向 | 保持 SKIP；没有继续该实验、导入、修依赖、重跑或替代验证。 |
| 旧 Slack thread、Unicode attachment name、LINE button lengths、Telegram code fences、DeliveryQueue FIFO/ACK | 已有记录，排除重复；本批没有重复动态验证。 |
| 猜测 `packages/chat/src/package.json` 的静态导航 | 首次工具 exit 1；[明确标记的响应转录](evidence/chat-navigation-skip.md) 保留。不修路径重试该方向，不把审查导航错误当成产品文件缺失。 |
| File store 权限/符号链接/custody 测试 | 只读源码说明边界，没有运行相关既有测试或自造实验。 |

## 首次验证和覆盖限制

| 首次 guarded shard | pass | expect | fail/skip | 结果 |
| --- | ---: | ---: | --- | --- |
| [progress load fixture](evidence/chat-progress-load.first.log) | 4 | 33 | 0 / 0 | Completed、exit 0 |
| [channel existing baseline](evidence/chat-channel-baseline.first.log) | 2 | 58 | 0 / 0 | Completed、exit 0 |
| 合计 | **6** | **91** | **0 / 0** | 2 clean shards |

每次仅运行 `node scripts/run-bun-test-shard.mjs --timeout 30000 FILE`；FIRST 合并 stdout/stderr 和 exit 均先完整落盘再读取，没有修 fixture 或重跑。4 项 focused 中包括 1 项缺陷 characterization、2 项恢复控制、1 项 shared splitter 控制；2 项是既有 channel 能力 baseline。splitter 控制在 max 2/17/1800/8000 下完整重建 Unicode/空白，块不超限且不拆开 UTF-16 代理对；不承诺 grapheme cluster 不分割。

[validation](evidence/chat-validation.json)、[findings](evidence/chat-findings.json)、[candidates](evidence/chat-candidates.json)、[冻结源码 manifest](evidence/chat-source-manifest.json)、[材料收据](evidence/chat-artifact-receipt.json) 记录命令、首次计数与哈希。没有 full-suite、build、typecheck、lint、真实磁盘错误、生产 host、真实 SDK/platform、模型、网络、账号/用户数据、native process 或权限安全/custody 执行的结论。fixture 调用 watcher 原型方法时没有构造 client，不进入 request/descriptor/spawn/checkpoint 路径。
