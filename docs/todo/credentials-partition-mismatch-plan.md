# 凭证服务 partition 与 per-session 浏览器面板不一致 — 修复方案

状态：仅方案，未动代码。
性质：**既有遗漏**（per-session browser partition 重构只改了面板侧，凭证服务这条线没跟着改），非 CDP 端口改动引入。

## 零、为什么必须修（动机）

- **凭证是跨 session 全局的**（存一次任何 session 的工具都能复用），但"用户实际登录的浏览器"已经是 per-session（每个 session 一个 `persist:browser:<bucket>`）。凭证服务却仍读写单一硬编码分区 → 抓不到用户真正登录的那份登录态。
- **单点登录站（已确认小红书就是）把这个 bug 从"不方便"升级成"多 session 场景根本没法用"**：
  - 单点登录 = 服务端同一账号只认一个有效会话。session A 登了、session B 再扫码登**同一账号** → 服务端签发新 token 并作废 A 的 token，A 随后 401。本地两个分区的 cookie jar 并存（Electron 不互删），但 A 那份在服务端已死。这是站点策略，CodeShell 拦不住。
  - 因此对单点登录站，**per-session 各自登录是反模式**；唯一稳妥姿势是"登一次 → 抓成 cookie 凭证 → 其他 session `restore` 复用同一份 token"。多个分区共用同一服务端会话，不会互相踢。
  - 而这条唯一正解**恰好卡在本 bug 上**：`captureAllCookies` / `restoreCookiesToBrowser` 硬编码 `persist:browser`，读不到 per-session 登录态、也导不回目标 session。**不修此 bug，单点登录站在多 session 下无解。**

## 一、已核实的事实

### 写入端（面板，per-session）
- `packages/desktop/src/renderer/panels/PanelArea.tsx:429`
  每个 chat session 用专属分区 `persist:browser:${bucket}`（bucket 经过字符清洗）。
- `packages/desktop/src/main/index.ts:1107-1110` (`hardenWebviewGuests`)
  只放行 `persist:browser` 前缀的分区，其余强制回落 `persist:browser`（防越权）。
- 用户在某 session 面板里登录 → cookie 落在 `persist:browser:<bucket>`。

### 读写端（凭证服务，硬编码单一分区）
- `packages/desktop/src/main/credentials-service.ts:17`
  `const BROWSER_PARTITION = "persist:browser";`
- `browserSession()`（:45）永远 `session.fromPartition("persist:browser")`。
- 6 个函数全部只碰这个分区：
  `listCookieDomains` / `getCookiesForDomain` / `captureCookieJar` /
  `captureAllCookies` / `restoreCookiesToBrowser` / `createCookieLease`
- 对应 5 个 IPC handler（`index.ts`）：
  `credentials:cookieDomains`(:1680) / `credentials:cookiePreview`(:1681) /
  `credentials:captureCookieJar`(附近) / `credentials:captureAllCookies`(:1697) /
  `credentials:restoreCookies`(:1701 附近) — 均不带 sessionId/partition。

### 两者永远不相交
面板写 `persist:browser:<bucket>`，凭证服务读/写 `persist:browser`（无 bucket）。中间无桥接。

## 二、真正会触发的后果（3 个）

1. **「从内置浏览器全量拓取 cookie」失效**（最痛）
   `CookieTab.tsx:157` 按钮 → `captureAllCookies` 读 `persist:browser`，
   但用户是在 per-session 面板登的（写进了 `<bucket>`）→ 拓到空。
2. **cookie 预览 / `cookieDomains` 看不到登录态**
   设置页读空分区，面板里明明登录了却显示无 cookie。
3. **`restoreCookiesToBrowser`（切换账号导回）/ `createCookieLease`（yt-dlp/curl 出 cookies.txt）读写错分区**
   导回的登录态在 per-session 面板里看不见；lease 读到旧的或空的。

## 三、更正一处误判：loginCapture 是对的，不是受害者

- `packages/desktop/src/main/credentials-login/index.ts:207`
  用**临时分区** `login-<uuid>`（非 persist，用完即焚），jar 直接回传渲染层存成凭证。
- 它**自带分区、根本不碰 `persist:browser`**，是唯一自洽的路径。
  之前"loginCapture 抓到的存进 persist:browser"的说法不成立。

## 四、修复方案 A（分区感知，推荐）

思路：凭证是跨 session 全局的（存一次任何 session 都能用），凭证服务读**单一分区**本身没错；错的是"用户实际登录的浏览器"现在是 per-session，没有那个唯一的内置浏览器可抓。→ 让操作跟随"当前 session 的分区"。

改动清单（集中，语义清晰）：

1. `credentials-service.ts`
   - 6 个函数签名加可选 `partition?: string` 入参，默认 `BROWSER_PARTITION`（兼容 popout / 旧调用）。
   - `browserSession(partition = BROWSER_PARTITION)` 用传入分区。
   - 仍做前缀校验：只接受 `persist:browser` 开头的值，否则回落默认（与 `hardenWebviewGuests` 一致的 defense-in-depth）。
2. `index.ts` 5 个 handler
   - 收 `sessionId`（或直接收 `partition`）参数，解析出该 session 的 bucket → `persist:browser:<bucket>`，透传给 service。
   - bucket 解析要与渲染层 `PanelArea.tsx:429` 同一套清洗规则（`replace(/[^a-zA-Z0-9_:.@-]/g, "_")`），建议抽一个共享工具函数避免两处漂移。
3. `renderer/credentials/CookieTab.tsx`
   - 全量拓取 / 预览 / 导回时，把当前 session 的分区（渲染层本就在算 `persist:browser:${bucket}`）传进 IPC。
   - 若 CookieTab 处于"无 session 上下文"的设置页场景，需决定默认取哪个分区（见下方待确认）。

## 四.五、派生副作用：restore 的 clear-mode 在 per-session 下会误清整个面板

- `restoreCookiesToBrowser` 默认 `mode="clear"`（`credentials-service.ts:95`）会先
  `clearStorageData({storages:["cookies"]})` **清空整个目标分区的 cookie** 再逐条导回。
- 目前只清共享 `persist:browser`，影响面小。但按方案 A 改成分区感知、传入某个 session 的分区后，
  "切换账号"会把**那个 session 面板里所有站点的登录态一起清掉**（不只目标站）——在 per-session
  语境下比现在危险得多。
- 处理：导回到 per-session 分区时**默认 `mode="merge"`**（只覆盖同名 cookie，保留其他站登录态），
  或在 clear 前弹确认。clear 仅在用户明确要"干净换号"时用。

## 四.六(定稿)、拓取改为「两个按钮」——抓当前会话 / 抓全部

用户拍板：不靠隐式"活跃"猜分区，UI 明确给两个入口。

- **按钮 A「抓当前会话」**：抓**打开凭证页的这个 chat session** 自己的浏览器分区
  (`persist:browser:<当前bucket>`) 的全部 cookie。渲染层本就知道自己的 bucket，直接把它
  派生的分区/session 传给 handler。语义最清楚——"我在哪个对话里点，就抓那个对话的浏览器"，
  不依赖 active-guest 那种"最近点了谁"的隐式状态。
  - 边界：若当前会话的浏览器面板没登录任何站 → 抓到 0 条，提示"请先在本会话的浏览器面板登录"。
- **按钮 B「抓全部」**：遍历**当前所有活着的浏览器面板 guest 的 session**，各自 `cookies.get({})`
  合并去重后返回。兜底用（想把所有会话的登录态一次性捞出）。
  - ⚠️ 语义代价：不同 session 若登了同站的**不同账号**，合并 jar 会混号——按钮/说明里标注清楚，
    由用户主动选择时接受。
  - ⚠️ 能力边界：Electron **无 API 枚举所有 persist 分区**，只能覆盖**当前还开着的**面板 guest 的
    session；从没打开过或已被 idle 回收的 session 分区枚举不到。这是硬约束，不是 bug。
  - 实现：从 `listGuests()`/guests 集合取所有 live guest 的 `webContents.session`，按 session
    去重（同一 session 的多 tab 共享一个分区，别重复抓），逐个 `captureAllCookies(sess)` 后 merge。

旧的「跟随 active guest 单按钮」方案作废，改为上面两个显式按钮。下节 active-guest 讨论仅作背景保留。

## 四.七(作废/背景)、"session 一多抓哪个分区"的默认策略（原：跟随 active guest）

- 复用已有的 `active-guest.ts`（最近 attach/focus 的 guest = 自动化目标）：从 active guest 反查它的
  `webContents.session` 分区名，作为拓取/导回的默认目标。匹配真实操作流（"我刚在哪登的就抓哪"），
  不需要新增 session 选择器 UI。
- 边界：active guest 为空（从没开过面板）→ 回落共享 `persist:browser` 并提示"请先在内置浏览器登录"。
- 歧义防护：active guest 是**跨窗口全局最近一个**。拓取前在 UI 显示"将从 XX 分区拓取 · N 条 cookie"
  让用户确认，避免多窗口下抓错分区。
- 不采用：让用户从下拉选 session（枚举分区成本高、UI 重）、聚合所有分区（不同 session 可能登不同账号，
  合并会串号）。前者可作后续"高级：指定来源"补充。

## 五、待你确认的点

- **CookieTab 在设置页打开时的 session 归属**：设置页可能不绑定某个 chat session。
  需要明确："全量拓取"是拓当前活跃 session 的面板分区，还是让用户选 session？
  （这决定 handler 是收 sessionId 还是收显式 partition。）
- **popout / 旧共享分区**是否仍保留 `persist:browser` 作为一个可选目标，还是全面 per-session。
- 是否需要一个**迁移/兜底**：老用户此前登录在 `persist:browser` 里的 cookie，改造后要不要能读到（例如"拓取"时同时扫共享分区 + 当前 bucket 并合并）。

## 六、方案 B（不推荐）

强制"从内置浏览器拓取"只认共享 `persist:browser`，并让某个面板固定用共享分区。
→ 破坏 per-session 隔离初衷，仅作对比记录，不采用。
