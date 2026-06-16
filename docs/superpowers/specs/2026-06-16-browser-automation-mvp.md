# 浏览器自动化 MVP — 技术方案(最终版)

> 2026-06-16 起草,2026-06-17 定稿。依据:`docs/browser-automation-research-2026-06-16.md`(调研)。
> 目标:让 agent 用工具驱动**内置 webview** 完成网页操作(看/点/填/导航),token 经济、
> 复用用户登录态、安全由执行层兜底。本文是落到 CodeShell 现有代码的具体接线。

---

## 0. 选型结论(每条都用证据/对标钉死)

**主干 = CDP 驱动 Electron 内置 webview(`webContents.debugger`),observe 走 a11y 树,act 走真实输入事件。**

被淘汰的路线及理由:
| 候选 | 否决理由(已核实) |
|---|---|
| 注入 JS 做 act(`executeJavaScript` + `dispatchEvent`) | 合成事件 `isTrusted=false` → 防爬站拦截 + 复杂框架(支付控件/受控组件)行为不一致。业界 act 一律走 CDP 真实输入。 |
| `chrome-devtools-mcp`(用户已装的 `in`) | 依赖**用户系统装 Chrome + 装 Node + npx 能跑**(报错原话 "Could not find Chrome")。对开箱即用桌面 app 不可接受 → 仅留作开发者可选增强,不进默认依赖。 |
| Playwright `connectOverCDP` 连 webview | 官方承认是「**低保真 relay**」:双层 RPC 中继 → state 漂移 / tab 崩溃时卡死。连 Electron 只给单 context。 |
| 另起 Playwright headless Chromium | 引入 Chromium 下载(几百 MB)、登录态默认不通、要写第三套 bridge。 |
| **Electron 原生 `webContents.debugger`** ✅ | **直连内置 Chromium 的 CDP,一跳无中继 → 高保真;零外部依赖(Electron 自带 Chromium,三平台内核一致);act 是 `Input.dispatchMouseEvent` → isTrusted=true。** 代价:click/type 的坐标换算几十行边角自己写(Puppeteer/SeleniumBase 有成熟模式可抄)。 |

**跨平台澄清**:Electron 的 webview 在 Win/mac/Linux **都是 app 自带的 Chromium**,与用户系统是否装 Chrome 无关 → CDP 永远通、内核永远一致。(只有改用 Tauri 这类「系统 WebView」才会有内核不统一问题,我们是 Electron,不存在。)

**Codex 反向验证**:Codex browser use = in-app 浏览器 + CDP + **DOM/a11y 树(非截图)**,与本方案一致。差异:Codex 的 in-app 不持久化登录态,要登录就切去接管真实 Chrome;**CodeShell 的 `persist:browser` 持久分区让内置 webview 自带登录态,一条线覆盖 Codex 需要两条线(in-app + 真实Chrome)的场景,且避开「接管真实 Chrome」的安全风险。**

---

## 1. 跨进程桥(复用现成 askUser 模式)

浏览器在 **renderer**,工具在 **core worker**,中间隔 main。这条桥**已有现成范本**:
`askUser`/审批就是 core→host→renderer→back 的请求/响应 RPC(`server.ts` `requestAskUserFromClient`)。
浏览器桥镜像它:

1. **`ToolContext.browser?: BrowserBridge`**(`context.ts` 新可选字段;headless/无面板 → undefined,工具优雅降级报错)。
   ```ts
   interface BrowserBridge {
     snapshot(): Promise<BrowserSnapshot>;       // a11y 树 → 带 ref 元素列表
     click(ref: string): Promise<BrowserResult>;
     type(ref: string, text: string): Promise<BrowserResult>;
     navigate(url: string): Promise<BrowserResult>;
     scroll(dir: "up"|"down", amount?: number): Promise<BrowserResult>;
   }
   ```
2. **协议**:新增 `agent/browserAction` method + `Engine.setBrowserBridge(fn)`,交互 session wire(headless 不 wire)。
3. **main**:转发 `agent/browserAction` ↔ renderer,**豁免 30s rpc 超时**(浏览器动作可能慢,见 [[project_rpc_30s_timeout_freeze]])。
4. **renderer**:`BrowserPanel` 实现 BrowserBridge,底层用 `webContents.debugger` 发 CDP(§2/§3)。

> BrowserBridge 是**驱动无关接口** —— core 只认它,底层是 Electron debugger 还是(未来)别的实现可换,core 工具无感。

---

## 2. observe:`browser_snapshot`(a11y 树)

```js
await dbg.attach("1.3")
await dbg.sendCommand("Accessibility.enable")            // ① 必须先 enable(AXNodeId 才稳定)
const { nodes } = await dbg.sendCommand("Accessibility.getFullAXTree")  // ② 全树
```
- a11y 节点给:**role / name(可访问名=可见文本/label）/ 属性(focusable/disabled/expanded)/ backendDOMNodeId**。
- 过滤成「可交互且有意义」:role ∈ {button,link,textbox,checkbox,combobox,menuitem,tab,…},有 name 或可聚焦;丢 ignored 节点和无名 generic。
- 输出**扁平列表**(token 经济,~数百–4k vs 截图 5万):
  ```
  [ref=e1] button  "搜索"
  [ref=e2] textbox  "关键词"
  [ref=e3] link     "登录"
  ```
- **ref→backendDOMNodeId 映射存 renderer 侧**(动作工具按 ref 反查)。ref 每次 snapshot 重新分配(对齐 Playwright-MCP per-snapshot ref)。
- **缺口提醒**:a11y 树**不含坐标** → act 时要补(§3)。

---

## 3. act:ref → 坐标 → 真实输入

a11y 树没坐标,`Input.dispatchMouseEvent` 要坐标 → 中间补一跳:
```
ref → backendDOMNodeId
  → DOM.getBoxModel({ backendNodeId })      // 拿 box → 中心点 (x,y)；先 scrollIntoViewIfNeeded
  → Input.dispatchMouseEvent(mouseMoved → mousePressed → mouseReleased, {x,y})   // isTrusted=true
```
- **click**:`DOM.scrollIntoViewIfNeeded` → getBoxModel 取中心 → moved(stable)/pressed/released。
- **type**:先 click 聚焦 → `Input.insertText({text})`(或逐字 dispatchKeyEvent)。
- **navigate**:`Page.navigate({url})`(或 webview `loadURL`)。
- **scroll**:`Input.dispatchMouseEvent({type:"mouseWheel", deltaY})`。
- box 拿不到(元素已不在/被遮挡)→ 返回明确错误「ref stale,请重新 snapshot」,让 agent 重观察。

> 备选:`DOM.resolveNode(backendNodeId)` 拿 JS 对象引用、在元素上操作,绕开坐标换算。实现时择一,坐标路更通用先用它。

---

## 4. 工具(细粒度,按 ref)

core 新增 `tool-system/builtin/browser-tools.ts`,全 `isConcurrencySafe:false`(同一 webview 串行):
`browser_snapshot` / `browser_navigate{url}` / `browser_click{ref}` / `browser_type{ref,text}` / `browser_scroll{dir,amount?}`。
- 细粒度 ≠ 单个 browser_act:工具定义稳定 → 对 prompt 缓存友好(改工具定义会使整缓存失效);LLM 决策清晰。
- 暂不做 MCP server,MVP 内置工具直连最简单。

---

## 5. 决策循环 + 省 token

- **观察遮蔽**(调研最高杠杆,确定性):历史 `browser_snapshot` 结果在下一轮折叠成占位符
  `[snapshot step N — collapsed]`,只留**最近一份** + 任务摘要。落点:engine 现有 Tier 压缩层
  识别 browser_snapshot 的 tool_result、对非最近一份替换占位符。**不必每步上大模型摘要。**
- **prompt 缓存**:工具定义 + 系统提示固定为前缀,别在循环里改 → 缓存读取省 ~90%。

---

## 6. 登录态 + 2FA(CodeShell 的优势位)

- 直接用 `persist:browser` 分区 = 持久 profile,**复用用户在面板里的真实登录态**,零额外工作(优于 Codex in-app 的无持久化)。
- 登录墙/2FA:工具返回 `{needsHuman:"login required"}` → agent 停下提示「请在浏览器面板手动登录」→ 用户在 webview 登录 → persist 自然保存 → 下个 snapshot 已登录态。human-in-the-loop,本地 app 天然支持。

---

## 7. 安全(执行层代码兜底,不交 LLM)

- **CDP attach 共存**(已核实真冲突):attach 期间用户开 DevTools 会踢断 CDP、且干扰圈选 picker 高亮(electron#34260/#23035)。
  → **CDP 只在自动化任务运行时临时 attach,任务结束 detach**;用户平时浏览/圈选时不挂 CDP。
- **敏感动作审批**:click/type 命中密码/支付/删除字段或按钮(password input、文本含「支付/删除/确认下单/transfer」)→ 走现有 `askUser` 强制确认。
- **域名白名单**:settings `browserAutomation.allowedDomains`,执行层(非 LLM)校验 navigate/动作目标域。
- **凭据不进上下文**:snapshot 对 password/敏感 input 只输出存在+label,**不输出 value**。
- **prompt injection**:网页文本恶意指令靠上面确定性审批兜底,**不指望 LLM 识别**(调研:模型层防不住)。隔离 profile 已由 hardenWebviewGuests 提供。

---

## 8. 落地顺序(MVP)

1. **core 纯类型/工具(可 TDD,不碰 renderer)**:`ToolContext.browser` + `BrowserBridge` 类型;`browser-tools.ts` 五工具 + 注册 + guard(无 bridge 不可用);a11y 节点→扁平列表的**纯函数**(给定 AXTree JSON → 期望 ref 列表)单测。
2. **协议**:`agent/browserAction` method + `Engine.setBrowserBridge` + server wire(headless 跳过)。
3. **main**:IPC 转发,豁免 30s 超时。
4. **renderer**:`BrowserPanel` 实现 BrowserBridge(debugger attach/enable/getFullAXTree/getBoxModel/dispatch),临时 attach-detach。
5. **安全**:域名白名单 settings + 敏感动作接 askUser。
6. **观察遮蔽**:压缩层折叠旧 snapshot。
7. **端到端 smoke**:真机让 agent 在面板里搜索/点击/填表一次。

**第 1 步是纯 core、可 TDD、不碰 renderer、不依赖跨进程** → 从这里开工最稳。

---

## 9. 进阶(P2+,本 MVP 不做)
- **无人值守/独立进程**:隐藏 `BrowserWindow({show:false})` 复用同一 BrowserBridge(它也是 webContents,CDP 同样驱动;无人用 DevTools → CDP 随便独占,无共存问题)。这是「用户在场 webview / 无人值守隐藏窗口」双线的进阶线。
- 视觉兜底:`Page.captureScreenshot` + Set-of-Mark 标注 + `browser_click_xy`(a11y 树覆盖不到的 canvas/地图)。
- `chrome-devtools-mcp` 作开发者可选增强(不进默认依赖)。
- Cookie Lease(TODO 7.5,姊妹能力,可并行)。
- 高频流程固化成确定性脚本,不每步进模型。

## 10. 风险 / 待验证
- 观察遮蔽硬证据来自编码 agent(SWE-bench),迁到浏览器需自测。
- a11y 树对复杂 SPA(shadow DOM / iframe / 虚拟列表)的覆盖度 — MVP 先覆盖普通页,shadow/跨域 iframe 留进阶(CDP 对 iframe 比注入 JS 强,但要处理 frame tree)。
- CDP attach 与圈选 picker 的具体共存细节需真机调(临时 attach 窗口期内禁圈选,或圈选时先 detach)。
