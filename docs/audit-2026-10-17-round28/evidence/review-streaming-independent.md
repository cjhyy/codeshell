# STREAMING-R28-01 第二份独立静态复核

支持 **STREAMING-R28-01 /P3 静态formal**，0新增候选，不另计同根因问题。本review只新增本文和 [独立source manifest](review-streaming-independent-source-manifest.json)，未修改冻结作者12份材料、Root8份材料或Lab prep15pins；0产品函数/import/parser/React/测试/fixture/VM/native/Git/网络/模型执行，没有运行Root verifier或函数镜像。

实际独立阅读全文：fence-aware leaf124、StreamingMarkdown173、AssistantMessageView98、leaf test151、component test83；types只读1065–1110、1153–1210、1807–1872，Markdown只读155–190。产品/测试合同共835行。另读旧plan608–628、walkthrough126–155、R19报告全文27、parseDocument skip全文13，共91行历史合同。独立manifest在本review重读这些声明范围之前先持久化11个filesystem SHA，阅读后finish11逐项相同；这不是原作者的read-time证明，也未声称独立执行Git blob绑定。

[组件143–148](../../../packages/desktop/src/renderer/messages/StreamingMarkdown.tsx:143) 的第二次分块直接对整个stablePrefix使用连续newline分隔符并trim，没有fence状态。作者例子是普通闭合js代码块、内部空行、围栏之后仍有prose tail。手工逐行核 [leaf81–123](../../../packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts:81)：内部空行处openAfter为true，不是最终稳定切点；闭围栏之后的空行处为false，故完整闭围栏进入stablePrefix。第二次split却把它切成一个只有opening fence/首段代码的字符串，以及另一个含次段代码/closing fence的字符串。组件128–129逐块创建StreamMarkdownChunk，每个167–172又单独调用ReactMarkdown，不共享fence上下文。这与140–142的“完整自包含闭合代码块、单独解析等价于一起解析”合同直接矛盾。输入结构和值流足以支持该有限P3，无需猜测某个库最终具体生成多少HTML节点。

普通生产可达性成立：types的stream_request_start创建done:false，text_delta既可给当前assistant累加原文，也可在旧slot已done时建立新的done:false消息；AssistantMessageView63–70原样转交text/done，没有关闭默认rich。throttledText可在消息未结束时包含这个已闭合前缀，随后还有正文继续流入。仅当这一阶段实际被呈现才有可见影响；没有做120ms时序实验，不声称每个很快结束的响应都会出现。done:true在组件50–58直接把同一完整text交给Markdown，绕开chunker；rich=false、无内部空行的闭块、未闭fence留activeTail均是有效反证。

影响只认领富流式阶段的代码块结构：这里不改message.text或持久存储，也没有clipboard写入。StreamingMarkdown160–163本来就延后代码块copy/collapse；AssistantMessageView71的footer copy仅在done后出现并读取完整message.text。因此不扩大为最终回答损坏、代码丢失、复制错误、依赖失败或安全问题。leaf18/component8合计26个既有测试只是声明，本review没有借其源码期望冒称通过或动态观察。

查重独立读了作者 [历史决策](streaming-history-decisions.json) 和对应旧父文。C4为性能建议blank-line memo chunks，C1要求切点不穿fence；当前破坏的是二者组合后仍无条件二次切分的合同，旧walkthrough只解释路线，未登记这个具体缺口。C2的reference/footnote跨chunk是明确已知限制，不复报。R19-R1/R2是把正文放进固定外层prompt fence或按UTF16截断，producer与修复点都不同；本项从原本有效的闭合围栏开始在renderer内拆文档，不使用旧prompt/model结果。parseDocument旧metadata失败仍保持SKIP，无恢复依赖、parser执行或替代验证。

逐项重算作者receipt12份材料bytes/SHA、source13pins当前bytes/SHA与行界，全部匹配；作者报告仍为6622B/SHA `9b58f8e86a18e917a3a8c01124ff1bd5216ef3af61f8b556d4cf184f4b3ae643`，20个本地链接/行界无误。读取作者2677-path去重收据的计数和完整保留上下文：35/67/2/3均低于120cap，两项缺陷词命中确是done/error与旧cwd修正，完整leaf/consumer上下文中无exact splitIntoChunks。结合已经重核的相同2677库存和此次旧父文阅读，不重复生成庞大inventory，也不宣称历史语义穷尽。

本review起初指出Root辅助source manifest把27行R19报告写成1–30/covered30；Root已保留原 [first manifest](review-streaming-root-source-manifest.first.json)，仅修正active范围为1–27。我随后核实active7pins均不越界、总数671→668、R19源码SHA未变。这个已处理的metadata问题不是产品缺陷或产品重跑；不影响上述静态值流。当前无未解决阻断，支持保留该P3；最终索引、Git集成和目标持续状态仍由Root核验。
