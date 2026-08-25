# 安全加固遗留问题 — 已完成（2026-08-25）

> 来源：2026-08-12/08-13 两轮全仓安全加固（191 files, +12k）提交前的独立复查。
> 2026-08-25 复核并完成余下 8 项：统一 manifest 安全读取、拒绝点号名称假成功、
> undo/redo 会话与窗口校验、撤销设备防复活、browser anchor 生命周期清理、
> DeliveryQueue 逐记录清理重试与锁外附件下载、user scope fail-closed。
> 本文件移入 archive，以下保留修复前的问题与验收依据。

## 共同根因

前两轮给读取路径加了严格校验（bounded / no-follow / schema），但严格读取端的
失败模式是**破坏性**而非**隔离性**——旧写入方产生的数据遇到新校验会被
「丢弃」或「整体抛错」，而不是被隔离。已修的凭据库和 marketplace 注册表是
这个模式的两个实例。原 P1 的主题与 Panel App 注册表问题已在
0.8.10 发布前修复并补上回归测试。

参考正确形态：`packages/core/src/plugins/installedPlugins.ts` 的 `registryOf()`
——坏条目 `continue` 跳过，不影响其余条目，也不阻塞写入。

---

## P2 — 加固不一致（修复前记录）

### 1. `pluginContent.ts` 是唯一仍在裸读 manifest 的路径

- 位置：`packages/core/src/plugins/pluginContent.ts:144`
- 现状：`JSON.parse(readFileSync(join(installPath, CANONICAL_PLUGIN_MANIFEST_FILE)))`
  没有 lstat / 大小上限 / `O_NOFOLLOW`，而同一文件同一 schema 的兄弟路径
  `pluginCatalog.ts:65-86` 走了完整加固读取。
- 影响范围（已核实）：仅 inspect/展示。实例化走的是加固后的 `pluginCatalog`
  并会重新校验 `revision`（`pluginAutomationTemplates.ts:35-46`），所以**软链
  manifest 无法真正被调度执行**；但运维人员在 `InstallCapability` 的 inspect
  输出里看到的是未加固数据。
- 建议：复用 `pluginCatalog` 的读取函数，删掉这条独立路径。

### 2. 带点号的插件/Skill 名会静默 no-op 却报告成功

- 位置：`packages/core/src/tool-system/builtin/install-capability.ts:556-560`、`791-797`
- 现状：`SAFE_PLUGIN_SEGMENT_RE`(`:34`)/`SAFE_SKILL_NAME_RE`(`:35`) 允许 `.`，
  名字被插进点分设置键 `capabilityOverrides.plugins.${plugin}`；
  `setDottedSetting`（`settings/manager.ts:137-148`）按 `.` 拆成嵌套对象
  `{plugins:{a:{b:"off"}}}`，而读取端 `capability-control/overlay.ts:22-26`
  期望扁平 `Record<name,"on"|"off">`，非法结构被归一化为 inherit。
- 结果：`disable plugin a.b` 返回「Disabled ...」但插件依然启用。
- 建议：禁止名字中的 `.`，或改用非点分的键写入方式。

### 3. 三个 `files:*Turn` IPC handler 未接入统一会话校验

- 位置：`packages/desktop/src/main/index.ts:6222`、`:6228`、`:6234`
- 现状：`files:turnUndoState` / `files:undoTurn` / `files:redoTurn` 仍用旧的
  `typeof sessionId !== "string"` 检查并丢弃 `_e`（无 sender 绑定），而同文件
  其余会话 handler 已统一升级为 `assertDesktopSessionId`（对比 `:6518`、`:6601`）。
- 下游 `file-history-service.ts:20` 的 `SAFE_ID = /^[A-Za-z0-9_.-]+$/` **接受 `".."`**，
  这正是 `assertDesktopSessionId`(`:5568-5580`) 明确拒绝的值。
- 当前非可利用（`sessionsRoot()/..` 下没有 index.json，`loadFromDir` 返回空历史），
  但 `undoTurn`/`redoTurn` 是**对工作区的破坏性写入**，是本轮中校验最弱的一组。
- 建议：接入 `assertDesktopSessionId` + sender 绑定，并收紧 `SAFE_ID` 排除 `..`。

## P3 — 健壮性 / 资源（修复前记录）

### 4. 已撤销设备可通过再次配对复活

- 位置：`packages/server/src/mobile-remote/trusted-device-store.ts:53-63`
- 现状：`addDevice` 只在 `!d.revokedAt` 时复用行，撤销行留在文件里，**相同
  secretHash** 会走到 `devices.push(...)` 新建一个未撤销的行（新 id、同密钥）。
- 触发条件：需机主主动发起配对（一次性 token），因此不是认证绕过；但
  「撤销」并非永久，且撤销行永不回收，逼近 `MAX_TRUSTED_DEVICE_ROWS`(4096) 后
  合法配对会被拒。
- 附带：同函数 `:54` 用 `===` 比较 secretHash，而兄弟路径 `authenticate`(`:89`)
  刻意用了 `timingSafeEqual`（注释标注 leak Y-3），两者不一致。
- 建议：命中已撤销行时显式拒绝（或走审批复活），并清理撤销行；比较统一走
  `secretHashEquals`。

### 5. `browserAnchorsByParent` 随窗口开关无界增长

- 位置：`packages/desktop/src/main/index.ts:5841`（写入）、`:2615-2620`（唯一删除）
- 现状：删除只注册在 `createBrowserPopout` 内，主窗口自身的 `closed`
  处理（`:1346-1353`）不清理该 map。从未点过 popout 的窗口，其 anchor 快照
  （上限 256 条 / 1MB）会驻留到进程结束，每次开关窗口累积一份。
- 建议：在 `mainWindows.delete(win)`(`:1348`) 处一并 delete，可顺带移除
  `browserAnchorParentCleanupRegistered`(`:2591`)。

### 6. DeliveryQueue 全局单次 persist 重试会漏掉其他记录的 spool 清理

- 位置：`packages/chat/src/delivery-queue.ts:279`
- 现状：`schedulePersistRetry` 用 `if (this.persistRetryTimer) return` 保证全局
  只有一个待重试，且 cleanup 闭包按记录捕获。若记录 X 失败已排程、记录 Y 随后
  失败，则 Y 的 `discardSpool` 永不重试；Y 此时已从内存 `pending` 摘除（`:252-253`），
  只能等下次 `start()` 的 `sweepOrphanedSpool`(`:116`) 回收。
- 非消息丢失（终态文件整体写入，恢复语义仍是 at-least-once），但长驻网关在
  一次瞬时磁盘错误后 spool 目录会持续增长。
- 建议：改为按记录排队重试，而非单一全局定时器。

### 7. 附件下载在全局互斥锁内进行

- 位置：`packages/chat/src/delivery-queue.ts:160`（`spoolAttachments` 在 `withMutation` 内）、`:322`
- 现状：`attachment.load()` 是无界网络拉取，却持有与 `process()` 记录终态
  （`:242`）相同的锁。一个慢附件会阻塞其他 enqueue 与终态持久化，
  `maxConcurrent` 实际达不到表面语义。
- 建议：把下载移到锁外，只在写入状态时短暂持锁。

### 8. `install-capability.ts` 的 user scope 守卫是 fail-open 形态

- 位置：`packages/core/src/tool-system/builtin/install-capability.ts`（`ctx?.settingsScope && ctx.settingsScope !== "full"`）
- 现状：`settingsScope` 为 `undefined` 时条件短路，走向放行。当前经 `engine.ts:2664`
  与 `subagent-spawner.ts:346` 都会填默认 `"project"`，正常引擎路径不可达，
  但守卫形态应改为 fail-closed（缺省即拒绝）。

---

## 验证建议（补 CI 矩阵）

上一轮报告已提过、本轮仍未落地：为持久化路径建立统一的故障矩阵测试
——oversized / symlink / directory-as-file / corrupt JSON / 并发多进程 /
写入失败 / 重启恢复。本轮 6 个缺陷里有 3 个（凭据、注册表、redo 顺序）
就是因为测试只覆盖新不变量、不覆盖**旧数据**与**多步序列**而漏网。
