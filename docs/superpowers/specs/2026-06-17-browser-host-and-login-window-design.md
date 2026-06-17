# BrowserHost 底座 + 独立窗口登录抓 cookie 设计

> 2026-06-17 · 解决「内置 webview 登不上 Google/YouTube(此浏览器不安全)」。参考 repo
> `video-download-eletron` 的三套方案中,选 `loginAndGetCookies`(独立 BrowserWindow 加载登录页
> → 用户登录 → 读 session cookie),因为**顶层 BrowserWindow + loadURL 是完整 Chromium 窗口,
> Google 拦截远比嵌入式 `<webview>` 宽松,通常能登上**。产出的 cookie 存进凭证模块第二期已做的
> 具名 cookie 凭证体系(`平台__账号名`),复用多账号/切换/重拓/UseCredential 全套。

## 1. 背景与目标

凭证第二期的内置浏览器分区方案对小红书等不挑浏览器的站有效,但 **YouTube/Google 在内置
`<webview>` 里被识别为不安全浏览器、登不上**(Google 故意拦嵌入式)。本设计加一条新的 cookie
获取方式:**独立登录窗口**。

**为什么不选另两条路**(已调研,见对话):
- 读真实 Chrome cookie 库(参考 repo `chromeCookies.ts`):Win Chrome 127+ App-Bound
  Encryption(v20)解不开;mac 要弹 Keychain 授权;且 YouTube cookie 从日常浏览器抓会被频繁轮换、
  官方警告有封号风险。
- yt-dlp `--cookies-from-browser`:同上 Win ABE / 锁库 / YouTube 轮换问题,yt-dlp 官方明确不推荐。

**独立窗口方案的优势**:cookie 从我们自己的 Electron session 直接读**明文**,不碰 DPAPI/Keychain/
ABE;天然是「无痕隔离会话」(官方推荐的 YouTube 做法);能登 Google。

## 2. 架构:分层 + 分两步

**分层**(用户要求):
- **底层 `BrowserHost`**:统一「浏览器载体(BrowserWindow / webview)」的创建+配置+安全加固+
  生命周期+读 cookie 的公共逻辑。现在散在 `main/index.ts` 的 `new BrowserWindow`、
  `hardenWebviewGuests`、CSP、防外链那套,逻辑上归它。
- **控制层**:具体「用浏览器干嘛」的业务(登录抓 cookie、popout 浏览、browser-driver 自动化),
  各建在底座上。

**分两步达成「全收编」**(用户拍板:最终全收编,但分步降风险):
- **第一步(本次实现)**:抽 `BrowserHost`(先只实现 `window` 形态)+ 新登录窗口建其上,跑通
  YouTube 登录抓 cookie。现有主窗/popout/BrowserPanel webview **不动**。
- **第二步(后续,本次不实现,接口预留)**:把现有主窗、popout、BrowserPanel 的 `<webview>`
  逐个迁到 `BrowserHost`(每迁一个回归一次),完成全收编。

## 3. BrowserHost 底座(第一步只实现 window 形态)

位置:`packages/desktop/src/main/browser-host/`(desktop main 私有,强依赖 Electron,**不进 core**
—— 符合 core 最小 harness 方向 [[project_core_minimal_harness_business_layer]])。

职责:
- **创建**:统一入口创建浏览器载体。形态 `kind: 'window' | 'webview'`。本次只实现 `window`
  (`new BrowserWindow`);`webview` 形态留接口,第二步实现。
- **公共配置**:preload、`contextIsolation/sandbox/nodeIntegration` 安全加固、`partition`、UA、
  `setWindowOpenHandler` + `will-navigate` 防外链。
- **生命周期**:`loadURL`、`did-fail-load`/`render-process-gone` 兜底、关闭/销毁、回收。
- **读 cookie**:`getCookies(partition, domain)`(Electron `session.fromPartition(p).cookies.get`)。
- **销毁分区**:`destroyPartition(partition)`(`clearStorageData`)。

**不管**(边界):业务逻辑(登录判定、存凭证、anchor 转发)都在控制层;底座只给「一个配置好、能
加载 URL、能读 cookie、能干净销毁的浏览器载体」。

接口草案:
```ts
interface BrowserHostOpenOptions {
  kind: 'window';            // 第一步只支持 window
  url: string;
  partition: string;         // 如 persist:login-<id>
  width?: number; height?: number; title?: string;
  userAgent?: string;
  onFailLoad?(info): void;
  onRenderGone?(info): void;
}
interface BrowserHostHandle {
  readonly webContents: Electron.WebContents;
  loadURL(url: string): Promise<void>;
  executeJavaScript<T>(code: string): Promise<T>;
  getCookies(domain?: string): Promise<ElectronCookieLike[]>;  // 该 handle 的 partition
  close(): void;
  onClosed(cb: () => void): void;
}
```

## 4. 登录窗口控制层

位置:`packages/desktop/src/main/credentials-login/`(建在 BrowserHost 上)。

核心:
```ts
loginAndCaptureCookies({ url, platform }): Promise<{
  jar: ElectronCookieLike[];
  domain: string;
  suggestedLabel?: string;             // 抓到的用户名(自动填账号名)
  loginCheck: { ok: boolean; missing?: string[] };
}>
```

数据流:
```
渲染层 Cookie tab「弹窗登录」(填 url + 平台名)
 → IPC credentials:loginCapture
 → main loginAndCaptureCookies:
     1. partition = persist:login-${id}          (全新临时分区 = 无痕)
     2. BrowserHost.open({ kind:'window', url, partition })
     3. did-finish-load 注入:浮窗提示 + 「我已登录,保存」按钮 + 「取消」
        (按钮经一个约定通道/console 哨兵回 main —— 见 §6)
     4. 用户点「保存」:
        - getCookies(targetDomain)               (该 partition 该域 cookie)
        - executeJavaScript 抓用户名(失败忽略)
        - 特征 cookie 校验(§5)→ loginCheck
     5. 自动关窗 + destroyPartition(persist:login-${id})   (登完即焚)
     6. resolve { jar, domain, suggestedLabel, loginCheck }
 → 渲染层:
     - loginCheck.ok=false → 软提示「似乎没登上(缺 X),仍要保存吗?」(useConfirm)
     - suggestedLabel 预填账号名 → 走既有 credentials:save 存 cookie 凭证
       (id=平台__账号名,type=cookie,meta.platform/domain;复用第二期)
```

关键点:
- **临时分区登完即焚**:不串号、不留痕、天然多账号。
- **cookie 直读明文**:从 Electron session 读,不碰 DPAPI/Keychain/ABE。
- **存凭证复用**:控制层只产出 `jar + 建议名`,存走第二期 `credentials:save` —— 多账号/切换/
  重拓/UseCredential 自动全有,不重写。
- **点保存 → 自动读+关+销毁**(用户拍板,一步到位)。
- **取消**:关窗 + 销毁分区 + resolve 一个 cancelled 态(不存)。

## 5. 登录态校验(双层:已知表 + 通用兜底)

判定「真登录 vs 游客」—— 防止把游客 cookie(如 YouTube 没登录也有的 VISITOR_INFO/PREF)误存。

- **已知站特征表**(精确判,易扩展,集中一处常量,不写死逻辑):
  | 站 | required cookie |
  |---|---|
  | youtube.com | LOGIN_INFO, SID, HSID |
  | bilibili.com | SESSDATA, bili_jct, DedeUserID |
  | x.com / twitter.com | auth_token, ct0 |
  | instagram.com | sessionid, ds_user_id |
  | tiktok.com | sessionid, sid_tt |
  | weibo.com | SUB, SUBP |
  required 全在 → ok;缺 → ok=false + missing 列表(软提示,不硬拒)。
- **未知站通用兜底**(小红书等不在表里):启发式 —— 存在「会话类 cookie」(`HttpOnly`+`Secure`
  且 value 长度 >10、名字非 `_ga*`/纯访客标识)≥1,或多个长随机值 cookie ≥2 → 视为 ok。否则 ok=false。
- **软提示**:ok=false 不阻止保存,渲染层 useConfirm「似乎没登上(缺 X),仍要保存吗?」,
  用户可坚持存(应对校验表过时)。

**用户名抓取**(可选增强,自动命名账号):per-site `executeJavaScript`(YouTube 头像 alt /
B站 `__INITIAL_STATE__.user.uname` 等),抓到 → suggestedLabel 预填;抓不到 → 用户手填。
失败永不阻塞。已知表 + 用户名脚本都放同一常量文件,易加站。

## 6. 「我已登录」按钮回传 main 的通道

登录页是外部站点(无我们的 preload)。注入的浮窗按钮要把「点击」传回 main:
- 方案:注入脚本里按钮 onclick 触发一个**约定 console 哨兵**(如
  `console.log('__CODESHELL_LOGIN_SAVE__')`),main 侧 `webContents.on('console-message')`
  监听该哨兵 → 触发保存流程。镜像 BrowserPanel 现有的「in-guest click 拦截 → console 哨兵」做法
  [[project_browser_panel_nav_bugs]]。「取消」同理一个哨兵。
- 不给登录页注入 preload(安全:外部站点不该拿到我们的 API)。

## 7. 错误处理

- 加载失败 / 渲染进程崩(白屏):did-fail-load/render-process-gone → 关窗+销毁分区+返回友好错误
  (引导「开 GPU 兼容模式重试」,镜像参考 repo)。
- 目标域 0 cookie:返回 ok=false + 提示「未获取到该域 cookie,请确认已登录」。
- 用户直接关窗(没点保存):视为取消,销毁分区,不存。
- 临时分区销毁失败:best-effort,不阻塞(下次启动 sweep 兜底,可选)。

## 8. 测试 (TDD)

desktop(`bun test src/`,Electron session/BrowserWindow mock):
1. 登录态校验:已知站 required 全在 → ok;缺一个 → ok=false + missing 正确。
2. 通用兜底:有会话类 cookie → ok;只有游客 cookie(VISITOR_INFO/PREF/_ga)→ ok=false。
3. 用户名抓取:脚本返回字符串 → suggestedLabel;抛错/空 → undefined,不阻塞。
4. loginAndCaptureCookies:点保存哨兵 → getCookies + 校验 + 关窗 + destroyPartition 调用;
   取消哨兵 → 销毁+cancelled,不读 cookie。
5. BrowserHost.open(window):partition/加固 webPreferences 正确;getCookies 按分区读;close 触发 onClosed。
6. 渲染层 Cookie tab:loginCheck.ok=false → useConfirm 软提示;suggestedLabel 预填账号名;
   保存走 credentials:save。

## 9. 复用 / 不重写

- 存凭证、列表、切换、重拓、UseCredential:**全部复用凭证第二期**
  [[project_multi_account_cookie_creds]],控制层只产出 jar + 建议名。
- console 哨兵回传:复用 BrowserPanel 既有范式 [[project_browser_panel_nav_bugs]]。
- 防外链 setWindowOpenHandler/will-navigate:从 index.ts 现有逻辑提炼进 BrowserHost。

## 10. 后续阶段(本次不实现,接口预留)

- **第二步全收编**:主窗 createWindow、popout createBrowserPopout、BrowserPanel `<webview>`
  逐个迁到 BrowserHost(含 CSP 安装、窗口状态、webview 加固、anchor 转发的归并)。每迁一个回归。
- **临时分区启动 sweep**:清理上次遗留的 `persist:login-*`(若有持久化残留)。
- 已知校验表 / 用户名脚本随用随加站。
