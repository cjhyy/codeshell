# CodeShell 第二十二批审查

冻结点 `ab258c3f534b19014b2ed85da3111649f166ab86`。本批新增 **1 个 P3、0 候选、0 新关联问题**，只记录，未修改产品。全仓审查目标继续，不能由本批叶子测试推断全仓无 bug。

| 方向 | 结果 | 实际验证与边界 |
| --- | --- | --- |
| [错误提示](friendly-error.md) | ERROR-R22-01：额度类 429 被改写成临时限流，丢失原始原因和正确处理建议 | 12 focused / 25 expect；实际 helper + 轻量异常类。provider 包装和传播链静态，官方错误合同另存，未运行 SDK/模型/额度耗尽/重试 |
| [预算及阈值](budget.md) | 0 新问题；旧 token-budget 控制和分支疑点不重复计算 | 8 pass / 17 expect = 4 existing + 4 focused；实际 reactive 叶子，真实压力与 TurnLoop 只静态 |
| [会话标题](title-report.md) | 0 新问题；手工命名保护与 title-only merge 是当前静态反证 | 12 focused / 34 expect；实际 title 叶子及 owned callbacks，未执行 Engine/rename/store/IPC |
| [terminal-ui 提案](terminal-frontier.md) | 0 新问题；1 条 banner 算式线索保持未分类 | 0 产品尝试；有顶层初始化且未建立普通消费者，未强行导入或抽取函数验证 |

三次首次守卫 shard 合计 **32 pass / 76 expect / 0 fail / 0 skipped**，其中既有 4、focused 28。原始合并 stdout/stderr 与退出收据均先保存后阅读，0 产品重跑、0 fixture 修复或失败方向替代验证。characterization 的通过只确认当前行为，缺陷未修复。执行命令及逐项边界见 [validation](validation.json)，正式登记见 [findings](findings.json)、[candidates](candidates.json)、[related](related.json)。

错误记录仅确认“原因/建议丢失”这一限定影响。OpenAI 官方当前说明中，429 既可为暂时请求限流，也可为余额或支出/使用额度问题；这是该普通触发的外部依据，见 [官方错误说明](https://developers.openai.com/api/docs/guides/error-codes) 与 [精简事实收据](evidence/root-external-contract.json)。没有对所有 compatible endpoint 作通用合同保证，也未实测 SDK 错误实例、网络请求、计费、重试次数或等待时长。错误要在中间重试或 fallback 最终未恢复并继续传播时才显示该提示，并非每次 429 立即显示。

去重扫描 docs/bugs 的全部既有 MD 与递归 parsed JSON 标量，含 archive/_archive、排除本批；读取时共 **2,232 文件 = 1,202 MD + 1,030 JSON，309,994 字符串叶 / 436,035 全标量，0 解析错误**。匹配计数、保存上限及已选读语义在各方向收据分别说明；宽泛 429/A12/title 等会匹配行号、统计数或 SHA，不等于新增问题，也不宣称历史语义穷尽。

一次独立 Node SDK 包导出元数据查询失败，该方向直接 SKIP，0 SDK/Bun 运行；不能据此断言 SDK 缺失或 Bun resolver 失败。它与实际零依赖 helper 测试无依赖。旧失败路线均维持跳过。元数据导航、输出截断、title 收据排序订正另见 [Root notes](evidence/root-metadata-notes.md) 和各作者收据，不算产品失败或验证覆盖。

没有真实模型/付费 API/账号/用户资料/业务网络/外部消息/native/PTY/权限/security/custody/watchdog/身份实验，没有共享依赖/dist 重建、build、typecheck、lint、完整 suite 或 E2E。现有 mixed friendly/Engine-title 套件未运行，其中安全相关 case 只静态阅读；未恢复旧 TUI Diff、sliceAnsi、i18n、文档 parser 等失败方向。

本批在独占 worktree 的 `codex/audit/engine-budget-title-errors-round22-20261017` 工作。结束刷新时 main 并行前进 22 个提交到 `7e5570210d7e9336cbe9d6a90ed375832e7e3329`，涉及 20 个 CI、Desktop/Web 验收脚本及既有发布记录路径，与本批新目录分离；本批选择的源码字节未变。初始与集成前主 checkout 快照只有 HEAD 不同，原有删除和四个未跟踪文件的字节/hash 保留。该变化不触发产品重跑，不将并行验收当作本批验证。见 [initial snapshot](evidence/integration-before.json)、[integration plan](evidence/integration-plan.json)、[source manifest](source-manifest.json)、[source status](addressed-sources.json)。

交叉复核与元数据检查见 [错误提示 review](evidence/review-friendly.md)、[预算 review](evidence/review-budget.md)、[标题/terminal review](evidence/review-title-terminal.md)、[Root QC](evidence/root-qc.md)、[汇总 review](evidence/review-aggregate.md)。最终文件 hash 索引见 [evidence index](evidence-index.json)，作者收据核验见 [worker integrity](worker-integrity.json)。最终暂存、提交和主 checkout 的逐字节比对收据保存在本轮归属的 `/tmp/codeshell-audit-20261017-round22-stage-verification.json` 与 `/tmp/codeshell-audit-20261017-round22-integration.json`，不将不存在的未来提交 SHA 写进本文件。
