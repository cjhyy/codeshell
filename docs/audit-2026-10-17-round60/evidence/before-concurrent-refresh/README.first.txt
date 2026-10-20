# 正式60：构建入口、资源复制与发布元数据

有限结论 **0新增正式问题、0候选、0新关联**。历史仍为 **118项：45P2、73P3**，见[全部问题](../audit-2026-10-17-round58/ALL-ISSUES.md)与[机器目录](../audit-2026-10-17-round58/recorded-findings-catalog.json)。这是历史记录数，不是当前未修复数。

| 有限包 | 实际检查 |
| --- | --- |
| [150 build meta](evidence/build-meta/report.md) | 当前root exports/bin与shim生成目标、core/tui声明入口、root build顺序；旧R24/R31同SHA全文重叠保留，未运行build/CLI |
| [151资源复制](evidence/copy-assets/report.md) | 三包真实copy参数、来源资产及runtime读取路径；旧zero-match已处理原因不重报，实际复制/删除/构建均0 |
| [152版本检查](evidence/release-versions/report.md) | 当前15声明包与目录、版本/依赖/lock输入及普通bump→verify→发布前置调用；旧A11标签推送排除，未运行发布或改lock |
| [Root153清单分类](evidence/root-release-audit-config/report.md) | config297全文静态+两consumer选段共448语义代码行，494显示；root/core/web三个manifest属性投影。non-code、types-only与runtime分别消费，不扩成全发布正确性 |

旧范围、完整显示、语义选段、JSON pointers、仅文件名/行号导航、hash与测试声明均在[原manifest分类](source-manifest.json)保留；行数含旧范围与consumer重叠，不能相加成新增唯一覆盖。测试声明不是运行通过。

[共享历史batch](evidence/root-release-audit-config/history-batch.json)纳冻59排60+、含archive：6126 MD/JSON、4322397递归JSON值scalar、0parse错。四目标109/34/33/57，cap100，build-meta仅前100；机器访问不等于全历史语义阅读，不能据没有命中认定未读或新颖。

本批[产品执行](validation.json)为0，不导入/运行产品/helper/build/test/install/publish/native/模型/业务网络；也不借R6的旧17pass。151/152导航输出截断与151首次将JSONC当JSON解析失败按原诊断保留，未捕获输出不伪造，后续只读有限原件；既有失败产品实验继续跳过。

106份prep原件逐字节复制，208条收据核验，12个冻结锚点；39个混合源/配置/指令/元数据pins不是同数新增产品全文。[复制回执](evidence/prep-copy-receipt.json)、[冻结检查](evidence/freeze-checks.json)、[Root复核](evidence/review-aggregate.md)、[证据索引](evidence-index.json)。首次整理输出和冻结空白例外均保留。

读取基线`c6a85ac1b69329f35bc1f6ff34d08070f91b1d96`，所有作者冻结后refresh main至`c6a85ac1b69329f35bc1f6ff34d08070f91b1d96`；[并发路径](evidence/incoming-main-paths.json)、[历史字节漂移](evidence/incoming-history-drift.json)按实记录，不倒填原query。只集成本批文档，保留主目录已有改动，不push。

[可靠覆盖台账](../audit-2026-10-17-round55/evidence/coverage-current/report.md)仍是旧45相同SHA迁移：4643路径、304完整范围/168部分/4171无法确认；4339不能标full不是精确剩余量。46–53仍DEFERRED_UNPARSED、54–60未统一回填，非TS/TSX和完整运行机制不在分母。[当前hash绑定](evidence/coverage-snapshot-current-binding.json)4643全同，库存4644，多出的1路径是旧57证据fixture。全仓目标active，未完成。
