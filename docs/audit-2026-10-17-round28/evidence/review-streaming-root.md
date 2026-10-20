# STREAMING-R28-01：Root 独立静态复核

支持 **1个P3静态formal，0候选**。Root独立全文读 fence-aware leaf124、消费组件173、component test83、AssistantMessageView98，选读types的建立/文本累加/完成标记与旧设计/旧prompt报告。精确范围和SHA在 [review source manifest](review-streaming-root-source-manifest.json)；只读，不调用函数或React/parser/Markdown库，不恢复任何旧失败方向。

普通输入和源码反例成立：围栏内两段普通代码以空行分隔，围栏已经闭合，后面仍有tail prose。叶子追踪围栏状态，选择闭围栏之后的blank boundary，因此整个代码块位于 stablePrefix。随后组件143–148无条件按两个以上newline再split，将其变成 `opener+first line` 与 `second line+closing fence` 两个独立文本。每个文本单独交给ReactMarkdown，不共享fence上下文，违反同处“self-contained closed blocks / separate parse equals whole parse”的明示合同。这些边界是手工源码推导，没有执行JS/Python镜像、eval、AST/VM或产品helper来补观察，也没有HTML/截图可声称复现。

实际调用链不是人工无效DTO：types在stream start创建done:false并原样累加普通text_delta，AssistantMessageView对非空文本转发message.text/done，未关闭默认rich。消息只需在闭合围栏之后继续流一段prose，throttle缓存可包含该完整前缀而done仍false；没有做真实时序实验，不声称每个短响应都可见。完成时done:true直接交全文Markdown，不再走splitIntoChunks，可恢复完整结构。原始message.text、磁盘、clipboard均不修改；stream本来无代码copy控件，不扩大为复制或最终内容丢失。无内部blank的闭块、未闭块activeTail、rich=false原pre均为反证。

独立阅读最终作者报告/finding/边界，并逐一核 [作者 receipt](streaming-artifact-receipt.json) **12份材料** bytes/SHA相同；report6622B/SHA `9b58f8e86a18e917a3a8c01124ff1bd5216ef3af61f8b556d4cf184f4b3ae643`。作者26个现有test声明全未执行；所有raw/runs为空，不借R27failed compose shard或旧parser绿色测试支持本项。Root没有修改产品或运行新fixture。

[独立历史查询](review-streaming-root-dedup.json) 重hash相同2677文件库存，再对MD全文/JSON value scalars搜索，chunker58与streaming47总命中均低于60 cap，全部上下文保存。很多blank-chunk词属于旧ApplyPatch文法，不是此renderer机制；Root选读旧plan608–628和R19旧报告：C4建议memo chunk，C1要求不拆fence，其组合未解决二次切块。C2reference/footnote是明示已知限制；R19固定外层prompt fence/UTF16是另一producer，并非本次原来有效closedblock被拆开的原因。正则检索和选读不证明全历史语义穷尽。

唯一metadata locator误写旧report文件名已在 [notes](aggregate-metadata-notes.json) 标出人工diagnostic摘录，outer0与未捕获innercode分别保留；随后使用rg实际库存路径读取，不是产品失败修复或验证重跑。全部结论只限本次源码范围，支持保留该P3，产品未修。
