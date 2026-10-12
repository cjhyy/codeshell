# Round23：macOS 全局菜单错投后台窗口

2026-10-12 SG07:52（clock实读UTC23:52:50）。内部ID **D23-1，建议P3；root拟收录R82**。作者最终guarded Bun **1文件3测试39断言、Completed、0fail/0skip、exit0**。产品代码未改，未build/clean、未启动真实Electron/浏览器/CLI/worker/model或业务网络。

## 问题与触发

在macOS正常打开主窗A→创建主窗B并完成菜单安装→回焦A→明确点击应用原生菜单“查找”“命令面板”“切换侧栏”或“最近项目”，callback仍使用B的webContents，实际preload和App consumer因此更新B的本地状态，前台A未执行该命令。目标严格是**最后完成菜单安装的窗口**，不假定并发创建时安装顺序等于创建顺序。

根因位于 `packages/desktop/src/main/menu.ts:11` 的win参数闭包：`:88` Find、`:100` Palette、`:107` Sidebar、`:65` Recent以及`:53` Add Project都直接 `win.webContents.send(...)`。`:143`–`:144` 将模板安装为全局Menu；callback不读第二参数focusedWindow、不查当前focused/live窗口。每次createWindow末尾才安装（latest `main/index.ts:2711`，initial`:2705`）。全仓 `refreshAppMenu`只有定义，无调用；focus/closed事件不重装。Main closed`:1541`–`:1549`只做资源/集合清理。

实际preload `preload/index.ts:1423`–`:1439`只订阅接收renderer的menu频道；App `App.tsx:1424`的actual callback在Find`:1450`/Palette`:1453`/Sidebar`:1457`改变其本地状态，Recent`:1433`/`:1442`设本renderer的activeProjectId。因此不用同项目Session广播就能触发，与R61的持久selected Session广播是两个根因。

评级为P3：已证明前台菜单操作落到后台窗口，造成流程混乱；没有任务运行、授权绕过、持久历史/草稿丢失证据。Add Project真正picker及registry广播未挂，不声称A完全不会看到项目列表变化。B仍活着时“新窗口”从B转发仍可创建正常C，所以不把它单列为失败。

## 正常与恢复控制

- 单窗A，以及最后安装B当前前台时，实际menu/preload/App callback正确更新接收窗。
- actual `useResponsiveSidebar.ts:38`–`:44`在宽窗或drawer关闭时直接调用action；fixture选择这个正式可达状态。
- A自己的renderer控件仍有可用操作入口；侧栏Search打开SessionSearch，与菜单Find全文SearchView不同。CmdF/K/B另有App renderer keydown路径，本项只验证显式菜单callback，不推断所有快捷键结果。
- 内部重新 `installAppMenu(A)`后A的Find/Recent正常，仅作为根因控制，**不是产品可见恢复按钮**。
- A命令面板直接newWindow→Main创建C后菜单安装到C，可恢复C自己的路由；全关后Dock activate新窗或重启重装亦是源码支持的恢复。A仍活着时activate/second-instance只show/focus，role reload不重走createWindow，均不自动修A的menu owner。
- native role项（copy/reload/quit等）、removed inspector noop不使用这些custom consumer，不纳入finding。

## 最小动态复现与范围

Fixture位于 `/tmp/codeshell-review-20261012-desktop-preflight-round23/`。目标仓库以process.cwd()解析，证据写fixture同目录，方便同源两冻结快照复跑。直接import actual menu.ts，仅mock Electron Menu/app目录和owned recents元数据；actual preload onMenuEvent/newWindow与App唯一onMenuEvent callback经TypeScript AST精确提取原文、Bun内存转译。两owned窗口各有独立词法window/IPC listener/state，没有共享可变renderer window。

维护runner命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-desktop-preflight-round23/menu-routing.test.ts
```

`final-run.log`的最终收据是3pass/0fail、39expect、1file，`Completed Bun shard: 3 tests, 0 skipped; 0 failures.`，exit0。`observations.json`保存三个场景：

1. 单A执行6命令正常；最后安装B前台Find/Recent正常。
2. A→B安装后focus A，将A明确作为click第二个参数传入。六条消息仍送B且focusedAtSend均为A；A messages=[]、Search/Palette=false、activeProject=A-initial-project；B Search/Palette=true、activeProject=owned-project-x、sidebarToggles=1。主要证据是活窗Search/Palette/Recent实际consumer状态。
3. B关闭后Find发送仍指dead B，A未收到；手动内部install(A)后Find/Recent正确。**关闭异常由owned adapter定义为OWNED_DESTROYED_WEBCONTENTS_ADAPTER，仅证明错误目标仍被选中；不是实际Electron throw/crash收据。**

click的focusedWindow参数依据Electron API契约建模，未做OS实际菜单鼠标点击、完整App/Electron E2E。Add Project只验证正确接收方调用stub；newWindow调用实际提取preload `window:new`，未运行Main createWindow。`productMainAppWorkerCoreImported:false`是导入列表的**源码审计声明，不是动态modulecache探针**。

## Guard与清理

首个产品import前确认maintained隔离HOME，安装maintained exact-origin guard后进一步拒绝并记录fetch/http(s).request/get/net/tls/Socket.connect/Bun.connect/listen，以及Node child_process与Bun spawn；owned Electron utilityProcess也拒绝。没有owned listener、HTTP fixture、真实URL加载或guard negative probe。最终networkOrChildAttempts=[]；owned loadRecents实调7次（3tests各断言2/2/3），直接证明recents mock命中。

`cleanup-receipt.json`从最终owned recent path确定maintained HOME，Completed后 `existsAfterCompleted:false`。未启动native，无原生PID需清理。node/Bun runner本身为测试支架，业务child探针针对fixture的被测运行入口。

## 冻结源码与账本

| 文件 | SHA256 |
| --- | --- |
| network-guard.ts | `181e297543df9f562eff2b49eaa0e0a92b63c6ea5c685c7b2071dcd88f1097c2` |
| menu-routing.test.ts | `4b5b75074d57ba4f34c5300b2490bd0d0557aea75cee5c4780b501c524d460c8` |
| actual menu.ts full | `6f65230f21d3a1c9b567d97a2b53433ab313435c49b54f32721647df11e87475` |
| actual preload/index.ts full | `b85c80ec01b488890fcfad0e9afed4fb1e02575dcba8e30cce8a06805ed44327` |
| actual App.tsx full | `556e985d3c0898b5915c713a2a0a280f59bf504b4797e89278143bdcdfd265b8` |
| extracted preload onMenuEvent:1423 | `9bbae30bbb078fd726e4c30361ddad2758c4b3ad24cf5fea05969e3c3f899a6a` |
| extracted preload newWindow:1408 | `98395d7db82f8f6757c324f084a482c8ed8e4a57594ba682fc4c1ca29fb480bc` |
| extracted App callback:1424 | `6bb1f5d0045b0d5214870572f4f3160d4ded0a516b73909cc6d8890cae28bb0a` |

source-manifest.json保存full SHA和逐字提取原文。menu/preload/App在initial84740/latesta66f两冻结基线full SHA一致，Main仅调用安装行号不同；root另存对照manifest。

作者首次3/36/Completed、0fail/0skip/exit0，原source/guard/log/observations/manifest保存在archive-first/。随后仅增加recents计数三断言与scope说明，最终3/39。**无harness失败；历史首次不累计为最终suite**。root已独立两基线同源运行并报告各exit0，最终logs/obs核对由root记录；不将三次最终运行相加。正式收录时通用suite仅新增一文件三测试，预期82文件246测试，总finding82=1P1/52P2/29P3，最终统一统计由root裁定。

完整启动/OS入口排除证据保留在 `/tmp/codeshell-review-20261012-desktop-preflight-round23.md`。本轮没有open-file/open-url系统注册承诺、second-instance越权、window-state失败恢复或启动无限等待的新确认项；未把内部codeshell:open-file信号冒充OS事件。
