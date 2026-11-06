# 内置浏览器使用问题：修复方案

> 状态：已实现（分支 `claude/desktop/browser-closed-tombstone-20261105`），待 CI、合并与安装版验收
> 落地记录见 §8
> 日期：2026-11-05
> 基线：`main` @ `10b26d958`；已安装版本 0.9.52
> 事故样本：Session `s-mw384o1p-46df4c41`（B 站登录态注入 + 浏览器操作）
> 前置设计：[browser-profile-workspace-lease-design.md](browser-profile-workspace-lease-design.md)（Profile / Workspace / TabControl 分层，本文不重复）

## 0. 一句话结论

分层设计（Profile 决定 Cookie、Workspace 决定页面、TabControl 决定写权）本身没问题，出问题的是**落地时三处没有对齐**：面板仍按 Session 算分区；任务窗口关闭后的状态机互相卡死；注入只报“写了几条”而不核验。本方案按“先把已写好的修复合并发版，再补核验与防回归”分四个 PR 推进。

## 1. 事故还原（日志与磁盘证据）

### 1.1 Cookie 写进了另一份存储

`~/Library/Application Support/code-shell/Partitions/` 中同一项目同时存在：

```text
browser%3Ap%3Aa01c3580-…                               ← 项目 profile（注入写到这里）
browser%3Aa01c3580-…%3A%3As-mw384o1p-46df4c41          ← 会话分区（面板读的是这里）
```

链路：

1. `renderer/panels/PanelRegistry.ts:164`（main 上）仍是 `` `persist:browser:${bucket…}` ``——Session 级公式。它来自 2026-07-10 的 `0d16f9f9d`（面板注册表收口），早于 Phase 1；Phase 1 改分区公式时漏了这一处，§10 核实表也没覆盖到它。
2. 面板 guest 注册时 `active-guest.ts` 的 `assertExpectedPartition` 期望项目分区，于是 `partition mismatch`，guest 注册失败。
3. `InjectCredential`（`agent-bridge.ts:1606-1611`）找不到活动 guest，退回 `partitionForSession()` → 项目分区，写入 46 条，返回 `{ ok: true, count: 46 }`。
4. 面板仍读会话分区，刷新多少次都是未登录。模型据 `ok:true` 告诉用户“注入成功”。

主进程不会拦截这种漂移：`index.ts:1445` 的 `will-attach-webview` 只校验 `persist:browser` 前缀，任何 Session 级旧格式都会被放行。

### 1.2 任务窗口关闭后的死循环

engine 日志中，该 Session 的浏览器调用序列（节选，每行一次模型调用）：

```text
08:21:24 request_takeover        ok          ← 弹出任务窗口
08:21:53 resume_control          TARGET_CLOSED（用户已关窗）
08:21:56 browser_navigate        Browser control is paused
08:22:02 resume_control          TARGET_CLOSED
08:22:34 browser_observe         Browser control is paused
08:24:28 InjectCredential        ok
08:24:34 browser_navigate        Browser control is paused
08:25:06 browser_navigate        Browser control is paused
08:25:12 request_takeover        TARGET_CLOSED
```

关窗后 `controlPaused` 仍为 true：`resume` 报“已关闭”，`navigate` 报“已暂停”，两条错误提示互相指向对方。另外：

- 首次 `navigate` 的真实异常被统一替换成“页面已跳转”；
- 任务窗口在工具返回里被标成 `builtin-panel`，模型以为自己在操作面板；
- 即使解开死锁，`navigate` 走 `recover=true`，用户关窗后仍可被模型静默重开（只有提示词在拦）。

## 2. 目标行为

| #   | 要求                                                                    | 验收口径                                                                |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| G1  | 同一项目、同一 profile：面板、任务窗口、注入三者用**同一个 Cookie jar** | 三者 `session.storagePath` 相同；磁盘不再新增 `::s-` 目录               |
| G2  | Agent 知道自己在操作哪个页面；“操作面板”必须是用户授权的那个确切标签页  | 每次 observe 带 `sourceKind`；不会因“面板”二字另开任务窗口              |
| G3  | 注入结果可核验                                                          | 返回写入目标、成功/跳过/过期条数，并回读确认；“写入 N 条”不等于“已登录” |
| G4  | 用户关窗 = 停止                                                         | 本轮内任何浏览器调用都不能重开；新一轮用户请求才可重开                  |
| G5  | 安装版实测通过                                                          | §6 的两条真机流程                                                       |

## 3. 已完成的修复（未合并、未发版）

| 分支                                                         | 提交        | 内容                                                                                                                                        | 对应  |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `codex/desktop/browser-profile-parity-20261105`              | `6734e0194` | 面板改用 `browserPartitionForBucket(bucket)`，与运行时一致                                                                                  | G1    |
| `codex/desktop/browser-profile-recovery-20261105`            | `d1dce4668` | 关窗解除暂停（修死锁）；导航错误不再被掩盖；面板分区对齐                                                                                    | G1 G4 |
| 同上                                                         | `a462dea2c` | 新增 `builtin-task-window` 身份；接管/关闭提示改写；`list_tabs` 说明范围                                                                    | G2    |
| `claude/desktop/browser-closed-tombstone-20261105`（未提交） | —           | **原生阻断**：用户关窗后本轮所有浏览器调用（含 navigate / takeover）被宿主拒绝；下一次 `agent/run` 才解除；关闭记录不随 continuity TTL 失效 | G4    |

G4 的实现要点（`browser-driver/background-runtime.ts`）：

- `onClosed` 记 `recovery="closed"`、`reopenable=false`；`ensureTarget` 对未解除的用户关闭**无视 `recover`** 直接拒绝。idle/capacity 回收仍可 navigate 重开。
- 解除入口只有 `beginRun(ownerId)`，由 `agent-bridge` 在看到 `agent/run` 时调用（`dispatch.ts` 的 `beginBrowserRunForStartedRun`）。模型在本轮内没有任何参数能触达它；重启后本来就是新一轮，语义自洽。
- `pruneContinuity` 跳过未解除的关闭记录，只受条数上限约束。

> 注意：parity 与 recovery 两个分支都改了 `PanelRegistry.ts` / `WebviewHost.tsx` / `BrowserPanel.tsx`，合并时必有冲突，需要合成一个分支后重跑测试，不能分别合入。

## 4. 待做的改动

### 4.1 分区只能由主进程决定（防 1.1 再发生）

问题根源是“分区公式在 renderer 有 7 个调用点、主进程照单全收”。改法：

1. **主进程收紧准入**：`will-attach-webview` 对 `browser` 类 webview 只接受 profile 形态的分区（`persist:browser:p:*` / `persist:browser:u:*` / `browser:qchat:q:*`）。旧 Session 形态（含 `::`）拒绝挂载并打日志，不再静默放行。新增 `isProfilePartition()`，放在 `shared/browser-profile.ts`。
2. **静态守卫测试**：扫描 `packages/desktop/src/{renderer,main}`，除 `shared/browser-partition.ts` / `shared/browser-profile.ts` 外，禁止出现 `` `persist:browser:${ `` 这类拼接。0d16f9f9d 那种回归会在 CI 上直接失败。
3. **对齐测试**：同一个 bucket，`PanelRegistry` / `App.tsx` / `useRunController`（×4）/ `useHostSubscriptions` / `agent-run-browser-registration` 算出的分区必须完全相同（parity 分支已有一部分，补齐到全部调用点）。
4. **已知潜在缺陷（本次不改，记录）**：`active-guest.ts:386` 的 `assertExpectedPartition` 只按项目默认值校验，没考虑显式 profile（`u:<name>`）。现在没有调用点传显式 profile，所以不触发；将来接 `isolated` 时必须先改这里。

旧的会话分区目录（本机 105 个、2.8 GB）按 2026-09-06 的决定不迁移，本方案也不删除。

### 4.2 注入结果可核验（G3）

现状：`credentials-service.ts:173-208` 的 `restoreCookiesToBrowser` 对 `cookies.set` 失败直接 `catch {}` 跳过；已过期的 Cookie 会 `set` 成功、随后被 Chromium 丢弃，却仍计入 `count`。工具层只回传 `count`。

改法：

1. `restoreCookiesToBrowser` 返回结构化结果：

   ```ts
   interface CookieRestoreResult {
     partition: string; // 实际写入的 jar
     target: "panel-tab" | "partition-only";
     attempted: number;
     written: number;
     expired: number; // 写之前就按 expirationDate 过滤掉
     failed: { name: string; domain: string; reason: string }[]; // 截断到前 10 条
     verified: number; // 写完后 cookies.get 回读，按 name+domain+path 命中的条数
   }
   ```

   `count` 保留为 `written` 的别名，兼容现有调用方（`CookieTab`、auto-refresh 的 `result.count === jar.length` 判断）。

2. **回读核验**：写完后对涉及的域名执行 `sess.cookies.get({ domain })`，按 name+domain+path 计 `verified`。`verified < written` 视为部分失败，`ok` 仍为 true，但结果里明确列出差额。
3. **刷新范围**：现在只给发起 Session 的 bucket 发 `browser:reload`。Profile 已按项目共享，改为刷新**同一 partition 下所有已挂载的面板 guest**。任务窗口如果存活，结果里注明“任务窗口需 navigate 后生效”，不偷偷刷新它（避免打断用户接管中的页面）。
4. **工具返回文案**（`InjectCredential`）：

   ```text
   已写入 profile p:<project>（面板标签页 #12 已刷新）：写入 44 / 46，回读确认 44，已过期 2。
   这只表示 Cookie 已就位；是否已登录，需要 browser_observe 页面上的登录信号后再下结论。
   ```

5. 提示词（`browser.md`）补一句：注入后必须观察页面再判断登录状态，不能把写入条数当作登录结果。

### 4.3 明确操作目标（G2）

现状：面板标签页只能靠用户点工具栏盾牌授权（`BuiltInTabClaimBackend.grant`），模型没有发起授权请求的途径。用户说“操作面板里那个页面”时，模型只能自己另开任务窗口，或者让用户去找盾牌。

改法（新增一个动作，不新增工具）：

1. `browser_act{action:"request_panel_access"}`：在当前 Session 的**活动面板标签页**上方弹出一条确认条“Agent 请求操作此标签页 [允许] [拒绝]”。用户点“允许”就是一次用户手势，直接走现有 `grant()`；拒绝或超时（60 s）则返回 `NEEDS_HUMAN`，本轮不再重复弹出。
2. 授权后，`browser_observe` 的身份是 `builtin-panel` + 标签页标题/URL；未授权时，`list_tabs` 在末尾附一行“面板有 N 个标签页未授权；如用户要求操作面板，使用 request_panel_access”。不暴露这些标签页的 URL，避免越权读取。
3. 面板标签页被用户关闭：沿用 `revoked` 语义（`built-in-handoff.ts` 已实现，不会回落到任务窗口），与 G4 的任务窗口关闭保持一致：本轮停止。
4. Cookie 注入与页面授权**完全无关**：注入只看 profile，无需盾牌；文档和提示词都写明这一点（这是本次事故里被混淆的点）。

### 4.4 G4 的补充

1. **测试已覆盖**：关窗后连续 navigate + takeover 3 次不开窗；新一轮才可重开；evict + 重新 acquire、continuity 过期后仍阻断；新一轮里再关窗再阻断；`agent/run` 触发解除、`agent/cancel` 不触发。
2. **待真机确认**：⌘W、红色关闭按钮都触发 `closed`；退出应用、空闲回收、容量回收**不**记为用户关闭（代码上 `disposeEntry` 先删 entry 再 `host.close()`，`onClosed` 的 `entry.target?.host === host` 分支对已删除 entry 无影响，但需真机验证）。
3. **解除信号的边界**：任何 `agent/run` 都会解除，包括移动端排队消息、Mimi 派发。按“新请求 = 用户新意图”接受；如果后续发现自动续跑类 run 也走 `agent/run` 并导致重开，再把条件收窄为“带用户消息的 run”。

## 5. 交付顺序

| PR       | 内容                                                                                                    | 依赖 | 用户可感收益                               |
| -------- | ------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------ |
| **PR-1** | 合并 parity + recovery + tombstone 三个分支为一个；解决冲突；跑全量测试 + `smoke-background-browser.ts` | —    | 面板能看到注入的登录态；关窗后不再反复尝试 |
| **PR-2** | §4.1 主进程准入 + 静态守卫 + 对齐测试                                                                   | PR-1 | 防止同类回归                               |
| **PR-3** | §4.2 注入核验与刷新范围                                                                                 | PR-1 | “注入成功”可信                             |
| **PR-4** | §4.3 `request_panel_access`                                                                             | PR-1 | 用户说“操作面板”能直接生效                 |

PR-1 单独发一个补丁版本即可解决用户当前遇到的问题；PR-2/3 可并行；PR-4 涉及 UI，单独评审。

## 6. 验收

### 6.1 自动化

- 单测：§4.1 对齐与静态守卫、§4.2 结构化结果（过期 / 失败 / 回读差额三种）、§4.3 授权确认条的允许 / 拒绝 / 超时、G4 现有用例。
- Electron smoke（`scripts/smoke-background-browser.ts` 扩展）：
  1. 注入 → 断言面板 guest 的 `session.cookies.get` 能读到 → 刷新后页面带登录 Cookie；
  2. `request_takeover` → 程序关闭任务窗口 → 连续 3 次 navigate → 窗口数不变 → 模拟 `agent/run` → navigate 成功。
- 先修好 smoke 里已知失败的快捷键检查，否则 smoke 结果不能计入门禁。

### 6.2 安装版真机（必须在打包安装后做，不能用 dev 构建代替）

1. 新建 Session → `InjectCredential` 注入 B 站凭证 → 面板刷新显示已登录 → 再新建一个 Session，打开面板同样已登录（G1）。
2. 让 Agent 打开需要登录的页面 → 弹出任务窗口 → 用户 ⌘W 关闭 → Agent 本轮停止并告知用户；同一轮内不再弹窗 → 用户发“再打开” → 正常重开（G4）。
3. 用户说“操作面板里这个页面” → 出现确认条 → 允许 → Agent 在面板标签页上操作（G2，PR-4 之后）。
4. 磁盘上不再新增 `::s-` 形态的 partition 目录（G1）。

## 7. 未决问题

1. `request_panel_access` 的确认条放在面板内，还是复用聊天区审批卡片？放面板内更贴近“这个标签页”，但面板折叠时用户看不到；倾向“面板内 + 聊天区一行提示”。
2. 注入核验是否要内置“登录信号”检测（例如按站点配置检查某个 Cookie 或页面元素）？本方案不做，交给模型 observe；若某些站点频繁误判再加。
3. 旧会话分区（2.8 GB）是否提供一次性清理入口？不影响功能，可放到设置页的“存储”里。

## 8. 落地记录（2026-11-05）

基于 `origin/main` @ `d0a165b2e`（parity 已由 #295 合入）一条分支依次提交：

| 提交                    | 对应      | 说明                                                                                                                                                                  |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9173ea30f` `a334aae42` | PR-1      | recovery 两个提交 rebase；与 #295 的冲突仅在注释，保留 main                                                                                                           |
| `6051757f3`             | PR-1 / G4 | 用户关窗后本轮宿主强制阻断；`agent/run` 解除                                                                                                                          |
| `5d9fc03c5`             | PR-2      | `will-attach-webview` 只接受 profile 分区（`isProfileBrowserPartition`）；静态守卫已用旧公式验证会报错                                                                |
| `e4a009771`             | PR-3      | `CookieRestoreResult`（written / expired / failed / verified）；`InjectCredential` 返回 partition、target、reloadedPanels 与“不等于已登录”说明；同 jar 的面板全部刷新 |
| `c8e29d980`             | PR-4      | `browser_act{action:"request_panel_access"}` + 面板确认条；拒绝或 60 s 未答本轮不再弹；子任务不可申请                                                                 |
| `e016b8306`             | §6.1      | 修复 smoke 的快捷键失败：Puppeteer 驱动在 macOS 下 ⌘A/C/X/V/Z 不触发编辑命令（真实缺陷，不是测试环境问题）；smoke 增加真实窗口关闭流程                                |

与方案的差异：

- §7-1 确认条只放在面板内，未做聊天区提示。面板未挂载时直接返回“请先在面板打开页面”，不弹任何东西。
- §4.1-3 的“对齐测试”由静态守卫替代：所有调用点都只能走 `browserPartitionForBucket`，守卫保证没有第二个公式。
- §6.1 的“注入 → 面板读到 Cookie”只有单元测试（结构化结果 + 回读），没有进 Electron smoke；留给 §6.2 安装版验收。
