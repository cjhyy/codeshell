# 本批前沿选择与范围

第24批是持续目标中的进展，已提交8b9677c78：19脚本/workflow、7776行静态审查未确认新问题，0产品运行；独立review与89份材料、172源pin的最后集成收据另存。没有将全仓目标标为完成。

本批选中 `runtime/output-clean.ts` 的普通CRLF可见文本处理。提案阶段只有源推导；actual叶子的一次guarded字符串验证由独立作者负责，Root不运行另一份复现。真实后台进程/manager、BashOutput或协议只静态读调用链，不能从纯字符串结果推出实际Windows、进程或完整LLM流程已测试。raw保留与cleaned projection分开，不声称磁盘日志损坏。

Root与作者初筛都再遇到 memory-sort 的有效时区字符串排序，这是既有 OM3 且旧整组失败，排除新计数和动态恢复。simple-diff的CRLF文本不变量已有round19 17/57控制，O(n*m)只有旧静态观察；全部排除，不重复小文本suite或压力实验。SectionCache已有round5实际覆盖；Root读相邻prompt-cache/diagnostic等仅作前沿导航，未建立独立普通producer违约，不造候选或重跑旧baseline。

[data proposal](evidence/data-prep/proposal.json) 与 [root negative proposal](evidence/root-prep/proposal.json) 逐字节copy，原提案时点70d2e与本批冻结8b9677产品字节重核见 [copy receipt](evidence/prep-copy-receipt.json)。copy/rehash不是新全文阅读或运行；其中历史库存含读取时尚未提交的round24，不把旧材料中的pass统计变为当前通过数。全历史作者扫描与总命中/保存context分别保留，关键词不证明语义穷尽。

Root先前静态导航错猜 `builtin/bash-output.ts` 不存在，rg exit2已在 [navigation note](evidence/root-prep/navigation-note.json) 保留；随后按真实库存与内容搜索定位 `background-shell-tools.ts`，只读BashOutput与protocol output段。没有加载产品或重复失败动态方向。其它metadata错误原首响应也随prep保存，不把未知exit重构成实测值。

Git写归Root，仅修改本批审查材料，未改产品；沿用独占worktree并从刷新后的origin/main建新分支再FF最新本地主线。后续最终合并要重核source SHA、incoming路径与主checkout dirty快照，保持用户删除与四个untracked文件字节。

Link/Host 负提案也已 [原字节保存](evidence/link-prep/proposal.json)：27实际库存、24阅读pins（19full/5selected，含文档/入口），10作者材料+原收据。旧HL-01/02/HL-C1与既有Host6/22父记录保留，不跑旧baseline、不新增bug/候选/关联；manifest/lookup/locale/recipe等有限普通producer范围没有新反例，真实凭据路由仅静态。历史2452与data2451的读取时点/partition不同，不拼接成一次库存。24pin重核仍为hash/provenance，作者未作Git写或自行建branch；Root当前round25新branch另由integration plan证明。
