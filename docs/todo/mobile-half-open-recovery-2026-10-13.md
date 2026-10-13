# 手机失联恢复与前台审批补同步

本项对应交付台账 P1.5。源码基线 `012cab63dc569ea48fee0138aa9e178cce6c59de`
（0.9.40）。本记录覆盖源码验收；正式发行与实体手机验收另行记录。
电脑配对 Mobile 和独立 Hub/Web 使用各自现有协议，不增加认证方式、系统后台推送或自动重发任务。

## 连接合同

- 每个 socket 有独立生命周期。连接阶段 10 秒；Mobile 打开后另有一次独立的 10 秒认证
  期限。前台事件风暴不会延长认证期限。
- 可见页面每 15 秒检查一次连接，发送既有只读请求，5 秒内等待响应。Hub 使用
  `agent/query { type: "sessions" }`；Mobile 使用 `session.list`。不改变普通请求
  原来的 30 秒期限，也不为长 Run 增加完成期限。
- Hub 只由本 socket 的检查 ID 对应的 result/error 确认健康。Mobile 原协议没有请求
  ID，只能由当前 socket 的 `session.list.ok` 或没有业务路由字段的控制错误确认。
  拒绝或不支持的明确响应仍证明连接可用；普通输出、审批通知不能替代检查响应。
- `online`、前台可见、聚焦及 `pageshow` 触发单次检查和补同步。隐藏页面暂停连接计时；
  返回前台重新起检查，已排队的旧期限不能处分恢复后的连接。
- 检查失败先退休旧 socket 的事件与请求，再尽力关闭并沿用原退避重连，不能等待失联的
  `close` 事件。旧世代的 ACK、打开、关闭和期限不能覆盖新世代。退出和 4401/4403
  撤销停止自动重连。

## 待审批恢复

新增 `serve/approval.snapshot` 只读 RPC，仅在已认证的 Hub socket 上可用。请求 ID 必须为
非空且不超过 512 字符的字符串，或安全整数；params 只能为空对象或省略。返回：

```json
{
  "approvals": ["原有待审批 payload"],
  "leases": [{ "requestId": "…", "holderId": null, "expiresAt": null }]
}
```

范围与原升级握手发送的审批快照相同。读取不认领、不释放、不提交审批、不启动 Worker。
已提交但尚未收到 Worker ACK 的审批不会重新成为待提交项；过期 lease 的投影为空，不因
读取延长期限。前台补同步将结果交给原 `serve/approvalSnapshot`/`serve/approvalLease`
reducer。更新的通知或用户提交会提升局部 revision，使迟到快照失效。
连接退休、授权终止或显式关闭也会立即提升连接世代；已经返回、仍在微任务队列中的
旧快照不能在新连接建立前恢复审批卡。

旧 Host 对未知 serve 方法明确返回 JSON-RPC `-32601` 时，本次恢复最多退回一次原有认证
重连以取得握手快照。其他权限、参数或网络错误不会触发这种兼容回退。重连不重发 Run、
审批或上传；使用原 Session、clientMessageId 和日志 cursor 核对已送达状态。

Mobile 保留原恢复路径：协商输出日志后，`MobileOutputClient.begin` 发送带恢复 ID 的
`session.select`，Host 在同一选择下重放待审批；旧协议 `session.sync` 也重放待审批。

## 验证与边界

私有证据目录：
`/Users/admin/.codex/release-verification/p15-halfopen-implementation-or5831td`。

- 旧客户端的两个前台检查回归确实失败。另一次真实 WS 单向失效中，上行响应丢失而
  61 条通知继续下行，初实现没有退休连接；对应原件保留。修复后真实 WS 在原期限内
  退休并重连，最终进程 exit 0。中间私有 fixture 的计时器清理错误也保留，不算产品失败。
- 组合源码上 7 个受保护 shard：110 tests / 508 assertions / 0 skipped / 0 failures。
  包含认证独立期限、后台排队期限、旧世代回调、权限错误、兼容回退，以及迟到审批
  快照与真实通知/提交的竞争。
- “响应已返回、采用前连接失效”的 5 个新增回归在修复前全部失败，覆盖真实 controller
  reducer 与 ProtocolClient 的正常退休、4401 撤销和显式关闭；修复后纳入上述组合。
- `bun run build:server` 在私有 HOME 完整成功后，实际 Node Server 与真实 Core Worker
  使用受控 loopback SSE 模型。控制器与 Worker 都在 Core 前执行原 generic guard 的
  6 + 4 负探针。健康同 OPEN 连接漏待审批通知后，前台查询恢复同 requestId/lease，
  未延长预约；提交一次审批后丢 ACK，原 Run 继续，重连恢复同日志身份/游标，原输入
  在真实日志中恰好一次。最终 Run、审批发送次数各为 1；所有子进程、socket、peer 和
  listener 关闭。它不是付费模型、实体手机或生产部署验收。
- 原 150 帧 / 50 fps / 200 ms 输出性能门槛及原十项交付范围不变。

实际手机仍需分别验证电脑配对与云项目：断网/换网、锁屏/后台恢复、审批双击与跨设备
已处理状态、消息与任务结果补达、退出/撤销以及项目隔离。应用内提示和恢复后状态补达
与 OS 锁屏 push 不同；现有 Panel 通知在工作台显示，不承诺持久通知中心或 WebPush。
实机入口与手测方式仍等待用户反馈，受控浏览器或窄 viewport 不能关闭该门槛。
