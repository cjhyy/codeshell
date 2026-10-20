# 第21批聚合独立复核

结论：接受本批**0新正式、0新候选、1旧source-concern关联**与**56pass/193expect、8existing+48focused、0fail/skip/rerun**。审查四分区报告、4scope reviews、聚合README/coverage/classification/validation/source/integrity/index、实际fixture/raw/exit、integration snapshots/plan；只读源码与Git blobs，不导入产品、不运行测试、不改作者材料、无Git写。

本次复核写入前，实际batch有81文件、80indexed（仅index self排除）；逐个计算bytes/SHA，路径集合精确相等、全部匹配。39unique frozen/current/main source pins以实际文件和两个Git refs核验，40worker source entries与聚合pins一致；49author receipt artifact entries和worker-integrity49项均匹配。全部Markdown共81个本地链接/行号存在且在界内。source/hash核验不等于深读全部大文件或运行其消费者。

四个raw逐字节核hash，validation与index一致；exit中有rawSha256/rawBytes才比较，Root exit未含rawSha256，未补造字段。command/argv按实际schema读取，四条命令均为守护runner且30s参数；first attempt1/exit0、raw Completed与每组7/17、15/30、16/52、18/94一致。合计56/193、8existing+48focused，无失败/跳过/重跑。fixture与preflight/author artifact证据一致；本复核没有重执行这些命令，也不能由现存hash独立重演先保存后检查的时间顺序，保留作者首跑收据声明。

分类与范围没有扩大：NDJSON仅显式ownedstreams，无真实CLI consumer、默认stdin、timer/schema/approval/auth；JSON是真实classes/factory/chalk配合未调用Text依赖stubs及finally恢复stdout spy，旧A12和reuse误报排除；Prefix只实际普通normalize/list，validator/branch ownership/native未恢复；Budget是真实leaf+heuristic，8existing含既有Unicode/默认cap控制。关联BUDGET-R21-R1的302slots/602separator chars与301slots/600控制是手工合法输入下的真实函数现象，实际caller正600/200仅静态证明，普通302slot producer与aggregate gate未证明。旧round4是source concern而非带严重级别正式ID，聚合未声称默认预算600、真实provider拒绝、修复或新候选。

全历史2169=1189MD+980JSON、288528strings/404370scalars、0parseerror，以及总matches/context caps/旧语义记录/读时库存界限，在报告和scope材料中分开；不能用关键词或零项证明全仓已无bug。metadata猜测/输出截断/anchor范围修订有披露，未触发产品替代验证或恢复既有失败方向。

初始/premerge/plan.primaryBefore三份对象完全相同，独立重取当前primary快照亦完全相同：HEAD仍615e4e4dd3a61b1ad132ab4f3683985a0d582386，原删除/status、tracked/staged diff hashes及4untracked路径/bytes/SHA均保留。当前ownedHEAD/main与冻结点相同，base..main0commits，plan外部提交/路径为空。这里只证明复核时点，后续staging/commit/primary FF gate、incoming仅owned/disjoint、dirty前后比对、staged/commit/primary blob匹配和最终receipt仍需Root实际执行，未把plan当完成。

没有要求作者修订的阻塞项。本文件是预期新增元数据：当前index在写入前有效，Root必须加入本复核并重新生成/核验index及最终file/link计数后再stage。没有push、产品修改、全量suite或全仓完成声明。
