# Root UTF8 incremental output candidate

**0新增formal / 1 static candidate UTF8-R34-C1/P3 / 0 new-related**。普通完整有效buffer配固定16384 cap的utf8SafeCutLength本身没有新反例；候选是邻接小burst尾部，不把NaN/分数cap/任意invalid Buffer当普通输入。

BashOutput源码明确允许STILL-RUNNING on-demand peek，默认incremental直连manager.readOutput。child stdout/stderr的data listener把原始Buffer直接write给RingFile；内存tail按原byte合并。reader从绝对offset取当前尾部，只有长度大于16KiB才调用safe-cut；小burst直接toString(utf8)，再把本次全部bytes加入agentReadOffset。

静态条件：整体有效UTF8流的一个多字节字符跨两个data event，peek落在两部分之间。第一部分尚不完整却被解码并消耗，第二部分到达后，下一incremental read从已推进游标开始，无法重组原字符。这里是源码与API语义推导，没有观察真实宿主chunk/peek时序，没有输出/Buffer/语言fixture。保留P3候选，未升级formal。完整snapshot仍可能在原始bytes保留后恢复字符，因此不声称磁盘损坏、原始buffer永久丢失或每次输出必错。

[Node Buffer文档](https://nodejs.org/api/buffer.html#buftostringencoding-start-end)说明UTF8错误序列替换，[StringDecoder文档](https://nodejs.org/api/string_decoder.html)说明跨writes缓存不完整尾字符。只读资料为v26.12.0，不验证安装Bun/Node版本；未执行资料示例。独立review的同一邻接线索仍保留其未分类强度，Root单独拥有候选分类。

[source manifest](source-manifest.json)5实际semantic paths482行=431product+51tests（5现有test声明0run）。Background locator早于pin，initialSemanticReadSha256保留null；完整ring188虽读取FS代码文本，仅用于内存byte生产链，不声称审验权限/native或文件实效。tool63–78打印但只计1–62普通BashOutput范围。原parent646f保持，formal34 baseline后绑定；独立history与正式差集不借为Root自己的旧全文阅读。

[决定](decisions.json)、[验证](validation.json)、[外部资料限制](external-sources.json)。0产品/import/函数/Buffer或UTF8语言fixture/CLI/shell/真实输出文件/测试/browser/network/native/付费/权限custody实验，0pass/expect。旧失败方向继续跳过；不扩all snapshot surrogate、ring wrap或stdout/stderr交织为更多项。
