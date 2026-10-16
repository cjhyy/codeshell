# Server / Web / Chat / Link / Browser 审查记录

基线：`66ee7737a7d6203319834e601c84afe6757f801e`。只记录审查与自有复现，不修改产品实现。本轮已收尾；“已验证”不代表真实平台端到端验证。

## 第一轮已确认

### SWC-01 [P2] 同渠道多账号排序改变后，持久消息会交给另一个账号

- 位置：`packages/chat/src/chat-gateway.ts:140`（按 `channel:ordinal` 构建持久路由标识）、`:147`（按该标识恢复 adapter）；`packages/chat/src/channel.ts` 的 adapter 合约没有稳定账号标识。
- 触发：SDK 合法配置 `[账号 A, 账号 B]`，B 收到消息，队列已经持久接收但尚未投递；重启时配置顺序变成 `[B, A]`。同渠道多账号是现有 `chat-gateway.test.ts` 明确支持的功能。
- 预期：消息继续归属 B，或因无法确定原账号而拒绝恢复；实际：旧 `custom:1` 被解析为 A，middleware 与 `reply()` 都使用 A。
- 影响：跨账号错误回复、读取错误账号上下文；当不同账号使用局部 target 标识时，可能投给错误对话。这里实际证明的是路由错账号，没有声称验证真实 Telegram/Slack 的可达性或数据外泄。
- 验证：直接执行真实 `ChatGateway.run()` 与 `DeliveryQueue`，两轮真实磁盘队列，平台 adapter 为无网络回调替身。第一轮 B 持久记录 `adapterId=custom:1`，第二轮交换顺序，得到 `A:private account B content`，B 没有 send。证据：`evidence/server-chat-identity.test.ts` 第一个测试。
- 是否已知：对旧 `docs/review-*` 按 adapter identity / ordinal / account 查重，没有找到同一问题；旧修复注释仅考虑移除“不相关渠道”导致全局索引移动，仍未绑定同渠道账号身份。
- 建议：持久 adapter ID 绑定不可变账号身份，不使用列表位置；恢复时验证身份，无法匹配时明确处置，不能自动落到另一个账号。

### SWC-02 [P2] 不同账号的消息共用去重键，第二个账号被当作重复成功接收

- 位置：`packages/chat/src/delivery-queue.ts:150`、`:160`、`:595` 的 `deliveryDedupeKey`。键只包含 `channel,target,senderId,messageId`，不包含传入的 `adapterId`；completed 也共用同一 namespace。
- 触发：两个同渠道账号都收到相同 target/sender/message ID（例如同一个群消息到两个 bot，或自定义渠道的账号局部 ID）；消息正文/账号不同也不影响 dedupe。
- 预期：各账号具有独立 inbox 身份；实际：两个 adapter handler 都 resolve，但第二条没有持久记录、不会进入它自己的 middleware。
- 影响：多账号 SDK 会静默丢一条合法输入；第一账号先完成时，同样会被全局 completed 键抑制。
- 验证：真实 gateway、真实 durable queue，A、B 两个独立无网络 adapter 分别 emit；两个 handler 返回成功，磁盘 pending 只有 A 的一条。证据：`evidence/server-chat-identity.test.ts` 第二个测试。
- 是否已知：未找到旧已确认同根因条目。该问题与 SWC-01 同属账号身份缺失，但无需重启或重排即可触发，去重键的修复位置也不同。
- 建议：dedupe 与 completed 键加入稳定账号身份，并对旧格式迁移时采取保守策略。

### SWC-03 [P2] 小附件 spool 发生 I/O 错误时仍返回接收成功，重启后消息消失

- 位置：`packages/chat/src/delivery-queue.ts:183`、`:190`、`:238`、`:385` 的 `spoolAttachments` catch；`packages/chat/src/chat-gateway.ts:163` handler 丢弃 enqueue 状态并 resolve。
- 触发：已启动 durable queue 的 spool 目录暂时不可用（复现中目录位置被普通文件阻塞），收到合法、只有 1 byte 的附件；停止进程后恢复目录，再重启。
- 预期：普通小附件的持久化故障应明确告知调用者已降级，令其可以选择拒绝确认或可靠重试。当前 memory-only fallback 是代码有意的可用性策略，README 也承认媒体 loader 可留内存；本项不把所有后备策略本身判为 bug。实际：spool 的所有异常被吞成 `undefined`，记录设置 `persistent=false`，enqueue 返回 `queued`，平台 handler 会视为成功；下一次队列没有该消息。
- 影响：瞬时磁盘权限/容量/路径故障期间，已 ACK 的附件消息永久丢失。当前注释和测试明确保留“过大附件”内存后备，但普通有效附件的 I/O 故障也走同一无告警路径。
- 验证：真实 queue 的 filesystem 写入失败，enqueue=`queued`、内存 pending=1；恢复目录后构建新 queue，pending=0。正常 1 byte 附件对照可恢复 pending=1。证据：`evidence/server-chat-identity.test.ts` 第三、四个测试。没有真实平台 ACK；ACK 影响来自 gateway handler 的真实 resolve 接线和平台合同，不夸大为实际服务商重投实验。
- 是否已知：旧 `docs/review-remaining-2026-10-12/coding-tui-chat.md:229` 仅将 spooling 后备列为“未加独立恢复 fixture 的可见风险”；本轮新增小附件真实 I/O 故障与重启证据，不是复制旧已确认结论。
- 建议：区分显式超限策略与普通 I/O/materialization 故障，向调用者返回/记录降级状态，再由调用者选择拒绝确认或接受内存后备；避免“queued”掩盖本地不可恢复性。

验证命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-16/evidence/server-chat-identity.test.ts
```

结果：4 pass / 0 fail / 9 expect；guarded runner 使用隔离 HOME。fixture 全部自有临时路径，结束后删除；无真实账号、外部网络、模型调用。

## 已读范围与下一轮

- 第一轮：Mobile `remote-host-manager` 的完整建立连接/认证/输出/撤销路径；Web `useRemoteSocket`、`mobileOutputClient`、`app/protocol`、approval reducer；Chat `delivery-queue`、`chat-gateway`、`lifecycle`、`ingress`、adapter factory；Browser diagnostics `inspector` 与 Desktop 使用接线；Link browser handoff、device OAuth broker、service 开头；Hub auth HTTP、Web auth/API scope。
- 查重后保留为已知待再验：Mobile broadcast/device 输出无背压；Chat 同 target retry 越序；Telegram allowlist 前下载。它们不会计入本轮新增条目。
- 第二轮继续：Link 授权生命周期/HTTP 边界；Web 输出恢复和 scope 切换；server uploads/session/request 生命周期；browser/CDP 兼容层。

## 第二轮已确认

### SWC-04 [P2] Matrix botUserId 可省略，正常回复会再次进入输入并触发回复回环

- 位置：`packages/chat/src/config.ts:617` 把 botUserId 作为可选配置；`packages/chat/src/matrix.ts:163` 仅用这个可选值过滤自己，没有启动时查询 token 的真实用户 ID。
- 触发：合法 Matrix 配置有 homeserver/token/允许的 room，但没有 botUserId，且用户 allowlist 为空（允许 room 中的成员）；用户发一条消息，bot 回复后 homeserver 在下一次 `/sync` 返回 bot 自己的 `m.room.message`。
- 预期：自己的回复始终排除输入；实际：sender 与 undefined 不等，bot 自己的文字成为一条新消息，回复后又返回下一轮 sync。
- 影响：出现自问自答、额外模型/工具任务与平台发送。CLI 的 per-sender rate limit 可最终阻止一个 burst，不能把它当作身份过滤；SDK 未安装 limiter 时回环可持续。未执行真实模型、计费或平台端到端循环。
- 验证：真实 `MatrixAdapter.run()` 和 `send()`，注入严格检查 `https://fixture.invalid` 的纯内存 fetch（没有真实 HTTP）。初始 owner 消息后，正常 bot echo 两次，观察到 dispatch `[owner,bot,bot]`、send=3；设置正确 botUserId 的对照为 dispatch `[owner]`、send=1。证据：`evidence/server-chat-matrix-self.test.ts`。
- 是否已知：旧审查只对 Matrix 静态扫读，未找到同一已确认问题。Mattermost 也有同样可选 self-ID 过滤设计，但本条动态证据仅覆盖 Matrix，不把另一个平台作为已验证。
- 建议：启动时通过受认证的 whoami 确定真实 bot ID 并校验可选输入，或把该身份设为必填、拒绝无法过滤自己的配置。

验证命令：`node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-16/evidence/server-chat-matrix-self.test.ts`；2 pass / 0 fail / 19 expect，隔离 HOME，无网络调用。

### SWC-05 [P2] 一个有效 JSON 但非对象的 state.json 让整个磁盘会话目录查询失败

- 位置：`packages/server/src/sessions-service.ts:337-342` 仅 catch JSON.parse/readFile，`:343-345` 后直接解引用及对 state 使用 `in`，没有校验 JSON 根是对象。
- 触发：会话目录包含单个损坏的 `state.json`，内容为合法 JSON `null` 或 `42`，其他会话健康。
- 预期：隔离损坏会话并继续列其他记录，与同文件 `listSessions()` 的防御逻辑及当前 malformed JSON 分支保持一致；实际：`null` 在读取 `.ephemeral` 时抛错，`42` 在 `"parentSessionId" in state` 抛 TypeError，整个 async list reject。
- 影响：Desktop 磁盘会话恢复、侧栏导入与依赖该 catalog 的 host read model 无法读取任何会话，直到损坏文件被人工处理。未证明正常 Core writer 会写入 null/数字；这是明确的本地损坏隔离缺陷，不声称远程攻击入口。
- 验证：真实 reader、真实独立文件系统；健康+null 和健康+42 均 reject；相邻 `listSessions()` 仍正常返回健康记录；损坏内容改成 `not JSON` 后 listDiskSessions 也正常略过并返回健康记录。证据：`evidence/server-session-catalog.test.ts` 第一个测试。
- 是否已知：按 listDiskSessions / corrupt / non-object / null 查重，没有找到同一旧已确认条目。
- 建议：JSON.parse 后在局部 try 范围内验证非 null、非数组对象，再读取字段；单条不合格直接 continue。

### SWC-06 [P3，条件触发] 相同目录 mtime 的混合大小写会话，分页会漏项

- 位置：`packages/server/src/sessions-service.ts:304` 用 `localeCompare` 排序；`:315` 用 UTF-16 `>` 判断 cursor 后继，两者次序不一致。
- 触发条件：两条以上合法 ID 的会话目录 `stat().mtimeMs` 完全相同，且分页边界落在两种字符次序不同的位置。Core 自动化会话使用 nanoid(16)，大小写/下划线/连字符合法；本轮 fixture 用 utimes 明确构造同 mtime，**没有证明日常 APFS 写入自然产生相等时间戳**，也没有把 startedAt 相等当作目录时间相等。
- 预期：分页拼接应等于全量列表；实际：合法 `a000…、B000…、c000…` 全量为 a/B/c，limit=1 连续分页只返回 a/c，B 从后续页消失且 cursor 已结束。
- 影响：满足时间戳条件的历史恢复/侧栏加载遗漏部分记录；原文件仍在，不属于磁盘数据丢失。不同 mtime 的正常对照完整返回 a/B/c。
- 验证：真实 reader 和真实目录，局部 Core 根目录/archive export 用未使用即抛错的 stub 代替，所有调用显式传入 fixture 根，没有 Core/Engine/renderer/import producer 执行。证据：`evidence/server-session-catalog.test.ts` 第二、三测试。
- 是否已知：独立发现后查重命中旧 `history-pagination-static-preflight.md`，旧报告只保留静态条件候选；本轮补了 reader 动态证据，但仍保留“自然生产同 mtime 前提未验证”的限制，不将其计作全新根因。
- 建议：sort 与 cursor 后继比较统一使用同一个 comparator。

验证命令：`node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-16/evidence/server-session-catalog.test.ts`；3 pass / 0 fail / 10 expect。累计自有证据：3 文件、9 tests、38 expect；均 guarded HOME、0 外部通信。

## 已有测试与构建结果

以下 baseline 均在同一冻结 worktree、经 `scripts/run-bun-test-shard.mjs --timeout 30000` 执行并从首次运行起将 stdout/stderr redirect 到相应磁盘日志。各分组内部独立测试文件可见日志中的 suite 名称；workspace 依赖经只读 symlink 指向主仓库已有安装/构建产物，不宣称所有依赖模块均从本 worktree source 加载。

| 分组 | 首次结果 | 原始磁盘日志 |
| --- | --- | --- |
| Server（auth store/HTTP、approval lease、run replay、worker bridge、disk catalog/archive、trusted devices/pairing/client event validator、Link handoff/HTTP），12 文件 | 121 pass / 1 fail / 532 expect | [server-baseline-server.log](evidence/server-baseline-server.log) |
| Web（stream/journal/transcript/room/attachments/device、output client/reconnect/liveness、approval/API scope/Link），12 文件 | 121 pass / 0 fail / 355 expect，Completed | [server-baseline-web.log](evidence/server-baseline-web.log) |
| Chat（queue/gateway/config/media/webhooks/desktop client/adapter factory），7 文件 | 71 pass / 0 fail / 182 expect，Completed | [server-baseline-chat.log](evidence/server-baseline-chat.log) |
| Link + CDP + browser-devtools，7 文件 | 104 pass / 0 fail / 560 expect，Completed | [server-baseline-link-browser.log](evidence/server-baseline-link-browser.log) |

Server 首次唯一失败是 `links/http.test.ts` 的 native Node disconnect case，错误为本 worktree 尚无 `packages/server/dist/links/http.js`，在 import 阶段 `ERR_MODULE_NOT_FOUND`，尚未达到业务断言。该首次失败原始日志保留，没有覆写成通过。

父代理授权后只执行 `bun run --cwd packages/server build`；该脚本清理并重建本任务 worktree 的 server/dist，未重建/清理共享依赖。构建 exit 0 已在当时工具返回中确认，[server-build.log](evidence/server-build.log) 保存脚本输出。随后只重跑 `packages/server/src/links/http.test.ts`：11 pass / 0 fail / 42 expect、Completed，native disconnect case 通过，见 [server-baseline-links-http-after-build.log](evidence/server-baseline-links-http-after-build.log)。没有再执行完整 Server 分组，因此不把首次整个分组写为一次通过；单文件重跑与首次的 10 条正常测试重复，不能另加为新覆盖。初次共有 418 个不同 tests，其中 417 通过、1 环境失败；补构建后的单文件日志补齐该 case 的通过证据。

## 自有复现收据与限制

三份自有 fixture 最初执行时**没有 redirect stdout/stderr 到文件**，临时 JUnit 也未保留。此前报告的 4/2/3 pass 与 9/19/10 expect 来自当时 exec_command 返回的 stdout，包含各自 `Completed Bun shard`。质量核查指出原始磁盘收据缺失后，本轮仅把已有会话工具 stdout 逐字转录为以下文件，没有重跑补收据：

- [server-chat-identity.log](evidence/server-chat-identity.log)：tool chunk `859ee5` 的 transcript excerpt。
- [server-chat-matrix-self.log](evidence/server-chat-matrix-self.log)：tool chunk `3d8ad2` 的 transcript excerpt。
- [server-session-catalog.log](evidence/server-session-catalog.log)：tool chunk `17a8f0` 的 transcript excerpt。

这些是**从保留会话输出派生的逐字摘录，不是 runner 原始落盘日志或独立 JUnit 收据**；每份文件头明确说明该区别。因此复现源码、工具返回与摘录支持本轮观察，但不能声称具备独立磁盘 raw/JUnit 审计链。

第二轮额外静态阅读：`server/hub/{files,uploads,run-replay,approval-lease}`、headless server 请求准备/关联/完成与撤销接线；Panel resource directories/process file 导出；Link operation validation/runtime 适配；Web `auth/api-context`、panel resource upload/runtime polling、environment/website routing；Chat Matrix/Mattermost/Lark/WeCom/LINE/WhatsApp adapter。未从这些剩余静态路径新增未经验证的 bug，旧已知背压/ACK 等问题也没有因仅扫读而再声明为已动态通过。

平台限制出现后父代理要求停止所有动态实验、构建和服务测试；从该通知起仅做已有文件读取与报告整理，没有重试被中止的操作。审查在此收尾，**不是已穷尽全部模块、所有平台或整个仓库行为**。本报告范围未运行真实外部账号、付费模型、真实平台消息、完整浏览器/Electron 或 Docker。SWC-06 继续保留明确触发前提；Mattermost self-ID 相似设计只作静态待审，不提升为验证项。
