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

必须二选一，并且写进设计而不是留给实现时临场决定：

- **方案 A（推荐）**：一次性迁移。每个 project 选「最近使用过的 session partition」提升为该 project 的 profile partition，其余保留在磁盘上不删。
- **方案 B**：保留旧 partition 作只读回退——新 Session 先读 profile，未命中时回退到旧 partition。实现更复杂，但零丢失风险。

无论哪种，都**不能删除**旧 partition 目录：读不懂的数据要隔离而不是清空。

## 5. 落地顺序

| 阶段  | 内容                                                                                       | 依赖 | 用户可感收益                |
| ----- | ------------------------------------------------------------------------------------------ | ---- | --------------------------- |
| **0** | 把 renderer / main 两份 `browserPartitionForBucket` 收口成一处                             | —    | 无（纯重构，零行为变化）    |
| **1** | `BrowserProfile`：partition 由 `profileId` 派生；默认 project 级 `shared-auth`；含 §4 迁移 | 0    | **新 Session 不再丢登录态** |
| **2** | `BrowserWorkspace` + `SessionBrowserBinding`（不含 `role`）                                | 1    | 页面归属与 Session 解耦     |
| **3** | 稳定 `tabId` + `TabControl` 排他写 + §3.2 校验 + §3.3 四种处置                             | 2    | 不再误操作已导航的页面      |
| **4** | `claim-tab` 显式移交                                                                       | 3    | 跨 Session 交接具体页面     |

Phase 0 先做的理由：不收口，后面每改一次 partition 规则都要改两个地方，且两处会静默漂移。

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

## 6. 未决问题

1. **Profile 默认粒度**：project 级是否够？跨 project 复用同一登录（例如公司 SSO）需要 profile 可跨 project 引用，这会让 §4 的迁移映射更复杂。
2. **`shared-workspace` 是否要做**：目前没有明确用例；若不做，`role` 字段永久不需要。
3. **Quick Chat**：现在走独立的 `browser:qchat:` 前缀（非 persist）。它应该有自己的临时 Profile，还是共享 project Profile？涉及「临时会话是否该继承登录态」的产品判断。
4. **`markDeliverable` 的页面归属**：结果页释放控制后仍属于原 workspace，还是升格为「用户的页面」？影响下一轮清理是否会关掉它。

## 7. 核实状态

2026-09-04 逐条核实，全部**引用行号与代码一致**：

| 声称                                   | 位置                                                                      | 结果                                        |
| -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| partition 由 bucket 派生（renderer）   | `appUtils.ts:111-114`                                                     | ✅                                          |
| 同一逻辑在 main 侧有第二份实现         | `active-guest.ts:93-98`                                                   | ✅ 前缀常量同值（`:13-14`）                 |
| `bucket = projectId :: sessionId`      | `transcripts.ts:199-201`                                                  | ✅ 分隔符是 `::`，已修正正文                |
| Workspace/Binding/Profile 已是三个 Map | `active-guest.ts:72-76`                                                   | ✅                                          |
| `tabId` 是 `webContents.id`            | `active-guest.ts:287`                                                     | ✅                                          |
| 既有 `leases` 是进程引用计数           | `background-runtime.ts:169`（`leases += 1` + idleTimer，按 `ownerId` 计） | ✅ 与写权无关                               |
| 动作目标无归属校验                     | `automation-host.ts:157` `deps.activeGuest()`                             | ✅ 比原先表述更强，见 §3.2                  |
| 落盘 partition 现状                    | `~/Library/Application Support/code-shell/Partitions/`                    | ✅ 72 目录 / 1.9 GB / 单 project 最多 13 份 |

补充核实的两项：

- **策略与 partition 无关**：`loadBrowserAutomationPolicy()`（`load-policy.ts:34`）不接受任何参数，读的是全局设置；`intercept.ts` 全部导出都是纯行解析，不碰 partition。**所以 §3.1 选 `isolated` 不会顺带改变域名白名单或审批行为**——隔离只影响 Cookie/站点数据，这是我们想要的正交性。
- **`markHandoff` / `markDeliverable` 在当前代码中不存在**（全仓无匹配）。§3.3 是本设计**新增**的语义，不是对既有实现的描述；读者不要去代码里找对应实现。

**仍未逐行核实**（不影响本文结论，只影响 Phase 3 实现细节）：

- `packages/cdp/src/driver.ts` 的 `CdpActionsDriver` 如何维护 snapshot 的 ref 映射。`automation-host.ts:209-211` 的注释说明 driver 是 per-guest 复用、ref 表要跨多次 worker 请求存活；若 `TabControl` 失效必须连带作废该 ref 表（否则失效后仍可能用旧 ref 点到新页面的元素），实现时需确认这个作废钩子挂在哪。
