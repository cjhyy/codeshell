# 浏览器 Profile / Workspace / 租约 分层设计

> 状态：设计稿（待评审）
> 日期：2026-09-04
> 基线：`main` @ `072b83fe`
> 目标：把当前由 `sessionId` 一并承担的「登录态、页面归属、标签页身份、控制权」四件事拆成四层，使多个 Session 默认共享登录态、默认隔离任务路由，并通过显式租约接管具体标签页。
> 参考：Codex Desktop 26.901.22334 的分层（应用级 Profile + 会话路由 + 稳定 tabId + `sessionControlled` 控制权），[Browser 文档](https://learn.chatgpt.com/docs/browser)、[Browser extension 文档](https://learn.chatgpt.com/docs/chrome-extension)

## 1. 问题：一个 `bucket` 在干四件事

`bucket = projectId + sessionId`（`renderer/app/appUtils.ts` 的 `bucketKey`），而浏览器侧的一切都从它派生。

### 1.1 登录态被绑在 Session 上

```ts
// packages/desktop/src/renderer/app/appUtils.ts:111
export function browserPartitionForBucket(bucket: string): string {
  const prefix = bucket.startsWith(QUICK_CHAT_BUCKET_PREFIX) ? "browser:qchat" : "persist:browser";
  return `${prefix}:${bucket.replace(/[^a-zA-Z0-9_:.@-]/g, "_")}`;
}
```

`bucketKey` 用 `::` 连接（`transcripts.ts:199-201`：`` `${projectBucketSegment(projectId)}::${sessionId ?? "_none_"}` ``），所以实际值形如：

```text
persist:browser:<projectId>::<sessionId>
```

Electron 的 partition **就是 Cookie jar**，所以：

**每开一个新 Session，登录态从零开始。** 这不是概念不清的美学问题，是每天都会碰到的功能缺陷——需要登录的抓取、下载、发帖类任务，每换一个 Session 就要重新登录一次。

本机磁盘已经能直接量化这个后果（`~/Library/Application Support/code-shell/Partitions/`，2026-09-04 实测）：

```text
browser%3A5ffdbdff-…%3A%3As-mtgxb4dl-8dd35d4f
browser%3A5ffdbdff-…%3A%3As-mtg157x2-1acd78a5
browser%3A5ffdbdff-…%3A%3As-mtl8jf6s-57bdc5ab
```

- 共 **72** 个 partition 目录，`Partitions/` 总占用 **1.9 GB**；
- 其中**一个 project 有 13 个独立 Cookie jar**（`r-mradzshz-qq9ic0`，合计 72 MB）——等于同一个项目里，同一批站点被要求重新登录了 13 次。

磁盘占用是次要问题，主要问题是 13 份互不相认的登录态。

同一份逻辑在 main 侧还有第二份实现（`main/browser-driver/active-guest.ts:93`，返回 `BrowserPartition`）。两处必须同时改，否则「partition 怎么算」会在两侧漂移。

### 1.2 「页面归属」已经存在，但也叫 bucket

`active-guest.ts` 里已经有一套完整的归属索引：

```ts
const byGuestId = new Map<number, GuestRecord>();
const guestIdsByBucket = new Map<BrowserBucket, Set<number>>(); // ← 这就是 workspace
const activeGuestIdByBucket = new Map<BrowserBucket, number>();
const bucketBySessionId = new Map<string, BrowserBucket>(); // ← 这就是 binding
const partitionByBucket = new Map<BrowserBucket, BrowserPartition>(); // ← 这就是 profile
```

也就是说 **Workspace / Binding / Profile 三层在实现里已经各自存在了，只是三者的 key 都是同一个 `bucket`**，因此无法独立变化。这个设计不是从零新增三层，而是把已有的三个 Map 各自解耦到自己的键上。

### 1.3 `tabId` 会被复用

```ts
/** One browser tab as the agent sees it. tabId is the webContents.id (string). */
tabId: String(record.guestId),   // active-guest.ts:287
```

`tabId` 是 `webContents.id`——一个进程内自增整数，**标签页关闭后会被 Electron 复用**。当前没有任何一层校验拿到的 tabId 是否还是原来那个页面。

### 1.4 现有 `lease` 是另一回事，不要混名

`background-runtime.ts` 已有 `leases: number` / `acquire()` / `release()`，但那是 **Chromium 进程存活的引用计数**（idle TTL 后回收整个 target），不是「谁能写这个标签页」。

> 本文一律用 **`TabControl`** 指排他写权，避免与既有 `lease` 撞名。

## 2. 分层模型

```text
BrowserProfile     登录态与站点数据（Cookie / localStorage / 历史）
      ↑ 多个 workspace 可共享一个 profile
BrowserWorkspace   一组标签页与其导航状态
      ↑ binding
SessionBrowserBinding   哪个 Session 用哪个 workspace
      ↓
TabControl         某个 Session 在某段时间内对某个标签页的排他写权
```

四层的正交性：

| 层                      | 回答的问题                | 生命周期                    |
| ----------------------- | ------------------------- | --------------------------- |
| `BrowserProfile`        | 我是谁（登录成谁）        | 长期持久，跨 Session 跨重启 |
| `BrowserWorkspace`      | 有哪些页面                | 跟随任务，可持久            |
| `SessionBrowserBinding` | 这个 Session 操作哪组页面 | 跟随 Session                |
| `TabControl`            | 现在谁能写这一页          | 短期，turn 级，可撤销       |

### 2.1 类型草案

```ts
interface BrowserProfile {
  id: string;
  /** Electron partition。由 profileId 派生，不再由 sessionId 派生。 */
  partition: string;
  /** 展示名，UI 上必须可见（见 §5.2）。 */
  label: string;
  createdAt: number;
}

interface BrowserWorkspace {
  id: string;
  /** 内置来源填 profileId；外部来源见 §6.1 的 BrowserSource。 */
  profileId: string;
  /** 稳定 tab 身份，见 §3.2；不是 webContents.id。 */
  tabIds: string[];
}

interface SessionBrowserBinding {
  sessionId: string;
  workspaceId: string;
}

interface TabControl {
  tabId: string;
  holderSessionId: string;
  mode: "control" | "observe";
  turnId: string;
  expiresAt: number;
  /** 防 tabId 复用 */
  generation: number;
  /** 防「同一 tab 导航走了」，见 §3.2 */
  expectedOrigin: string;
  expectedTitleHash: string;
  /** 防「外部浏览器重启了」，见 §6.2；内置来源填固定值。 */
  browserId: string;
}
```

**`role: owner | member` 有意不放进 `SessionBrowserBinding`。** 三种默认策略里它都是死字段（`shared-auth` 与 `isolated` 都是一对一，`claim-tab` 的归属由 `TabControl.holderSessionId` 表达）。只有将来做 `shared-workspace`（多 Session 看见同一组标签页）才需要。现在写进去，它会重复 `status: "active"` 的老路——写入后从不维护，之后没人敢删。

## 3. 关键决策

### 3.1 策略：默认 `shared-auth`

| 策略                      | Profile | Workspace | 用途                                     |
| ------------------------- | ------- | --------- | ---------------------------------------- |
| **`shared-auth`**（默认） | 共享    | 独立      | 复用登录态，任务页面互不干扰             |
| `isolated`                | 独立    | 独立      | 不同账号、敏感任务                       |
| `claim-tab`               | —       | —         | 把一个精确标签页显式移交给另一个 Session |

`shared-auth` 的默认 Profile 粒度是 **project 级**。

**这个默认有一个真实副作用**：同一个 project 里跑两个不同 GitHub 账号的任务会互相踢下线。因此：

- Profile 粒度必须**可配置**，Session 可显式选 `isolated`；
- 当前使用哪个 Profile **必须在 UI 上可见**（§5.2），否则"我为什么被登出了"是一个用户无法自查的问题。

### 3.2 接管校验：`generation` 不够

`generation` 只能防 tabId 复用，防不住同一个 tab 导航走了：

> Session A 取得某结账页的控制权 → A 的 turn 间隙，用户在同一标签页点到了别的站点 → A 恢复后往一个完全不同的页面填表单提交。

在支付、发帖、改配置这些场景里这是真实伤害，不是理论风险。Codex 的做法是接管时校验**浏览器 ID + 标签页 ID + 标题 + URL** 四项。

因此 `TabControl` 存 `expectedOrigin` + `expectedTitleHash`，并且：

- **每次写操作前**校验，不只在接管时校验；
- 不匹配时让 control **失效**（要求重新接管），而不是继续执行；
- 校验 origin 而非完整 URL——同页内的 query/fragment 变化不该导致误判。

另外需要一个不复用的稳定 `tabId`：当前 `String(webContents.id)` 不满足。建议 workspace 侧自发 `tab-<uuid>`，与 `webContents.id` 做一层映射，`webContents` 销毁时映射失效而 id 不回收。

**校验挂在哪里已经确定。** `automation-host.ts` 的 `runBrowserAction` 已经有一条逐动作的门链，只需在其中插入一环：

```ts
let guest = deps.activeGuest();          // :157  ← 目标解析
// … 面板未挂载时按需打开并重新取 guest（:158-175）
const targetUrl = req.action === "navigate" ? req.url : safeUrl(guest);
if (!domainAllowed(targetUrl)) return …;  // :192  域名白名单
if (isSensitiveAction(req) || learnedSensitiveRef) await requestApproval(…); // :204 敏感动作
const driver = driverForGuest(guest);     // :211  执行
```

现状的问题正在 `:157`：**动作打到「当前活动的那个 tab」，全程没有任何归属校验**。`AutomationDeps.activeGuest()` 的注释就是 "Current automation-target guest webContents"——它回答的是「哪个 tab 是活动的」，而不是「这个 Session 有权写哪个 tab」。

因此 `TabControl` 校验应作为**门链中的新一环**，插在 `:157` 解析出 guest 之后、`:211` 取 driver 之前，与域名白名单、敏感审批同层。这也天然满足 §3.2「每次写操作前校验」——因为这条门链本身就是每个动作都走一遍的。

### 3.3 turn 结束时的处置

对齐 Codex 的四种语义，缺一种就会出现「结果页被关掉」或「垃圾标签页堆积」：

| 情况                   | 处置                             |
| ---------------------- | -------------------------------- |
| Agent 临时创建、未标记 | 关闭                             |
| 用户原本打开的页面     | 释放 control，**页面不关闭**     |
| `markHandoff`          | 保留，下一轮继续操作             |
| `markDeliverable`      | 页面作为结果保留，释放自动化控制 |

「页面存在」与「控制权存在」是两件事——这是整个设计里最容易实现错的一条。

### 3.4 单写者

即使将来做 `shared-workspace`，同一标签页也**只能有一个 `mode: "control"` 持有者**。多个 `observe` 可以并存。不允许两个 Agent 同时写同一页。

## 4. 迁移（Phase 1 的硬约束）

现有用户的 Cookie 全部在 `persist:browser:<projectId>::<sessionId>` 下，落盘目录名是 URL 编码后的形式（`browser%3A<projectId>%3A%3A<sessionId>`）。改成 profile 派生后这些 partition 会变成孤儿——**用户的直观感受是「我所有登录都没了」**。

迁移代码必须按**实际落盘名**匹配，不能按未编码的逻辑名去找目录（`%3A` = `:`）。

> **实际决定（2026-09-06）**：选了第三条——**不迁移**。旧 partition 全部留在磁盘不再使用，用户重新登录一次即可。因此 Phase 1 的实现里没有任何目录扫描与编码名匹配。下面两个方案保留作为记录。

必须二选一，并且写进设计而不是留给实现时临场决定：

- **方案 A（推荐）**：一次性迁移。每个 project 选「最近使用过的 session partition」提升为该 project 的 profile partition，其余保留在磁盘上不删。
- **方案 B**：保留旧 partition 作只读回退——新 Session 先读 profile，未命中时回退到旧 partition。实现更复杂，但零丢失风险。

无论哪种，都**不能删除**旧 partition 目录：读不懂的数据要隔离而不是清空。

## 5. 落地顺序

| 阶段      | 内容                                                                                                                                    | 依赖 | 用户可感收益                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------- |
| ~~**0**~~ | ✅ **已落地** `29330223`：两份 `browserPartitionForBucket` + 两份 Quick Chat 前缀收口成一处                                             | —    | 无（纯重构，零行为变化）                                 |
| ~~**1**~~ | ✅ **已落地** `ca4f9739`：partition 由 profile 派生；默认 project 级 `shared-auth`；显式 profile 可隔离/可跨项目共享；按决定**不迁移**  | 0    | **新 Session 不再丢登录态**                              |
| ~~**2**~~ | ✅ **模型已落地** `5a70d797`：`BrowserWorkspaceRegistry` + `SessionBrowserBinding`（不含 `role`）；尚未替换 `active-guest` 的三个 Map   | 1    | 页面归属与 Session 解耦                                  |
| ~~**3**~~ | ✅ **模型已落地** `5a70d797`：`TabControlStore`（async）+ 四项校验（browserId/tabId/origin/titleHash）；尚未接进 `automation-host` 门链 | 2    | 不再误操作已导航的页面                                   |
| **4**     | `claim-tab` 显式移交                                                                                                                    | 3    | 跨 Session 交接具体页面                                  |
| **5**     | `BrowserSource` 外部来源（attach 用户 Chrome）+ §6.2 识别 + §6.3 分级权限                                                               | 3    | 复用用户真实登录态                                       |
| **6**     | 服务端 `BrowserBridge` 实现 + `TabControlStore` 共享存储实现                                                                            | 3    | 浏览器任务可跑在服务端                                   |
| ~~**7**~~ | ✅ **已落地** `525ccbb2`/`62f750de`/`82bb54bd`/`a191cb23`：工具面身份暴露（§8.3）+ Cookie UI 的 profile 可见性（§8.4 三条）             | 1    | Agent 知道自己以谁的身份在点；换号 UI 说得清写进哪个身份 |

> **Phase 2/3 的落地范围说明**：`5a70d797` 只落了**模型与存储**（`browser-workspace.ts` / `tab-control.ts`，各自带测试），**没有改任何调用点**——`active-guest.ts` 的三个 Map 和 `automation-host.ts` 的门链都还是原样。这样做是为了让新模型先被测试证明，再单独做一次替换；替换是行为变更，需要单独的真机验收。接线剩余工作：(a) `active-guest` 的 `guestIdsByBucket`/`bucketBySessionId` 改由 `BrowserWorkspaceRegistry` 承担；(b) `TabControl.validate()` 插进 `automation-host.ts:157` 与 `:211` 之间（§3.2）。

Phase 0 先做的理由：不收口，后面每改一次 partition 规则都要改两个地方，且两处会静默漂移。

**Phase 5 / 6 都只依赖 Phase 3**，彼此独立，可并行也可只做其一。但 §7.3 的两条准备工作（`TabControlStore` 接口 async 化、`BrowserSource.endpoint` 字段）必须在 **Phase 3 就位**——事后补会改到所有调用点。

### 5.1 Phase 边界上的验证

Phase 1 的验收**不能只看测试全绿**——`bucket → partition` 的改动是数据布局变化。需要实测：

1. 在 project 内建 Session A，登录某站点；
2. 新建 Session B，确认**无需重新登录**；
3. Session B 选 `isolated`，确认**要求登录**（隔离生效）；
4. 重启应用，确认 A/B 的登录态各自保持。

### 5.2 UI 要求

Phase 1 必须同时给出「当前 Profile」的可见性，否则共享登录态会变成一个不可解释的黑箱：

- 浏览器面板上显示当前 Profile 的 `label`；
- 能看到「这个 Profile 还被哪些 Session 使用」；
- 切换到 `isolated` 是一个显式动作，不是隐式推断。

## 6. 浏览器来源：选择流程必须可识别

前面几节默认「浏览器」就是 Electron 内置的 `<webview>` guest。实际上有四种来源，而**当前代码只认识第一种**：

| 来源                          | 现状                       | 登录态            |
| ----------------------------- | -------------------------- | ----------------- |
| 内置面板 guest（`<webview>`） | ✅ 唯一实现                | 由 partition 决定 |
| 内置后台无头 target           | ✅ `background-runtime.ts` | 同上              |
| 用户日常 Chrome（CDP attach） | ❌ 无任何代码              | 用户真实登录态    |
| 远端/服务端浏览器             | ❌ 无任何代码              | 服务端 profile    |

核实：全仓 grep `connectOverCDP` / `remoteDebugging` / `9222` / `externalBrowser` **零命中**；`chooseBrowser` / `selectBrowser` 之类的选择流程也不存在。

### 6.1 `BrowserSource` 必须是显式一等概念

「用哪个浏览器」现在是隐含的（`deps.activeGuest()` 给什么就是什么）。加入外部来源后，它必须成为可识别、可展示、可审计的字段：

```ts
type BrowserSource =
  | { kind: "builtin-panel"; profileId: string } // 面板 guest
  | { kind: "builtin-headless"; profileId: string } // 后台 target
  | { kind: "attached-chrome"; endpoint: string; browserId: string } // 用户的 Chrome
  | { kind: "remote"; endpoint: string; browserId: string }; // 服务端

interface BrowserWorkspace {
  id: string;
  source: BrowserSource; // ← 取代 profileId 单字段
  tabIds: string[];
}
```

`profileId` 只对内置两种有意义——**attach 到用户 Chrome 时登录态不归 CodeShell 管**，这正是要区分的原因。

### 6.2 识别必须贯穿全流程，不只在选择那一刻

Codex 的接管校验包含**浏览器 ID**，不只是 tabId。理由同 §3.2：外部浏览器会重启，`browserId` 变了而 endpoint 没变。因此：

- `TabControl` 增加 `browserId`，校验时四项齐验（browserId + tabId + origin + titleHash）；
- 每次动作前确认 `BrowserSource` 仍是取得控制权时的那个；
- **UI 必须显示当前来源**：用户需要一眼看出「Agent 正在操作我的日常 Chrome」还是「内置沙箱」。这是安全属性，不是体验优化——在用户真实登录态里点击的后果完全不同。

### 6.3 权限门必须按来源分级

§7 已核实：`loadBrowserAutomationPolicy()` 是全局的，不区分来源。加入 `attached-chrome` 后这不再够：

- 内置 partition 里点错，最坏是污染一个沙箱 Cookie jar；
- 用户日常 Chrome 里点错，可能是真实转账、真实发帖、真实删库。

因此 `attached-chrome` / `remote` 至少要求：默认更严的白名单、敏感动作**强制**审批（不可被 learned-ref 放行）、并在会话记录里标注来源。

## 7. 服务端部署

### 7.1 结论：`packages/cdp` 已经可以，`browser-driver` 不行

已核实：

- `packages/cdp/package.json` **不依赖 electron**（CODESHELL.md 称其为 "env-agnostic CDP browser action layer"）；
- `BrowserBridge` 接口定义在 **core**（`tool-system/browser-bridge.ts:168`），是纯 Promise 方法集，无 Electron 类型；
- 而 `browser-driver/` 下 4 个文件直接 `from "electron"`：`automation-host.ts`、`background-runtime.ts`、`active-guest.ts`、`electron-cdp.ts`。

也就是说**分层已经对了**：core 定接口、cdp 做动作、desktop 提供 Electron 实现。服务端要做的是**给 `BrowserBridge` 加第二个实现**，而不是改造上层。

### 7.2 本设计与服务端的关系

四层模型在服务端**语义不变，实现改绑**：

| 层                      | 桌面               | 服务端                      |
| ----------------------- | ------------------ | --------------------------- |
| `BrowserProfile`        | Electron partition | 容器内 user-data-dir        |
| `BrowserWorkspace`      | guest 集合         | 远端 browser context        |
| `SessionBrowserBinding` | 内存 Map           | 需持久化（跨进程/跨实例）   |
| `TabControl`            | 内存               | **必须持久化 + 跨实例互斥** |

**这是唯一一处服务端会推翻桌面假设的地方**：桌面的 `TabControl` 可以是内存对象，因为只有一个 main 进程；服务端多实例时，租约必须落在共享存储上，否则两个实例会同时授予同一个 tab 的写权，`mode: "control"` 的单写者保证就破了。

### 7.3 因此现在就要做的两件事（不是现在实现服务端）

1. **`TabControl` 的接口从一开始就设计成可持久化**：不要把它写成一个内存 `Map<string, TabControl>` 直接散在模块里，而是走一个 `TabControlStore` 接口（`acquire` / `validate` / `release`，全部 async）。桌面给内存实现，服务端给共享存储实现。**async 是关键**——事后从同步改异步要动所有调用点。
2. **`BrowserSource` 里的 `endpoint` 从一开始就存在**（§6.1）。桌面内置来源填不填都行，但字段在，服务端就不用改类型。

反过来，**现在不必做**的：不要为了服务端提前抽象 `browser-driver/` 里那 4 个 Electron 文件。它们本来就是「桌面实现」，服务端会有自己的实现文件，强行共用只会让两边都别扭。

## 8. 工具面与既有 Cookie 能力

前面几节讲的是 host 侧的数据模型。但 Agent 是通过**工具**看世界的——模型看不见 partition，只看得见工具签名。这一节把两者接起来。

### 8.1 现状核实

| 能力                                                   | 位置                                                                                                          | 现状        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------- |
| `browser_observe` / `browser_act` / `browser_navigate` | `core/tool-system/builtin/browser-tools.ts:50,214,380`                                                        | ✅ 存在     |
| `InjectCredential`（把已存 cookie 注回浏览器）         | `core/tool-system/context.ts:499`，执行在 `agent-bridge.ts:1005`                                              | ✅ 存在     |
| Cookie 抓取 / 恢复 / 租约                              | `desktop/main/credentials-service.ts`（`captureCookieJar` / `restoreCookiesToBrowser` / `createCookieLease`） | ✅ 存在     |
| 「从所有活动浏览器会话抓 cookie」                      | `index.ts:4317` → `captureAllCookiesFromSessions(listGuestSessions())`                                        | ✅ 存在     |
| **工具层能选/能看 profile**                            | 三个 browser 工具的入参                                                                                       | ❌ **没有** |

也就是说：**Cookie 的抓取与注入早就有了，缺的是"以哪个身份"这一层没有暴露到工具面。**

### 8.2 Phase 1 对既有 Cookie 能力的影响（已验证，无破坏）

- `InjectCredential` 经 `partitionForSession()` 解析目标，而该函数已走 Phase 1 的派生，所以**注入的 cookie 现在落到 project profile**，下一个 Session 直接可用——这正是想要的，比原来每次注入只对单个 Session 有效更好。
- `isBrowserPartition()` 接受新格式：`persist:browser:p:<project>` / `persist:browser:u:<name>` / `browser:qchat:q:<bucket>` 四种全部实测通过。
- `captureAllCookiesFromSessions` 枚举的是**活动 guest**（`listGuestSessions()`），不是磁盘 partition，因此不受 partition 改名影响；副作用是要去重的 jar 变少了。
- `credentials-service` / `cookie-credential-browser` 全部 24 个测试通过。

### 8.3 缺口一：工具看不见身份

三个 browser 工具都没有 profile 参数，模型无法知道、也无法选择自己在用谁的登录态。这在 §6 引入外部浏览器后会变成安全问题：模型不知道自己是在沙箱里点，还是在用户的真实 Chrome 里点。

最小改法（不新增工具）：

1. **`browser_observe` 的返回里带上身份**——`{ profileId, sourceKind, isUserBrowser }`。模型据此在敏感动作前自己收敛，也让 transcript 可审计。
2. **`browser_navigate` 增加可选 `profile` 入参**，语义等同 §3.1 的显式选择；不传就是 project 默认。用于"这一步用小号"的场景。
3. 不要给 `browser_act` 加 profile 参数——身份应在打开页面时确定，而不是每次点击都能换。

### 8.4 登录态回路：已经完整（更正）

**本节的初稿写错了**，说「只有注入、没有抓取另存」。实际逐条核实后，回路是**通的**：

| 环节                | 位置                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 人工登录            | `requestHumanTakeover`（`browser-bridge.ts:171`）                                                                  |
| 抓取当前分区 cookie | `captureCookieJar` / `captureAllCookies`（`credentials-service.ts:131,145`）                                       |
| IPC                 | `credentials:captureCookieJar` / `captureAllCookies` / `captureAllCookiesAllSessions`（`index.ts:4295,4311,4316`） |
| UI 抓取并另存为凭证 | `renderer/credentials/CookieTab.tsx:233,241` → `credentials.save(...)`（`:213`）                                   |
| 注回浏览器          | `restoreCookieToBrowser`（`CookieTab.tsx:279`）/ `InjectCredential`（Agent 侧）                                    |

所以 §3.1 `isolated` 的实用前提**已经满足**：用户可以在一个 profile 里登录小号、抓取另存，再注入到另一个 profile。

**Phase 1 之后出现的三条 profile 维度适配，已全部落地**（`82bb54bd` / `a191cb23`）：

1. `CookieTab` 的抓取按钮以 `activeBucket` 为目标，而 bucket 现在映射到 project profile。文案应从「当前会话的浏览器」改为「当前 profile」，否则用户会以为抓的是这个 Session 独有的。
2. 抓取/注入的 UI 里**看不到 profile 名**（§5.2 的可见性要求同样适用于这里）——用户需要知道自己正在从哪个身份抓、往哪个身份注。
3. 没有「把这条凭证注入到**指定** profile」的入口，只能注入当前会话所属的 profile。做 `isolated` 换号时这一步是必要的。

这三条都是 UI/文案层面的适配，没有新增底层能力：`browserProfileLabel()` 把 profile id 变成「作用域 + 名字」，抓取提示说明来源身份，换号确认说明写入身份。

### 8.5 外部浏览器的 Cookie 边界（§6 的前置约束）

一旦支持 attach 用户日常 Chrome：

- **禁止从 `attached-chrome` 批量抓 cookie**。那是用户全部的真实登录态，抓走等于导出他整个浏览器身份。按域名、按需、经审批可以；`captureAllCookies` 式的全量抓取必须对外部来源关闭。
- `InjectCredential` **不应**注入外部浏览器：往用户日常 Chrome 里写 cookie 会污染他的真实登录。注入只对内置 profile 开放。

这两条不是实现细节，是 §6.3 分级权限的具体内容。

## 9. 未决问题

1. **Profile 默认粒度**：project 级是否够？跨 project 复用同一登录（例如公司 SSO）需要 profile 可跨 project 引用，这会让 §4 的迁移映射更复杂。
2. **`shared-workspace` 是否要做**：目前没有明确用例；若不做，`role` 字段永久不需要。
3. **Quick Chat**：现在走独立的 `browser:qchat:` 前缀（非 persist）。它应该有自己的临时 Profile，还是共享 project Profile？涉及「临时会话是否该继承登录态」的产品判断。
4. **`markDeliverable` 的页面归属**：结果页释放控制后仍属于原 workspace，还是升格为「用户的页面」？影响下一轮清理是否会关掉它。
5. **attach 用户 Chrome 的落地方式**（§6）：走 `--remote-debugging-port` 还是浏览器扩展？端口方式要求用户以特殊参数重启 Chrome，扩展方式要过商店审核。Codex 用的是扩展。
6. **服务端的 Profile 归属**（§7）：容器内 user-data-dir 是每租户一个，还是每 project 一个？涉及多租户隔离，比桌面的 project 级默认严格得多。

## 10. 核实状态

2026-09-04 逐条核实，全部**引用行号与代码一致**（§6/§7 于 2026-09-05 补核）：

| 声称                                             | 位置                                                                                      | 结果                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| partition 由 bucket 派生（renderer）             | `appUtils.ts:111-114`                                                                     | ✅                                                              |
| 同一逻辑在 main 侧有第二份实现                   | `active-guest.ts:93-98`                                                                   | ✅ 前缀常量同值（`:13-14`）                                     |
| `bucket = projectId :: sessionId`                | `transcripts.ts:199-201`                                                                  | ✅ 分隔符是 `::`，已修正正文                                    |
| Workspace/Binding/Profile 已是三个 Map           | `active-guest.ts:72-76`                                                                   | ✅                                                              |
| `tabId` 是 `webContents.id`                      | `active-guest.ts:287`                                                                     | ✅                                                              |
| 既有 `leases` 是进程引用计数                     | `background-runtime.ts:169`（`leases += 1` + idleTimer，按 `ownerId` 计）                 | ✅ 与写权无关                                                   |
| 动作目标无归属校验                               | `automation-host.ts:157` `deps.activeGuest()`                                             | ✅ 比原先表述更强，见 §3.2                                      |
| 落盘 partition 现状                              | `~/Library/Application Support/code-shell/Partitions/`                                    | ✅ 72 目录 / 1.9 GB / 单 project 最多 13 份                     |
| 外部浏览器/选择流程零实现（§6）                  | grep `connectOverCDP`/`remoteDebugging`/`externalBrowser`/`chooseBrowser`/`selectBrowser` | ✅ 全仓 0 命中                                                  |
| `packages/cdp` 不依赖 electron（§7）             | `packages/cdp/package.json`                                                               | ✅ 依赖为空对象，可直接跑在服务端                               |
| `BrowserBridge` 在 core 且无 Electron 类型（§7） | `core/src/tool-system/browser-bridge.ts:168`                                              | ✅ 纯 Promise 方法集                                            |
| `browser-driver/` 绑定 Electron（§7）            | 4 个文件 `from "electron"`                                                                | ✅ automation-host/background-runtime/active-guest/electron-cdp |

补充核实的两项：

- **策略与 partition 无关**：`loadBrowserAutomationPolicy()`（`load-policy.ts:34`）不接受任何参数，读的是全局设置；`intercept.ts` 全部导出都是纯行解析，不碰 partition。**所以 §3.1 选 `isolated` 不会顺带改变域名白名单或审批行为**——隔离只影响 Cookie/站点数据，这是我们想要的正交性。
- **`markHandoff` / `markDeliverable` 在当前代码中不存在**（全仓无匹配）。§3.3 是本设计**新增**的语义，不是对既有实现的描述；读者不要去代码里找对应实现。

**仍未逐行核实**（不影响本文结论，只影响 Phase 3 实现细节）：

- `packages/cdp/src/driver.ts` 的 `CdpActionsDriver` 如何维护 snapshot 的 ref 映射。`automation-host.ts:209-211` 的注释说明 driver 是 per-guest 复用、ref 表要跨多次 worker 请求存活；若 `TabControl` 失效必须连带作废该 ref 表（否则失效后仍可能用旧 ref 点到新页面的元素），实现时需确认这个作废钩子挂在哪。
