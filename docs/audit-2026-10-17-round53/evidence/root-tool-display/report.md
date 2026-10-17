# Root111：工具摘要及Glob状态行计数

提出同一P3静态提案 **TUI-R111-C1**：CLI正常1文件成功结果的数字header和路径被算作2files；TUI普通零结果的“No files matched the pattern.”被算作1files，collapsed/expanded相同。没有实际运行工具、算式、helper、测试或TUI；仅普通生产字符串和真实显示分支的源码推导。原结果/搜索字节保留，不声称搜索漏项或数据丢失。[提案](proposal.json)。独立112是同一问题的定向复核，不另计数。

Root最初Core toolDisplay的compactOutput有相同形状，但实际TUI/CLI消费者自行实现摘要，因此未以一个无活跃consumer的helper建立影响。真正CLI TextRenderer64–72消费正常tool_result.r.result并传到compactSummary145–146；Core globToolDef name为Glob，84–85零结果返回成功字符串，103–117正常1–200输出“数字files matched:”header+实际路径。TUI ToolCallResult124–145排error/空结果后走renderToolOutput，244–261只删除数字header，其它非空行都被当成文件。显示字段确实回到152行summary，未展开FS/权限或terminal机制。

普通TUI1–200正结果已去header，是反例；CLI该分支没有去header。旧May30 JSON /123只是producer超过200结果缺header及单复数不一致，R7files22引用该旧格式项；它不是消费者把header/status算作文件的原因，给producer补header也不能修本提案。详情见[原对象区别](dedup-distinction.json)。旧R14 UTF16关联和Read字节标签不重复登记；R21 JSONsummary/NDJSONtimer、旧TUI/fixture失败均未运行或恢复。Windows驱动器路径是否满足当前支持合同留给113定向复核，不在此自动晋升。

正文前pin固定Core209行/6985B/SHA41ba468c…；[26scope投影](coverage-read.compact.json)已读，R14原MD只称五helper静态、R40/R43明确hash-only，未建立确定sameSHA目标全文，不能由unknown推从未读。当前全文静态显示209行仅是本次范围；可能与旧静态阅读重叠。支持消费者各自[预读pin](consumer-initial-pins.json)先于body/nav。

[范围](source-manifest.json)1full+3selected，407产品语义/577正文显示/0测试声明；terminal-ui同名本地函数只导航。源快照[Core](source-excerpts.json)/[消费者](consumer-source-excerpts.json)在实际显示后捕获，不倒填first-read；没有全局唯一覆盖升级。

[历史](history.json)5150=1489MD+3661JSON、2430509strings/3611347scalars，纳52排53+含archive。宽toolcause5024、path266/SHA60，各cap60不等于全读。[首Glob宽查](focused-history.json)87/cap60误召回global等上下文，60个有界窗口实际显示；[词边界精查](precise-history.json)15/15全部读完，见[实读](precise-read.json)。它们没有证明全史语义穷尽；准确原R7/May30对象另核，不拿宽搜索0或库存当不存在旧问题。

首次metadata摘录请求renderer到165而实际pin163，IndexError后止写，[原诊断](capture-first-diagnostic.json)保留；只改结束端为实际163，不重跑产品。另一次误猜可选R7files-related.json的rg报路径不存在、outer pipeline0，nestedexit未知，[记录](old-source-navigation-limits.json)明确未伪造pin。原stdout未另存之处只称工具转录。所有实际源pin与原5150历史字节[结束相同](ending-checks.json)。产品/helper/import/fixture/tests/React/DOM/clock/timer/model/网络/native/Git均0，仅自有metadata标准库处理；不修产品。
