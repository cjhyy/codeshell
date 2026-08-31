# CodeShell 优化路线技术方案：通知闭环 → 可靠性债务 → 任务中心（2026-08-31）

> **For agentic workers:** 阶段一 / 阶段二的每个批次（N1–N3、R1–R4）都是可独立执行的
> 最小批次，执行时使用 superpowers:subagent-driven-development 或
> superpowers:executing-plans，沿用 2026-08-30 优化轮已验证的流程：
> 隔离 worktree → RED 先行 → 最小实现 → 独立复审 → 全仓门禁 → 单条 Conventional Commit。
> 阶段三及以后是设计草案，**动工前必须先各自过 brainstorming + 独立 PRD/计划**。

**Goal:** 让后台任务（Mimi 委派、后台 agent、自动化）的完成结果**必达**：持久写回原聊天、
重启可补投、去重不重复；随后收口四项已确认的可靠性债务；再在此地基上统一本地任务中心。

**Architecture:** 不新建通知系统。现有架构已有三条设计正确的"必达"范式 ——
long-task ledger 的 `closureRecordedAt` 水位线、IM Gateway 的持久 outbox + 连续 ack、
语义 `deliveryKey` 跨重启去重 —— 本方案的全部工作是**把游离在这三个范式之外的链路收编进来**，
并用仓库既有的 `file-mutex` 原语（`writeFileAtomic` / `acquireLockOnPath` / `mutateJsonFile`）
补齐持久化。

**Tech Stack:** Bun + TypeScript monorepo；Electron desktop main（packages/desktop）；
core Engine/protocol（packages/core）；headless server（packages/server）。

**执行状态（2026-09-01）：** 阶段一 N1–N3、阶段二 R1–R4 已实现并分别提交；
R4 在移除已废弃 notifier 测试后由 `119` 继续收紧到 `118`。阶段三/四已完成独立 brainstorming、
PRD 与实施计划：

- `docs/superpowers/specs/2026-09-01-local-task-center-design.md`
- `docs/superpowers/plans/2026-09-01-local-task-center.md`
- `docs/superpowers/specs/2026-09-01-github-pr-workflow-design.md`
- `docs/superpowers/plans/2026-09-01-github-pr-workflow.md`

**开工顺序（已确认）：** 通知闭环(P0) → 可靠性债务(P0) → 本地任务中心(P1) →
PR 工作流(P1) → 原生产物 → Computer Use → 连接器深化 → 平台出口 → IDE/团队。
云端与沙箱明确排除。

---

## 1. 阶段一：后台完成通知闭环（P0）

### 1.1 现状：链路全景（2026-08-31 实勘）

完成通知目前由 **11 条链路**拼接而成，收敛点有三个：

| 收敛点 | 位置 | 覆盖 |
| --- | --- | --- |
| `onTaskClosed` 回调 | `packages/desktop/src/main/index.ts:1597`（coordinator 侧 `packages/desktop/src/main/pet/pet-long-task-coordinator.ts:1026` `notifyClosed`） | Mimi 委派的 long task：写工作记忆 → 写回 Mimi 聊天 → 广播 renderer → 推 IM Gateway → 系统通知，共 5 个副作用 |
| `agentNotificationBus` | `packages/core/src/tool-system/builtin/agent-notifications.ts:403` | 后台 agent / 后台 shell / 视频轮询完成：唤醒模型（`packages/core/src/protocol/background-result-wakeup.ts:25`）、桌面通知（`index.ts:3244`）、renderer toast、external runtime 唤醒 |
| `publishGatewayControlEvent` | `packages/desktop/src/main/index.ts:897` | 所有 IM 推送：持久 outbox（`im-gateway-control-server.ts:291`，先落盘再可见）+ 连续 ack + `deliveryKey` 去重 |

**已经可靠的部分（不要重做）：**

- long task 终态补投：启动时扫描 `isTerminal && !closureRecordedAt` 重新投递
  （`pet-long-task-coordinator.ts:256`），`background_wait` 误关有专门恢复事务（`:244`）。
- Gateway outbox 重启重放 + 语义 `deliveryKey` 跨重启去重
  （`packages/desktop/src/main/notification-relay.ts:118`）。
- closure 决策幂等（`pet-dispatch-service.ts:723`，key 持久在 ledger 内）。

### 1.2 缺口清单（按用户五条要求对照）

| # | 缺口 | 位置 | 违反的要求 |
| --- | --- | --- | --- |
| G1 | **`NotificationQueue` 纯内存**：后台 agent/shell/视频的完成结果，崩溃或退出即永久丢失，重启后模型不会被唤醒、聊天里永远没有这条结果。这是最高频链路，却是唯一零持久化的 | `agent-notifications.ts:320` `private buckets = new Map()` | 持久写回原聊天；重启补投 |
| G2 | **系统桌面通知 4 处独立实现、策略不一致、零去重**：`index.ts:1718`/`:3244`/`:3222`/`:3192` + renderer 链路各自 `new Notification()`；有的判焦点有的不判；core 里还有一套完整实现的三平台 notifier 是死代码（`packages/core/src/services/notifier.ts`，全仓零调用） | desktop main 多处 | 系统通知只作辅助；重复事件不重复发 |
| G3 | **`onTaskClosed` 五个副作用无事务性**：A1（工作记忆蒸馏）失败会 throw，导致 `closure-recorded` 水位线不落盘，下次启动整个 closure 重跑 —— IM 推送和聊天写回有去重兜底，但**系统通知会重复弹** | `index.ts:1598`–`1725` | 重复事件不重复发 |
| G4 | **pet report 去重是内存 Set + 1000 条 FIFO 驱逐**：重启后同一 `reportId` 会**再注入一次 Mimi turn**（Gateway 侧被 outbox 兜住，模型侧不会）；且 `index.ts:2062` 用 `latestForSession` 而非活跃性过滤，可能把 report 关联到已终结的旧 task 拿到失效的路由目标 | `index.ts:2054`、`:2135` | 重复事件不重复发 |
| G5 | **transcript 的 assistant 直写无幂等**：`pet-host-action-completion.ts:93` 的 `hasClientMessageId` 只保护 user 消息，上游 `completePetHostActionReceipt` 又是 fire-and-forget，重试会追加重复 assistant 消息 | `pet-host-action-completion.ts:87`–`100` | 重复事件不重复发 |
| G6 | Goal 模式下进程在完成瞬间重启 → projection 只能证明 "session completed"，task 被保守标为 `interrupted` | `pet-long-task-coordinator.ts:699`–`707` | （有意的保守设计，**本阶段不改**，由阶段三任务中心提供 verify/retry 入口） |

### 1.3 设计决策

**D1 — `NotificationQueue` 落盘（补 G1，本阶段核心）**

- 持久化粒度：**每 session 一个文件** `<sessionDir>/pending-notifications.json`，
  与 session 的所有权对齐（谁跑这个 session 谁写），避免一个全局文件被多进程争抢。
- 只持久 `kind === "result"` 的 envelope（progress/direction 本就是瞬态）。
- 写入用 `writeFileAtomic`（`packages/core/src/utils/file-mutex.ts:118`），
  锁用 **`acquireLockOnPath`**（`file-mutex.ts:91`）而不是 `acquireFileLock` ——
  后者锁整个目录，session 目录下还有 transcript 等并列资源，目录锁会造成无关阻塞
  （此坑已在 Electron 主线程上真实踩过）。
- 注入点：`NotificationQueue` 是模块单例、无依赖，新增
  `notificationQueue.attachPersistence({ fileForSession(sessionId): string | null })` seam，
  由 protocol server / desktop 装配时注入；未注入时行为与现状完全一致（测试零迁移成本）。
- 写时机：`enqueue` / `drain` / `restoreResults` 三处成功后同步落盘该 session 的 bucket
  （文件很小，无需 debounce；`drainAll` 之后落盘的是**已扣除**的余额，天然与
  `background-result-wakeup.ts:113` 的 restore 回滚兼容）。
- 恢复：加载时逐条 schema 校验，**坏条目隔离到 `.corrupt` 旁路文件，绝不 throw、绝不清空**
  （严格校验叠加旧数据会全量清空，是本仓库明文教训）；`kind === "result"` 的条目重新
  `installLegacyResultAliases`（`agent-notifications.ts:298`，别名是非枚举 getter，
  JSON 序列化时自然丢失，恢复时必须重装）；`sequences` 以恢复出的
  `envelope.sequence` 最大值重播种。
- 补投触发：两条，缺一不可 ——
  1. **懒恢复**：session rehydrate 时先恢复 bucket，既有的 run 边界 drain
     （`run-finalize.ts:59`）与 `maybeWakeIdleSession` 自然消费；
  2. **启动主动扫**：desktop / protocol server 启动完成后，对存在
     `pending-notifications.json` 且非空的 session 逐个调既有
     `wakeSessionForBackgroundResults`（复用其全部防重入/busy 等待/headless 跳过逻辑）。
- **明确不做**：不给 bus 的桌面通知/toast 订阅者做重启重放 —— 系统通知是辅助（用户要求），
  补投的目标是**聊天里的结果**，由唤醒 turn 写回。

**D2 — 统一桌面通知出口（补 G2）**

- 新建 `packages/desktop/src/main/desktop-notifier.ts`，唯一职责：
  `notify({ key, title, body, urgent? })`。
  - 统一策略：非 `urgent` 时 `BrowserWindow.getFocusedWindow()` 有焦点则跳过；
    body 截断 180 字；沿用 `panel-app-bridge.ts:2283` 的速率限制形态。
  - **持久去重**：`key`（即各链路已有的 `deliveryKey`）写入一个 bounded JSON store
    （复用 `packages/desktop/src/main/pet/bounded-json-store.ts` 模式，上限 500 条），
    同 key 只弹一次 —— 这直接消掉 G3 场景下 closure 重跑时的重复系统通知。
- 迁移 4 个调用点：`index.ts:1718`（A5，key 用既有 `sha256("pet-task-closure\0"...)`）、
  `:3244`（bus 订阅，key 用 envelope.id）、`:3222`/`:3192`（automation，`urgent: true`
  保留"有焦点也弹"的既有语义，key 用 `automation-notification.ts:16` 的 deliveryKey）。
- **删除死代码** `packages/core/src/services/notifier.ts`（三平台 osascript 实现，
  全仓除 re-export 外零调用；desktop 用 Electron `Notification`，不需要它）。

**D3 — closure 副作用加固（补 G3、G4、G5）**

- `index.ts:1598` 的 A1（`petSegmentController.onDelegationClosed`）包 try/catch：
  蒸馏失败记日志、**不阻断**水位线落盘（蒸馏本身有持久 dedupeKey，重启后可自愈重试）。
- `index.ts:2062` `latestForSession` → 活跃性过滤（`activeForSession` 或对 terminal task
  显式拒绝其 `completionTarget` 路由），杜绝把 report 路由到已失效目标。
- `deliveredPetReports` 从内存 Set 改为持久 bounded store（同 D2 的存储模式），
  key = `reportId`，重启后不再重复注入 Mimi turn。
- `pet-host-action-completion.ts` 的 assistant append 增加与 user 消息对称的
  `hasClientMessageId` 幂等检查（clientMessageId 前缀协议三个写入者共用，改动只在
  append 入口，不动前缀协议本身）。

### 1.4 批次划分（每批一个 commit，RED 先行）

#### 批次 N1 — core：NotificationQueue 持久化 + 重启补投

**Files:**
- Modify: `packages/core/src/tool-system/builtin/agent-notifications.ts`（attachPersistence + 三处落盘）
- Modify: `packages/core/src/protocol/server.ts`（装配 + 启动扫描唤醒）
- Test: `packages/core/src/tool-system/builtin/agent-notifications.persistence.test.ts`（新增）

- [x] **RED 1**：`enqueue 后进程重启（新建 queue 实例 + attachPersistence 同一目录），
      getSnapshot 能看到该 result envelope，且 drainAll 返回的 envelope 保留 legacy 别名
      （`envelope.finalText` 等 getter 可读）` —— 现状必然失败（Map 随实例消失）。
- [x] **RED 2**：`持久文件被写入半截 JSON 后 attachPersistence 不 throw，坏文件被移到
      *.corrupt，queue 以空 bucket 起步`。
- [x] **RED 3**：`drainAll 成功后落盘文件不再包含已 drain 条目；restoreResults 后重新包含`。
- [x] 最小实现：persistence seam + load/save + server 装配。
- [x] 启动扫描：server 启动后对非空 pending 文件的 session 调
      `wakeSessionForBackgroundResults`，补一条集成测试（复用该文件既有测试的
      manager/rehydrate fake 形态；**注意 ~14 个手写 Engine fake 对新增 Engine 成员敏感，
      本批不得改 Engine 接口**）。
- [x] GREEN：`bun test packages/core/src/tool-system packages/core/src/protocol` 全绿；
      **改完 core 先 `bun run build` 再跑 desktop/pet 下游测试**（下游吃的是 dist）。

#### 批次 N2 — desktop：统一 DesktopNotifier + 持久去重 + 删死代码

**Files:**
- Create: `packages/desktop/src/main/desktop-notifier.ts` + `desktop-notifier.test.ts`
- Modify: `packages/desktop/src/main/index.ts`（4 个调用点收编）
- Delete: `packages/core/src/services/notifier.ts`（及 `services/index.ts:23` 的 re-export）

- [x] **RED**：`同一 key 调用 notify 两次（第二次在新实例上，模拟重启）只弹一次`；
      `非 urgent 且有焦点窗口时不弹`；`urgent 时有焦点也弹`。
- [x] 迁移 4 个调用点，逐点保持既有 key/文案；删除死代码后 typecheck 证明零引用。
- [x] GREEN：desktop main 相关测试通过；全仓门禁见文末执行记录。

#### 批次 N3 — desktop：closure / report / transcript 幂等加固

**Files:**
- Modify: `packages/desktop/src/main/index.ts`（A1 try/catch；`:2062` 活跃性过滤；
  deliveredPetReports 持久化）
- Modify: `packages/desktop/src/main/pet/pet-host-action-completion.ts`（assistant 幂等）
- Test: 对应各文件既有测试旁新增用例

- [x] **RED 1**：`onDelegationClosed throw 时 closure-recorded 仍然落盘、A2–A4 仍执行`。
- [x] **RED 2**：`同一 reportId 跨"重启"（新建 Set/store）到达两次，reportSessionMessage
      只被调用一次`。
- [x] **RED 3**：`completePetHostActionReceipt 以同一 clientMessageId 调两次，
      transcript 只有一条 assistant 消息`。
- [x] **RED 4**：`report 关联到的 task 已 terminal 时不再使用其 completionTarget 路由`。
- [x] GREEN：desktop pet 全套 357 个测试通过；全仓门禁见文末执行记录。

### 1.5 阶段一验收（对照原始五条要求）

| 要求 | 达成机制 | 验证方式 |
| --- | --- | --- |
| 结果持久写回原聊天 | 唤醒 turn 写 transcript（既有）+ N1 让"待写回"本身可持久 | N1 RED 1/3 |
| 系统通知只作辅助 | D2 单一出口，写回链路不依赖它 | N2 用例 |
| 应用重启后补投 | long-task 水位线（既有）+ N1 启动扫描唤醒 + Gateway outbox（既有） | N1 集成测试 + 真机：杀进程→重启→Mimi 聊天出现结果 |
| 完成/失败/取消/等待审批都能通知 | 终态三种已由 ledger 覆盖（1.1 表）；等待审批由 pet-attention-policy + mobile pending-approvals 重放（已核验有测试）覆盖 | 既有测试 + N2 迁移不回归 |
| 重复事件不重复发消息 | deliveryKey 去重（既有）+ N2 持久通知去重 + N3 三处幂等 | N2/N3 RED 用例 |

真机验收脚本（手动，一次跑完）：委派一个 30s 后台任务 → 任务运行中杀掉 app →
重启 → 断言 ①Mimi 聊天里出现结果消息 ②系统通知至多一条 ③再重启一次零新增消息。

---

## 2. 阶段二：可靠性债务收口（P0）

四项均已在 `docs/todo/claude-repository-optimization-2026-08-30.md` §2/§4/§6.7 完成
证据化审计，此处只定批次边界与本次实勘新增的发现。**修复模式全部沿用 C3 已验证的
迁移范式（`SettingsManager` / `mutateJsonFile`），不新建第二套锁/原子写实现。**

#### 批次 R1 — 记忆正文原子写（原 C4）

- `packages/core/src/session/memory.ts:292` `writeFileSync` →
  `writeFileAtomic(filePath, content, 0o600)`（该文件 `:39` 已 import，索引侧 `:984`–`:1005`
  就是正确范例）。同语义替换，一行 + 新增 `memory.atomic-save.test.ts`。
- **范围红线（审计已明确）**：只做原子性；`recordRecall` 等锁内读改写、以及本次实勘发现的
  `delete()`（`:520` 裸 `renameSync` 进 trash，相对索引锁同样无守护）**不混入本批**，
  后者记为 R1 后续候选。

#### 批次 R2 — headless server：`maxPayload` + pending 请求上限/超时（原 C5 + §4 合并批）

- `packages/server/src/serve/headless-server.ts:239` 补 `maxPayload: 1024 * 1024`
  （对齐 `remote-host-manager.ts:194` 既有取值；需先确认最大正常协议帧不超限）。
- `pendingWorkerResponses`（`:107` 定义、`:296` 无条件插入）三个修复点：
  1. 每 tab 配额（参照 `mobile-upload-service.ts:122` "每设备 16 + TTL" 范式，
     建议 64），超配额拒绝并回错误帧；
  2. 条目记 `insertedAt`，定期 reaper 按 TTL 清扫并向 tab 回超时错误；
  3. **本次实勘新增**：`:316` `ws.on("error")` 只做 `tabs.delete(ws)`、不清扫该 tab 的
     pending 条目（close handler `:311` 会清扫），error 不伴随 close 时永久泄漏 ——
     error handler 补齐与 close 对称的清扫。
- RED：超限帧被拒且连接不致命；配额溢出返回错误；error 路径后 map 为空。

#### 批次 R3 — onboarding 写入迁移到锁原语（原 §4 跟进）

- `packages/core/src/onboarding.ts:336`–`398` `appendOnboardingResult` 整体改为
  `mutateJsonFile(file, ...)`（`file-mutex.ts:143`），一次拿到锁、锁内重读、唯一 tmp、
  大小上限、symlink 守护；**删除 `:397` 的非原子 `writeFileSync` fallback**（它正是
  tmp+rename 要防的撕裂路径）。该文件存明文 apiKey，语义必须 fail-closed：
  存在但读不了 → 报错且字节不动（对齐 C3 第二轮 `readConfigFileForMutation` 的契约）。
- 顺带核对 `:198` 的无锁读（决定是否跳过 onboarding）——读侧可容忍陈旧，不改，注释说明。
- `packages/core/src/engine/engine.ts:3065` 的同款非唯一 tmp 写法记为独立后续，不混入。

#### 批次 R4 — `scripts/lint-baseline.json` 漂移收口

- 原审计建议把 `maxWarnings` 122 → 119；`v0.9.2` 基线已是 119，本轮移除废弃
  notifier 测试后实际警告进一步下降，最终由基线守卫自动收紧为 118。

### 2.1 执行记录

| 批次 | 状态 | Commit / 证据 |
| --- | --- | --- |
| N1 | 完成 | `ec789b9b feat(core): persist background result notifications` |
| N2 | 完成 | `2200500d feat(desktop): unify durable system notifications`；入口抽取 `9561c06f refactor(desktop): extract notification routes` |
| N3 | 完成 | `f0732d11 fix(desktop): harden Mimi completion delivery` |
| R1 | 完成 | `4439d07c fix(core): write memory bodies atomically` |
| R2 | 完成 | `cb94334e fix(server): bound pending websocket requests`；复审加固 `fe7b48ef fix(server): isolate websocket send races` |
| R3 | 完成 | `46e9798d fix(core): serialize onboarding settings writes` |
| R4 | 完成 | `954f15ba chore(lint): lower warning baseline to 118` |
| 门禁漂移 | 完成 | `2e953977 test: realign reliability gate fixtures`（移除已删死代码的旧测试；补录既有 `WatchSession` composition） |

### 2.2 最终门禁（2026-09-01）

| 门禁 | 结果 |
| --- | --- |
| 全仓 CodeShell 测试 | `9215 pass / 45 skip / 0 fail`，1268 files |
| typecheck + workspace builds | exit 0 |
| ESLint | `0 errors / 118 warnings` |
| `lint:engine-bypass` | exit 0 |
| `lint:workflow-test-paths` | 7 条路径全部存在 |
| `lint:baseline` | 118，exit 0 |

---

## 3. 阶段三：统一本地任务中心（P1，设计草案）

**问题**：Runs、后台任务、自动化、Mimi 委派、子 Agent 是五套用户可见系统。

**核心决策：读模型聚合，不合并存储。** 五个来源的 store 各自成熟且有严格 schema
（`FileRunStore` 事件溯源、long-tasks ledger、CronStore、NotificationQueue），
迁移合并的风险（严格校验清空旧数据）远大于收益。新建
`packages/desktop/src/main/task-inbox/`：

- **摄入**：订阅五个既有 seam —— `onTaskClosed`、`agentNotificationBus`、automation
  `onJobEvent`、`RunManager.attach`、external runtime seam（`index.ts:1460`）——
  归一化为 `{ taskKey: source:id[:attempt], status: running|waiting|done|failed|cancelled,
  title, sessionId?, artifacts[], updatedAt }`，落 bounded store。
- **动作回路由**：cancel/retry/resume 按 source 分发回各自控制器
  （coordinator cancel、`RunManager.cancel/resume`、CronStore）；"打开原 Session"
  统一走 sessionId。
- **Mimi 接入**：任务中心读模型即 Mimi 的任务视图数据源（替代其单独查 ledger），
  阶段一的 G6（Goal 完成被保守标 interrupted）在这里给 verify/retry 入口。
- **UI**：单一收件箱面板（运行中/等待/已完成/失败四档），复用 PanelRegistry。

依赖关系：**必须在阶段一之后**（否则收件箱聚合的是一个会丢事件的源头）。
动工前单独过 brainstorming + PRD（renderer 交互面大，需要独立需求收敛）。

## 4. 阶段四：GitHub / PR 完整工作流（P1，方向）

Review 面板已能审本地 diff（且 cwd 推导走主进程 session 绑定，隔离已验证），
GitHub Link 已能列出/读取 PR。缺口是把两者接通：PR checkout → 本地 review 面板复用 →
行内评论回传 GitHub → checks 状态展示 → approve/merge。动工前单独出 PRD。

## 5. 后续阶段（P2/P3，一句话立项方向）

- **原生产物**：结构化产出（报告/图表/文件）作为一等公民挂在任务上，任务中心展示。
- **Computer Use**：桌面级操作能力，依赖权限模型先行。
- **连接器深化**：现有 MCP Client 基础上做官方精选连接器与凭据管理。
- **平台出口**：稳定的外部 Client SDK（headless server 协议冻结是前置，R2 是其地基）。
- **IDE 与团队**：VS Code/JetBrains 扩展、分享、审计权限，最后做。

---

## 6. 横切工程约束（每批都适用）

1. **门禁命令**：全仓测试必须
   `env -u CODE_SHELL_CAPABILITY_MODULES -u CODESHELL_AGENT_STDIO bun test --timeout 30000 tests packages`
   （宿主 app 环境变量泄漏会造成假失败；显式限定本仓测试树，避免 Bun 扫入已被 Git ignore
   的本地 `.agents/skills` / `agent/skills` 第三方自测）；typecheck / lint / lint:engine-bypass /
   lint:workflow-test-paths / lint:baseline 全部 exit 0，lint 维持 119 warning / 0 error。
2. **core → 下游**：改 `packages/core` 后先重建 core 再跑 desktop/pet 测试（下游吃 dist）。
3. **跨进程共享文件写入一律走 `file-mutex` 原语**，这是一个根因不是多个 bug；
   同目录并列资源用 `acquireLockOnPath` 而非目录锁。
4. **严格校验不得清空旧数据**：所有新增持久文件的加载路径，坏条目隔离（`.corrupt`），
   读不懂时禁止提交覆盖。
5. **格式化只 prettier 改过的文件**，不跑仓库级 format。
6. **测试**：不用 `mock.module`（跨套件泄漏）；涉及 Engine fake 的批次不得扩 Engine 必选接口。
7. **流程**：每批隔离 worktree、RED 证据留档、独立复审（2026-08-30 轮 C1/C3 各被复审
   拦下一次真问题，该环节不可省）、单条 Conventional Commit。

## 7. 里程碑

| 里程碑 | 内容 | 出口判据 |
| --- | --- | --- |
| M1 | N1–N3 | 1.5 验收矩阵全过 + 真机杀进程补投脚本通过 |
| M2 | R1–R4 | 四批各自 RED→GREEN + 全仓门禁，审计文档 §6.7 清零 |
| M3 | 任务中心 PRD | brainstorming 收敛，独立计划文档 |
| M4 | PR 工作流 PRD | 同上 |
