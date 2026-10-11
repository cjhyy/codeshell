# 第十轮独立复核：Web / 配对端意图、草稿、配置与上传

审查对象：R03 / R25 / R26 / R27 / R32 / R33 / R34 / R37 / R40 / R41。产品只读快照为 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，`a66f4ef291f304ee4df9da8095a90671d9a8f140`；主报告和既有便携证据来自 `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12`。开始重新阅读 CODESHELL.md。未修改产品、主报告、goal 或 automation，未 build。

结论：**10 项均保留，8 P2 / 2 P3；没有撤销、升降级或新增问题。** R03 原 fixture 的旧式输出与人为扣住 ACK 不能单独证明最新生产时序，本轮补充现代输出日志恢复的断线复现后仍成立。建议 R03 优先描述“提交已接受、ACK 到达前断线、任务离线完成、重连后重试”的窗口，避免读者误以为正常有序活动 WebSocket 可以任意丢失一个 ACK 而继续交付后续帧。

## 本轮新执行的目标补强

证据目录：`/tmp/codeshell-review-20261012-web-quality-round10/`。

- `modern-intent-recovery.test.tsx`：动态从 `process.cwd()` 导入产品，输出 JSON 相对 `import.meta.url`，不依赖临时产品绝对导入。外置脚本的 node_modules 链接只用于依赖解析。
- `modern-intent-recovery.log`：**2 pass / 23 expect / 0 fail / 0 skipped**，仅在 a66f 快照新执行。
- `modern-intent-observations.json`：fetch/http(s)/net/tls 入口守卫；3 个负向探针均被拒绝，0 次意外守卫命中。

命令：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-quality-round10/modern-intent-recovery.test.tsx
```

guarded runner 创建隔离 HOME 并清除继承凭证；在 Core / Main 导入前安装守卫。目标测试使用真实 `useRemoteApp`、`useDesktopController`、`SessionManager`、`SessionOutputJournal`、`SessionOutputCoverageStore`、`SessionSnapshotStore` 和 Main `MobileOutputRecovery`。WebSocket 是内存传输；生产者完成事件由 fixture 写入真实日志，不启动模型、worker 或真实网络服务，也不声称模拟了 OS 网络栈。网络守卫是进程内守卫，并非 OS 沙箱。

正常对照：ACK 先到达，再断线并恢复输出日志，输入框仍为空，不会凭空恢复提交草稿。

异常对照：已发出的提交没有收到 ACK，先断线；原稿随 transport failure 恢复；fixture 在离线期间用原 clientMessageId 写入用户输入、run 身份、完整输出和 completed 状态。重连协商 `outputJournal: 1`，由真实 Main recovery 读取有界日志并恢复原用户条目和完成答案。此时原草稿仍在、`uncertain=false`，再次 send 被接受且产生不同 clientMessageId。没有从仍连接的有序 socket 中选择性删除 ACK。

## 逐项挑战与结论

### R03 / W1 — 保留 P2，现代日志恢复不等于提交回执核对

生产 `useRemoteApp.ts:349–366,1251–1264,1278–1280` 把等待 ACK 与输出流分开管理；断线拒绝并清空 ACK waiters，每次 send 重新生成 UUID。`DesktopApp.tsx:362–388,478` 把失败提交恢复为普通草稿，始终暴露 `uncertain:false`。输出日志 commit 不会用恢复出的用户条目 clientMessageId 结算或清理这份已恢复草稿。本轮通过现代能力、真实 Main recovery、匹配输入 ID 及 completed 持久状态补强了这一点。

真实服务端边界成立：`core/src/protocol/server.ts:2069` 在入队后发 `agent/runAccepted`；`mobile-run-dispatch.ts` 等待它后，`mobile-chat-turn.ts` 才继续 finalize 并返回，`handle-client-event.ts:422–429` 最后回 `chat.accepted`。网络可在提交到达后、浏览器收到这个 ACK 前断开。`remote-host-manager.ts:554–563` 的 close 释放 viewer，Desktop `index.ts:1214–1217` / orchestrator `releaseViewer` 撤销读/命令选择，并不取消已入队的原生任务。任务可继续完成，重连再恢复输出。

原 `intent-id-review.test.ts` 用真实 Engine 验证 same-ID 只调用 provider 一次，new-ID 会第二次执行；本轮不重复模型替身测试。限定为“可被当成新任务再次执行及再次产生任务效果”，并非每次重试都必然重复某个具体 Bash/file side effect。正常 ACK、原 ID 去重和运行中暂时阻止发送都不反驳此窗口。Room 的去重契约不作为本轮额外结论。

### R25 / W7 — 保留 P2，配置互斥门禁不能识别旧表单

真实 `DefaultModels` `HubSettings.tsx:646–674` 在外部刷新到达后会合理更新未编辑字段，连接编辑也另有 revision；但两个页面可在刷新前都构造完整 `{text,auxText}` 请求。`hub/configuration.ts:213–232` 在锁内覆盖这些已验证的连接 ID，没有 revision/原值比对。最终日志记录 `{two,one}` 先保存成功，随后旧请求 `{one,three}` 保存成功，最终 `{one,three}`。

既有 fixture 使用完整认证 Hub，并在第一 HTTP 响应返回后才放行第二个已经构造的请求，符合 `headless-server.ts:542–583` 配置门禁，不是强迫两个事务同时运行。首个任务前无 worker 是合法状态；有 worker 时需等待热重载结束。配置通知即使已更新页面，也不能修改已序列化、尚在网络中的请求。用户重新保存正确默认值可恢复；此项是跨字段静默丢失更新，不是不可恢复文件损坏。

### R26 / W8 — 保留 P3，409 安全保护正确，提示的恢复流程失效

`HubSkills.tsx:86–101` 的刷新更新列表 snapshot；已经打开的编辑器仍读取 `pane.detail` (`:257–265`)，保存仍使用旧 `detail.revision` (`:505–515`)。既有真实 Skills handler / 文件 revision 复现两次 PUT 都携带同一旧 revision；刷新清错且保留文字，但下一次仍 409。生产 `skills-management.ts:326–335` 在授权后执行相同 revision 检查；认证/配置门禁不会替客户端更新旧详情，合法闲置用户顺序操作可达。

限定为当前编辑流程无法按“刷新后重试”恢复。原草稿和他人已保存内容都保留；复制草稿、关闭并确认放弃、重开、粘贴和核对可恢复。不要改写为数据丢失、授权绕过或永久不可保存。

### R27 / W9 — 保留 P3，迟到结果没有绑定被测配置

`HubMcp.tsx:103–120` 的配置刷新按 checkedAt 清理当时已有结果；`:183–186` 的 pending probe resolve 只检查 mounted/abort，之后仍可把旧结果写回同名新卡片。既有真实组件最终日志显示新命令 `new-command` 与旧 `old_command_tool` 成功结果同时可见；没有执行真实 MCP。

生产服务端有 `cancelServer`，但 `mcp-configuration.ts:501–505` 已完成 probe 会先从 probes map 删除，`:558–562` 再返回响应。另一页面随后修改配置，不能撤回已结束且在网络中延迟的响应；HTTP 结果和配置通知之间没有同一有序消息流保障。模型连接页另有 revision 变化时 abort 的正常对照 (`HubSettings.tsx:376–391`)，MCP 此路径缺少对应约束。重新测试或再次刷新可恢复；仅列成功状态/工具列表误导，不称执行旧工具或授权泄漏。

### R32 / W10 — 保留 P2，仅新凭证无法写入的存储条件

`storage.ts:25–34,44–52` 吞掉写失败却不缓存 secret。`useRemoteSocket.ts:147–160` 在 pair.complete 使用 A；pair.ok 后 `:187–188` 再读不到持久值、生成 B，直接用服务端刚返回的 device.id 认证。真实 RemoteHostManager / TrustedDeviceStore 最终日志证明 pair.ok、secret 改变、auth.failed、status unpaired，留下一行未使用的设备。

这不是 fixture 人为替换设备 ID：当次 auth.device 使用 pair.ok 返回值。条件须同时满足无现有稳定 secret、读取可用、写 secret 失败；已有稳定 secret 的设备不在“必然失败”范围。新设备普通存储、令牌过期及外部身份攻击均不属于此项。释放存储空间后重新配对可恢复；未验证真实浏览器填满存储的 UI，但 setter 抛 QuotaExceededError 后生产代码和真实认证因果已充分固定。

### R33 / W11 — 保留 P2，创建 ACK 关联保护存在但被输出自动绑定旁路

`useRemoteApp.ts:564–597` 的创建 ACK 确实检查 clientRequestId、conversationRevision 和 connectionGeneration，过期 ACK 不应随意绑定；这项不否认该门禁。问题在 `session.stream` `:748–771`：当前无 boundSession 时先绑定首个合法后台 session，再处理现代 output cursor / recovery。`DesktopApp.tsx:253–265` 把任一新 activeSessionId 当作 pendingCreate 的结果迁移草稿，并清掉 pending。

既有 fixture 已用 `outputJournal:1`、真实生产 session.stream envelope 和 outputCursor，而非旧式 raw 帧。后到的匹配创建 ACK 会转到真正新 ID，但新稿留在后台 ID。`localDrafts` `DesktopApp.tsx:427–430` 只列 desktop-new-*，所以迁走后不再显示为本地新稿。正常 worker 输出对已认证移动端广播 (`index.ts:1741–1754`)，不是伪造跨设备认证输入。草稿仍在内存；手工选择那个后台会话可取回。不得扩写为永久删除、任意账户注入或新任务已经在错误会话执行。

### R34 / W12 — 保留 P2，前端上传锁没有连接生命周期

`mobileAttachments.ts:145–153` 的 ticket PUT 没有 AbortSignal/客户端超时；disconnect effect 只拒绝仍等票据的 waiter 和 ACK waiter，已经进入 fetch 的 Promise 仍被等待。`DesktopApp.tsx:335–336,386–388` 的全局 sendingRef 直到该 Promise settle 才释放，所以同页重连 online 后独立纯文本也被阻止。既有日志固定正常有效 300 KiB PNG、真实服务生成的票据、无 signal、重连 online 仍 uploadBusy，显式释放 PUT 才恢复。

真实主机的保护必须保留：MobileUploadService 默认五分钟 TTL，`mobile-upload-service.ts:247–253` 对已接收中的传输主动 abort；普通 socket close 不 revokeDevice/cancelActiveTransfers。不能声称主机已接收的 PUT 永久运行，也不能把受控 pending fetch 等同真实硬件无限挂起。结论是前端没有连接代次/可取消恢复、被旧请求阻塞到网络或服务端期限结束；页面重新加载或 PUT settle 能释放锁。无新增原文件丢失/上传绕权结论。

### R37 / W13 — 保留 P2，freshNative 是真实生产限定

实际项目 root 新建按钮在离线状态可点击 (`DesktopControls.tsx:163–184`)；`useRemoteApp.newSession:1457–1541` 先把可见 workspace 切到 B、清掉绑定，再忽略 socket.send=false。重连没有重发 session.create；后续 chat.send 未绑定 sessionId 且不携带 B project/root，客户端 workspace 一致性检查因此不能发现服务器仍留在 A。

既有 fixture 用真实 handleClientEvent、MobileExternalRuntimeCommands 和 prepareAgentRunMetadata：先在线合法新建 A、不发送首轮，离线点击合法 B，重连第一条任务仍被真实 metadata preparation 写成 A session/cwd/projectId，并收到关联 ACK。`handle-client-event.ts:295–298,354–380` 采用设备选择；`external-runtime-commands.ts:56–69` 只为尚未存在且属于设备新建路由的 freshNative 允许直接原生提交。生产已有反证测试 `external-runtime-commands.test.ts:394–415` 明确要求已存在 native session 必须有当前 viewer selection，且即使传 newlyMintedNative=true 也不能绕过 exists。

因此只保留旧 A 尚未落盘、同设备状态仍存续的窗口；不泛化到任意已保存 A，也不是 root/project-ID 伪造或绕过任意项目授权。模型执行被本地接纳替身截断，验证到错误目标被真实 Main 接纳；未运行模型或实际改写 A 文件。在线确认新建 B 可恢复。

### R40 / W15 — 保留 P2，保护新稿合理但失败稿没有产品副本

`drafts.ts:54–59` 的 revision 检查正确保护后续稿 B，不能简单去掉它。问题是调用方 restore=false 后仍删除失败稿 A 的可访问副本：Hub `useHubController.tsx:127–140,584–587` 删除原气泡和 submission，配对端 ACK 前本来没有用户气泡，`DesktopApp.tsx:364–370` 又忽略 restore 返回值并声称“已保留”。真实 Workbench textarea 发送期间仍能输入 B。

确定的可达拒绝在 worker 转发前：生产 Hub 配置变更门禁或附件准备错误 (`headless-server.ts:958–1017`) 先关联 RPC error 后 return；配对端 dispatch 失败回关联 clientMessageId error (`handle-client-event.ts:404–409`)。不存在已接受/持久日志可替代恢复的前提。既有正常对照无 B 时 A 能恢复、重试；有 B 时 B 仍在、A 不在草稿/消息/历史。仅确定文本和产品恢复入口缺失，不声称所有已接受任务历史或附件二进制都消失。

与 R03 区别：R40 选取明确预入队拒绝，不确定/已执行回执不参与；没有第二次执行。与 R33 区别：这里原稿没有被迁到另一个可选会话，不是错误会话选择造成隐藏。

### R41 / W16 — 保留 P2，保持页面的核对机制与刷新保护是两个边界

Hub `useHubController.tsx:567–572` 在 transport/timeout 把 submission 留在内存 uncertainSubmissions；`:187–228` 的保持页面重连核对能根据持久用户 ID 判断已消费或无会话并恢复，这是正确机制。可是 hasUnsent `:705–707` 只计普通草稿，Workbench `:215–223` beforeunload 只看它、uploadBusy、navigationDirty，没有 uncertain。

既有最终测试同时挂载真实 Workbench（普通草稿对照会 preventDefault），且用完整认证 Hub / 真 loopback WS 在传输入口丢一次 agent/run 后断线。实际服务端刷新前后 session API 都为空，排除了“任务已接受，只是客户端看不到历史”；未启动模型。uncertain=true 时离开保护=false，重建页面后仅内存意图消失。保持页面恢复或已有持久任务可以恢复，不应称所有断线/刷新都会丢任务。与 R40 的明确拒绝后失败稿删除、R03 的已接受后新 ID 重发独立。

## 既有日志与快照核对

本轮读取下列便携 fixture 的最终脚本和两基线日志，**没有把这些读取算作本轮重新运行**：

| 便携脚本（reproductions/ 下） | 原基线 / 最新快照均通过 |
| --- | --- |
| web/flow-review.test.tsx | 4 tests / 16 expect |
| web/intent-id-review.test.ts | 1 test / 4 expect |
| web-round2/settings-review.test.tsx | 3 tests / 23 expect |
| web-round3/mobile-lifecycle-review.test.tsx | 5 tests / 43 expect |
| web-round5/recovery-review.test.tsx | 9 tests / 56 expect |

每个基线各 **22 tests / 142 expect / 0 fail / 0 skipped**，覆盖文件中也包含本轮范围外的正常/既有问题，不可解读为本轮新增 22 个专项。最新日志位于 `validation/latest-a66f4ef2/repro__*.log`。本轮新增目标为另计 **2 tests / 23 expect**。

相关 Web、移动协议、配置、上传和 Main 路由文件在 84740d56..a66f4ef2 间无行为 diff；核对到 `headless-server.ts` 只有 11 行 Panel projectScope 接线新增，与本轮发送/配置门禁无关。因此没有将这十项既有缺陷归因于 a66f 新功能。

## 主代理收束

现代日志补强已复制为 reproductions/quality-round10/modern-intent-recovery.test.tsx，改为按脚本位置定位产品，两基线各2测试23断言通过；观测JSON分别来自各自执行，不把作者基线当执行基线。R03主描述已改为ACK前断线、离线完成和现代日志恢复窗口。
