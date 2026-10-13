# 第十三轮：配对 Web 连接、监听和导航生命周期

> 主报告收束：本附录原候选 W23 在此改称 W24，正式编号为 **R62 / W24 / P3**。root 已将便携脚本复制到报告目录，并在 84740 与 a66f 两基线分别 guarded 复跑成功。下文“仅 latest”描述的是代理首次实验范围，不能用来覆盖这次补充验证。


审查冻结快照：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，`a66f4ef291f304ee4df9da8095a90671d9a8f140`。开始前读取 `CODESHELL.md`，对照主报告 R10/R11/R16/R19/R32/R33/R34/R37/R38/R41 和 `auth-round7.md` 去重。只写本报告及同名 `/tmp` 目录，没有修改产品、主报告、goal 或 automation，没有 build。

结论：**1 项独立、可恢复的 P3 候选 W24；另外 5 项目标测试为正常控制。** 未确认新的连接泄漏、重复实时订阅或跨会话历史归属缺陷。普通旧房间历史/审批回包有过滤；同设备广播的 `ccRoom.opened` 导航干扰仍归 R16。

## W24 [P3] 离开 CLI 会话后，旧房间审批卡仍阻塞新对话

实际入口：生产 `packages/desktop/src/mobile/main.tsx` 渲染共享 DesktopApp/Workbench；`packages/web/app/DesktopApp.tsx:529` 提供 `DesktopChatControls`，其 `DesktopControls.tsx:57–65` 在 activeRoom 存在时显示“离开 CLI 会话”，直接调用 `app.leaveRoom`。不依赖已经废弃的 `packages/desktop/src/mobile/App.tsx`。

触发条件：已打开 CLI 房间 A，A 的普通阻塞审批（测试使用 Read，而不是 AskUserQuestionAsync）已经在当前页面显示；用户点击“离开 CLI 会话”。`useRemoteApp.ts:1608–1622` 发 unsubscribe、清 activeRoom/历史引用和 feed，却没有清除属于 A 的审批。`DesktopApp.tsx:332–337` 把全部 `app.approvals` 计入 running，并拒绝新 send；`:481–487` 继续渲染该卡。此时标题/消息区已离开 A，仍残留 A 的卡，独立新稿无法发送。

证据：`/tmp/codeshell-review-20261012-web-lifecycle-round13/lifecycle.test.tsx` 最后一项测试运行真实 `useRemoteApp`、`useDesktopController`，从真实 `DesktopChatControls` 生成的按钮元素取得并执行其 onClick。没有替换 leaveRoom、审批数组或 controller.send。断言 activeRoom 变 undefined、feed 清空、卡的 roomId 仍为 room-A、controller.running=true、实际 send()=false 且没有 chat.send 帧。预先给客户端提供一个真实协议形状的 native-B 列表项，再通过 controller.selectSession("native-B") 恢复；卡被清空、running=false。

正常反证：相邻测试在无既有审批的情况下执行同一按钮回调，离开后 running=false；随后到达的 A 审批因为 activeRoomId 不匹配而被丢弃。因而不是所有离开都会阻塞，也不是晚到审批重新插入卡，而是离开前已经存在的卡没有随导航清理。

恢复/影响：重选已有原生会话可恢复；新建会话也会清审批（`useRemoteApp.ts:1478–1502`，本轮仅源码核对）。旧卡保留原 roomId，若用户选择答复，`DesktopControls.tsx:305–318` 仍会给 A 发回应，**不是把审批发给新会话**。A 正常 resolved 广播也会清卡（`useRemoteApp.ts:1098–1099`）；这一正常终结路径本轮只读核对。本轮不宣称审批自动执行、权限绕过、任务/文件丢失，也不宣称用户必须重启。P3 与一步重新选择即可恢复的影响相称。

独立性：R10 是切到其他会话/断线时卡片丢失、没有服务端 pending snapshot；这里卡片仍在，却已脱离当前会话并阻塞新稿。R11/R19 分别依赖传输失败/回包失败，本例连接正常且没有发送审批答复。R14 是可选异步问题被误判为阻塞，本例普通 Read 审批在 A 内本来就应阻塞，问题是离开 A 后仍全局生效。建议单列 P3，而不要把 R10 的严重性扩大；如希望合并同类生命周期修复，可作为 R10 的独立反向子场景归档，但不能写成“所有房间切换都丢卡”。

建议方向：离开房间时按归属移除当前显示的卡，保留服务端 pending 权威；房间重新进入时应通过 pending snapshot 恢复（R10），而不是跨会话保留旧卡。发送门禁也应按当前会话绑定，避免其他会话的审批阻塞独立任务。

范围：前端真实 hook/controller/生产按钮回调的确定性测试；使用 mock WebSocket 注入合法协议事件，未挂完整 Workbench DOM、未启动实际 resident CLI、模型或外部账号。本项 UI 阻塞不依赖一个真实进程正在等待；服务端 Read 审批生产来源及持续 pending 契约已有第十轮实际本地 resident 证据，此轮没有重启该实验。

## 已运行的正常控制与排除

1. **配对 socket 重连/卸载。** `useRemoteSocket` 重新认证提升 connectionGeneration，旧代 send=false；旧 socket message 的闭包被当前 wsRef 检查拒绝。focus/pageshow/visible 在已在线 socket 上只触发 resync。卸载置空全部 socket handlers 并移除四个唤醒监听，随后派发唤醒事件没有新 socket 或 resync。连续 focus+online 在 CONNECTING 阶段会替换待连接 socket，测试看到共三次构造，但前两份已经 CLOSED，只有一份当前连接；不把有限的主动重拨误报成重复连接泄漏。对应源码 `useRemoteSocket.ts:103–121,179,225–232,248–285`。
2. **CC 历史去重和切换归属。** 同一 seq=6 从 room.history 与 room.message 到达只显示一次。切到 native-B 后，旧 A 的 history、transcriptSubscribed 和 approvalRequest 都被过滤，不替换当前内容/会话。对应 `useRemoteApp.ts:862–894,1028–1031,1064–1067,1373–1405`。未构造任意重排单连接同步回包的 fixture：实际 `handle-cc-room-event.ts:77–111` 在没有 await 的分支同步取快照/历史后立即 reply，`TranscriptSubscriptionManager.subscribe` 也同步建立 snapshot/cursor，不能靠 mock 人为延迟声称普通 A→B→A 历史乱序可达。异步打开和同设备多页签广播已归 R16，不新增。
3. **Hub 认证撤销与显式恢复。** 真实 ProtocolClient 收 4401 时拒绝 pending RPC（transport），发一次 auth loss；等待超过首个自动重连预算后仍无新 socket。显式 connect() 建立新 socket 并使用新请求 ID；旧 socket notification 闭包不进入回调。源码 `protocol.ts:125–135,169–197,223–226`。本项使用 mock close code，认证端真正主动撤销/多页签的可达性由已有 auth-round7 覆盖，不声称本轮重新运行真实 Hub。
4. **viewer 引用计数、切房间和精确释放。** 真实 TranscriptSubscriptionManager 在隔离目录读自制 Codex JSONL。两 viewer 共享 A，viewer1 改订阅 B 后 A 的 viewer2 仍有效；随后迟到 unsubscribe(viewer1,A) 不会退订 B。B 的新行由新 viewer 的同步 drain 看见；逐一 release viewer 后仅最后一个 viewer 离开时 stop watcher。生产 `RemoteHostManager.releaseSocket` 在 close/revoke/stop 发 viewer-offline，`desktop/main/index.ts:1214–1217` 同步调用 orchestrator.releaseViewer 和精确 transcript unsubscribe；这一 Main 接线本轮只读，未启动真实 WS server。`subscribe`/`unsubscribe` 来源 `transcript-subscriptions.ts:88–170`，不把共享 watcher 当成多次监听。
5. **普通 leave 对照。** 无既有卡时同一生产按钮正常回到 idle；离开后的旧房间审批被过滤，详见 W24 对照。

静态可疑但未确认、**不列正式**：Hub session list 多个异步 HTTP refresh 未见 request counter，可能出现旧列表覆盖；本轮没有证明真实 server 处理与用户删除/导航时序下会造成新增流程阻塞。WebSocket OPEN 半开、旧 CONNECTING socket 在 close 后人为触发 onopen 的 mock 顺序没有真实浏览器证据，亦不列缺陷。没有扩展 R32/R33/R34/R37/R38/R41 已有凭证、草稿、上传和离开保护结论。

## 执行、安全与证据

命令（工作目录为冻结仓库）：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-lifecycle-round13/lifecycle.test.tsx
```

最终 **6 pass / 47 expect / 0 fail / 0 skipped，1.391 秒**。实际 stdout 保存 `lifecycle.log`，逐项结论在 `observations.json`。只有冻结 a66f 执行本轮最终六项；并未声称两基线都复跑。所查七个关键文件在 84740d56→a66f4ef2 的 git diff --stat 为空，属于旧实现本轮新增发现，不是 a66f 引入。

guarded runner 创建隔离真实 HOME；真实 fetch/http/https/net/tls 入口与 child_process spawn/exec/fork 在动态产品导入前安装拒绝 guard；mock WebSocket 构造只接受精确 `ws://127.0.0.1:51313/ws`，没有真的监听或连接。最终 denied=0，未执行网络/子进程创建；这是已调用入口上的拒绝 guard，不是 OS 级网络沙箱的声明。测试只用自制临时 JSONL、watchFile 和 mock 浏览器；所有 hook/client/watcher 已释放，临时 transcript 目录已删除，无需清理进程，没有读取或操作任何其他任务进程。

开发测试经历两个 harness 修正：先把 /tmp 测试的 React 解析改为仓库 node_modules 的动态导入；然后将“连续两次唤醒必定仅构造两份”的错误断言改为核对旧连接已关闭和当前连接唯一。没有改产品来使测试通过。中间五项版通过后加无审批 leave 对照，最终统计以六项版日志为准。
