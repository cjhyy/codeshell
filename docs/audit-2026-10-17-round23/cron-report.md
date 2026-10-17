# Cron expression 普通数据边界复核

冻结点 `c1d007ed0af1eca9b56b32fabbb0ea2401037ee1`。本方向 **0 新确认、0 新候选、0 新关联项**。唯一首次 guarded shard 为 **7 pass / 19 expect / 0 fail / 0 skipped**，全部是 owned focused 普通叶子控制；既有任何 cron、interval、Scheduler 或 automation suite 都没有执行。没有产品修改。

完整阅读实际 `automation/cron-expr.ts` 207 行：无 runtime import，字段语法为 star、star/n、单值、range、range/n 及其列表；day restriction flags 刻意区分裸 `*` 与显式全范围，匹配规则在本文件中明确。`parse-schedule.test.ts` 和 `scheduler-cron-expr.test.ts` 引入 scheduler；既有 cron-expr suite 虽是纯叶子，也包含从 2027 年搜索至 2028 闰日等较长计算，所以本批只静态读，不盲跑或摘出重跑旧用例。[源码清单](evidence/cron-source-manifest.json)逐项区分全文与 selected 阅读，hash 不替代语义覆盖。

普通接线仅静态核对：`scheduler.ts:1231–1243` 的 `validateSchedule` 先识别五字段，再调用 parser，否则交给 interval `parseSchedule`；create/update 注释要求预先校验。display refresh、`arm` 和 `armCron` 分别在 selected 片段调用实际 `nextCronTime`。`automation/index.ts` 与 `index.internal.ts` 导出该叶子；CronCreate description 列举普通五字段表达式与时区。没有导入任何 barrel、Scheduler、store、runner、工具或真实消费者，也没有执行其 validation、timer、任务或显示分支。

唯一 [focused fixture](evidence/cron-focused.test.ts)绝对路径导入真实表达式叶子，无 mock，只使用合法的字段组合与固定 UTC `Date.UTC` 引用：列表/重叠范围去重、字段空白、组合 step range、带秒/毫秒引用的下一分钟、UTC 日界/年界、显式全 day range 的 restriction flags。五次 `nextCronTime` 调用都在一或两分钟内命中，总共至多六次候选分钟检查；没有压力、百万步搜索、真实时钟等待、DST、闰年长区间、非法字段、NaN/Infinity 或 timer 实验。这些只是现有行为的少量补充控制，不是新机制、全 cron 合同验证或问题修复。

全历史去重已定位[第二批 scheduling-data](../audit-2026-10-17/scheduling-data.md)：`TIME1`（该批第 23 项）早已确认多余 range/step 后缀被 split/parseInt 忽略，既有 44 项基线也已覆盖 cron/interval、DST、闰日、DOM/DOW OR 等。当前 `cron-expr.ts` 与该报告冻结 `ab8b03f86ad38835939d4125b56bf4513cae7f15` 的 Git blob **字节完全相同**，SHA256 都是 `5a5fcfd813afb00e42b32cbaa19f9be68918fed0608a30a33cb494ce7f2c3da0`。因此旧 `TIME1` 的相关源机制尚未改变；这是[源码状态核对](evidence/cron-source-status.json)，没有重跑旧 malformed 输入、Scheduler update 或旧复现，也不新增缺陷计数。

同样排除旧 `TIME2` 的 CronCreate 时区显示、May30 interval typo 默认十分钟/zero interval 历史，以及旧不存在 `automation/cron-runtime.ts` 路径方向。`nextCronTime` 明示约两年搜索上限，旧报告已把超过该窗口的合法表达式列为能力范围，本批不把这个明示限制本身升级为故障。内部 parseField 注释出现的单值 step `a/n` 不在文件头枚举的公共支持语法中；没有普通输入合同或实际消费者证据，未通过刻意输入强造新项。

[全历史扫描](evidence/cron-dedup.json)递归读取 docs/bugs 的 MD 与 JSON 全标量，含 archive/_archive，排除本批；读取时 **2301 文件 = 1213 MD + 1088 JSON，335490 string leaves / 472091 scalar leaves，0 parse errors**。exact 命中 192 次全部保存；较宽 cron mechanism 命中 556 次，仅保存前 300 context，且其 `OR` 等词可产生普通文字噪声。命中数不是问题数，也不证明语义穷尽。[去重决定](evidence/cron-dedup-decisions.json)保留具体旧机制、当前静态状态及未执行边界。

[首次 raw](evidence/cron-first.raw.log)与[exit](evidence/cron-first.exit.json)均先落盘再阅读，exit 0，明确 `Completed Bun shard: 7 tests, 0 skipped; 0 failures`。[验证收据](evidence/cron-validation.json)记录一次执行、0 失败、0 重跑。后续仅做静态与元数据收集。没有 Scheduler/automation runner/真实任务/模型/网络/账号/权限/安全/native 操作，没有真实 timer 或系统时区实验，没有恢复旧失败方向，也没有 build/typecheck/lint/full suite 声明。[作者收据](evidence/cron-artifact-receipt.json)保留材料字节哈希。
