# TUI StatusLine 普通数据静态前置审查

结果：0 formal / 1 static candidate / 0 new related。候选 **STATUSLINE-R64-C1（建议 P3）**：同一前台查询持续 active 时，最后一个后台任务完成若被普通 UI 提交，会重置共享耗时起点。保持候选提案，未观察真实帧，未执行任何产品、测试或计时器。

## 普通数据链与候选边界

`App.tsx213–218` 把前台查询与后台聚合忙闲状态 OR 成 `isRunning`；`436–439/446` 的 effect 同时依赖三者，任一变化后只要 OR 仍真就重写 `runStartRef`。`StatusLine.tsx125–126/167–171` 用该 ref 算运行耗时，`App.tsx1669–1681` 还把同一差值写为 `turn_duration`。正常后台选项、注册 running、snapshot 通知和终态 status/时间赋值已有限选读，详见[源码范围](source-manifest.json)、[摘录](source-excerpts.txt)和[单行生产字段](producer-status-selected.json)。

限定 case 是已有后台任务时开始一个前台查询，前台仍在进行而最后后台任务完成，bg true→false、query 保持 true，且状态变化在当前前台查询结束前被 UI 提交。起点 t0 被 t1 覆盖，结束 t2 的 footer 与 turn-duration 数据便减 t1，遗漏 t1−t0。这里只作源码算术推导，不是语言 fixture、真实时序或帧观察。详见[候选记录](candidate.json)。

反证与限制：新前台查询开始时重置合理，不作为 bug；稳定 flags 不重触 effect；Agent 后台路径 `711–714` 有 runYield，因此不声称每次首 spawn 都会出现独立可见帧。不推断 session 全程计时、后台任务生命周期计时、持久会话损坏或账单影响。QueryGuard、lease、owner、transport、模型与真实任务机制均未展开。Parent 将另做知情针对性复核，不因本提案自动升级。

## 其他普通显示检查

StatusLine 的 context 只用 App 的 base/max 比值并上限 100%；所读 App 事件把 promptTokens/compact after 传入，对 session_cumulative 有过滤。cost 字符串由 App 传入后直接显示；既有 23 行测试声明保留 unknown/partial 文本，本轮仅读声明，零执行。model 简写、token 缩写与 elapsed 文本有限阅读；未用非法 NaN/Infinity/乱码造反例。未另立问题，也不宣称全行为正确。

## 历史与覆盖口径

[完整机器库存](history.json)在 2026-10-17 15:49:52–55 UTC 记录 4255 个 docs/bugs MD/JSON（1423/2832，1765237 string values、2662013 scalar values，169 archive/_archive 路径，0 JSON parse errors）。纳已冻46、排47–65；完整递归 scalar 机器扫描不是人工全文语义阅读。当前 leaf 227 行/7462B，SHA `59bef2bd5014ce72d2d2d63e24ed7e10c20efb7e2355601a0264202cf8582c43`。

[首读 pin](initial-pins.json)、[显示前 pin](source-display-pins.json)、[覆盖 gate](coverage-gate-rows.json)与[路径/SHA窗口](history-contexts.json)记录 path17/SHA7、8 个库存或导航元数据行，未建立 same-SHA full；不把 rank/no-row 当未读。整 leaf 227 行被显示，但 interval/perf/记录/TTY 机制排除，故仅 selected 普通语义，不登记 product full。App 首次 rg 导航早于 dedicated pin，保守保留 initialSemanticReadSha256=null；后续所选正文在 dedicated pin 后读取。

[补充查询方法](history-focused-method.py)只针对原库存字面/AND，runStart1、status+elapsed3、background+elapsed31、cost-model50，cap30 保存1/3/30/30；实际选读[14个有限窗口](history-focused-selected.json)，不把命中或保存 cap 当历史穷尽。旧 COST-R9-01 模型 ID 定价、旧非 REPL ctx run/runs、i18n/diff/终端渲染与既有失败动态方向不重报。[原扫描方法](history-method.py)保留。

## 诊断、时点和冻结

首次 focused 选读显示 6512 tokens 超过6200输出限，命令 exit0；[首诊断](history-selected.first-output-diagnostic.json)与完整 selected JSON保留，随后仅补读被省略的 index24 窗口，无产品错误或重跑。registry360–370 意外显示相邻363–369 lease字段，仅360–362/370登记普通语义，不再进入机制。

Root 最初报告 c3a9ece…，后报告2735100…仅新增正式47 docs；本审查 Git0，不独立认证该提交。原4255纳46排47时点不倒填。[结束哈希](ending-checks.json)与[验证口径](validation.json)另列；finalize 仅元数据，不产生第二次源阅读。所有文件由[冻结收据](reviewer-receipt.json)固定，收据自排除。
