# CodeShell 第十批审查记录

冻结源码：`6966dc0f98d21dbc2ecced6cdd6467d17b81bc39`。本批审查浏览器诊断数据、模型目录/缓存、Pet 普通数据投影与 disclosure，以及 run 存储/查询/检查点。确认 **3 项 P3**，另保留 **1 个检查点启发式语义候选**。仅记录，未修产品；全仓持续审查仍未完成。

| ID | 问题 | 实际证据与范围 |
| --- | --- | --- |
| [DIAG-R10-01](diagnostics.md) | DOM 遍历预算检查之前，完整枚举宽子树的 children collection | 生产 callback + VM/fake iterable；输出仍有界，没有真实浏览器延迟、内存峰值、超时或卡死结论 |
| [PET-R10-01](pet.md) | 并发命中在默认 20 行上限后裁切，却漏报 truncated | 真实 search/reader + 21 个自有健康会话；20 个会话的正常边界对照通过，不扩大成所有调度必触发 |
| [PET-R10-02](pet.md) | Unicode 小写扩长导致原文摘要坐标偏移、缺少命中词 | 真实 helper + 合法 Unicode 消息与 ASCII 对照；重复字符用作 stress prefix，UI/IPC/Host 接线仅静态 |

[模型目录报告](catalog.md)：0 项新确认、0 候选，保留明确的已知/契约不足排除。[Run 报告](runs.md)：关键词检查点把否定测试句标为 `tests_passing`，但现有设计明示 heuristic，缺更强准确性/成功状态契约，所以只记 RUN-R10-C1 候选。

**首次验证：9 个 clean guarded shards，169 pass、582 expect、0 fail、0 skipped；154 项既有 baseline + 15 项 focused observations/controls。** raw combined stdout/stderr 与退出码先保存再查看，没有失败的 Bun shard或产品重跑。Characterization 测试通过不代表产品缺陷已修复。具体见[验证汇总](validation.json)、[正式缺陷](findings.json)、[候选与静态观察](candidates.json)、[冻结源码 SHA](source-manifest.json)、[完整材料索引](evidence-index.json)。

静态猜测路径/文件名/glob、metadata regex 和字段选择诊断分别保留于分项报告和收据；这些不是产品或 Bun 失败。Root 的 renderer glob 方向与 Catalog 的 cache refresh 调用链方向按要求跳过，没有用替代运行补救。汇总器误收该已跳过路径的首次 metadata 错误与纠正也单独[转录说明](evidence/root-assembly-note.md)，不补跑产品验证。其他分项的猜测地址只读诊断也与实际执行材料分开。旧失败的 fixture/平台/依赖方向没有恢复。

查重覆盖旧 audit/review/archive/_archive 的 Markdown 和逐层解析 JSON。Root 的全量目录扫描为 1,032 Markdown、512 JSON（126,651 string leaves，0 parse errors）；其他分项保留各自相关 corpus/嵌入 JSON 搜索范围与限制。旧 CDP visibility 剪枝、500 未扫描候选、JSON 编码预筛、cache provenance、RunStore append-lock/recovery 和前批 CostTracker 等均明确排除；未把关键词查重当作绝对语义穷尽证明。

四份只读交叉复审：[诊断](evidence/cross-review-diagnostics.md)、[Pet](evidence/cross-review-pet.md)、[模型目录](evidence/cross-review-catalog.md)、[Run 候选](evidence/cross-review-runs.md)。复审没有加测或产品修改；Pet 并发措辞收窄为本次实际观察与可能调度，报告收据同步更新，原始 logs/fixtures 不变。[最终材料检查](evidence/final-quality.md)记录来源、日志、链接、收据与整合边界。

审查期间 main 前进至 `3f9fcfdafece38ee21715431e05477201e4e55d4`，14 个路径属于其他任务的 Desktop native-path/UI、AppImage 验收、CI 与文档。已快进当前任务分支，静态确认本批直接缺陷/候选源码未变，见 [main source review](evidence/main-source-review.json)。[初始快照](evidence/integration-before.json)与[最终整合前快照](evidence/integration-before-final.json)确认主工作区现有删除、tracked/staged diff 与 4 个未跟踪文件字节均保留。

本批没有真实模型、付费 API、账号、用户数据、外部消息、原生应用/PTY、认证/权限/security/custody/watchdog 实验，没有共享 dist/依赖重建或全仓 build/typecheck/lint/test 声明。模型目录断言仅证明冻结数据内部一致，不核验当前外部厂商能力或价格。另一个 `codeshell-panel-apps` 仓库未在本批全量审查。
