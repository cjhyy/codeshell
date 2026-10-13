# 第 21 轮 Chrome idle disconnect 独立质量核证

审查时间：2026-10-12 06:42–06:45 Asia/Singapore。只读冻结 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`（`a66f4ef291f304ee4df9da8095a90671d9a8f140`）。已读作者 fixture、最终日志、observations、抽取后的 Main JS，并逐段核对生产 BrowserPanel、preload、Main、ChromeBackend、NativeServer 与 extension service-worker。**本复核未执行测试、未改 fixture 或产品；仅写本 `/tmp` 文件。**

作者 fixture：`/tmp/codeshell-review-20261012-browser-lifecycle-round21.test.tsx`，只读核对时 SHA256 `ef376b426f71dc862ec7ce2f6ac0861997fcd1f21a7883d49d7e015c6e20c8f0`。作者最终日志为 `/tmp/codeshell-review-20261012-browser-lifecycle-round21-final.log`，记录 **1 文件 / 3 tests / 40 Bun expect / 0 fail / 0 skipped / Completed**。这属于作者执行证据，不是复核代理的新执行，也不得和后续移植重跑重复累计。observations 中 networkCalls=0、subprocessCalls=0。

结论：**支持一个窄 P3 候选：“Chrome 空闲断线后仍显示正在使用，未呈现连接已结束及重新配对入口”。** 用户可显式断开再配对恢复；下一次工具动作正确 fail closed，并会触发后续轮询纠正。因此不支持 P2、不支持授权越界、错目标执行、真实数据/消息丢失、永久不可恢复或 Chrome 动作在断线后继续执行等扩大结论。

## 实际复现链与替身边界

- 实际生产 `BrowserPanel`、ToastProvider、renderer hooks 在 MiniDOM 中挂载。以真实 React props 中的 onClick 调用组件正式 click handler；不是 Electron 原生鼠标事件、webview 或完整 App。
- 实际 `packages/desktop/src/preload/index.ts:1694`、`:1696`、`:1698` 分别调用正式 pairing/status/revoke channel。Electron contextBridge/ipcRenderer 是自有内存 adapter。
- fixture 从完整 Main 源码抽取 `assertRendererSessionAccess()`（`packages/desktop/src/main/index.ts:4324`）及 `chrome-begin-pairing`、`chrome-status`、`chrome-revoke`、`chrome-installation` callbacks（`:4483` 起），TypeScript transpile 后执行。比对抽取 JS，原有 live-session/owner/label 检查均保留，没有重写有问题的业务分支。AgentBridge 的 known-session/owner 目录由 owned adapter 提供；测试确实验证另一 sender 被拒、unknown task 被拒。并非完整 AgentBridge/Main 运行或真实目录集成。
- ChromeExtensionBackend 为真实实现。其 Native transport 由 connected boolean + owned request adapter 表达；hello/pairing.grant 由 fixture 送入正式 `handleExtensionMessage()`。不把它当真实认证、Native Messaging framing、Chrome debugger attach 或用户当前标签。
- 两次 actual 2 秒 status poll 由生产 BrowserPanel 定时器产生，未重写 refresh。各 case 以 predicate 等待，不把同步伪造 chromeRuntime state 当复现。
- 所有 Core/renderer/Main-host 模块加载前安装 maintained exact-origin guard，以及 direct net/tls/subprocess 拒绝。无真实 Chrome、Native relay、worker、Electron、模型或外网；fixture URL 是 owned 不加载地址。

## “正在使用”不能解释成仅保留历史授权

仅 Backend `granted` 字段不足以断言用户误导，因为它可能表示历史 permission。本 fixture 进一步执行实际 UI：

1. `BrowserPanel.tsx:292` refresh 取正式 Host status，`:300` 提交 chromeRuntime；`:309` 每 2 秒刷新。
2. `:621` 仅看 `chromeRuntime.granted` 选择 `chromeActive`。`connected` 虽在 schema 与回包中存在，没有用于文案、active 按钮或恢复分支。
3. 中文 `packages/desktop/src/renderer/i18n/ns/panels.ts:201` 为 “Browser Runtime 正在使用已登录的 Chrome 标签：{title}”；英文 `:484` 为 “Browser Runtime is using the signed-in Chrome tab: {title}”。两者均表达当前使用，和同文件 built-in “已授权”文案有可核对差异。
4. `BrowserPanel.tsx:575` 根据 granted/pairing 只显示“断开 Chrome Runtime”，`:580` 继续 active；`:609` 只在 error 存在时 alert；`:618` 继续展示 active banner。测试断线后 Host 回包 connected=false、旧 granted 仍在、error 缺省，经过 2 次实际轮询仍见该 banner/断开按钮，连接按钮不存在、alert=0。

这里不把“idle 时也说正在使用”单独当问题；真正失败触发是 transport 已断且旧 grant 在正式执行门禁中被定义为 ended，UI 仍持续声称当前可用，并让恢复操作首先表现为断开。

## idle disconnect 不是无效状态注入

作者的 disconnect() 只让 owned Native transport status 由 connected=true 变 false，没有直接改 backend grants、renderer state 或绕开回调；该 seam 对应以下生产路径：

- `chrome-native-server.ts:106` status 由 live client 与 destroyed 决定 connected。
- Native socket close 在 `:166` 清 client、reject pending，但没有 backend onDisconnect/revoke callback。无在途 requests 时完全可能只变 connected。
- Backend `status()` 在 `chrome-extension-runtime.ts:150` 继续由 `liveGrant()` 取 granted；`:550` 的 liveGrant 只检查 TTL，和 `:491` 的 isCurrentGrant 把 !server.connected 判定为 grant ended 不一致。
- Chrome 扩展 `service-worker.ts:65` onDisconnect 把 nativePort=null、拒绝 pending、调用 sessions.revokeAll()。`removed()` 在 `:201` 仅在 nativePort 仍存在时发送 tab.detached/tab.closed；extension disconnect 的本地 cleanup 不会通过已经断开的连接通知 Backend。代码没有自动重连 timer；nativeConnection 由后续 nativeRequest 调用创建，新连接 hello 在 `:76` 发送。
- 因此例如扩展/Native relay 在空闲期间断开而 Desktop 仍运行、没有新 hello 或工具动作时，该状态正式可达。不能用“正常 tab.closed 事件常能及时 revoke”否定所有 Native transport 断线情形，也不能称作者已经实测真实扩展关闭。

existing `chrome-extension-runtime.test.ts:240` 的 disconnect 分支先启动一个 action 并排队第二个，之后 action 的 requestForGrant 后置检查会清 grant；不能覆盖本候选的 idle poll。实际新 hello 在 Backend `:229` 明确清旧 grant，是正常恢复控制，不能证明无 hello 时状态会自行修正。

## 恢复与 fail-closed 对照

作者第二项通过实际 UI revoke 按钮 → preload → unchanged Main callback → Backend.revoke，connected=false 时仍清旧 grant、返回 status，使连接按钮重新出现、active banner 消失。旧 grant 下 navigate 返回 NEEDS_HUMAN、native browser.action=0。接着 owned transport 重连并向实际 Backend 送 fresh hello，再点击真实 UI connect，生成新 pairing code；正式 pairing.grant 后 status 有新 grantId、connected=true，UI 恢复 active。

新 grant 下 listTabs 走 actual secureBridge `chrome-extension-runtime.ts:435` → currentTab `:316` → requestForGrant `:523` → owned Native adapter `tab.get`，成功返回 exact tab 23。它证明新授权状态下高层只读 RPC 恢复，**不是纯内存 tab 枚举，也不是真实 Chrome 浏览器动作实测**；不声称 navigation/click/登录态或真实扩展附着已恢复。首次质量消息曾将 listTabs 简写为内存 control，后续已向父代理纠正为上述准确调用链。

作者第三项在 idle disconnect 后调用实际 Backend.dispatch；isCurrentGrant 清旧 grant并返回 Chrome connection ended / NEEDS_HUMAN，native browser.action=0，之后生产轮询清 active UI、恢复连接按钮。此对照直接支持安全门禁正常、问题仅为无动作期间的反馈与恢复入口；其 evidence 不是“离线操作悄悄成功”。

## 建议正式报告范围

主定位可选 `packages/desktop/src/renderer/panels/BrowserPanel.tsx:621`，关联 `chrome-extension-runtime.ts:150`、`:550`；中文/英文证据 `i18n/ns/panels.ts:201`、`:484`。触发条件写明“已配对且未过期，在空闲期间 Native transport 断开，Desktop/会话继续存在，未发生 fresh hello 或工具 dispatch”。影响写明“继续显示当前使用 Chrome；普通 2 秒轮询不纠正，也不出现连接失败/直接配对入口；需显式断开后重配，或由下一次失败动作触发更新”。

修复应让 status 报告连接结束时及时结束旧 grant/给出断线状态，或让 renderer 显式按 connected 展示恢复提示；仍保持 ended marker、fresh explicit grant 和 exact tab/grantId fences。不要以静默 fallback 到另一 browser target 作为恢复。

parent Stop 的静态窄缝继续保留在原预审批注，本次没有动态覆盖，不并入此候选。
