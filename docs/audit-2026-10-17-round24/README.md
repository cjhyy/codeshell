# CodeShell 第二十四批审查

冻结点 `c9056c8047a8e75ab2469e59bf1d3fedd9ad7272`。本批为近期验收脚本的深静态合同审查：**0 新确认、0 候选、0 新关联；0 产品、测试、import 或 CI 执行**。没有修改产品，全仓目标继续；未发现足够证据支持新问题，不等于这些脚本已经运行正确或全仓无 bug。

| 方向 | 冻结点全文静态主目标 | 证据边界 |
| --- | --- | --- |
| [Workflow / packaged fixture](workflow-fixture-report.md) | 4 文件 / 1,143 行 | 接线、成功/失败与请求诊断；其它 close/settlement/receipt 只 full/selected，0 native/watchdog/信号执行 |
| [Windows NSIS](windows-report.md) | 5 文件 / 2,041 行 | 安装→两轮 UI→marker 替换→卸载→cache/final gates；0 PowerShell/安装器/Windows 运行 |
| [Browser helpers](browser-helpers-report.md) | 5 文件 / 1,511 行 | capture/exit/cleanup/verifier 合同；0 authority、browser、真实 HOME 或进程实验 |
| [Browser scenes](browser-scenes-report.md) | 5 文件 / 3,081 行 | Auth/SW/subagent 场景、失败锁存与收尾；操作/test 声明仅静态期待，不是通过项 |

合计 **19 个脚本/workflow、7,776 行全文静态阅读**；来源为 round22 并行提交的 20 个变化路径，另一个 release history 只选读。[target inventory](evidence/root-target-inventory.json) 分配每个方向。full static 不等于穷尽语义、传递依赖、所有平台分支或运行时正确性；其它阅读范围和 source pin 在作者 manifest 分别标记。

三份分审与 Root 均没有写/运行 fixture、测试、VM/AST 验证、浏览器、installer、网络/账号、真实 HOME、native/PTY、认证/权限/security/custody/watchdog/身份实验，也没有 build/install/typecheck/lint、全 suite 或 E2E。没有产品 raw/exit，因为本批尝试为 0；没有把旧 64 Node、31 browser、83 native、13 UI 或负例 2pass/6fail 纳入当前计数。[validation](validation.json) 的执行列表为空，不能读作一次零失败通过门禁。

主要未升级依据是实际正常 producer/合同反证：Windows step 只在成功后 push，最终 UI wrapper 与两轮 exit/settlement 并非只看一个 receipt.status；helper 的负例矩阵只证明选定 case/status 与保留，不能独证每个失败原因；generic settle 的 cleanup 授权由 caller 决定，既有测试明确允许 primary assertion 后尝试 cleanup，没有据未承诺的通用保留规则强造 bug。signal ledger 记录请求意图，不能解释为 OS-wide 信号送达证据。旧 Web report-after-removal 与 WEB-R5 等边界分别去重保留，未重新定级或恢复旧失败方向。登记见 [findings](findings.json)、[candidates](candidates.json)、[related](related.json)。

本批全历史去重包含 docs/bugs 的所有 MD 与递归 parsed JSON 标量，含 archive/_archive、排除本批；读取时 **2,375 文件 = 1,223 MD + 1,152 JSON；370,703 strings / 523,455 scalars，0 parse error**。总匹配、保存上限、选读父对象与噪声分别说明，不宣称关键词或 hash 等于语义穷尽。前批 [package 负提案](evidence/root-package-prep/proposal.json) 的 135 source/meta pins 仅重核 hash/provenance，不算新增 135 份阅读；没有用未构建 dist 制造错误或重开旧包边界失败路线。

结束两次刷新时 main 累计前进 **7 个提交（含 merge）/7 个路径**到 `70d2e3846ea48d0d797e51dbeac7026f563c76bb`，选定 workflow 增9行、发布文档累计增214行。冻结作者阅读记录保持 c9056；Root 只读 workflow 完整差异、第一次发布 diff 前115输出行与第二次前112输出行，新增其它5个脚本路径未被算作本批完整审查或执行。最终 [source manifest](source-manifest.json) 分别保存 frozen/current/main SHA，两个已知差异不能被误写成所有字节从头到尾没变。见 [main source review](evidence/main-source-review.json)、[source status](addressed-sources.json)。没有新修复验收或远程 CI 成功结论。

分支为 `codex/audit/acceptance-contracts-round24-20261017`，独占 worktree 已 FF 最新 main。初始/结束主 checkout 快照只有 HEAD 不同，原有 tracked 删除、diff/staged 状态和4个 untracked 文件的 bytes/hash保留；最终 FF 前后重新核验。见 [initial snapshot](evidence/integration-before.json)、[integration plan](evidence/integration-plan.json)、[worker integrity](worker-integrity.json)。Root EOF 上界1156/实际1155 的 metadata Assertion 已保留并仅修阅读范围，未改 source/fixture/raw 或运行产品；Git写归主审文档集成，其它作者/reviewer 无 Git 写。

独立复核见 [Windows review](evidence/review-windows.md)、[helpers review](evidence/review-browser-helpers.md)、[scenes review](evidence/review-browser-scenes.md)、[Root review](evidence/review-workflow-fixture.md)、[Root QC](evidence/root-qc.md)、[aggregate review](evidence/review-aggregate.md)。[evidence index](evidence-index.json) 对除自身外的全部材料存 bytes/SHA。最终暂存/commit/主checkout逐字节、whitespace 与 dirty 保全收据保存在 `/tmp/codeshell-audit-20261017-round24-stage-verification.json` 和 `/tmp/codeshell-audit-20261017-round24-integration.json`；不把未来提交 SHA 写入报告，不 push。
