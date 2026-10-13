# 移动配对 / 新会话 / 断线上传第三轮审查

基线：`84740d56e55517b004948a0a0e07649ad6fbf998`。产品工作区：`/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`，下面产品路径相对此目录。本轮未修改产品文件。

生产入口：`packages/desktop/src/mobile/main.tsx:4,14` 实际挂载共享 `packages/web/app/DesktopApp.tsx`，后者使用本报告测试的 `useRemoteSocket`、`useRemoteApp` 和 `useDesktopController`；没有使用旧移动 App。测试保留生产 `outputJournal:1` 协商能力。

验证命令：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-web-round3/mobile-lifecycle-review.test.tsx
```

最终结果：**5 pass / 0 fail / 0 skipped / 43 assertions / 960ms**。脚本及日志位于本目录。guarded runner 隔离 HOME；Core-facing import 前封锁 fetch；配对测试创建全新临时 TrustedDeviceStore、真实 loopback RemoteHostManager，上传票据测试创建真实临时 MobileUploadService。WebSocket 由 fixture 精确推进生命周期和服务端帧，HTTP PUT/退出请求用受控未完成 promise 模拟正在等待的浏览器请求。W13 使用真实 handleClientEvent、MobileExternalRuntimeCommands、prepareAgentRunMetadata，项目注册表读取以两个合法的隔离项目 fixture 注入，只用 fixture worker 发真实格式的队列确认，不执行任务。不访问用户账户/服务，不发送模型请求。

## W10 — [P2] localStorage 配额耗尽时，新设备配对成功后立即认证失败

- 精确定位：`packages/web/src/lib/storage.ts:38-44` 每次读取不到 secret 就重新生成；`:23-28` 吞掉 setItem 失败却没有内存缓存。`packages/web/src/hooks/useRemoteSocket.ts:147-159` 配对时生成一次 secret，`:187-194` 收到 pair.ok 后再次读取/生成 secret 并认证。
- 操作时序：新浏览器尚未有 `cs.deviceSecret`，同源 localStorage 已满，getItem 可以读取而 setItem 抛 QuotaExceededError。用户打开桌面提供的一次性配对链接；第一帧 pair.complete 携带 secret A；主机真实保存设备并返回 pair.ok；浏览器第二次 getOrCreateSecret 得到 secret B；随后 auth.device 携带 B。
- 实测：真实 RemoteHostManager 的第一帧返回 pair.ok，第二帧返回 auth.failed。客户端最终显示 unpaired，桌面留下一个无法在该浏览器使用的已配对设备记录。日志 `QUOTA_PAIRING` 记录 `credentialChanged:true`、`unusedDeviceRows:1`，未输出任何真实凭证。
- 服务端校验与限制：`packages/server/src/mobile-remote/remote-host-manager.ts:445-464` 的一次性 pairing.commit 成功后才发送 pair.ok；`:466-477` 使用真实 TrustedDeviceStore.authenticate，后者 `trusted-device-store.ts:80-95` 比较已存 secret 且拒绝已撤销设备。此处服务器正确拒绝不匹配 secret；缺陷在客户端未保持同一次页面生命周期的稳定身份。本复现是新设备、已有 quota 用尽；未把 getItem 本身被浏览器禁止的其他场景混入。
- 影响：配对主流程不能完成，重新生成配对链接仍重复失败，直到用户清理同源存储或换浏览器。safeSet 的现有注释声称可使用内存值继续握手，实际只有本次函数返回值，没有跨两次调用保留。
- 建议：为 device id/secret/name 提供页面级稳定内存后备，写失败时明确提示持久化受限。pair.ok 后认证与同源 HTTP 身份读取应使用同一个稳定身份源，而非临时生成第二份 secret。
- 测试缺口：现有 socket 配对测试使用正常 MemoryStorage，未覆盖 getItem 正常、setItem 抛 quota 的握手全流程。
- 信心：高，已用生产主机认证代码验证。

## W11 — [P2] 新会话创建确认前，后台原生会话输出会把新草稿搬到错误会话

- 精确定位：`packages/web/src/hooks/useRemoteApp.ts:768-771` 在 boundSessionRef 为空时无条件绑定第一条 session.stream，没有检查 pendingCreateRef；新会话 action `:1464-1468,1505-1522` 正处于 pendingCreate 且主动清空当前 binding。`packages/web/app/DesktopApp.tsx:253-265` 把随后出现的任意 activeSessionId 当成新建结果，迁移草稿后就清除 pendingCreate。
- 操作时序：用户从已选会话点“新建”，创建请求已发送但 chat.accepted 尚未到达；用户立刻输入新任务草稿。桌面另一原生任务此时输出合法 session.stream。客户端绑定这个后台 session 并迁移草稿。真正新会话的带匹配 clientRequestId 的 chat.accepted 随后到达，客户端正确切到新会话，但用于迁移的 pendingCreate 已被消耗。
- 实测：真实 useRemoteApp 和 useDesktopController 中 activeId 依次为 `desktop-new-*` → `unrelated-background` → `actually-created`。真正新会话草稿为空且 localDrafts 为空；再次选择 unrelated-background 才能找回完整草稿。日志 `NEW_SESSION_DRAFT_STOLEN` 保留绑定时序及草稿实际归属。未声称未经授权执行了错误会话的任务。
- 服务端路径与限制：`packages/desktop/src/main/index.ts:1731-1749` 把每个 worker 输出广播到已认证移动客户端；`packages/server/src/mobile-remote/remote-host-manager.ts:543-550` 广播不按手机当前选中会话筛选，因此其他原生会话的合法输出可以抵达。创建在 `packages/desktop/src/main/mobile-remote/handle-client-event.ts:317-343` 校验目标后回带 clientRequestId；目标项目/root 和 legacy cwd 校验在 `:209-229`，本问题不绕过目标校验。UI 的 ACK 绑定检查 `useRemoteApp.ts:568-597` 本身有效，遗漏的是其之前的流自动绑定路径。后台输出可在创建请求仍未送达、目标校验等待、或响应传输延迟时先到手机；无需伪造消息或过期 ACK。
- 影响：新建任务的文本/附件草稿被归到另一任务，新建页面看似丢稿；用户若沿错误绑定继续编辑，也会在错误上下文处理草稿。这与第一轮 CC open 广播响应问题不同：此处是原生后台 stream 和新会话 pending 状态交叉。
- 建议：pending create 时将非目标原生输出只记未读，不自动绑定；草稿迁移必须以对应 clientRequestId 的创建确认作为依据，而不是任意 activeSessionId 变化。
- 测试缺口：既有 ACK revision/generation 测试隔离了迟到确认，没有覆盖创建确认前收到其他任务的原生 session.stream，并同时检查草稿最终归属。
- 信心：高，实际客户端控制器确定性复现；广播与创建确认路径已静态核对。

## W12 — [P2] 已开始的手机 HTTP 图片上传无法随断线取消，重连后继续阻塞后续发送

- 精确定位：`packages/web/src/lib/mobileAttachments.ts:145-153` 取得 ticket 后的 HTTP PUT 没有 AbortSignal/客户端超时。`packages/web/src/hooks/useRemoteApp.ts:1251-1266` 断线只拒绝尚在等 ticket/消息 ACK 的 waiter，已经开始的 PUT 不在这些集合中。`packages/web/app/DesktopApp.tsx:335-336,359-389` 全局 sendingRef 只在该异步 sendChat 结束后释放，`:475-476` 同时让上传/添加附件保持忙碌。
- 操作时序：已连接手机选择 300 KiB PNG（超过 inline 阈值）并发送，服务端发有效票据，浏览器 PUT 正在传输/等待响应；Wi-Fi 切换等原因令 WebSocket 断开，旧 PUT 尚未完成；手机成功重连后输入另一条文本并发送。
- 实测：真实 MobileUploadService 接受该文件元数据并生成 TTL=300000ms 的票据。真实客户端 PUT RequestInit 没有 signal。WebSocket 完成重新认证后 app.status 已为 online，但 uploadBusy 仍 true；controller.send 对后续纯文本返回 false，未发 chat.send。只有旧 PUT 拒绝后才释放 busy。日志 `STALLED_UPLOAD` 保存上传字节数、没有 signal、重连在线状态和阻塞结果。
- 服务端校验与限制：服务端 `packages/server/src/mobile-remote/mobile-upload-service.ts:110-149` 验证 MIME、大小、设备和票据数量，且 `:247-253` 在票据到期时主动中止正在接收的传输，默认 TTL `:12` 为5分钟。因此正常抵达主机的旧 PUT 有服务端到期上限，本条不称无限阻塞。普通 WebSocket close 的 `remote-host-manager.ts:554-563,135-144` 只释放 viewer/在线计数，生产代码没有 device-offline 上传清理监听；只有显式设备撤销 `:580-584` 或停主机 `:632-635` 才批量中止上传。真实浏览器也可能较快因网络错误拒绝 PUT；问题触发条件是旧 HTTP 请求仍未 settle，而 WS 已恢复。
- 影响：手机已经显示在线，仍可能数分钟不能发送独立文本任务或重新选择附件；共享 Workbench `packages/web/app/Workbench.tsx:803-838` 显示“正在发送…”且禁用发送，停止按钮只在 run running 时出现，没有上传取消恢复入口。
- 建议：每次发送/上传建立 AbortController，断线或显式取消时中止属于旧 connectionGeneration 的 HTTP 请求，尽快恢复草稿和发送能力；上传取消状态应与运行停止分开表达。
- 测试缺口：既有上传测试覆盖 ticket 超时、PUT 失败、体积限制和服务端传输到期，但未覆盖 ticket 已成功取到、HTTP 仍 pending、WS 断线再在线后的控制器发送恢复。
- 信心：高（客户端锁生命周期确定性复现；网络条件使用受控 pending PUT，主机实际票据校验和5分钟上限已核实）。

## W13 — [P2] 手机离线新建另一个项目的任务后，首条文本可在上一个尚未落盘的项目会话执行

- 精确定位：`packages/web/src/hooks/useRemoteApp.ts:1457-1541` 新建没有 online 检查；`:1523-1540` 忽略 socket.send=false，却已在 `:1499-1522` 把 UI 项目和会话切换为新目标。重连 `:1633-1640` 只请求 room/project 列表，`:1195-1221` 没有 bound session 就不恢复/重发创建。首条发送 `:1276-1277` 捕获空 sessionId。服务端 `packages/desktop/src/main/mobile-remote/handle-client-event.ts:295-298,354-357` 将空 sessionId 解析为旧设备选择；`external-runtime-commands.ts:56-69` 对刚由本设备创建而未落盘的 native session 有 freshNative 例外。
- 生产按钮：`packages/web/app/DesktopControls.tsx:163-184` 根目录选择按钮在 offline 状态没有禁用；传入 action 是 `DesktopApp.tsx:293-306,521-527` 的真实 workspace/draft/newSession 包装。专项从 renderSidebar 返回的实际 app.newSession callback 调用，未误用共享 controller.newSession（该零参数 callback 只用于当前项目新对话）。
- 操作时序：手机在线时在合法项目 A 点新建，收到带 clientRequestId 的创建 ACK，尚未发送第一轮，所以 sessionId=A新ID 已在设备状态中、但未持久化。WebSocket 断线；用户在目录选择器点击项目 B 的主根并填写任务。客户端切到 B 并呈现新草稿，但没有 session.create 帧被发送。WebSocket 重连为新 viewer，旧 viewer authority 已撤销；重连没有补发 B 创建。用户发送首条纯文本，帧中没有 sessionId/projectId/cwd。
- 实测：UI 发送前 workspaceCwd 为 B；真实服务器 handler 根据仍保留的 st.selectedSessionId/st.sessionId 找到 A新ID，freshNative 校验允许该尚未落盘 ID 进入 Core 原生路径。真实 prepareAgentRunMetadata 用有效项目 A 注册根重新校验/注入元数据后，排队确认的 agent/run 包含 `projectId:a,cwd:project-a,sessionId:A新ID`。日志 `OFFLINE_CREATE_WRONG_PROJECT` 保留 UI 路径、实际排队路径、无重发帧及 `realMetadataValidation:true`。
- 服务端校验与限制：此问题严格限定为旧会话由该设备刚新建、没有首轮写入，符合 `sessionId===st.sessionId && !exists`。对已经落盘的旧会话，新 viewer 没有当前 accepted selection 时会被 external command authority 拦住，不能泛化为任何旧会话都错误执行。生产 `mobile-remote-orchestrator.ts:291-312` 保留设备会话状态；断线 `:131-134` 只撤销 viewer 的命令/恢复授权；项目根真实校验 `:348-358` 和元数据检查保证执行 A 是合法授权根，但它不是手机当前明确选择的 B。专项注入的注册表包含两者均合法、已信任根，没有弱化 session producer gate，也没有假造 exists=true。
- 影响：断线状态允许的新建操作看似完成，恢复在线后首条任务却在另一个合法项目执行；真实模型若遵循文本编辑文件，会作用于 A。测试仅验证队列请求目标，没有发任何模型请求或实际修改项目文件。
- 建议：离线时禁用需要服务端确认的新建/切项目，或显式保留 pending create 并在重连确认前阻止发送。首条 chat.send 应携带已确认的新会话 ID/创建关联，而不是依赖设备上一个选择的 fallback。
- 测试缺口：缺少“旧项目刚创建未落盘 → 离线选择另一个项目新建 → 新 viewer 重连 → 首条发送”的集成测试。仅测 offline send 拒绝或已有持久会话 authority，无法覆盖 freshNative 例外。
- 信心：高（实际 UI action、服务器 dispatcher、producer gate 和 Main 元数据验证均复现；worker 执行用排队确认 fixture 止步）。

## W14 — [P3] “退出此设备”必须等待 HTTP 响应，网络慢请求会阻止本地退出

- 精确定位：`packages/web/app/DesktopApp.tsx:550-553` 直到 post 的 finally 才调用 app.logout；`packages/web/app/auth.ts:70-78,102-108` 没有超时/AbortSignal。共享 Workbench 生产按钮 `packages/web/app/Workbench.tsx:518-525` 直接调用这个 callback，没有 pending 反馈。
- 操作时序：已配对且 WebSocket online，用户点击“退出此设备”；同源 POST /api/v1/auth/logout 正在等待请求建立或响应，尚未 settle。WebSocket 仍正常。
- 实测：真实 controller.logout 在 HTTP promise pending 时保留 cs.deviceId，socket 保持 OPEN，app.status 仍 online；释放成功 HTTP 响应后才清掉本地 ID、关闭 WS、进入 unpaired。日志 `STALLED_LOGOUT` 保存退出前后状态。
- 服务端限制：Desktop HTTP `/auth/logout` 在 `packages/server/src/desktop-web/http-api.ts:409-414` 正常收到请求后立即丢弃该浏览器的 HTTP session 并回200，但不负责清掉浏览器设备 ID/已配对 WS；客户端仍必须关闭 WS。本条不是声称主机正常处理退出要耗时，触发条件是网络中 HTTP 请求/响应卡住。请求较快失败时 finally 会完成，本地退出能恢复。
- 影响：点击退出没有视觉反馈且仍显示/保留工作台，用户无法及时完成本地退出；若网络恢复而请求仍在等待，只能刷新/清存储等手工绕行。没有声称远端设备撤销被绕过，列为流程 P3。
- 建议：本地停止发送、关闭 socket、清除页面身份和展示退出状态应立即执行；服务器 cookie 撤销独立进行并给出有界重试/超时。不要让本地退出依赖一个未限定时长的 HTTP promise。
- 测试缺口：退出测试未覆盖 HTTP logout 未完成但 WS 正常的状态。
- 信心：高，实际 controller 和 socket 生命周期确定性复现。

## 未提升为正式发现的路径

- 未把在线 session.create 与后续 chat.send 的异步 dispatch 直接认定为普遍错误会话执行。生产 external command authority 对已保存原生会话的旧选择有检查；W13 仅报告已证明的离线丢请求与 freshNative 限定窗口。
- 未把普通设备撤销后重新配对的猜测列入：生产桌面移除入口会实际删除设备，不等于只设置 revoked 标记的测试辅助情形。
