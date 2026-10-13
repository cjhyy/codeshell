# 正式发现证据入口最终只读核对

时钟核对：2026-10-12 SG10:46:36；补链后最终核对 SG10:47:38（UTC02:47:38）。结论：R01–R54全部能映射到实际报告文件及正确heading，未见不同轮次同号误链、编号/级别冲突；R55–R86现有文件级链接全部目标存在。新增发现/产品import/fixture/test/native/Git/模型/网络执行均0，未修改README、产品或报告，只写本/tmp稿与标准库核对收据。

独立核对作者映射 early-evidence-mapping.json（SHA c9d6de4f77d838b5db7a6610abd9ff5773a26f0860f430149fafd9a518469f15）的全部54行：17实际文档，每个targetFile存在、headingLine的整行文本与mapping一致；另按独立建立的R编号→文档/局部编号表逐项核对，0冲突。所有有级别heading均与README当前级别一致，R29现P3降级标签正确。README正式表86编号连续且唯一。

四个重点入口正确：

- R35 → desktop-round3.md:27，D13/P1，重复Enter/worktree回滚，不是较早Desktop D项。
- R42 → credentials-round5.md:5，C1/P2，Cookie新增覆盖，不是第十一轮download的同号C1。
- R36 → runtime-round3.md:40，T3/P2，worker stdin异步EPIPE，不是T1终态写盘或T2 Panel进程退出。
- R21 → README.md:136“新会话首次运行中的恢复不能裁掉日志基点”，正文138明确R21；它是主报告内独立分析段，不应创造不存在的root附录文件。

还需保留四类非机械ID标题：R30/T1与R31/T2实际runtime标题没有T1/T2文本；R39/F1在files-round4.md:9的成功归档恢复提示段，标题没有F1；R49在collections-round6.md:5的共享资料集跨文件子错误恢复段，标题没有R49。对应正文与正式问题语义已核，不应因header没有局部ID就误判无证据。Quick Chat实际文件名为quickchat-round8.md，Collection为collections-round6.md。

补链后README已实际有86个正式行的证据链接：早期54条target与同一mapping逐项一致、完整evidenceLabel一致，0冲突；R21唯一self入口为README.md:136，其他53条均为正确文件级链接。R55–R86所有目标仍存在。最终link-only README SHA为3ceff228111efad03cbae59fe35c980ee0b845f9db434d5a2016ebe1025a4146，与主审给定版本一致。该导航补全不改发现本身、不增实验或恢复能力；本次没有重读706日志或再次执行6286测试。主审后续只追加footer/progress时，表格对应关系无需重建。

[逐项heading/路径收据](/tmp/codeshell-review-20261012-evidence-entry-quality-final.receipts.json)。本次只做文档读取、字段比较与哈希；没有全量rawlog复核或新增candidate。
