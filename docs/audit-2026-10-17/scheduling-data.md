# Core 定时 / 任务日期普通数据审查

冻结基线 `ab8b03f86ad38835939d4125b56bf4513cae7f15`，分支 `codex/audit/remaining-20261017`。本续审只写本报告与 `evidence/time-*`；不改产品/Git，不运行真实计时等待、长 sleep、模型、网络、原生工具或真实账户。动态只用纯函数、内存 scheduler、假时钟/假 timer 和自有临时文件。

## 覆盖记录

- 读取当前 `automation/cron-expr.ts`、`scheduler.ts`、`store.ts`、`index.ts`；相关 field/range、timezone/calendar、absolute one-shot、reload/interval-phase 既有测试；普通 CronCreate/CronList 时间投影与 Sleep 参数路径。
- 旧报告仅查重：2026-05-30 的 interval malformed silent fallback 已修；2026-10-12 的 Host 120秒续接提前结算/错误归类属于已知，不重复验证或计数。
- 静态读取试图打开不存在的 `automation/cron-runtime.ts`，命令报 ENOENT；跳过该不存在路径，不变换名称重试同项。这不是已运行实验失败。
- 独立运行记录：`time-cron-data-round1` 为 2 pass / 12 expect，`time-sleep-data-round2` 为 2 pass / 5 expect，`time-cron-once-display` 为 1 pass / 3 expect；均首次 guarded、Completed，无失败/重试。第三个文件补足一次性确认字符串直接附加时区的精确显示边界，没有重跑前两个 fixture。

## 已确认发现

### TIME1 · P3 · 非法 cron 分隔符被静默截断，create/update 接受不同计划

- 位置：`packages/core/src/automation/cron-expr.ts:60–61,72–74`；`scheduler.ts:1238–1240` 的 validation 调用。
- 触发：普通 cron 字符串 `0-1-59 9 * * *`（多一个 range 端点）或 `*/5/0 9 * * *`（多一个 step）；不是合法文档语法，理应报配置错误。
- 预期/契约：parser 注释列的 field 语法为 star、star/n、a、a-b、a-b/n 及 comma-list；`CronScheduler.create` 的前置校验注释 `:557–558` 和 update 文档 `:797–799` 要求坏输入在修改前抛错、保持原 job。`validateSchedule` 也注明 invalid 应抛错。
- 实际：`split()` 解构只取前两段，后续段完全忽略；第一式分钟 Set 为 `[0,1]`，第二式为 `[0,5,...,55]`，包括额外 `/0` 也未拒绝。实际内存 scheduler update 保存了第一非法字符串，同时把 prompt 从 original 改为 updated。
- 影响：配置 typo 表面创建/更新成功，但实际执行时间由截掉后缀的另一表达式决定，用户不能从原字符串发现其真实含义。仅验证纯解析、next-time 和内存 update，未触发任何任务/真实 timer。
- 证据：`evidence/time-cron-data-round1.test.ts` 第一项与 `evidence/time-cron-data-round1.log`，整组 **2 pass / 0 fail / 12 expect / Completed**。Date.now 为假时钟，scheduler executionDisabled。
- 查重：旧 2026-05-30 的 `Silent default fallback masks invalid schedule configuration` 是 interval `5mn` 被硬编码十分钟替代，当前已修；本项为新 cron field parser 忽略多余分隔段，两者修复位置/触发串不同。有限旧 2026-10-12/remaining/10-16 检索未见同项。

### TIME2 · P3 · CronCreate 的一次性执行时间按 Host 时区显示却标注 job 时区

- 位置：`packages/core/src/tool-system/builtin/cron.ts:205–210`。
- 触发：Host formatter 时区 UTC，计划 `0 9 * * *`、job timezone=Asia/Tokyo，假当前 UTC 2026-10-17 00:00；nextRun 正确为 UTC 2026-10-18 00:00，即 Tokyo 09:00。
- 预期：返回确认中的日期和附带时区一致，应显示 Tokyo 09:00，或明确显示 UTC 00:00 并标 UTC。
- 实际：`new Date(nextRun).toLocaleString()` 未传 timeZone，得到 Host 的 `10/18/2026, 12:00:00 AM`；一次性分支返回“将于 10/18/2026, 12:00:00 AM (Asia/Tokyo) 执行一次”，把 UTC 时刻的钟面贴上 Tokyo 标签。周期分支同样输出 Host-local Next run 且不注明 Host 时区。
- 影响：用户确认一次性提醒的执行时间时得到九小时偏差的钟面文案。底层 nextRun 数值正确，因此不声称实际任务在错误绝对时刻触发，也不把 recurring 分支的歧义扩大为底层 scheduler 数学错误。
- 证据：首次 `time-cron-data-round1` 第二项为周期输出；独立 `evidence/time-cron-once-display.test.ts` / `.log` 为一次性输出 **1 pass / 0 fail / 3 expect / Completed**。都用真实 Intl 本地 formatter 与真实 CronCreate 字符串，动态选择与 Host 不同的 job timezone，避免绑定审查机器所在地；Date.now fake、executionDisabled，不跑任务。
- 查重：旧报告的 timezone 下拉贫瘠、默认值、Host续接结算等与此输出格式不同；本轮有限查重未发现同项。

## 既有基线与统计

- `node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/automation/parse-schedule.test.ts packages/core/src/automation/cron-expr.test.ts packages/core/src/automation/scheduler-timer-overflow.test.ts packages/core/src/automation/scheduler-absolute-once.test.ts`。
- `evidence/time-scheduling-baseline.log`：**44 pass / 0 fail / 143 expect / Completed**。interval parser 和 cron parser/nextTime 是纯函数；timer ceiling/absolute one-shot 是 Bun fake timers、fake Date.now、自有 temp CronStore、内存 fake executor。覆盖DST跳时/重复分钟、闰日、DOM/DOW OR、长 timer 切片和 absolute catch-up 边界。没有真实等待/进程/网络/模型。
- 本续审正式 **2 项 P3**；4 个干净 Completed 首次 shard合计 **49 tests / 163 expect / 0 fail / 0 skipped**。Sleep 两条为旧边界复核，不新增发现编号。
- `evidence/time-source-manifest.json` 保存 6 个关键生产源码和 7 个 fixture/log 的 SHA-256；6 个源码逐字节匹配冻结 Git blob。没有产品修复或重跑失败实验。

## 未计发现的已知范围 / 候选

- `nextCronTime` 明确限定约两年搜索，leap-day 等合法但下一次更远的表达式可能返回 null；这是已记录能力范围，未用其直接计缺陷。
- `arm()` 明确在缺 timer / cold load 时重置 interval 的 now+interval 相位；新绝对 `runAt` one-shot 才承诺保留目标。旧 relative-once 的冷恢复延迟是能力/语义候选，尚未运行，不冒称未文档化错误。
- `Sleep` 注册后中止会清 timer，但 acknowledgement 仍返回完整“Slept for 300 seconds.”。独立 fake-timer 动态结果为实际假 elapsed=0、remaining timer=0，正常2.5秒假推进对照通过；**旧 `docs/review-2026-10-12/goal-sleep-round20.md:63` 已明确记录此文案边界并指出 TurnLoop/ChatSession 另有 abort gate**，因此仅列已知复核，不计新发现/任务继续执行。
- 未运行真实 Desktop/TUI 创建和时区 UI、任意实际 timer 等待、权限策略/审批、真实 executor/模型、系统 suspend/wake、进程 crash、多进程竞争；静态阅读与有限纯函数例子不能视为完整 scheduling 验收。
