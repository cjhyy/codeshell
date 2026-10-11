# 第21轮 BrowserPanel 授权、失联与恢复审查

冻结产品基线 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，`a66f4ef291f304ee4df9da8095a90671d9a8f140`。首次核时 UTC2026-10-11 22:36:55（SG06:36:55），最后动态结果在 SG06:42 完成，截止 SG2026-10-12 11:00 前交父审。已读 CODESHELL.md、主审 README/flow-coverage 及 panels-round6、links-round8、download-round11 去重；现有79项未覆盖本项 idle Chrome feedback。产品、构建、operator 状态未修改，所有新增证据仅在 `/tmp`。

结论：主审独立复现及质量核对后正式收录 **R80/B21-1/P3**。Chrome Native 通道在闲置时结束，面板后续正常轮询仍显示“正在使用已登录的 Chrome 标签”，没有失联提示；显式断开后重新配对可以恢复。实际动作时会正确阻断，不是安全越权、错目标执行或永久无法恢复。

## R80/B21-1 [P3] 闲置Chrome通道结束后，正常轮询仍显示正在使用，只提供断开

### 正式触发条件与入口

1. 一个已知且由当前 Desktop window 拥有的任务，用户在实际 BrowserPanel 点击“连接已登录的 Chrome 标签”，由合法 Chrome 扩展配对完成 exact tab grant。
2. 30分钟 grant 尚未到期，任务暂未执行浏览器动作；Chrome/native relay通道结束，尚没有新 authenticated `hello`。
3. 仍打开的 BrowserPanel 每2秒正常刷新状态。断线不是需要抢时序的瞬间，也不要求用户在按钮 pending 时操作。

正式 Main helper [index.ts:4324](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:4324) 要求 `bridge.hasKnownSession()` 并检查 `panelOwnerWebContentsId`，其它window被拒绝。配对、状态和断开 Main callbacks 在 [4483](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:4483)、[4502](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:4502)、[4507](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:4507)，preload原调用在 [index.ts:1694](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:1694)。这些生产方法在fixture均原样执行；live Session/owner目录是owned适配器，不声称实际AgentBridge/项目注册/worker运行。

普通 Chrome关闭或Native通道结束的生产链可达：`ChromeNativeBridgeServer` [chrome-native-server.ts:166](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-runtime/chrome-native-server.ts:166) 在socket close时清client/拒绝pending，仅此，没有通知Backend失效grant；扩展 [service-worker.ts:65](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/chrome-extension/service-worker.ts:65) 在onDisconnect清nativePort并revokeAll，没有自动重连循环。新连接的hello要到后续nativeConnection发生。未运行真实Chrome/relay，因此不把某次真实OS关闭时序或真实扩展连通性当作动态证据。

### 根因与显示语义反证

Backend [chrome-extension-runtime.ts:150](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-runtime/chrome-extension-runtime.ts:150) 的status调用liveGrant，返回 `connected:false` 时仍带granted；[liveGrant:550](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-runtime/chrome-extension-runtime.ts:550) 仅按TTL删除grant，没有检查Native connection。`error`只包含extension兼容性错误，断线不会设置error。

实际 [BrowserPanel.tsx:283](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/BrowserPanel.tsx:283) 每2秒poll、297–300正常提交status；[618](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/BrowserPanel.tsx:618) 仅由granted显示activebanner，完全没有使用connected。[i18n/ns/panels.ts:201](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/i18n/ns/panels.ts:201) 的正式文案是 **“Browser Runtime 正在使用已登录的 Chrome 标签：{title}”**，英文同样是 `is using`。工具按钮 [BrowserPanel.tsx:575](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/BrowserPanel.tsx:575) 仍是“断开 Chrome Runtime”；erroralert只看609的error。

不是单纯把granted解读成已连接：如果granted仅代表历史权限，status字段本身可以合理保留；但现有UI明确写实时“正在使用”，且同一Backend [isCurrentGrant:493](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-runtime/chrome-extension-runtime.ts:493) 将 `!server.status().connected` 判为grant ended，新hello [229](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-runtime/chrome-extension-runtime.ts:229) 注释明确“不保留旧grant”。扩展断线也撤销自己的session控制。没有找到“失联仍能继续使用”契约。

### 实际观察与正常、恢复控制

[最终fixture](validation/original-browser-lifecycle-round21/codeshell-review-20261012-browser-lifecycle-round21.test.tsx)、[最终Completed日志](validation/original-browser-lifecycle-round21/codeshell-review-20261012-browser-lifecycle-round21-final.log)、[机器可读收据](validation/original-browser-lifecycle-round21/codeshell-review-20261012-browser-lifecycle-round21-observations.json)。

| 场景 | 实际执行及结果 |
| --- | --- |
| 正常权限门禁 | 实际preload→原Main helper/callback：其它owner 72对owner71任务调用pairing被拒绝；known=false时被“live CodeShell task”拒绝，未创建pairing |
| 正常配对 | 实际Panel按钮→preload→Main→Backend.beginPairing生成code，实际Panel显示code；受控authenticated transport边界递交合法pairing.grant，实际Backend校验code/grantID/httpURL、下轮Panel显示active |
| 闲置断线 | 受控Native transport从connected=true变false，无新hello/浏览器动作；等到实际两次2秒poll。status为connected:false、同grantID/tab23、无error；DOM仍“正在使用…Owned memory tab”，无role=alert，没有连接按钮，仍提供断开按钮；native browser.action调用0 |
| 显式恢复 | 实际Panel点击断开，经原preload/Main/Backend清grant；DOM恢复连接按钮、activebanner消失；旧navigation返回NEEDS_HUMAN/不可重试且没有Native动作。受控新连接+hello后，再点实际连接按钮创建新code、新grant，正常poll显示active；actualBackend.listTabs通过返回唯一授权tab |
| 动作时正确失效 | 再次从正常grant闲置断线，第一navigation在Backend门禁被拒为NEEDS_HUMAN/detail包含Chrome connection ended，Native动作0；下一实际Panel轮询移除active、恢复连接按钮；再次navigation同样拒绝并带Reauthorize指引 |

这些结果明确排除“断线后继续控制Chrome”或“换到后台浏览器”的扩大结论。也不能说用户没有任何恢复办法：现有断开→连接→扩展再授权可用，新hello、TTL单独清旧grant为源码/既有测试支持，本轮动态验证的是显式撤销→新hello→重新配对组合以及下一browser动作触发清理。本项实际影响是闲置断线反馈错误、重新授权入口受旧状态影响，需要先断开；建议P3。

Backend [beginPairing:133](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-runtime/chrome-extension-runtime.ts:133) 遇旧liveGrant也会直接返回旧status，静态支持应统一grant liveness判定；本fixture未直接强行调用该分支作为另一个finding，正式UI此时只暴露断开。

修正方向：让poll/status在connection ended时更新grant有效性或清楚分开“原已授权”和“当前连接”状态，显示失联/重新授权；保留endedGrants continuity marker，避免移除旧grant后静默切到另一目标。不要为修显示而自动复活旧grant。

## 执行与范围

新增便携fixture **1文件、3测试、40个Bun expect、0fail/skip、Completed**，作者只在latest/a66f执行。网络、子进程次数均0。相关 Backend/server/preload/Panel/i18n/session-validator 产品文件在 `84740d56..a66f` diff为空，这是静态适用性，不冒充旧基线执行。父审若重跑两基线，应另账记录，不累加作者及父审测试数。

便携重跑命令（原作者绝对/tmp命令见原始归档）：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/browser-lifecycle-round21/browser-lifecycle.test.tsx
```

最终source SHA256：`ef376b426f71dc862ec7ce2f6ac0861997fcd1f21a7883d49d7e015c6e20c8f0`，现已冻结。fixture在自身目录输出同前缀extracted Main JS及observations；复制到独立目录重跑不会覆盖父审目录。

实际运行：完整BrowserPanel（新空白tab路径，不创建webview）、实际React/Toast/UI/i18n/useBrowserTabs、actualpreload、未改Main authority helper/Chrome callbacks、actualChromeExtensionBackend。抽取Main源码经Bun.Transpiler仅移除类型，保存为 [main.js](validation/original-browser-lifecycle-round21/codeshell-review-20261012-browser-lifecycle-round21-main.js)。

明确替身：ElectroncontextBridge/IPC内存传输、AgentBridge已知Session/owner目录、ChromeNativeTransport连接状态与tab响应、built-instatus恒未授权、空portprobe、owned安装descriptor。没有启动完整Main/App/AgentBridge、Electron/Chrome/Native relay、实际Chrome debugger、realworker/model/CLI、真实站点/账号。http://127.0.0.1:9只是ownedtab描述，没有listener或任何请求，任何外连尝试都失败。

maintained runner提供隔离HOME/状态和去凭据；产品导入前安装repo exact-origin guard（127.0.0.1:9），额外阻断net/tls与child_process spawn/exec/fork系列。实际等待只用于Panel自有2秒轮询，没有假造pendingHost await或race。

[first.log](validation/original-browser-lifecycle-round21/codeshell-review-20261012-browser-lifecycle-round21-first.log) 是支架诊断：0pass/3fail/17expect，错用了不存在的“撤销 Chrome 标签授权”标签，且把第一失效动作detail期望为另一路分支的error；生产返回是正常NEEDS_HUMAN/Chrome connection ended。只改fixture两个文字期望后，最终3/40通过；失败不算产品缺陷或额外通过测试。

## 取消、撤权与关闭排除及未验证边界

详细并行源码审计见 [cancel-gates.md](browser-cancel-gates-round21.md)，完成后的独立fixture/语义反证见 [cancel-gates-quality.md](browser-cancel-quality-round21.md)，支持窄P3。该子审新增执行0，现有测试仅作覆盖盘点，未再累计：

- child scope Abort/owner丢失：Core正式child binding dispose settle pending并发release，Main/lifetime关闭精确childtarget；旧pending acquire捕获released对象，前后检查不会被新child/regrant复活。
- built-in撤权/TTL/guest destroyed：exactguest、sourcewindow、bucket检查，revokedmarker禁止静默换目标；grant对象+controlEpoch保护排队及driver创建等待；新的显式grant可恢复。已有built-in-handoff.test覆盖。
- runtimeowner close：旧lease map identity/disposed门禁，openHost和createDriver await后复查并关闭迟到handle；closed logicaltab只可显式navigate恢复，旧handle不会路由另一任务。普通toollease release保留task target是设计，不能当资源泄漏。
- Chrome已在执行或排队的revoke/expire/disconnect/reconnect：现有tests240–278验证动作终结与NEEDS_HUMAN，当前candidate仅补idle status和真实Panel反馈；不会重复已有保护。
- Session删除清runtime/grants，childexit只清childscope；macOS窗口关闭后App活着、普通task还可以后台继续，不能只据主窗口关闭就要求全部parenttarget销毁。
- BrowserToolCard的非runningsummary虽用“已…”，ToolCardShell对failed有errorbadge和展开结果，未把单句summary当独立问题。

**未验证候选，不计finding：** parent原生Stop会settle Core pending browser request，而Main既派发的异步Browser dispatch没有per-request AbortSignal。尚未通过正式cancel/Host路由证明Stop后仍产生用户应被停止的实际动作，也未排除动作已提交、合法保留tasktarget以及人为Hostawait造成不可达时序。因此只留源码边界，不给优先级，不与B21-1合并。

最终 `git status --short --untracked-files=no` 为空，未修改任何产品代码；未触碰父审主报告/automation/goal。本项已由主审正式收录R80/P3；下述原作者/子审记录保留候选阶段语境。

## 主审双基线复现与收录

作者latest的3/40运行不重复累计。主审复制冻结同源fixture至84740与a66f两个独立工作区，分别guarded执行 **1文件3测试40个Bun expect、Completed、0fail/skip**。两个源码SHA256均为上述ef376b42…；实际网络/子进程调用均0。通用增量1文件3测试，累计81文件243测试。只增加R80/P3，当前正式80=1P1/51P2/28P3。

初始基线日志见[便携最终日志](reproductions/browser-lifecycle-round21/browser-lifecycle.test.tsx.log)，新快照见[独立归档日志](validation/latest-a66f4ef2/repro__browser-lifecycle-round21__browser-lifecycle.test.tsx.log)，双基线机器核对见[结果](validation/round21-browser-results.json)。[原作者/失败诊断](validation/original-browser-lifecycle-round21/)及[取消/owner门禁盘点](browser-cancel-gates-round21.md)分别保留。复现经过actual Backend的secureBridge.listTabs→currentTab→requestForGrant→owned tab.get，证明新grant高层只读RPC恢复；未执行实际Chrome动作。

[独立质量复核](browser-quality-round21.md)支持窄P3并核对正常恢复及去重；[子审质量核证](browser-cancel-quality-round21.md)新增执行0。fresh hello/TTL单独恢复未在本轮额外动态执行，不增加测试计数。
