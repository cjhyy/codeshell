# CodeShell 第二十五批审查

冻结点 `8b9677c78d150abe9681a2f65ab8e55b1288be4b`。本批 **新增1个P2，0候选、0新增关联**：普通CRLF完成行在后台输出清理中丢失正文。没有修改产品，持续全仓目标仍在进行。

[详细报告](output-clean.md) 与 [结构化问题](findings.json) 记录具体输入、实际结果、正常消费者、反证与去重。最短实际叶子样例 `ready\r\n` 变成 `\n`，两行CRLF只剩两个换行；混合输入仍保留LF行。四个字符化样例属于同一根因，合计一个问题。影响限定在cleaned agent-facing正文；raw ring/disk并非被清理函数改写，也没有证明真实Windows/后台命令/完整LLM流程已执行。

首次guarded Bun分组 **13pass /23expect /0fail /0skip，Completed**，包括既有7项和新增6项（4个当前错误字符化+2个LF/裸CR正常控制）。通过的字符化明确锁定当前错误，**不表示已修复**。[首份raw](evidence/output-first.raw.log)、[exit](evidence/output-first.exit.json)、[fixture](evidence/output-crlf.test.ts)、[wrapper](evidence/output-run-first.py) 已先保存merged stdout/stderr及exit再读取，没有重跑。只有实际output-clean叶子被产品运行；真实manager/tool/protocol、ring文件和producer均静态读，不加载Core barrel。既有7项包含原有有限ANSI控制，新增fixture只有短ASCII CRLF/LF/裸CR；不重开旧ANSI/OSC、sliceAnsi、CLI/Skill parser失败方向。

[静态独立review](evidence/output-static-crosscheck.md) 核正常raw→ring→clean→BashOutput链及既有合同，[原始证据review](evidence/review-output.md) 独立核fixture/raw/hash/计数和最终作者材料；review不运行另一份复现。代码中incremental推进raw cursor与all模式也清理仅是源证据，不扩大为进程/权限/安全/资源生命周期实验。

本轮另保存 [Link/Host负提案](evidence/link-prep/proposal.json) 与 [前沿选择](frontier-selection.md)：实际库存/有限全文或选段阅读没有建立新普通producer反例；旧HL、OM3 memory排序、simple-diff成本与旧控制等均去重排除，不为凑数量重跑旧baseline。24份prep copy与47source重核记录在 [copy receipt](evidence/prep-copy-receipt.json)，是原字节出处与hash验证，不等于又读47份全文。Link/data/Root和独立review历史扫描在不同时间点，分别保存MD/JSON/string/scalar计数与总匹配/context cap，含archives，不合成为一次库存或语义穷尽证明。

没有真实模型/付费API/账户/消息/业务网络/native/PTY/installer/浏览器/真实HOME/认证权限/custody/watchdog/身份实验，也没有build/install/typecheck/lint/fullsuite/E2E。guard runner本身的隔离HOME与结果写入不是产品真实进程或磁盘日志复现。旧失败方向继续跳过；metadata导航/语法错误首响应独立保存，不当作产品失败或修复后重跑。

[源清单](source-manifest.json)、[验证](validation.json)、[材料核验](worker-integrity.json)、[来源状态](addressed-sources.json)、[证据索引](evidence-index.json) 分别约束读/运行/字节证据。[RootQC](evidence/root-qc.md) 与 [聚合复核](evidence/review-aggregate.md) 记录最终计数及边界。Root拥有Git写入，仅暂存本批文档/fixture/原始证据，精确force-add唯一owned raw，不修改已有删除或用户资料；最终暂存/提交/主checkout逐字节与dirty保全收据放在 `/tmp/codeshell-audit-20261017-round25-stage-verification.json`、`/tmp/codeshell-audit-20261017-round25-integration.json`。不push、不宣称全仓完成。

结束刷新时main并行新增1commit/28paths到 `d9d2c33ddd1b2edea28a719e4cd0a505a96c0b08`。选定pin中只有Desktop main/index.ts增8行，Link作者所读catalog行段逐字相同；Root只读此完整补丁，另外27路径未算本轮完整审查或运行。实际清理叶子及消费者不变，不重跑。作者冻结SHA保留，最终current/main与frozen分列；[source delta](evidence/main-source-review.json) 和 [integration plan](evidence/integration-plan.json) 记录主checkout除HEAD外dirty完全保全。
