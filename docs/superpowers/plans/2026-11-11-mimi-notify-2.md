# Mimi 提醒二期实现计划

> 设计稿 §8.8、§9、§10.1、§13（2）、§15。基线：1b（PR #337）之上。
> 二期拆成几个 PR，按顺序叠：2a 出口收口 → 2b 回复码与"打开" → 2c-1 定时规则与跟进 → 2c-2 晨报、收工、心跳 → 2d 规则列表界面。

## 设计上的一处收窄（2c-1 已撤销）

> 2026-11-11 主人决定：只要一套定时系统，跟进进规则表，旧的 `follow-ups.json` 数据可以删除。下面这段收窄只在 2a 有效；2c-1 已把跟进改成 `schedule` 规则并删除旧跟进存储。

设计稿原写"`follow-ups.json` 与 `WatchSession` 迁入规则表"。调研结论：跟进记录的 id 被 FollowUps 工具行、cron `creationKey`、唤醒正则引用，记录还有认领/唤醒子状态，规则表没有这些；整表迁移风险高、收益只在"存储统一"。二期改为：**跟进表继续是"什么时候提醒"的唯一记录，但提醒的发送一律过路由器**（§16 的目标是"谁该被告知、怎么发"只有一处，这一点做到）。`WatchSession` 改为建 `session` 规则（`createdBy: "watch-session"`，目标为来源路由），不再靠长任务的 `completionTarget`。

## 不变量

- 新推送一律 `router.submit*` + `pet-delivery-plan.ts`；`RequestMimiDelivery` / `SendMessage`（主人逐条批准的即时发送）和绑定会话回复保持现状，设计稿写明原因。
- 新的 ledger 字段向后兼容：旧版本读到未知字段会隔离单条记录，可以接受；不要升 `SCHEMA_VERSION`（会让旧版本整表只读）。
- IPC 路由数与 preload invoke 数都在上限：复用/泛化现有通道，不加新通道。
- `packages/pet/src/index.ts` 导出语句已满 27：新导出并入已有分组模块。
- 行数上限：`index.ts` 4665/5000，`pet-dispatch-service.ts` 2393/2500，`external-runtime-service.ts` ~2444/2500，`pet-long-task-coordinator.ts` 1328/1500，`pet-notice-router.ts` 1241/1500，`pet-notice-ledger.ts` 1197/1500。新逻辑放新模块。
- 新 desktop pet-notice 测试登记 `.github/workflows/ci.yml` 的 pet-notice 步骤。

## 2a 出口收口

1. 跟进提醒（`pet-follow-up-runtime.ts:49-66`）改为提交 Notice（新 kind `followup.due`）：有 `completionTarget` → 目标为该路由，否则 `auto`（在场桌面、不在场最近 IM）。主人自己定的时间：不受免打扰压制（主人选了这个时刻），但计入每小时上限之外的 P0 兜底；有 ledger、去重键（唤醒键）、过期（`catchUpUntil`）。桌面通知走路由器的桌面出口，不再直接 `desktopNotifier.notify`。`resume` 意图不变（仍唤醒 Mimi / 长任务），只是它产生的提醒也过路由器。
2. `ReportToMimi` 原路回传（`index.ts:2407-2502`、`pet-report-turn.ts:71-78`）改为提交 Notice（kind `session.report`），目标由送达计划的 `planReport` 决定，只有两类：活动长任务的 IM 来源（Mimi 汇报轮的草稿，同以前）与每条指向 IM 对话的 `watch-session` 规则（模板），按对话去重；不发给主人（`NotifyMe`/铃铛规则、桌面派活），不发绑定或通知模式的路由。受免打扰/频控（P1），合并进摘要。
3. `WatchSession`：host handler（`index.ts:2233-2280`）改为建 `session` 规则（`createdBy: "watch-session"`、`target: route`），保留"已在看"和"已结束"的回复；长任务路径保留给真正的派活。对已有 watch 长任务的会话行为不变。
4. 渲染层"会话完成"本地通知（`App.tsx:1567`）：会话有活动规则时整体让位给路由器（不只 60 秒内触发过）。
5. 设计稿 §1.4/§8.1 出口表更新；§15 删掉"ReportToMimi 原路回传和跟进提醒自己发送"。

## 2b 回复码与"打开"

> **实现时的方向调整（主人决定）**：不让主人在 IM 里打固定格式，也不用正则解析回复。提示用自然语言，码只作内部 id；一个对话有多件打开的事项时用 ①②③ 编号；主人的回复由模型（辅助模型 → Mimi 主模型，严格 JSON）对照打开的事项解读，宿主校验后执行，模型都不可用时不猜。旧的 `回答 码` 命令与裸回复匹配删除；"打开"的产物只取结构化来源（不从正文抽链接）。下面的命令名（`继续 码` 等）保留为动作名，见设计稿 §7、§9。

1. ledger 新字段 `actions`（与决定提示的 `prompt` 分开）：`{ code, family: "goal" | "failure" | "open", sessionId, runtime: native|external, goalId?, revision?, expiresAt, artifacts? }`，独立的按码索引与解析；不触发 `staleReason`/`endVanished` 的决定逻辑。
2. 规则观察器的 blocked（Goal 等用户、上限停止）与 failed Notice 带上 `goalId/revision/reason`，生成动作码；正文附可用回复：
   - Goal 等用户：`回复 码 <文字>`（把文字作为回复发进会话）、`停止 码`、`交给 Mimi 码`；
   - 上限停止：`继续 码`（native `goalExtend` 按原上限再加一份 / external `extendGoal` 再 `updateGoal paused:false`）、`停止 码`、`交给 Mimi 码`；
   - 失败：`重试 码`（长任务 `retry`，否则把上一条用户消息重发）、`交给 Mimi 码`。
   - 码 24 小时过期；执行前复查（Goal id/revision 未变、会话还在、没被别处处理）。
3. `交给 Mimi 码`：起一次宿主唤醒的 Mimi 轮（参考 `wakeFollowUp`），带会话 id、卡点、最后摘要，Mimi 用已有工具接手（问主人或驱动会话）。
4. `reply()` 在现有 `回答` 正则之前解析新命令族，复用 `sameOrigin`/私聊校验；不带码的裸回复不适用于动作码。
5. "打开"（§9）：done Notice 收集产物：`turn_diff` 的文件（工作区内）、回复文字里的 URL（只认 GitHub/GitLab/Gitee/配置的企业域名/localhost）、长任务 `artifacts`。桌面通知带"打开"（定位会话）；IM 附 `打开 码`：文件 realpath 后必须在会话工作区内（复用 `panel-app-bridge-workspace.ts` 的检查），否则只定位会话；陌生域名回"要打开 `<域名>` 吗？回复 `确认 码`"；主人私聊 + 发送者校验，码 24 小时过期。宿主打开后回"在电脑上开好了"。
6. 设计稿 §7 表、§9 更新。

## 2c-1 定时规则；跟进改成规则（已实现）

主人决定（2026-11-11）：只有一套定时系统；跟进移进规则表，旧数据删除、不迁移，旧代码删除而不是并存；晨报、收工、心跳、循环与一次性跟进都是规则；自然语言一律交给模型，不对散文用正则。

1. 规则模型：`when.kind: "schedule"`（`at` 一次性 xor `cron` 循环、`timezone`、`missedPolicy`、`catchUpUntil` 只用于 `at`）；`then.mode` 加 `"remind"`（`title`、`text`）和 `"run-mimi"`（`title`、`text`、`sourceSessionId`、`taskId?`）；`createdBy: "follow-up"`；规则带 `wake`（当前这一次：`occurrence`、`stagger?`、`status`、`claimedAt?`、`completedAt?`、`detail?`、`taskId?`）。唤醒进度不改 `version`。不升 `SCHEMA_VERSION`，旧版本逐条隔离新行。形状与时刻计算在 `pet-schedule-rule.ts`，存储方法在 `pet-rule-store.ts`（`createScheduleRule` / `rescheduleRule` / `claimOccurrence` / `settleOccurrence` / `recoverClaims`；没改动的写入不落盘、不通知）。
2. 执行器 `pet-rule-schedule.ts`（`PetRuleScheduler`）：每条规则的当前这一次投影成一个一次性 core 任务，键 `mimi-follow-up:rule:<id>:<version>:<occurrence>`（旧版本已挡在自动化之外的命名空间）；漂移的任务重建；先落盘认领再执行；抛错记 `unknown` 不重试；启动时恢复残留认领；已过点的由宿主在启动、规则变化、唤醒/解锁时处理（`fire-once` 期限内补一次、`skip` 只在 90 秒内）；循环规则睡了多天只补最近一次。同一分钟错开 0–5 分钟（存进 `wake.stagger`）。启动时删除 `follow-ups.json` 和 `mimi-follow-up:` 任务一次并记日志。
3. 跟进层 `pet-follow-up-rules.ts`：`followUpMutation` 宿主动作（操作键和目标仍由宿主从这一轮派生，规则 id 由操作键确定性派生；外部会话不能续办）、`FollowUps` 行视图、到点的 `remind` / `run-mimi`（`PetDispatchService.wakeFollowUp` 或长任务续办）→ `pet-notice-follow-up.ts` → 路由器 `followup.due`。
4. 工具：`FollowUps`、`ManageFollowUp` 名字不变；`register` / `reschedule` 加 `recurrence`（cron，最多每小时一次，与 `wake_at` 二选一；工具与宿主都确定性校验并返回清楚的错误）。
5. 界面：`PetFollowUpSection` 显示重复规则，循环规则不给改期（找 Mimi 改），其余操作不变；IPC 复用 `pet:follow-up-control`（id 改为规则 id）。automation 列表隐藏 `mimi-follow-up:` 命名空间的任务。循环跟进带 `schedule_label`（模型写的说法），回执写名字 + 接下来两次。
6. 评审修正（2026-11-11）：只读或读不出的规则表不再拖垮桌面启动；隔离区的行加载时恢复；core `nextCronTime` 改为按字段跳跃（约 8 年上限、拨慢重复时刻只触发一次）；认领期间允许取消/改期；只淘汰已送达的一次性跟进。
7. 删除：`pet-registered-follow-up-store.ts`、`pet-follow-up-wake-coordinator.ts`、`pet-follow-up-runtime.ts`、`pet-follow-up-host.ts` 及其测试；pet 包里的 `PetRegisteredFollowUp` / `RegisterPetFollowUpInput` / `PetFollowUpWakeOutcome`（换成 `PetFollowUpWake`）。

## 2c-2 晨报、收工、心跳（已实现）

主人决定（2026-11-11）：主动行为一律是规则、只有一套调度；自然语言只交给模型；默认全关，晨报 09:00、收工 18:30（本地，每天），心跳活跃时段 09:00–22:00 每 30 分钟、绝不在免打扰内，判断 ≤ 8 次/天、消息 ≤ 4 条/天。三期的心跳并入本期。

1. 系统定时规则（`pet-rule-store.ts` `setSystemSchedule`，`pet-proactive-rules.ts`）：`system-brief-morning` / `system-brief-evening`（`then: compose`）、`system-heartbeat` / `system-heartbeat-recheck`（`then: judge`），`origin/createdBy: system`、目标主人、`auto`；第一次打开才建行，之后只暂停；设置改了就同步（新 version、从现在往后算）。只有 `system-heartbeat` 可以每小时两次（分钟恰好相差 30，由宿主写出）。执行器的任务键接受这四个 id；到点由跟进的调度器交给 `fireSystem`。
2. 晨报 / 收工（`pet-proactive-brief.ts`）：确定性收集 → 为空不发 → 辅助模型（再 Mimi 主模型）写严格 JSON，每行带 `refs` 并由代码复核 → 都不行用模板 → `brief.<kind>`（P1）过路由器。睡过了当天补一次，当天发过不再发。没有用宿主唤醒的 Mimi 轮：它的输出是不可核对的散文、还能调工具（见设计稿 §10.1 第 5 条）。
3. 心跳（`pet-proactive-heartbeat.ts`、`pet-proactive.ts`）：三项预检（未送达的新决定、续办跟进将到期而会话闲着、结果没看过；"超过预估 2 倍"因长任务没有预估未做）→ 有才判断 → 严格 JSON → `heartbeat`（P1）或一次复查；上限计数先落盘（`pet/proactive.json`），重启不归零。
4. 固定格子（`pet-notice-digest.ts` `slottedFlushAt`）：`digestSlots` 设了就只在格子发普通摘要；P0 与跟进摘要不变。晨报/心跳被压住时整条重发，不进摘要行。
5. 推迟：晨报、收工、心跳消息带新事项族 `notice`（动作 `defer`；摘要不带，免得每条摘要后 2 小时内的 IM 消息都多一次模型调用），回复解读模型给出 `until`（ISO，按给出的主人本地时间）；宿主夹到 [5 分钟, 36 小时]、最多 2 次，账本副本带 `deferredUntil/deferCount`，摘要冲刷到点整条重发（`pet-notice-defer.ts`）。原计划里的 `稍后 码` 命令和 `pet.notice.defer` 宿主动作没有做：回复一律由模型读，不加命令。
6. 设置（只有数据和 IPC，界面在 2d-2）：`briefs`、`heartbeat`、`digestSlots`（core 设置 schema + `pet-notice-settings.ts`）；`pet:notices:get-state` 带设置与 `proactive` 状态，不加通道。
7. "按字段覆盖、未改字段跟随升级"（§4.3）没有单独做：系统定时规则的 `then` 和形状由 id 决定、时间全在设置里，规则行没有主人能单独改的字段。

## 2d 规则列表界面

- 配置中心"通知与主动"卡片列出主人建过的规则（会话规则、跟进、系统规则）：暂停/恢复/删除（删除 = `state: "cancelled"`）。复用 `pet:notices:get-state` 返回 `rules[]`，泛化一个现有变更通道（例如 `set-session-bell` → `update-rule`），不加新通道。
- 会话铃铛显示该会话规则来源（自己说的 / 派活自动建的 / 看着它）。
