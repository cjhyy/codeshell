# CodeShell 第二十六批审查

冻结 `6d61f57ade1ef1b9fdc4d33020652007d995e7a7`，本批 **新增2个静态确认问题：1P2+1P3；0候选；1条旧问题关联**。没有修改产品或执行产品/测试。持续全仓目标仍active，本批不是全仓完成声明。

| 问题 | 正常触发与源码后果 | 记录 |
| --- | --- | --- |
| TUI-R26-01 / P2 | `/branch feature-cache` 的名字内部`-c`被当创建flag并删掉，源码请求`checkout -b featureache`；不是用户期望的切换名称 | [Branch报告](tui-branch-report.md) |
| RENDERER-R26-01 / P3 | 多文件turn快照包含根文件`__all__`时，该文件与“All”同值，无法只选它；viewer与AI草稿两个消费者同一根因 | [Renderer报告](review-renderer-report.md) |

两项均为直接普通producer/状态/调用链的静态因果确认；没有观察真实Git创建/切换、UI点击、Radix异常、提示送达或磁盘/提交损失。source-inferred argv不是实测argv，普通对照不是passing tests。所有产品/import/test/fixture/VM/AST/React/browser/native/业务Git/模型/网络/账号/真实HOME/权限security/custody/watchdog/身份尝试均0；Root Git metadata/workflow用于文档隔离与集成，不能笼统写全任务0Git。[validation](validation.json) runs=[]、pass/expect=0，**不是一次零失败门禁**，无产品raw/exit应存在。

[Target报告](review-target-report.md) 深读新scope/quote parser与prompt，未确认新的target缺陷；全参数空白压缩已是旧CLI-R4-01且原组失败，当前Review consumer只登记 [TARGET-R26-R1](related.json)，不升级原候选、不重跑。PERF别名的新TUI parser反证不等于旧public parseDimensions整体修复。服务/多仓库/范围/快照方向 [Service报告](review-service-report.md) 也未建立新违约，partial-error、empty、binary、size等反证明确；现有测试只有静态声明。Source范围按各作者full/selected/导航列出，不把新Review17/28路径或全部传递依赖说成全覆盖。

[Branch独立复核](evidence/review-tui-branch.md) 与 [Renderer独立复核](evidence/review-renderer.md) 分别核合同、反证、唯一因果、来源与材料。Reviewer额外props桥单列 [4项来源](evidence/review-renderer-source-manifest.json)，并不虚称作者16pins新增运行。当前所有新问题都是冻结点source证据，详细原报告中的行号和作者pin绑定该版本。

结束main另前进1commit/17paths至 `5e10a7e19734cfebd940fc11020bab3600b6e802`。9个选定源码/测试字节变化，Root完整读这些差异；另8路径只库存，没有新helper/fulltest/修复验收。Branch段不变，ReviewPanel的同值碰撞仍在当前 [329行选项](../../packages/desktop/src/renderer/panels/ReviewPanel.tsx:329)、[212行snapshot](../../packages/desktop/src/renderer/panels/ReviewPanel.tsx:212)、[424行viewer](../../packages/desktop/src/renderer/panels/ReviewPanel.tsx:424)。[delta](evidence/main-source-review.json) 和 [完整选定补丁](evidence/main-selected.patch) 保存old/new SHA；[findings](findings.json) 附最新行界，作者原冻结SHA不覆盖。不能要求所有最新current仍等于旧frozen。

全历史去重覆盖prior docs/bugs全部MD与递归JSON值标量，含169份archive/_archive路径材料、排整轮26：读取时2509=1241MD+1268JSON，426811 strings/609678 scalars，0parse。Root的branch12次命中全保存，广query174只留100；其它作者匹配/cap分别记录，不能把关键词零命中当语义穷尽。两份不同时间 [旧负提案](evidence/prior-negative-prep/proposal.json)、[target负提案](evidence/target-prep/proposal.json) 原字节保存共20文件；15prep pins只hash/provenance重核，不算新15份全文读。初语义SHA没保存的proposal保留null，Root新冻结匹配不能倒造旧读取时刻证明。

初始后已有一个未跟踪environment JSON被其它活动更新；后来HEAD也随并行main推进。[初始快照](evidence/integration-before.json)、[中途观察](evidence/integration-refresh-observed.json)、[最终集成计划](evidence/integration-plan.json) 分时保存，**不声称全程四个untracked字节完全不变**。最终FF以最新premerge快照为准保全dirty，tracked删除和其它原状态保留；不推断或改写该JSON内容。两个metadata Assertion（snapshot漂移及concurrent source equality）与导航首次响应分别保存，不是产品失败或产品重跑。

[源清单](source-manifest.json)、[材料核验](worker-integrity.json)、[来源状态](addressed-sources.json)、[RootQC](evidence/root-qc.md)、[聚合复核](evidence/review-aggregate.md)、[证据索引](evidence-index.json) 约束最终范围/bytes/hash。Root仅暂存本批文档及静态证据，0产品log，full/nonlog whitespace与stage/commit/primary逐字节和最新dirty保全收据另存 `/tmp/codeshell-audit-20261017-round26-stage-verification.json`、`/tmp/codeshell-audit-20261017-round26-integration.json`。不push，独占worktree继续用于持续目标。
