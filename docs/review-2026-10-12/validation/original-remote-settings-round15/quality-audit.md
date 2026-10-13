# 第十五轮 Mobile Remote 设置状态独立只读质量复核

结论：**保留 P3。** 正式支持的两个 Desktop 主窗口可以各自停留在“手机遥控”设置区。初始 Host 关闭、没有 relay 登记时，A 普通开启 LAN 后，B 的已挂载组件缺少更新触发，仍显示“已关闭”，开启按钮可用、关闭按钮禁用。Main 已真实运行，发起方显示正确。重新进入该设置区，或在 B 再次点开启可恢复；后者按同模式幂等返回原监听，不会创建第二个 Host。影响限于已打开观察方的状态与控制可用性，不是远程 Host 未启动、授权绕过、任务/历史丢失或所有远程模式均无法同步。

本复核只读 `a66f4ef291f304ee4df9da8095a90671d9a8f140` 工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`、已有最终 fixture/log，以及原审查主报告 R01–R65。未运行新测试、进程、listener、Electron、模型或网络实验，未创建子代理，未修改产品、主报告、目标或构建。新增执行文件/测试/断言计数均为 **0**；这里只写本文件。

## 正式入口与多窗口权限

`packages/desktop/src/renderer/shell/CommandPalette.tsx:188–194` 提供“新窗口 / Cmd+Shift+N”，调用真实 preload newWindow；Main `packages/desktop/src/main/index.ts:5835–5837` 调用 createWindow，`:1370–1380` 采用正常 renderer preload 并加入 `mainWindows`。不是只能打开一个设置窗口的产品限制。

`packages/desktop/src/renderer/settings/SettingsPage.tsx:333` 的正常设置导航包含 mobile-remote，`:817` 挂载完整 MobileRemoteSection。每个 renderer 的实例各有 `AdvancedSections.tsx:1572–1578` 的本地 status state，不共享 React 状态；各实例可以在另一个窗口开启前已读到 `{running:false}`。

Main `index.ts:1029–1039` 构造一份 Desktop remote services，windows getter 是全部 `mainWindows`。`desktop-remote-services.ts:67–75` 的 isMainWindow 接受集合中任意存活的实际 WebContents，没有只允许首窗口的限制；`device-relay-ipc.ts:11–20,22–32` 要求 sender 存活、senderFrame 等于主帧、属于该集合。正常两个主窗口都能合法 start/status/stop。fixture 只使用一个注册 sender 和两个 UI 实例，动态没有验证两个不同 WebContents；上述生产接线证明另一个正式窗口并非被权限门禁排除。

## 缺少启动后的更新触发

MobileRemoteSection 的 `AdvancedSections.tsx:1619–1637` refresh 读取 Main status 后 setStatus，并读取 relay/devices/passcode/binary/online 状态。`:1696–1703` 的 start 成功后只由**当前实例** setPairingUrl、调用 refresh；该调用不会更新另一个 renderer 的 state。

Main controller `packages/desktop/src/main/mobile-remote-controller.ts:209–251` 启动 LAN：校验模式和 generation，关闭旧 transport，在 `:233–242` await Host.start，随后返回 URL/pairing；LAN 成功后没有调用 publish。publish 在 `:98–104` 才触发 changed；service `desktop-remote-services.ts:60–65` 才会广播 `mobileRemote:relayStatusChanged` 到所有窗口。因此本例没有可推动 B refresh 的状态事件。

这里的初始条件需保留。controller 的 closeTransport `:113–118` 只有**已有 registration**时才 publish stopped；没有 relay 登记的初始 LAN 流程不会收到这个启动前事件。已有 relay 登记时可能产生启动前 stopped 广播，其异步刷新与新 Host 启动的相对顺序本轮没有验证，不能说所有已登记、跨模式或任意重启场景必然保持旧状态。

实际 `packages/server/src/mobile-remote/remote-host-manager.ts:147–159` 合并并行 start，`:353–385` 等待真实 HTTP listen 成功后保存 started。类全部 emit 点没有一般 Host-started 状态广播；`status():646–647` 只返回当前 started。它会发设备在线变化，但那条链不是一般运行状态事件。

一个关键反证是 fixture 替换了未运行的 tunnel。真实 `packages/server/src/mobile-remote/tunnel-manager.ts:319–334,388–395` 的 stop 没有 live child 时直接完成，并明确抑制 disconnect event；不会因 controller 在 LAN start 前调用 closeTransport 而自动替观察方刷新。因而 fixture 的 noop tunnel.stop 没有隐藏一个能够排除此初始 LAN 例的生产状态事件。

## 已检查的刷新、恢复与正常广播

没有忽略现成的 refresh，范围如下：

- **挂载/回到设置区**：`AdvancedSections.tsx:1654–1661` 的 effect 调 refresh；发现正在运行且有 URL 时 regenPairing。SettingsPage `:817` 按 active 区域条件挂载，切到别区再回到 mobile-remote 就能重读。effect 的依赖变化也可能使其重跑，所以“永远不会刷新”不成立；保持相同依赖的已挂载实例不会仅因 peer LAN start 自行重跑。
- **本地操作**：本实例 start `:1700–1703`、stop `:1717–1720`，以及 removeDevice `:1771–1772`、renameDevice `:1784–1789`、changePasscode `:1803–1804` 会 refresh。DeviceRelaySettings 的登记/移除也可调用传入 refresh，但该子组件只在 mode=relay 时挂载（`:1835–1836`）。这些是可见的额外刷新入口，不是初始静止 LAN 观察方的 peer 更新订阅。
- **tunnel / relay 事件**：`:1668–1685` 在 tunnel connected/disconnected 和 relay status 时 refresh。Main `index.ts:1077–1084` 真正转发 tunnel status，service `desktop-remote-services.ts:60–65` 真正转发 relay status。LAN 的成功启动不走这两条 post-start 更新。
- **设备在线变化**：Main `index.ts:1107–1112` 转发 onlineChange，preload `mobile-remote-api.ts:19–22` 正常订阅，但组件 `AdvancedSections.tsx:1687` 只 setOnlineIds，不刷新 status。所以即便之后设备在线，这个 listener 自身也不能修正 running=false。
- **不存在轮询/聚焦重读**：该组件没有 setInterval、focus、visibilitychange、storage 的运行状态刷新；SettingsPage 的 focus/keydown 相关代码负责搜索/标题焦点，没有给 MobileRemoteSection 加入运行状态刷新。模式 localStorage `AdvancedSections.tsx:41–57` 只是偏好，未订阅 peer storage 事件；启动时保存 mode 也不传播 running。
- **再次点开启可恢复**：controller `:219–221` 对已有相同模式且有 URL 的 Host，直接返回原 URL/配对码；组件随后按本地 start 的正常 refresh 更新。最终 fixture 第三项明确断言端口不变，不能描述成重复监听或需要先关闭旧 Host。
- **停止广播正常**：controller `:439–445` 在 stop 后显式 publish，即使未登记 relay 也 publish 当前 state；service 广播，实际 preload `device-relay-api.ts:8–11` 分发事件，组件 offRelay 回调 refresh。关闭按钮因本地 `status.running=false` 而禁用（`AdvancedSections.tsx:1923`）；先通过恢复入口得知 running 后，按钮可用、停止同步链正常。

UI 状态关系是生产源码直接决定的：start disabled 条件含 status.running（`:1910–1915`），stop disabled 含 `!status.running`（`:1923`），状态文案按 `status.running` 选择运行 URL或已关闭（`:1927–1930`）。观察方旧快照会同时给出三个一致但过期的反馈，不是 fixture 单独截取了一条无关文案。

页面中的“刷新”按钮在有 pairingUrl 时才渲染（`:1952–1957`），handler 只 regenPairing；初始 stale 观察方没有 pairingUrl，不能把这个按钮当作始终可用的通用 status refresh。即便某个其他操作刷新了 status，恢复说明也不能消除缺少 peer LAN-start 更新本身。

## 最终证据与替身范围

读取 `/tmp/codeshell-review-20261012-remote-settings-round15/remote-settings.test.tsx` 与最终 `remote-settings.test.log`。最终日志是 **3 pass / 23 expect() calls / 0 fail / 0 skipped，Completed**，耗时 731 ms。这是 root 已执行的一份证据，本复核没有重跑，不能再累计这 3 测试。

1. 第一项 `:109–130` 挂两个完整 MobileRemoteSection，A 实际执行开启 handler；真实 controller/Host 都 running，A 显示 owned loopback URL，B 仍已关闭且 start enabled/stop disabled。捕获的 start 后 relayStatusChanged 数量为 0，status IPC 增量仅 1（发起实例 refresh）。卸载重挂 B 后真实 status 读取恢复 URL。
2. **最终补强的停止控制** `:132–143` 先让 A 开启，再由 B 幂等点 start，并在 `:136` 断言 B 已显示运行 URL；然后 A stop，Host 停止，A/B 均回到已关闭，捕获广播且两个 relay listeners 在位。这已经动态验证观察方 running→stopped，不再只是“观察方原本就关闭”的弱控制。先前 3/22 版本另存为 control22.log，不与最终结果相加。
3. 第三项 `:146–158` 独立确认 stale B 可点 start 恢复同一端口，并验证错误 frame、非注册 WebContents 对象调用被真实 IPC owner gate 拒绝；Host 端口未被破坏。不存在为了复现而放宽正式控制门禁。

完整 renderer settings 组件、effects/actions、actual mobileRemoteApi/deviceRelayApi、createDesktopRemoteServices/controller/IPC 与 RemoteHostManager 都按生产逻辑执行。Host 唯一 listener bind 地址被替换为 owned `127.0.0.1`，仍经过真实 listen/stop/配对码实现；没有暴露 LAN 端口，也没有连接远程客户、浏览器、云账号或模型。`installLocalNetworkGuard(http://127.0.0.1:9)` 在这些导入前安装，脚本要求 guarded HOME。native Electron IPC 的传输由测试桥分派；safeStorage、未用 tunnel/binary/passcode 和 ancillary 只读 handler 是明确替身/适配，选择器绘制和 QR 编码也是替身；不能简称“没有替身的完整 Main”。

两个 UI root 共用一个 MiniDOM/window 对象、同一个注册 sender 和监听通道，**不是两个真实 Electron 窗口**。缺少 start 广播这一因果不依赖 sender 区分；生产多个主窗口共享 controller、分别本地 state、同样没有 post-start 事件，已静态核对。动态只证明组件→实际 preload→真实 controller/IPC/loopback Host 链中的两个实例行为，不声称原生窗口事件、焦点变化、LAN 地址可达性、远程 pairing/auth、完整 Main 或手机端到端验收已经完成。Host.status 只在实际 listen 成功后保存，当前证据足以确认 owned listener 已创建；没有通过真实 LAN 或 /health 访问验证外部连通性。

`remote-settings.harness-failed.log` 保留早期文本 helper 不兼容 MiniDOM 和调用不存在的 CloudAccountManager.dispose 所致失败；`remote-settings.initial-pass.log` 是早期 2 pass/15 expect。它们均是 fixture 开发过程，不是产品失败，也不并入最终成功数量。最终 cleanup `:100–104` 卸载两个 root，dispose controller/真实 Host，删除自建 owned 临时目录；没有读取用户账户或项目数据。

## 分级、去重与修复建议

P3 合理：正常多窗口可达，但影响局限于**已经打开的另一实例**的旧状态，发起窗口、真实 Host 和授权门禁正常；重挂或幂等 start 可恢复，stop 广播也能正常同步。不能将错误文案提高为已证实的安全入侵、无法关闭整个服务、永久状态损坏，或 P2 的任务执行问题。

与 R47、R61 独立。R47 是自动化任务生命周期变化后详情没有更新，其 producer、数据与订阅接口属于 automation。此项需要在 MobileRemoteController 的运行状态变更后更新 remote settings，修复自动化详情不触及该链。R61 是 shared SessionCatalog 的 activeSessionId 广播过度覆盖每窗口导航；本例恰是同一个全局 Host 事实**缺少**成功启动广播，未读取或修改 sessionIndices/activeSessionId。三项都涉及异步 UI，不能因此合并为同一根因或把它泛化成所有多窗口数据不同步。

建议给 remote Host 运行事实提供一致的 start/stop/mode 状态更新，并让所有已挂载 MobileRemoteSection 重读或消费权威 snapshot；保留本地 busy、当前 start/stop 结果处理、初次 mount refresh、same-mode 幂等与现有主窗口/frame门禁。可复用现有广播机制，但不应仅修改启动方 refresh，也不应为同步而去掉权限保护或每次 peer start 重启 Host。

只读 git diff --stat 确认关键 AdvancedSections、mobile-remote-controller、desktop-remote-services、device-relay-ipc、preload mobile-remote-api、RemoteHostManager 在 `84740d56e55517b004948a0a0e07649ad6fbf998..a66f4ef2` 之间无变动。本复核只动态证据读取 latest；源码相同不等于本子任务在旧基线再运行了测试。工作区 status 只见先前已有 `?? docs/review-2026-10-12/`。
