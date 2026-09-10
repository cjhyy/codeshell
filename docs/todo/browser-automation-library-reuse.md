# 浏览器自动化：当前生产实现与验证

更新日期：2026-09-09

本次迁移已接入桌面生产代码：Electron 内嵌页面与任务后台窗口使用 Puppeteer 高层动作；Chrome 扩展内部使用 Puppeteer 官方 `ExtensionTransport`；独立浏览器继续使用 Playwright。Agent 仍通过统一的 `BrowserBridge` 调用工具，目标授权、任务归属与人工接管由 CodeShell 管理。

这里的“已完成”指仓库中的生产路径、构建集成和隔离验证。此次没有覆盖或重启正在运行的已安装 CodeShell，也没有重载用户的 Chrome 扩展。使用新实现需要正常更新并重启桌面应用，再加载／重新加载配套扩展，重新授权标签页。

## 解决的问题与迁移范围

本轮最初复现了 Retina 截图只在左上角显示内容、嵌套内容区／Canvas 滚动被误判，以及页面滚动后点击坐标错误。问题涉及截图尺寸、输入、节点定位和结果观察，单独替换发送 CDP 命令的连接库不足以解决。

目前日常动作已复用 Puppeteer／Playwright 的 `Page`、`ElementHandle`、键盘、鼠标和截图接口。CodeShell 保留有界 DOM 观察、准确节点引用、少量表单控件适配、滚动区域选择、权限与生命周期。后台子任务提前结案属于另一条任务生命周期修复，与浏览器协议迁移分开验收。

| 浏览器来源                      | 当前生产调用路径                                                                                                        | 目标与登录态                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Electron 内嵌页面／任务后台窗口 | `BrowserBridge → PuppeteerBrowserDriver → 官方 ExtensionTransport → Electron debugger facade → webContents.debugger`    | 保持原 `webContents` 和 session partition；截图注入同一目标的 `capturePage`   |
| 用户授权的 Chrome 标签页        | `BrowserBridge → Native Messaging 高层动作 → 扩展内 PuppeteerBrowserDriver → 官方 ExtensionTransport.connectTab(tabId)` | 使用用户明确授权的同一标签页；不复制其登录态或接管整个浏览器                  |
| 独立任务浏览器                  | `BrowserBridge → PlaywrightBrowserDriver → Playwright Page／ElementHandle`                                              | 使用任务所属 BrowserContext／profile，不继承用户 Chrome 或 Electron partition |

默认来源仍是任务所属的 `in-app` 后台页面。独立 Playwright 是可选后端；只有显式 `auto` 配置允许在后端获取阶段选择替代来源。已授予某个现有标签页的授权失效后，工具返回需要人工处理，不借此分配另一张页面，也不换引擎重放可能已经生效的点击或提交。

主要代码入口：

- [来源与任务租约](../../packages/desktop/src/main/browser-runtime/runtime.ts)、[动作分发](../../packages/desktop/src/main/browser-runtime/dispatch.ts)。
- [Electron 连接适配](../../packages/desktop/src/main/browser-driver/electron-puppeteer.ts)、[原生截图](../../packages/desktop/src/main/browser-driver/electron-screenshot.ts)。
- [共享 Puppeteer 动作](../../packages/desktop/src/browser-library/puppeteer-browser-driver.ts)、[共享 DOM 观察](../../packages/desktop/src/browser-library/dom-observation.ts)。
- [Chrome 宿主授权与 RPC](../../packages/desktop/src/main/browser-runtime/chrome-extension-runtime.ts)、[扩展 service worker 源码](../../packages/desktop/src/chrome-extension/service-worker.ts)、[扩展连接生命周期](../../packages/desktop/src/chrome-extension/browser-sessions.ts)。
- [独立 Playwright 动作](../../packages/desktop/src/main/browser-runtime/playwright-driver.ts)、[开发者观察](../../packages/desktop/src/browser-library/browser-inspector.ts)。

## Electron：同一目标上的成熟动作库

生产入口 `electron-cdp.ts` 现在只是兼容导出，实际返回 `electron-puppeteer.ts` 创建的驱动。没有为 Puppeteer 启动新的浏览器、迁移 partition，或开启整个 Electron 应用的远程调试端口。

官方 `ExtensionTransport` 面向 Chrome 扩展，仍标为实验性。Electron 所需的 `chrome.debugger` facade 是 CodeShell 维护的适配，不能称为 Puppeteer 官方 Electron 支持。[官方接口说明](https://pptr.dev/api/puppeteer.extensiontransport)

这个 facade 使用固定的全局入口和每次连接独有的 token，将命令、事件与已观察到的子 session 限制在对应 `webContents`。它拒绝浏览器范围的命令和未知子 session；释放旧连接时先使 token 失效，晚到的 `close` 不会断开新连接。两个目标可以同时运行，关闭 A 不移除 B 的事件订阅。

DevTools 打开、debugger 被分离、目标销毁或显式接管都会使对应驱动失活，取消等待并释放引用。普通工具调用不会再次抢占 debugger；用户结束操作后，通过 `browser_act(action="resume_control")` 明确恢复，再读取新快照。窗口与登录状态继续保留。

截图使用 `webContents.capturePage(rect, { stayHidden: true })` 与 `NativeImage.resize`。元素区域从视口 CSS 像素按页面 zoom 转换一次；显示密度交给 Electron，避免重复应用 Retina 倍率。默认截图覆盖当前完整视口，不把物理像素尺寸再次当作裁剪尺寸。输出受最大图片尺寸限制，隐藏窗口继续隐藏。[Electron capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts)

## Chrome：扩展内执行，宿主只传高层动作

扩展以浏览器 bundle 加载 Puppeteer，直接调用官方 `ExtensionTransport.connectTab(tabId)`。命令补全、debugger 事件与 iframe 子 session 的协议路由由官方 transport 处理；Native Messaging 不再承载 `cdp.command` 或自行重建完整 CDP 事件代理。[官方扩展运行方式](https://pptr.dev/guides/running-puppeteer-in-extensions)

宿主发往扩展的目标命令是 `browser.action`、`tab.get` 和 `tab.detach`。每条命令绑定 `tabId + grantId`，宿主及扩展都验证授权；宿主获取标签信息时还检查返回的标签 ID。常规动作、开发者检查与导航保留原有域名权限检查。单个授权不能切换到其他标签，新弹窗不会自动加入授权。

配对码有效期为 2 分钟，标签授权为 30 分钟。同一授权内的动作串行；撤销同步使授权失活，已排队动作在执行前再次检查。正在执行的调用会被断开，晚到结果不能恢复授权。扩展重启、Native Messaging 断线、标签关闭和用户分离 debugger 均要求重新授权，普通调用不会自动重新连接。

人工接管会暂停动作并释放 debugger，保留页面和有效授权。显式恢复才创建新的 Puppeteer 连接与引用命名空间。Electron 与 Chrome 都会递增独立的控制代数，使接管之前排队的动作及恢复请求失效；只有之后新发出的恢复请求能重新控制。同标签的连接／关闭屏障覆盖“旧连接尚未完成就被撤销”的交错：新连接必须等待旧连接实际清理完成。连接／关闭对调用方的等待有 10 秒上界；超时不会提前放开仍在清理的目标。

传输限制维持 Native Messaging 的方向约束：宿主发往扩展的单条命令最多 1 MiB，扩展回复最多 64 MiB。图片仍受动作层尺寸上限约束。扩展打包代码及其第三方许可证随桌面资源一起构建。

扩展版本现为 **0.2.0**，最低 Chrome **125**，`hello.protocolVersion` 为 **2**。宿主必须收到协议 2 的 hello 才接受配对。旧扩展的 hello 即使没有请求 ID，升级错误也会保留到后续配对请求与状态中，明确提示更新并在 `chrome://extensions` 重新加载。不会为了兼容旧扩展恢复 raw CDP 通道。

## 元素引用、截图与滚动的共同语义

Puppeteer 和 Playwright 都从快照中保存准确的 `ElementHandle`。ref 绑定驱动实例、当前文档与实际 frame／节点；动作不会用同名文本或重新查询的 selector 替换原节点。DOM 替换、frame 导航／分离、页面导航、重新授权或恢复控制后，旧 ref 返回 `STALE_SNAPSHOT`，要求重新观察。

快照、内容与媒体提取遍历当前页面的 frames 和开放的 shadow DOM。媒体按类别和跨 frame 的配额限制输出；内联图片保留可操作引用，工具结果不展开 data URL 的正文。敏感输入值受到过滤。这是有界 DOM 观察实现，不承诺与完整浏览器可访问性树等价，也不覆盖封闭 shadow root 或 Canvas 的业务数据结构。

Puppeteer 点击／悬停直接作用于保存的节点，输入使用库提供的键盘和控件接口，并保留日期等原生控件的有限适配。Playwright 同样保留准确节点，利用其 `ElementHandle` 动作等待。两条路径均验证旧节点没有被替换，避免自动等待期间把操作转移到新节点。

滚动通过库的 `mouse.move`／`mouse.wheel` 投递到选出的可见内容区；独立 Playwright 不再为滚动创建原始 CDP session。`amount` 省略或为 0 时执行约定的默认滚动距离。动作后对比位置、内容或图像，识别无进展及导航；Canvas 或不可读取的位置明确返回未知，不能把轮询成功当作已经读到底。

两套成熟后端均只发送一次滚轮，随后以 75ms 间隔进行有界观察：有进展立即返回，最多约 1 秒且不超过 14 次采样。真实测试覆盖收到可信滚轮事件后延迟 250ms 才绘制的 Canvas，验证不会误报未移动或重复投递。观察仍有边界：更迟的绘制可能超出窗口，未知位置下的视口图像变化也可能来自其他动画。库的滚轮 API 本身不保证滚动已经结束，因此这些结果是观察证据，不是业务内容完整性的保证。[Playwright 滚轮语义](https://playwright.dev/docs/api/class-mouse#mouse-wheel)

## 开发者检查的权限与数据边界

新增 `browser_inspect`，单独要求工具权限，复用当前任务已经获准的目标，不增加任意 JavaScript、原始 CDP、跨标签或浏览器级访问入口。

| 模式          | 当前返回内容                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `dom`         | 可选 CSS 子树内有界的标签、简短文本、矩形和少量样式；不返回 input／textarea 值，也不遍历编辑区域的内容 |
| `console`     | 首次调用开始记录，再次调用读取近期文本消息与页面错误；每条文本有长度限制                               |
| `network`     | 首次调用开始记录，返回有界 URL、方法、资源类型、状态或失败信息；无请求头、响应头和正文                 |
| `performance` | 有界的 navigation、paint、resource 时间信息                                                            |
| `stop`        | 移除诊断监听并清空缓存                                                                                 |

记录上限为 100 条；DOM 遍历另有节点上限，页面求值等待上限为 8 秒。网络／性能 URL 去掉凭证、查询参数与 fragment，内联正文不会展开。控制台仍可能包含网站主动打印的内容；所有页面文本和日志都是不可信数据。

主文档导航时停止录制并清空缓存，防止从允许页面开始录制后，把其他来源的历史带回原页面。导航后需再次调用相应模式开始记录。授权释放、驱动销毁或目标关闭也会清除监听。它是受限诊断工具，不是完整 DevTools，也不会返回录制开始前的日志。

## 版本、兼容代码与构建生效

当前依赖固定为 `puppeteer-core@23.7.1`，独立浏览器使用 `playwright-core@1.60.0`。本轮真实 Electron 验证使用 **Electron 33.4.11／Chromium 130.0.6723.191／Node 20.18.3**；仓库 Electron 依赖范围仍为 `^33.0.0`。这些版本需要作为组合维护、测试，不把最新在线文档视为任意升级都兼容的承诺。

Electron facade 对官方 transport 的实验性约定仍负有兼容责任：23.7.1 会尝试恢复一个 Electron 不存在的合成 tab session；适配按未知子 session 拒绝，库在当前组合中容忍该错误。实现没有硬编码上游私有 session 名字。升级 Puppeteer 或 Electron 时须重跑实际双目标、子 frame、取消和截图验证。[固定版本 transport 源码](https://github.com/puppeteer/puppeteer/blob/puppeteer-v23.7.1/packages/puppeteer-core/src/cdp/ExtensionTransport.ts)

旧 `CdpBrowserDriver`／`CdpActionsDriver` 仍保留为兼容导出与回归对照，未作为 Electron、Chrome 或 Playwright 生产动作失败后的 fallback。`packages/cdp` 中环境无关的观察函数、类型、键盘映射等仍可复用；迁移没有宣称整个包已删除。

`scripts/build-chrome-extension.ts` 生成扩展 `service-worker.js` 及许可证，桌面构建已接入该步骤。Chrome 扩展 bundle 使用浏览器入口，不引入 Node 运行时；Electron 主进程构建包含其所需库代码。

仓库构建不会自动替换 `/Applications/code-shell.app` 或正在运行的进程。正常更新并重启新桌面构建后，还需让 Chrome 重新加载新版扩展并重新配对。本轮没有对运行中的用户应用做安装覆盖、强制重启或扩展重载。

## 已执行的验证与复现

2026-09-09 最终回归记录（以下测试计数互不重复）：

- 浏览器驱动、Runtime、共享库和扩展：28 个文件，**222 项通过、0 失败、0 跳过**，858 个断言；真实浏览器测试显式使用 Chromium 141.0.7390.37。
- Core 浏览器工具、独立检查权限、后台 Agent 生命周期及 Pet Session：6 个文件，**72 项通过**，281 个断言。
- 侧边栏、Session 公告、Pet 消息顺序与浏览器 UI：6 个文件，**66 项通过**，152 个断言。
- 合计 **360 项相关测试、1,291 个断言**。另外，移除 Server 一处未使用的多余参数以恢复全仓类型检查，其目录访问回归单独 7 项通过，不计入浏览器总数。
- Core 构建、桌面完整构建（main／preload／renderer／mobile／Chrome 扩展）、所有工作区类型检查均通过；修改范围的 lint、格式和 `git diff --check` 通过。
- 最终生产 Electron 与真实 Chrome 扩展 smoke 均通过，覆盖范围如下。没有运行安装器或覆盖正在使用的应用。

### Chrome 扩展真实端到端

从仓库根目录运行；以下为本机实际使用的完整命令，其他机器把路径改为支持扩展加载的 Chromium：

```sh
CODESHELL_TEST_CHROMIUM='/Users/admin/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium' bun run packages/desktop/scripts/smoke-chrome-extension.ts
```

脚本先重建当前扩展，创建临时 profile 与该 profile 内的 Native Messaging host 注册，加载实际生产扩展 bundle，并通过真实 native host／宿主授权服务操作本地页面。验证包括两个授权标签隔离、跨源 OOPIF 点击、授权不匹配、截图、人工接管／恢复、旧 ref 拒绝、DOM 检查、撤销后队列不执行、禁止隐式重连、标签关闭与 Native Messaging 断线释放。最后关闭浏览器并清理临时文件。

该 smoke 已在 macOS 临时 Chromium profile 通过；不连接用户现有 Chrome，不使用真实站点账号，不代表完成所有操作系统的扩展安装验收。手动解除 debugger 的测试使用 Chrome API，真实关闭事件和 native 断线也单独验证；用户点击 debugger 提示条的人工路径没有被描述成 UI 自动化验收。

### Electron 生产适配真实回归

```sh
bun run --cwd packages/desktop/scripts/browser-library-probe production
```

目录名保留 `probe`，但 `production` 命令打包的是当前生产 `electron-puppeteer.ts` 与共享驱动。它用仓库已安装依赖启动独立测试应用和生成的本地页面，不启动 CodeShell 桌面主程序，也不开放调试端口。临时测试目录会打印出来供检查。

已验证两个普通隐藏 BrowserWindow、DPR 2 与 zoom 1／1.25、非零页面滚动后的点击、跨进程 iframe、跨目标 ref 拒绝、原生截图四角像素与尺寸上限、DevTools 只暂停对应目标、取消等待和显式恢复。相同 `webContents`、partition、测试 cookie 保留；释放后窗口仍隐藏、目标未关闭，监听清理完成。

普通隐藏窗口是当前生产路径。历史 `offscreen: true` 对照曾出现 OOPIF 鼠标输入未到达的问题，不把普通隐藏窗口通过推广为所有离屏渲染模式都已支持。此项回归使用生成页面与测试 cookie，不是所有内嵌网页、插件和登录流程的完整验收。

### 聚焦回归与检查

```sh
bun test packages/desktop/src/chrome-extension/browser-sessions.test.ts packages/desktop/src/main/browser-runtime/chrome-extension-runtime.test.ts packages/desktop/src/main/browser-runtime/chrome-extension-manifest.test.ts
bun test packages/desktop/src/main/browser-driver/scroll.integration.test.ts packages/desktop/src/main/browser-runtime/playwright-driver.test.ts
CHROME_PATH='/Users/admin/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium' bun test packages/desktop/src/browser-library/puppeteer-browser-driver.test.ts
CODESHELL_TEST_CHROMIUM='/Users/admin/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium' bun test packages/desktop/src/browser-library/browser-inspector.integration.test.ts
bunx tsc --noEmit -p packages/desktop/tsconfig.json --pretty false
```

Chrome 生命周期测试覆盖 attach 未结束时撤销、晚到 detach、新授权等待、接管与恢复竞争、超时仍保持隔离，以及旧协议持续提示更新。Playwright 滚动回归主动令 `newCDPSession` 抛错，证明该路径使用高层接口。两套动作回归覆盖节点替换、frame／shadow DOM、输入、媒体提取和引用失效；inspector 回归覆盖两个来源间导航后清空记录。

需要真实浏览器的测试在找不到可执行文件时会跳过。Playwright 驱动／滚动测试使用 `defaultLaunchCandidates` 探测已安装的 Playwright Chromium 或系统浏览器；Puppeteer 和 inspector 的显式路径变量如上。统计时应核对实际运行与跳过数量。Puppeteer 测试同时设置原生窗口大小，避免 Chromium 141 的原生窗口小于模拟 viewport，导致激活后滚轮被裁切；生产 Electron／扩展使用 `defaultViewport: null`，不制造该尺寸差异。相关类型、格式、lint 与构建检查单独记录，不把它们计作真实浏览器验收。

## Browser Use 与 Codex 参照的边界

**Browser Use 不是本次运行时依赖。** 本次选择直接复用 Puppeteer／Playwright，与保留 CodeShell Agent、既有单标签授权及 Electron partition 的架构相符。

此前对 Browser Use 0.13.10 的源码核对表明，`BrowserSession`／Actor 可与其 Agent 分开使用，但 URL 型 CDP 连接及既有 targets 管理不直接等于本仓库的单标签授权。引入 Python 常驻服务、浏览器范围 target 隔离和既有连接转接会新增生命周期与部署成本。未来若接入，应作为另行验收的可选后端，而非把本次迁移描述成已经使用 Browser Use。[当时核对的连接实现](https://github.com/browser-use/browser-use/blob/2b1f9d377999a59fe7627c1a5aa88c12aa42e11f/browser_use/browser/session.py#L1839)、[targets 初始化](https://github.com/browser-use/browser-use/blob/2b1f9d377999a59fe7627c1a5aa88c12aa42e11f/browser_use/browser/session_manager.py#L784)

已有 `packages/cdp/src/keymap.ts` 的 Browser Use 键盘映射移植及 `THIRD_PARTY_NOTICES.md` 属于局部源码复用，后续维护责任仍在本仓库，不能与持续使用上游运行时混为一谈。Browser Harness 的连接／动作 helpers 也未接入本次生产路径。[此前核对的 Python helpers](https://github.com/browser-use/browser-harness/blob/afbcc381b963040c19627d788e40c7e7663171ee/src/browser_harness/helpers.py#L326)、[官方 JS 仓库](https://github.com/browser-use/browser-harness-js)

[Codex 官方 Browser 文档](https://learn.chatgpt.com/docs/browser) 可用于参照产品能力与授权体验。公开文档和本会话工具接口不足以证明 Codex 内部使用 Playwright、Puppeteer 或 Browser Use；本方案不声称其中任何库是已公开的“Codex 同款”。

## 其他官方参考

- [Playwright 自动等待与可操作性](https://playwright.dev/docs/actionability)
- [Playwright 截图](https://playwright.dev/docs/api/class-page#page-screenshot)
- [Playwright connectOverCDP 接口](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Playwright Electron API](https://playwright.dev/docs/api/class-electron)
- [Electron Debugger API](https://www.electronjs.org/docs/latest/api/debugger)
- [Puppeteer ConnectionTransport](https://pptr.dev/api/puppeteer.connectiontransport)
- [Puppeteer 浏览器版本兼容表](https://pptr.dev/supported-browsers)
