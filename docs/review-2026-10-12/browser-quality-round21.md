# 第21轮 BrowserPanel idle断线候选独立审计

Completed。新增测试、原生浏览器/Electron实验、模型、网络执行 **0**；未修改产品、作者fixture或主报告，仅写此独立审计。

读取作者最终报告 `browser-lifecycle-round21.md`、同前缀fixture、final.log、first.log、observations、feasibility、cancel-gates及cancel-gates-quality，并核对最新a66f冻结源码与主报告79项/flow去重。

## 裁定

**支持保留单项B21-1，建议P3。** 准确问题是：已合法配对、grant未过期，Native transport在闲置期间断开且没有fresh hello或browser dispatch时，正常2秒轮询已经拿到connected=false，但BrowserPanel继续显示“正在使用”与active状态，只提供“断开”而没有失联提示或直接重新配对入口。不是“已登录”几个字本身等同连接的语义争议，也不是断线后仍有浏览器控制权。

无需P2：旧授权动作正确fail closed，显式断开后重新配对可恢复；没有永久故障、数据损失或重要任务必然错误执行证据。也不应剔除为纯authorization契约：UI文案和同一Backend对断线grant的执行定义都明确表达了比历史授权更多的状态。

## 正式入口与契约

以下行号按 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell` 的a66f冻结源码。

- `packages/desktop/src/renderer/panels/PanelRegistry.ts:128–154` 将alwaysEnabled内置browser项挂载为BrowserPanel，并传engineSessionId。候选限定普通任务内的正式面板；popout入口没有engineSessionId，不扩成所有浏览器窗口均受影响。
- `BrowserPanel.tsx:283–314` 通过真实preload的status每2秒刷新；`:297–300` 正常收到结果后直接提交chrome状态。不是人为设旧renderer state，也没有依赖假的Host等待窗口。
- `BrowserPanel.tsx:347–379` 的正式Chrome按钮：有granted/pairing即revoke，否则beginPairing。按钮`:575–580`、banner`:618–623`均只读granted/pairing；connected虽在`:264`类型和Host回包中存在，没有用于该反馈。`:609–615`只显示已有error。
- `packages/desktop/src/renderer/i18n/ns/panels.ts:201` 是“Browser Runtime 正在使用已登录的 Chrome 标签：{title}”；英文`:484`同样为“is using”。这不同于同文件`:193` built-in的“已明确授权”描述。本审计不把正常idle也写“正在使用”单独视为bug，失败条件是连接实际已结束。
- 实际preload `index.ts:1694–1699` 进入Main正式pairing/status/revoke channels；Main `index.ts:4324–4336` 校验已知任务及window owner，`:4483–4510`调用Backend。fixture原样执行这些抽取闭包；known/owner目录本身是owned adapter，不是完整AgentBridge集成。

Backend `chrome-extension-runtime.ts:150–173` 返回connected=false的同时，由`:550–564`仅检查TTL的liveGrant保留granted；error目前只反映兼容性错误。**单独这个字段并不能证明缺陷**，历史permission可以保留。但`:491–509`的isCurrentGrant明确把!server.connected判为grant ended，`:229–239`的新hello清全部旧grant。因此持续active UI没有“断线仍可用”契约支持。

仓库设计文档 `docs/todo/browser-automation-library-reuse.md:49` 明确Native Messaging断线要求重新授权、普通调用不会自动重新连接。这是本地设计证据，不是本次动态执行或当前外部文档验证。

## 断线状态是否生产可达

Native server `chrome-native-server.ts:106–112` 由client/destroyed决定connected；socket close `:166–174`清client及pending，没有通知Backend清grant。Backend默认构造`:104–108`只提供onMessage，没有额外disconnect回调。singleton也仅有onGranted处理，不存在旁路定时清理。

扩展 `service-worker.ts:65–75` 在onDisconnect清nativePort并revokeAll；后续removed `:201`仅在nativePort存在时通知Host。已经断开的连接不能靠这次本地清理报告撤权。源码没有自动重连循环，nativeConnection仅在后续nativeRequest创建，hello在`:76`发送。故Native relay/扩展通道空闲断开、Desktop仍运行且没有新hello的状态可达；这不是无效状态注入。

正常tab.closed可能及时移除grant，不影响另一类Native通道结束的可达性。作者没有真实关闭Chrome/relay，此审计也没有；不能将某个OS关闭顺序、真实Chrome extension认证或debugger脱离时序列为动态已验证。

## 已有动态证据与恢复层级

作者最终latest日志为 **1文件/3tests/40Bun expect/0fail/0skip/Completed**；observations记录networkCalls=0、subprocessCalls=0。冻结fixture SHA由作者及其独立子审记载为 `ef376b426f71dc862ec7ce2f6ac0861997fcd1f21a7883d49d7e015c6e20c8f0`。本审计只读日志与源码，不重跑或新增成功次数。

1. actual BrowserPanel按钮、preload、未改Main helper/callback、Backend开始配对，owned transport交入合法pairing.grant。另一window和unknown task通过真实Main校验被拒。随后只切transport connected为false，等待生产定时器实际两次status轮询：status仍旧grant且无error，DOM仍“正在使用”，无alert/连接按钮，Native browser.action为0。
2. actual UI断开→preload/Main/Backend清旧grant并恢复连接按钮。旧navigation拒绝NEEDS_HUMAN。owned transport重连并向Backend送新hello，再经actual UI开始配对和合法新grant，正常状态恢复。
3. idle断线后调用actual Backend.dispatch，isCurrentGrant正确结束旧grant，navigation返回Chrome connection ended/NEEDS_HUMAN且Native动作0；下一真实轮询清active、恢复连接按钮。后续动作仍要求重新授权。

新grant的listTabs并非纯粹直接枚举grant字段：实际secureBridge `:435–444`→currentTab `:316–321`→requestForGrant `:523–547`→owned Native adapter tab.get。因此可称“新授权高层只读RPC恢复”；响应仍是内存tab，不可称真实Chrome navigation/click/登录态或debugger attach恢复。此前初审简写与remoteDriver另一个同名listTabs混淆，已按这条真实调用链纠正。

明确动态范围：MiniDOM中真实React组件/hooks/Toast/i18n、实际preload及抽取Main业务闭包、实际ChromeExtensionBackend。Electron IPC/contextBridge、known-owner目录、Native transport、built-in status、portprobe与installation descriptor为owned替身；当前新空白tab路径没有webview。没有完整App/Main/AgentBridge、真实Electron/Chrome/relay/worker/CLI/model/账号。协议message从已认证transport边界直接进入Backend，不是Native socket auth/framing测试。

fresh hello、TTL过期也可清旧grant，是源码及已有测试支持的恢复；新fixture没有分别把两者作为独立恢复case执行。显式断开→新配对和动作触发失效则有本轮组件/服务动态证据。不能写“无恢复入口”，宜写“断线反馈缺失，直接重新配对入口仍被旧grant状态取代为断开”。

## 去重、失败诊断及修复限制

现有79项中的R42是Cookie账号ID覆盖，R22/R23是Panel项目身份，R57是后台Bash下载清理；均非Chrome grant liveness。R67虽然同属状态展示，但为LAN启动广播遗漏，当前是已有轮询得到false仍不解释连接状态、Backend idle grant检查分裂，修复位置与触发独立。

已有 `chrome-extension-runtime.test.ts:240–278` 的disconnect测试先执行action并排队下一action，requestForGrant后置检查会清grant；不覆盖没有动作时的status/UI，不能用其通过反证本候选。该保护应保留。

first.log真实为0pass/3fail/17expect：标签期望用了不存在的文案，另一detail期望对应错误分支。最终fixture改正这两项期望后3/40，不把早期失败当产品新问题或累加通过数量。作者仅latest执行；只读diff确认Backend/Native server/extension service-worker/preload/Panel/i18n/session-validator在84740到a66f无变更，这是静态适用性，不冒充本审计或作者执行了旧基线。

支持的修复方向是统一status与执行门禁的grant存活状态，或清楚展示“原授权/当前连接结束”及重新授权入口。结束旧grant时保留endedGrants continuity marker，不能静默fallback另一任务浏览器、自动复活grant或放宽exact tab/grantId/owner检查。

cancel-gates预审的child release、built-in撤权/epoch、owner close门禁作为现有源码/测试盘点合理；本轮未执行它们，不加成功计数。parent Stop与已派发Main动作之间的per-request取消关系仍未动态证明，不并入B21-1、不分级、不增加finding。

结论可供主审将B21-1作为一个窄P3正式归档；最终编号与两基线portable复跑计数由主审处理。本审计新增执行0。
