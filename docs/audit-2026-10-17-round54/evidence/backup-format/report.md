本包对 output-journal-backup-format 的普通格式合同作有限静态审查，结果为 **0 新正式项、0 候选、0 新关联项**。没有建立正常 writer 产生、正常 reader 拒绝或错误重组的新反例；这不表示整个备份、恢复或存储机制正确。

当前工作树上下文由 Root 提供：正式53已冻结，HEAD 16c1a40c7e3f0cf7701fccd723293bfb1291f105。本作者没有调用 Git。源码只读，输出仅此 exact 临时目录。

正文前的 [初始 pins](initial-pins.json) 固定目标439行、16266B、SHA 98aaf46c9aa750189927786e834e47c1e39ae6b52cb77ed185dda0ac604e876a。fresh [历史库存](history.json) 纳冻结53、排54及以后，共5311件（1500 MD、3811 JSON），递归机器计数2575070字符串、3824469 scalar，169件具有 archive 或 _archive 精确目录组件，0 JSON解析错误。机器计数不等于作者阅读。

[canonical 原对象](canonical-gate-read.json) 保留 R23 source-manifest /sources/9 的限定：“incidental full static source during inventory; no semantic review”。R42 selection-decisions /decisions/0 又明确在正文前排除且不重开修复授权/身份机制。因此这里不能把旧 full display 升为旧 full semantic，也不能把 unknown、hash 或无 metadata row 说成历史从未读。[本次 gate 决策](gate-decision.json) 允许的只是正常 codec/entry 数据范围。备用私有 prototype id-index 仅有 hash pin，未选择、未读正文，不声称它是生产功能。

已建立的真实链和反证为：

- output-publisher.ts:11–15 导出 backup/restore/inspect；manual-repair.ts:548–558 正常 writer 写出相同 format/version/authority/floor/files 包装，561–562 随即交给 openBundle；401–410 是该读取入口的格式、版本与文件数判断，462–465 调用实际 verifyBackupChain。
- backup-format.ts:89–96 的 JSON/UTF8 与 barrier、160–165 的固定32768字节 storage wrapper 编码，与实际 parser 的长度/字段/摘要包装相配；这里只核数据形状，不认证摘要、身份或物理存储机制。
- journal.ts:1101–1139 先完整准备 event 或按64KiB切开的有序 fragment，1186–1205 构造 version2、递增 sequence 与同组 payload；1225–1233 的轮转判定先于1247–1254的整批 joined write。backup-format.ts:355–432 有对应 newline、序号、event/fragment互斥、分片顺序和完整组边界检查。选读代码未建立普通完整组必然跨段而被拒绝的反例；轮转实现与真实文件行为仍未认证。
- manual-repair.ts:986–989 的实际恢复分支也使用 encodeRepairStorage；两份既有测试200–229、290–318声明了完整与分段备份恢复后字节/输出/cursor断言。测试源码仅为声明证据，未执行，不能写成通过。

[范围清单](source-manifest.json) 记录4个产品文件 selected，产品语义388行；1个测试 selected，声明59行。合计447行不是全仓唯一新增覆盖。主目标439行确实整段显示，但 authority/header身份、lease、真实FS、inode/custody、安全等邻接内容不纳入本次语义结论，故 **0 产品 full**。source body显示881行，另有60行正文外导航，含导航显示941行；指令全文222行单列。逐段选读的 [源码文本](source-excerpts.json) 是显示后保存的可核对记录，不伪称先于阅读的全文快照，也不算第二次语义阅读。

历史 path/SHA/filename/oldcause 命中分别53/52/54/415，每query最多保存80；备用只作机器门槛，11/5/11/415。48个 compact 对象是路径/scope元数据投影，实际另核2个 canonical 原对象及 [5个有界历史窗口](history-selected-contexts.json)，未穷读全部命中或巨大 MD/JSON scalar。旧 archive 的 FileHistory/路径信任等窗口不作为本题普通 codec 新问题；R23/R42 机制排除仍保留，未开展旧 repair/authority 动态实验，也未制造坏JSON/任意DTO/Buffer语言fixture。

[首次诊断](first-diagnostic.json) 保留一次 metadata presenter 截断（原8113 tokens、预算4200、exit0、tool chunk b88820），后续只补读明确的5个窗口，未改原件或重扫来隐藏首输出。没有 fatal metadata exception 或产品失败。导航的 [来源说明](navigation-provenance.json) 区分原始持久stdout与 tool 输出行号转录；首个双 rg filename 命令只有 outer exit0，单独退出码未捕获，未编造。

[结束复核](ending-checks.json) 的8个源码/指令 pin 全同初始；5311件历史集合无新增、删除、字节变化。[验证口径](validation.json) 明确产品导入/函数/helper、fixture、测试、clock/timer、真实FS实验、网络、native/model进程与 Git 均为0。没有修产品或给修复实现作运行认证。只在本次范围内收口有限阴性。

[方法](history-method.py) 与 [元数据整理脚本](finalize-metadata.py) 仅处理审计文本、JSON、hash和范围；最终 navigation provenance/count 补充也是元数据记录，未执行作者以外的产品或测试脚本。[分类原件](classification.json) 与 [冻结收据](reviewer-receipt.json) 保存终态。
