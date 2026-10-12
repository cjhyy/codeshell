# 第二十三轮 Desktop 启动与系统打开入口预审

2026-10-12 SG07:51（clock实读UTC23:51:38）。本轮确认一项候选 **D23-1（建议窄P3，正式编号/收录由root裁定）**：macOS全局菜单callback捕获安装时窗口，切到另一活窗口后仍投递给旧窗口，实际preload和App callback因此更新后台窗口的Search/Palette/activeProject。旧窗口关闭后无重装/重选owner只保留源码与owned adapter边界，不声称实际Electron异常。其他启动、second-instance与所谓OS open-file/open-url入口没有可信新候选。作者最终maintained guarded Bun为 **1文件3测试39断言，Completed、0fail/0skip、exit0**；产品代码/build/clean/真实Electron/浏览器/CLI/worker/model/业务network均0。

## 去重与基线

先读 CODESHELL.md、主审 docs/review-2026-10-12/README.md 与 flow-coverage.md，另读 desktop-round1/round3、desktop-quality-round10、quickchat-round8、terminal-review-round13、R29优先级与既有菜单接线说明。当前正式81=1P1/52P2/28P3、通用Bun81文件243测试。R09是第二Hub清理首实例上传，R29是启动旧会话迁移投影覆盖新项目，R61是同项目双窗activeSession广播同步；本候选不复述这些根因。

主读 frozen latest a66f4ef291f304ee4df9da8095a90671d9a8f140；initial84740d56e55517b004948a0a0e07649ad6fbf998只读对照，menu.ts关键code一致。latest唯一installAppMenu调用Main index.ts2711，initial同调用2705。原工作区6034df8a不在本轮范围。子审browser_cancel_gate独立源码核验/0执行/0写文件，结论与本文相符。

## D23-1：macOS全局菜单未选择当前窗口

**正式可达用户流程**：正常已打开主窗口A→文件菜单“新窗口”创建B→回焦A→用鼠标明确点击macOS菜单“查找”“命令面板”“切换侧栏”或“最近项目”。不靠键盘事件先后、人工await或假Host延迟。普通两窗可以处于不同项目，纯Search/Palette也不需要shared Session/catalog广播。

源链与原因：

- `packages/desktop/src/main/menu.ts:11` 参数win在安装时捕获，`:12`–`:16`仅mac安装，其余平台setApplicationMenu(null)。`:18`读取recents后创建template，`:143`buildFromTemplate、`:144`**setApplicationMenu**是全局菜单。
- 自定义click在`:46`发送menu:new-window、`:53`menu:add-project、`:65`menu:open-recent、`:88`menu:find、`:100`menu:palette、`:107`menu:toggle-sidebar，全部直接用捕获的win.webContents.send；不读Electron给click的focusedWindow参数，也不调BrowserWindow.getFocusedWindow、isDestroyed或fallback。
- 每次Main createWindow结尾才在`index.ts:2711`安装。全仓refreshAppMenu只有menu.ts148定义，无调用；无window focus/did-focus重装。严格说目标是**最后完成安装的窗口**，正常顺序创建B即B；并非声称并发创建时一定最后创建者获菜单。
- actual preload `preload/index.ts:1423`–`:1439` onMenuEvent只监听**收到事件的renderer**，不把事件转到当前focus窗口。
- actual App `App.tsx:1424`回调中，Find`:1450`与Palette`:1453`改变接收renderer自己的search/palette状态，侧栏`:1457`同理；Open Recent `:1433` / `:1442`设接收renderer的activeProjectId。Add Project `:1427`进入本renderer addProject（useSessionNavigation.ts120–135），picker返回后在其本地setActiveProjectId。Main对新project的registry广播可以让另一窗口也看到该项目，不能据此说focused A必然完全没收到任何项目列表变化；被错误投递的是用户命令与选择owner。
- New Window `App.tsx:1462`→preload1408→Main5835–36 createWindow；它可以从错误窗口仍创建正常C，因此不把“B仍活着的new-window”单独称失败。B已关闭后callback仍指dead B，具体Electron throw/吞掉尚无动态证明，更不能声称Host crash。
- Main `index.ts:1541`–`:1549` closed只清资源/集合，没有重装菜单。`second-instance`→quick-chat-startup-cleanup.ts38–43只restore/show/focus首live window；`activate`7206–07仅没live主窗时新建；A仍活着时这些不会修复菜单closure。

**正常/恢复边界**：单窗A或当前最后安装B处于前台时目标正确；Electron role项（reload/copy/quit等）不使用这些custom闭包，不纳入候选。CmdF/K/B在App1370–1410还有focusedrenderer keydown路径，不能直接由源码断定所有快捷键失效/双触发，最小实验用明确菜单click。A侧栏添加项目/自有search按钮/自己的命令面板等renderer控件仍可正常操作。A命令面板CommandPalette189–193的新窗口动作直接调preloadnewWindow，创建C后Main重装到C；这能恢复C自己的菜单，不是把A菜单owner自动修好。手动调用installAppMenu(A)是内部正常对照，不是现有可见UI恢复。全关后Dock activate新建窗口或重启重装，是源码支持的恢复；role reload只重载renderer，不重走createWindow，不能称其会修好global menu。

与R61分开：R61依同项目selected Session持久广播；此处不用Session读写/共享索引，也可只用两个窗口打开Search/Palette，根因在Main全局menu闭包owner。未证明错project真实任务运行、权限绕过、历史/草稿持久丢失，建议窄P3而非按跨窗字样升格。

## 启动/OS入口排除

- latest Main630–635在取得process ownership后注册second-instance，仅focus现有live窗口，没有argv/URL/session解析。quick-chat-startup-cleanup.ts8–10取得lock失败就quit；runOwnedQuickChatStartupCleanup22先检查owns；Main3347–48非owner不进入startup链，3413–16清理亦有ownership。既有quick-chat-startup-cleanup.test.ts源码覆盖拒锁不动live qchat、owner清理、restore/show/focus；本轮未执行。与R09 Hub目录资源问题不同。
- 全desktop源码没有app.on("open-file"/"open-url")、setAsDefaultProtocolClient；build package.json也没有protocols/fileAssociations/CFBundleURLTypes/DocumentTypes。内部codeshell:open-file/open-url来自Markdown/FilesPanel/浏览器面板事件，是已有已授权renderer导航；不能当OS URL/file系统入口承诺，也不以未实现关联作为新缺陷。
- window-state-store.ts48–63清理损坏尺寸、64–71读取失败回默认；75起私有tmp+rename+串行writeQueue，失败queue会恢复。既有window-state-store.test.ts源码覆盖sanitize与rapid writes，仅只读，无新结论。
- Main index.ts1495/1498加载renderer，1502/1505/1509分别记录load/crash/preload失败，未自动recreate主窗。但mac菜单role reload/新窗口及activate存在正常恢复入口；没有天然文件丢失/身份错路由证据，不把“只log”直接立项。pet widget另有明确crash销毁/重建，不与主窗口混同。
- 启动login-shell-path.ts默认2500ms timeout、owned process groupTERM/KILL、fallback已知bin目录；未读到无限等待CLI安装是必要前提，不能用人为不settle spawn制造问题。本轮不运行shell。
- IM Gateway启动在createWindow前，但startConfiguredAtLaunch对fresh/disabled/no-channel立即返回；正式createChannelAdapterAsync是module加载+构造，真正run/connect以gatewayTask后台启动且start有25ms第一轮诊断；失败有catch继续开主窗。未找到可信自然永久await证明，不伪造adapter Promise立项。

## 最小隔离Bun与执行证据

root已读完整fixture/guard后授权maintained runner在latest执行。所有材料在 `/tmp/codeshell-review-20261012-desktop-preflight-round23/`，以process.cwd()解析目标冻结仓库，证据写fixture目录；复制到另一owned目录可独立复跑而不覆盖作者日志。实现：

1. maintained run-bun-test-shard；isolated HOME/TEST_HOME必须存在，Core/worker/App/Main入口均不导入。首个产品import前maintained exact-origin guard后叠加deny全部fetch/http(s)/net/tls/Socket connect与child/utility入口，记录尝试；无listener/真实URL、无真实Electron。
2. 直接import actual `main/menu.ts`，仅Electron Menu/app/BrowserWindow目录和recents数据适配。Menu.buildFromTemplate保留真实模板，setApplicationMenu记录global模板。两个owned Window webContents.send各走独立内存ipcRenderer listeners。
3. TypeScript AST精确提取actualpreload onMenuEvent/newWindow两个property initializer，以及App唯一window.codeshell.onMenuEvent callback，原样转译到owned文件或new Function。每个窗口使用独立回调依赖/状态，实际消息接收/consumer行为可观察；不挂完整App、不执行projectpicker/Core。
4. 控制：单窗A、最后安装B前台正确；回焦A时将A作为真实click的第二个browserWindow参数传入仍发B，观察Search/Palette/Recent只更新B。B destroy后只证明发送仍指dead B，owned适配器异常不冒充实际Electron异常。内部install(A)可恢复A只作control；renderer自有按钮恢复留源码范围。
5. 输出source hash/extraction行号、每场景状态/消息、guard0和finalCompleted收据。子agent/quality只读不另算执行。两个冻结baseline同源复跑由root按需安排。

完整原生Electron并非证明JS闭包路由必须条件；如果root认为nativeglobal Menu/focusedWindow参数契约仍需补证，可用既有maintained native isolator，两ownedhiddenwindows/无站点/preimportdeny/只Menu构造和callback.click，不加载Core/App/worker，不发送真实OS点击。那只能补真实Menu全局存留、focusedWindow参数与closedWebContents.send实际结果，不等于完整产品App E2E；必须先单独给完整启动/guard/loader方案审核。本轮**尚未授权launch且不会自行启动native**。

最终命令（workdir latest frozen，runner隔离HOME）：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-desktop-preflight-round23/menu-routing.test.ts
```

| 场景 | 实际观察/断言 | 限定 |
| --- | --- | --- |
| 单窗A，以及最后完成安装B前台 | A的Find/Palette/Sidebar/Recent命令更新自身；newWindow只产生window:new调用；B Find/Recent正常 | picker与Main createWindow未执行 |
| 安装A→安装B→focus A→显式菜单callback第二参数为A | 六条menu消息仍全部送B，focusedAtSend=A；A消息为空、Search/Palette保持false、activeProject保持A-initial；B Search/Palette=true、activeProject=owned-project-x、sidebarToggles=1 | focusedWindow参数依据Electron API语义建模，没有OS实际菜单点击；活窗Search/Palette/Recent是本项主要动态证据 |
| B关闭→focus A→Find | actual callback尝试发送仍指B（destroyedAtSend=true），A未收到；owned adapter显式throw OWNED_DESTROYED_WEBCONTENTS_ADAPTER | 这个throw由fixture定义，不是实际Electron throw/crash收据 |
| 内部installAppMenu(A)后Find/Recent | A正确更新 | 仅内部正常控制，不冒称现有用户按钮恢复 |

`navigateFromSidebar`在实际useResponsiveSidebar.ts38–44的宽窗或drawer关闭状态直接action；fixture选择这个正常可达分支。没有绕过workspace/Session身份门禁，因为未进入Core/Session操作。真实项目选择器和新窗口创建仅做接收方调用路由控制；不声称它们已被真实OS打开。sidebar自身search按钮是SessionSearch，不等同本菜单Find的全文SearchView。

最终源码冻结：

- network-guard.ts SHA256 `181e297543df9f562eff2b49eaa0e0a92b63c6ea5c685c7b2071dcd88f1097c2`。
- menu-routing.test.ts SHA256 `4b5b75074d57ba4f34c5300b2490bd0d0557aea75cee5c4780b501c524d460c8`。
- actual menu.ts full SHA `6f65230f21d3a1c9b567d97a2b53433ab313435c49b54f32721647df11e87475`；preload full SHA `b85c80ec01b488890fcfad0e9afed4fb1e02575dcba8e30cce8a06805ed44327`；App full SHA `556e985d3c0898b5915c713a2a0a280f59bf504b4797e89278143bdcdfd265b8`。
- 提取preload onMenuEvent1423 SHA `9bbae30bbb078fd726e4c30361ddad2758c4b3ad24cf5fea05969e3c3f899a6a`；newWindow1408 SHA `98395d7db82f8f6757c324f084a482c8ed8e4a57594ba682fc4c1ca29fb480bc`；App callback1424 SHA `6bb1f5d0045b0d5214870572f4f3160d4ded0a516b73909cc6d8890cae28bb0a`。提取原文与行号在source-manifest.json，可逐字核对。

最终收据 `final-run.log`：3pass、0fail、39expect、1file，末尾 `Completed Bun shard: 3 tests, 0 skipped; 0 failures.`，runner exit0。`observations.json`的owned loadRecents实际调用7次（测试分别断言2/2/3），证明recents mock命中；networkOrChildAttempts=[]。guard列出的Node/Bun业务网络和child入口都在首个产品import前安装拒绝并计数，没有listener或guard-negative probe。`productMainAppWorkerCoreImported:false`是源码核对的导入scope声明，明确不是动态modulecache探针；本轮未import完整App/Main/Core/worker，actualmenu以Electron和recents适配并使用实际提取consumer。

执行账本：首次作者运行 `first-run.log`为3/36/Completed、0fail/0skip、exit0，原source/guard/log/observations/manifest五件完整保存在 `archive-first/`。随后仅新增owned recents调用计数+三条断言及scope声明，最终作者运行3/39。**没有harness失败；首次历史不累计为最终新增测试**。root独立两基线复跑待其记录，不把重复运行相加成suite。按正式收录时通用Bun预期只增加一个文件三测试，最终项目统计由root统一结算。
