# Round32 selection 独立复核

支持 [selection作者报告](../selection-report.md) **0 formal / 0 candidate / 0 new-related**。当前producer顺序直接反证“loop开始就写boundary而切掉assistant”的初始前提；没有建立普通context选择错误。picker按真实user锚定任务，Core boundary按模型迭代关闭，两者不能混为同一语义单位。

## 原独立审查及范围

[原review](selection-review-prep/review.md)在读前固定source，完整阅读contextSelection218、modelSelection21与context tests223等小文件，精选MessageStream/Core producer与summary后端；共16个语义source/contract rows，1709行产品/测试、86行旧报告，另3项仅hash。正式化复用这同一次阅读，**新增source语义阅读0**，没有将重叠作者范围相加成独有覆盖。

决定性反证：finalizeModelTurn仅在completed标记后幂等关闭；普通assistant结束与tool-result持久化分支先于相关finalize。前端finish遇到无新真实user的segment会并入previous task，推进toEventId。MessageStream拒绝liveTurnActive后读取raw，按durable anchor alignment生成closed范围，再提交summary fork；不是用显示行号猜事件范围。

本reviewer独立额外跟随preload→protocol→Engine→SessionManager→Transcript：summary先选择再摘要，后端要求端点各唯一且顺序正确，按inclusive slice克隆，不静默扩展；工具配对校验显式拒重复/mismatch/orphan/unfinished。没有实际fork或模型调用。**这些backend片段是本独立review范围，作者仍明确保留其backend未读限制，未替作者增加覆盖。** source未证明全生命周期、取消、身份或恢复流程全部正确。

历史R74/C18-1摘要取消/超时与旧busy-fork失败是其它既有原因，不重报、不恢复动态验证，不借旧pass。model helper无已建立的实际UI调用者；同SHA旧R13审查不是历史未读的证明。测试声明只作静态合同。

## 正式元数据核对

正式baseline/branch由Root提供为4be4016b8661c6a10c60f4eb0f218552b4b7c5d0 / codex/audit/selection-taskparse-round32-20261017，reviewer0 Git，Root独立绑定source blob。13份独立prep已 [逐字复制](review-selection-copy-receipt.json)，原peer parent4dad、review起始4be上下文、时间/history与首次metadata诊断不变。作者10份prep也逐字匹配；作者10个formal source rows逐字段等于其prep，当前字节/范围均正确，late-null不倒填。

作者freeze后先pin再读formal报告/metadata。9份active收据artifacts和receipt自身全部匹配；报告10个本地链接有效。自己的 [source/check manifest](review-selection-source-manifest.json) 将16个实际source rows与current32 artifacts分列，不声称本轮报告/JSON是4be原始blob。

正式历史库存与独立prep的2988个row完全相同：1304MD/1684JSON、645399strings/957193scalars。作者原2921项未变，仅增冻结31的67份，排除32。作者59/60/2与独立19/303/2使用不同regex，不能互借计数；formal阶段只核metadata/差集，没有重复产品语义读。原review只读exact19、broad前20与failed2 contexts，不声称历史语义穷尽。

原审计一次no-match rg，以及scope finalizer把已完整读出的19行raw-api错记1–20后被EOF断言拒绝，均在prep中透明保留；只按原pin的正确EOF完成bookkeeping，没有重读source、产品失败或fixture重试。三个旧报告专门pin晚于scanner excerpts，initialSemanticReadSha256=null照旧。

作者与reviewer均 **0产品/import/函数/语言fixture/测试/真实fork/用户数据/native/模型/网络/Git执行，0pass/expect**；没有authority/auth/identity实验。没有未解决的分类或metadata问题。该negative只限声明的普通合同范围，不是全仓无bug结论。
