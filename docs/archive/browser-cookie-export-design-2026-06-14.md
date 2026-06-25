# Cookie Lease — 浏览器登录态到 CLI 工具的受控桥接

> 2026-06-14，修订 2026-06-14。背景：用户写了 `media-downloader` (yt-dlp + ffmpeg) skill，以及其他需要 cookie 的 skill。问题是：**用户在 codeshell 浏览器面板里登录后的 cookie，能不能流到 skill 跑的 yt-dlp 命令里？** 现状是不能——中间缺一座桥。本文记录调研结论、业界做法分歧、设计决策与实现方案，供后续做功能时当依据。

---

## 1. 一句话结论

**CodeShell 应该补一座从 BrowserPanel 登录态到本地 CLI 工具的受控桥，但不把它定义为通用 cookie 导出功能。推荐实现为「按域名、按任务、一次性、用户审批」的 Cookie Lease：主进程从 `persist:browser` 读取限定域 cookie，生成临时 Netscape cookies.txt，仅注入当前工具调用，结束后由 tool runtime 清理。通过约定 env `CODESHELL_COOKIE_FILE`，覆盖 curl / wget / aria2 / yt-dlp / gallery-dl / streamlink 及任意脚本语言的 cookie jar。**

- **现状**：`persist:browser` 分区里登录的 cookie，没有任何机制能流到 skill 的 CLI 命令。skill 跑在 bash 子进程，摸不到主进程的 Electron `session` 对象，这条接线在代码里不存在。
- **为什么主流不做、CodeShell 应该做**：主流 agent 的下载/抓取走浏览器栈，本就带 cookie，没有"喂给 CLI"的场景；且自动导出明文 cookie 是安全责任，大厂避之不及。CodeShell 两个条件都具备（有 CLI 下载场景 + 是本地桌面 app 能用确认/限权扛安全锅），且有架构优势（自有 partition 的 cookie 已解密，绕开 OS 加密）。
- **"临时"指文件，不是 cookie 值**：cookie 值从 `session.cookies.get()` 原样读出、原样写入 cookies.txt，不做任何篡改或重新签发。临时的是 `.txt` 文件——它在 `/tmp/codeshell-cookie-leases/` 下，用完即删。cookie 本身的过期/刷新逻辑归服务器端管理。

---

## 2. 现状：为什么 skill 用不上面板登录态

`media-downloader` skill 写得正确，给了两条标准 yt-dlp 路子，但两条都**够不到 codeshell 面板的登录态**：

| skill 的方式 | 读哪里的 cookie | 能用上面板登录态吗 |
|---|---|---|
| 方式一 `--cookies-from-browser chrome` | 系统**真实 Chrome** 的磁盘 cookie 库 | ❌ 不是面板那份；且撞上 macOS 钥匙串弹窗 / Windows Chrome 127+ App-Bound Encryption（解不开） |
| 方式二 `--cookies cookies.txt` | 用户**手动**用扩展导出的文件 | ⚠️ 能用，但跟面板登录态无关，要人肉导出 |

根因：cookie 存在 Electron 主进程的 `session.fromPartition('persist:browser')` 里；skill 是 agent 在终端跑的 bash 子进程，只能读文件/跑命令，**无法访问主进程的 Electron session 对象**。中间没有桥。

相关现状代码：
- `packages/desktop/src/renderer/panels/BrowserPanel.tsx` — `<webview partition="persist:browser">`
- `packages/desktop/src/main/index.ts` — `hardenWebviewGuests`（沙箱化 + 钉死 `persist:browser` 分区，与 `defaultSession` 隔离）

---

## 3. Cookie Lease 消费者：不止 yt-dlp

Netscape `cookies.txt` 是 CLI 生态的事实标准，Cookie Lease 天生覆盖以下全部消费者：

| 工具 | 用法 | 场景 |
|---|---|---|
| **curl** | `curl -b "$CODESHELL_COOKIE_FILE" URL` | API 调试、下载、自动化脚本 |
| **wget** | `wget --load-cookies="$CODESHELL_COOKIE_FILE" URL` | 批量下载、镜像站点 |
| **aria2** | `aria2c --load-cookies="$CODESHELL_COOKIE_FILE" URL` | 高速多线程下载 |
| **yt-dlp** | `yt-dlp --cookies "$CODESHELL_COOKIE_FILE" URL` | YouTube / B站 / 抖音视频下载 |
| **gallery-dl** | `gallery-dl --cookies "$CODESHELL_COOKIE_FILE" URL` | Pixiv / Twitter / Instagram 图包 |
| **streamlink** | `streamlink --http-cookies "$CODESHELL_COOKIE_FILE" URL` | 直播流录制 |
| **Python** | `http.cookiejar.MozillaCookieJar(os.environ["CODESHELL_COOKIE_FILE"])` | agent 手写 Python 脚本 |
| **Node.js** | `new (require("tough-cookie").CookieJar)(); jar.loadFromFileSync(process.env.COOKIE_FILE)` | agent 手写 Node 脚本 |
| **Ruby** | `HTTP::CookieJar.new.load(ENV["CODESHELL_COOKIE_FILE"])` | agent 手写 Ruby 脚本 |

env key 使用通用命名 **`CODESHELL_COOKIE_FILE`**，不绑定特定 skill，一次桥接覆盖所有 CLI cookie 消费者。skill 侧只需 `--cookies "$CODESHELL_COOKIE_FILE"`，不需要为每个 skill 单独做桥。

---

## 4. 业界做法：存了 cookie，到底拿不拿出来用？

（来源见文末。已验证事实，3 轮 deep-research / 定向调研。）

### 4.1 两个阵营

**A 阵营：存了但封闭使用——cookie 永不离开那个浏览器（主流）**
- **Codex 内置浏览器 / Codex Chrome 扩展**：登录态留在浏览器，agent 驱动那个浏览器来用，从不导出 cookie。
- **Claude in Chrome / Claude Code computer-use**：共享浏览器登录态，但靠"在浏览器内操作"或"截图点击"，cookie 不暴露给外部。
- **chrome-devtools-mcp / Playwright MCP 默认 persistent 模式**：登录态持久化在专属 profile，下次用同一个浏览器，不往外吐 cookie。
- **codeshell `persist:browser` 现状**：同属此类——存了，只在 webview 里用。

> A 阵营的共同逻辑：**"用 cookie" = "用持有 cookie 的那个浏览器去发请求"**，而不是把 cookie 字符串搬到别处。因为它们的任务（agent 浏览网页）不需要把 cookie 取出来。

**B 阵营：存了，而且明确支持"取出来"成可移植凭据（少数，但有先例）**
- **Playwright `storageState`**：官方的"导出登录态成 JSON"机制（`auth-state.json`），别的 session `--storage-state=` 喂回去。这就是业界版"把 cookie 拿出来用"，只是格式是 Playwright JSON、消费者还是 Playwright。
- **Browserbase Contexts**：持久化整个 user-data-dir（含 cookie），新 session 复用——也是"取出来再喂回浏览器"。
- **yt-dlp 的 `--cookies cookies.txt` 生态**：真正"cookie 离开浏览器、喂给非浏览器 CLI"的场景。现实是**没有 agent 工具帮做这一步**，全靠用户手动用浏览器扩展导出。

### 4.2 为什么"取出来给 CLI 用"几乎没人做

不是想不到，是两个原因：

1. **它们的 agent 不需要 CLI 带 cookie**。Codex/Claude/Playwright 的下载/抓取本就走浏览器栈，自然带 cookie。只有当工具链里有"浏览器之外的命令行下载器（yt-dlp/curl/aria2）"时，才会冒出"把 cookie 搬出来"的需求——这恰是 CodeShell 的场景，主流 agent 没有。
2. **导出明文 cookie = 安全责任**。cookies.txt 是全站登录凭据明文。官方生态宁可让用户手动用本地扩展去导，也不在工具里自动掏——自动掏 cookie，谁做谁背安全锅，大厂避之不及。

---

## 5. 推荐方案：Cookie Lease

把 §4.2 两条反过来看，正是 CodeShell 该做的理由：

- **"几乎没人做"不是因为没价值，而是别人没这场景 + 不愿背安全锅。** CodeShell 两个条件都具备：有 CLI 下载场景，是本地桌面 app（可用确认/限权扛安全锅）。
- **架构白送的优势**：cookie 在 Electron 自有 partition，`session.cookies.get()` 拿到的是已解密的——别人导出要硬刚 macOS 钥匙串和 Windows App-Bound Encryption，CodeShell 完全不碰这两道墙。
- **有正当业界先例**：Playwright `storageState` 已证明"导出登录态成可移植文件再喂给工具"是正当模式。CodeShell 只是把目标格式从 Playwright JSON 换成 Netscape `cookies.txt`——同思路，换输出格式。

### 5.1 Cookie Lease 模型

核心：cookie 文件不属于 workspace、不属于 skill、不属于 agent。它属于一个 **CookieLease** 对象，由 tool runtime 创建、注入、清理。

```
┌─────────────────────────────────────────────┐
│              CookieLease (主进程)             │
│                                             │
│  leaseId: "ck-abc123"                       │
│  domain: "youtube.com"                      │
│  filePath: "/tmp/codeshell-lease-abc123.txt"│
│  commandPid: 88421                          │
│  createdAt: 1700000000                      │
│  ttl: 300 (5分钟硬超时)                      │
│  status: "active" | "cleaned" | "leaked"     │
│                                             │
│  create()    主进程从 session 读 cookie 写文件  │
│  inject()    注入 CODESHELL_COOKIE_FILE 到     │
│              子进程 env                       │
│  cleanup()   删文件 + 审计记录                 │
│  forceCleanup()  超时定时器兜底                │
└─────────────────────────────────────────────┘
```

### 5.2 三层生命周期保证

**第一层：正常路径 —— tool runtime 的 try/finally**

Bash 命令执行完后，不管成功还是失败，cleanup 都要跑：

```ts
class CookieLeaseManager {
  async executeWithCookies<T>(
    lease: CookieLease,
    fn: (env: Record<string, string>) => Promise<T>
  ): Promise<T> {
    try {
      return await fn({ CODESHELL_COOKIE_FILE: lease.filePath });
    } finally {
      await this.cleanup(lease.id);
    }
  }
}
```

**第二层：异常取消 —— AbortSignal 联动**

用户 cancel 命令、超时 kill、agent 内部 abort 时，先删文件、再杀进程，防止子进程残留引用：

```ts
signal.addEventListener("abort", async () => {
  await leaseManager.cleanup(lease.id); // 先删文件
}, { once: true });
// 然后才 kill 进程
```

**第三层：崩溃兜底 —— 主进程定时器 + 启动扫描**

- 每个 lease 创建时设置硬超时定时器（默认 5 分钟），超时强制删文件
- 应用启动时扫描 `/tmp/codeshell-cookie-leases/`，清理超过最大存活时间的残留文件

cleanup 归 **tool runtime** 管，不归 skill、不归 agent、不归用户。

---

## 6. Cookie 过期处理策略

cookie 值本身不做任何修改，过期/刷新逻辑归服务器端。但 CodeShell 在 lease 创建和下载执行两个阶段提供检测和引导。

### 6.1 导出前检测告警

在 `createCookieLease()` 中检查 `expirationDate`，如果关键 cookie 在 24 小时内到期，向用户告警：

> ⚠️ `youtube.com` 的 2 个 cookie 将在 24 小时内过期。建议先打开浏览器面板访问该站点以自动刷新登录态。

用户可选择：继续、先刷新、或取消。

### 6.2 静默 webview 续期（可选，默认关闭）

如果用户允许，可在导出前用隐藏 BrowserWindow 导航到目标域名，让服务器自然下发新 `Set-Cookie`，获取刷新后的 cookie 再导出。风险：

- 某些站点检测到无头浏览器会拒绝或要求验证码
- 可能触发安全通知（Google 检测到异常设备登录）
- 不能用于需要交互的登录（2FA / OAuth）

### 6.3 运行时 403 兜底

如果下载进行中 cookie 过期，yt-dlp 退出码非零且 stderr 含 `HTTP Error 403` 时，明确提示用户去浏览器面板刷新登录态，与现有 skill 契约一致。

---

## 7. 安全护栏

cookies.txt 是全站登录凭据明文，必须配套：

- **按域名导出**，默认仅目标 URL 的 eTLD+1 域，不导出全部分区。审批弹窗显示精确域名列表。
- **用户显式确认**，接入现有路径权限/审批体系。审批文案包含：请求方（哪个 skill）、目标命令、域名范围、生命周期、文件位置（系统临时目录）、风险提示。
- **临时文件 0600 权限、用完即删**，在 `/tmp/codeshell-cookie-leases/` 下，绝不落工作区被 commit。
- **不提供「始终允许」**，每次都需要用户确认；trust policy 留后。
- 与 skill 现有交互契约一致：「403/登录类问题需用户配合 cookie，别替用户决定读哪个浏览器。」

---

## 8. 技术细节

### 8.1 Electron Cookie → Netscape cookies.txt 字段映射

Netscape 格式：每行一个 cookie，**7 个 TAB 分隔字段**，首行 `# Netscape HTTP Cookie File`。

| Netscape 字段 | 来源（Electron `Cookie`） |
|---|---|
| 1 domain | `domain` |
| 2 include-subdomains `TRUE/FALSE` | 由 `hostOnly` 推导（`hostOnly===true` → `FALSE`） |
| 3 path | `path` |
| 4 secure `TRUE/FALSE` | `secure` |
| 5 过期 Unix 秒 | `expirationDate`；session cookie（无 `expirationDate`）填 `0` |
| 6 name | `name` |
| 7 value | `value` |

坑：
- Electron `expirationDate` 历史上有精度 bug（[electron/electron#5438](https://github.com/electron/electron/issues/5438)），生成时间戳时验证
- 首行 header 必须有，否则 yt-dlp 报格式错
- cookie 键或值含换行/制表符的跳过，不合规 cookie yt-dlp 吃不了
- 换行符 Node 写文件自动按 OS 处理

### 8.2 进程边界

cookie 在主进程（Electron main），命令在 core 进程。文件路径通过 IPC 传递：

```ts
// Core 侧请求 lease
const response = await ipc.send("cookie-lease:create", { domain, purpose });

// Desktop 主进程创建临时文件
const lease = await createCookieLease(domain);
return { leaseId: lease.id, filePath: lease.filePath };
```

### 8.3 代码位置

> **⚠️ 实现落点与本提案不同（2026-06-25 核查）**：本节是设计**提案**的文件布局,功能已落地但**实际代码位置/机制与下方提案不符**,照此寻码会扑空。**真实落点**:
> - core 侧:`packages/core/src/credentials/`（`cookie-jar.ts`、`use-credential-tool.ts`(物化临时 `cookies.txt`,见 `COOKIE_FILE_PREFIX`/30min sweep)、`use-gate.ts` 三档门）。
> - desktop 主进程:`packages/desktop/src/main/credentials-service.ts`(`createCookieLease`/`cleanupLease` 等**函数**,非 `CookieLeaseManager` 类)。
> - **机制差异**:最终走 **`UseCredential` 工具**按域物化 Netscape `cookies.txt` 供 CLI 消费(关联记忆 `project_multi_account_cookie_creds`),**不是**约定 env `CODESHELL_COOKIE_FILE` 注入(该 env 全仓未实现)。无独立 `cookie-lease.ts`。
> 下方原提案布局仅留作设计 rationale。

- **`packages/desktop/src/main/cookie-lease.ts`** — CookieLeaseManager + formatNetscapeCookies + createCookieLease + 三层清理
- **`packages/desktop/src/main/ipc/cookie-lease-handler.ts`** — IPC handler：创建、审批弹窗、清理
- **`packages/core/src/engine/cookie-lease.ts`** — core 侧 lease 请求接口
- **`packages/core/src/engine/tool-executor.ts`** — Bash/spawn 工具注入 `CODESHELL_COOKIE_FILE`

---

## 9. 未决 / 范围外

- **UI 形态**：agent 触发时弹审批窗口，还是 BrowserPanel 里一个按钮，待定。推荐：agent 触发时弹审批，面板不暴露直接导出按钮。
- **静默 webview 续期**：默认关闭，作为可选项。需要用户明确启用。
- **env key 命名**：`CODESHELL_COOKIE_FILE` 已定，通用命名覆盖所有 CLI 消费者。
- **多域支持**：当前单域；如果一次下载涉及多个域名，是否需要多个 lease 或合并导出，待场景驱动。
- **记住授权（per-site remembered grant）**：当前不做，每次确认；trust policy 留后。
- **复用真实 Chrome 登录（而非面板登录）**：范围外。业界唯一可行是"扩展内嵌真实 Chrome + native messaging"（Codex 扩展、Claude in Chrome），产品级工程量 + 受商店签名约束，不进此方案。
- **时效性**：Chrome 版本门槛多（127 ABE / 136 断 CDP-默认 profile / 144+ `--autoConnect`），本文事实半年后可能漂移。

---

## 10. 主要来源

- OpenAI Codex 内置浏览器：https://developers.openai.com/codex/app/browser
- Codex Chrome 扩展：https://developers.openai.com/codex/app/chrome-extension
- Claude Code computer-use：https://code.claude.com/docs/en/computer-use
- Claude in Chrome：https://code.claude.com/docs/en/chrome
- chrome-devtools-mcp：https://github.com/ChromeDevTools/chrome-devtools-mcp
- Chrome 136 remote-debugging 变更：https://developer.chrome.com/blog/remote-debugging-port
- Playwright MCP user-profile / storageState：https://playwright.dev/mcp/configuration/user-profile
- Browserbase Contexts：https://docs.browserbase.com/features/contexts
- Chrome App-Bound Encryption（Chrome 127+）：https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html
- yt-dlp README（`--cookies` / `--cookies-from-browser`）：https://github.com/yt-dlp/yt-dlp#filesystem-options
- yt-dlp FAQ（cookie 导出 / ABE workaround / 安全告诫）：https://github.com/yt-dlp/yt-dlp/wiki/FAQ
- yt-dlp ABE 解密失败 issue：https://github.com/yt-dlp/yt-dlp/issues/10927 · macOS Keychain/v10：https://github.com/yt-dlp/yt-dlp/issues/13710
- Netscape cookie 文件格式：https://everything.curl.dev/http/cookies/fileformat.html
- Electron `session.cookies` API / Cookie 结构：https://www.electronjs.org/docs/latest/api/cookies · https://www.electronjs.org/docs/latest/api/structures/cookie
- WorkBuddy（腾讯云）Agent Browser：https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/WorkBuddy-Zero-Cost-Skill-Top-10/Agent-Browser（注：登录态复用机制官方未披露）
- OpenCode（sst/opencode）tools / webfetch：https://opencode.ai/docs/tools/ · https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/webfetch.ts（无浏览器/无 cookie 复用）
