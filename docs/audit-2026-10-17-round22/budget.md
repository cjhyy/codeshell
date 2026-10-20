# Engine 输出预算与 reactive threshold 复核

冻结点 `ab258c3f534b19014b2ed85da3111649f166ab86`。本方向 **0 确认、0 候选、0 新增关联项**。首次 guarded shard 为 **8 pass、17 expect、0 fail、0 skipped**，其中既有 4 项、新增普通数值控制 4 项。没有产品修改。

完整阅读 `token-budget.ts` 60 行、`reactive-threshold.ts` 22 行及既有 threshold 测试 28 行；`turn-loop.ts` 和 `model-facade.ts` 只读选定的调用/类型片段，详见[冻结源码清单](evidence/budget-source-manifest.json)。动态只导入零 runtime import 的真实 `crossedReactiveThreshold` 叶子；没有导入、构造或执行 Engine、TurnLoop、ModelFacade、ContextManager、provider 或真实 stream。

`reactive-threshold` 的既有四项检查首次跨桶、桶内不重发、下一桶和第一阈值之前的行为。新增[实际叶子 fixture](evidence/budget-reactive-focused.test.ts)检查恰好 2000/4000、一次跳到 6500 后仅报告当前 bucket 且桶内不重发、333 的单调非整除序列和彼此独立的新计数。小序列循环属于一个 focused case，不按函数调用次数增加测试项。没有负数、NaN、Infinity、超大计数、模型或上下文压力实验。

实际消费者已静态确认：`turn-loop.ts:2118–2144` 在一次 `callModelWithFallback` 中持有累计数和 last bucket，文本 delta 才增加估算值；命中探针后调用 `shouldReactiveCompact`，然后只写 warning。一次 delta 跨多个桶时，叶子返回最新桶，实际消费者只需检查当前压力；没有依据要求补发每个跳过桶的旧压力检查，因此未把该正常控制登记成缺陷。没有声称运行了实际 callback、模型重试、`onStream` 缺省路径或流中压缩。

`token-budget.ts` 不重复运行。全历史去重找到[第九批 usage 记录](../audit-2026-10-17-round9/usage.md)：已实际通过有限/无限预算、90% nudge 后 stop 两个控制，并已记录 diminishing 分支在正常单调计数中难以达到、缺少独立可见错误或更强契约的静态观察。本批核对 `turn-loop.ts:911` 的 tracker 创建及 `:1889–1928` 的检查/后续分支，没有把旧控制或旧观察重新算成新问题，也没有刻意修改 tracker、模型计数或真实循环强行触发该分支。

静态文档边界也已留存：[deep-dive v2:218](../core-deep-dive/v2-02-engine-turn-loop-deep-dive.md#L218) 和[旧版 deep-dive:88](../core-deep-dive/02-engine-turn-loop.md#L88) 把探针描述成可能流中紧急压缩；真实调用当前只 warning。[已有完整审查:386](../archive/core-complete-review.md#L386) 与[七月状态机记录:211](../archive/review-2026-07-09/06-turn-loop-state-machine.md#L211) 已写明这一边界。本批把它保留为历史文档措辞矛盾，未据此声称发现新的 helper/运行时压缩故障或新增严重级别。

[去重结果](evidence/budget-dedup.json)递归覆盖 `docs/`、`bugs/` 中 **2232 文件：1202 MD、1030 JSON、309994 字符串叶、436035 全标量叶，0 解析错误**，含 archive/_archive，排除本批。所有 JSON 标量均按字符串或 JSON 拼写搜索；键不算标量值。exact/budget/reactive 模式分别命中 218/118/72 次，保存上下文 218/118/72，不代表语义穷尽。[人工去重决策](evidence/budget-dedup-decisions.json)区分旧预算控制、历史描述与本批新 threshold 控制。

[首次合并原始日志](evidence/budget-first.raw.log)与[退出收据](evidence/budget-first.exit.json)在阅读前均已落盘：exit 0，runner 明确 `Completed Bun shard: 8 tests, 0 skipped; 0 failures`。[验证收据](evidence/budget-validation.json)保留运行范围及计数。没有失败 shard、修复、重跑或替代验证，没有恢复任何旧失败方向。既有所有 Engine/goal/预算集成测试均未运行；本批叶子控制不替代实际上下文压力、token accounting、真实 callback 生命周期或端到端证据。没有执行全仓 suite、build、lint 或 typecheck。
