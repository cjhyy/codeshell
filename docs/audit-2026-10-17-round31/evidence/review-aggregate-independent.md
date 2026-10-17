# Round31 候选边界与整合元数据独立复核

支持 [Root终态](../root-report.md) **0 formal / 1 SEARCH-R31-C1 candidate / 0 related**。逐cell与整query小写的静态原因充分；普通生产/公开入口尚未建立，所以不将它表述为已观察到的用户漏搜或正式UI故障。独立 [source reviewer](review-search.md) 的P3 helper-contract原判断保留，与Root最终candidate分类分开，不能为了统一计数改写原意见。

## 源码、规格与入口

独立全文读searchMatches56、searchHighlight52与既有test143，选读render-to-screen125–198、screen1–130、Ink180–205/700–730/1280–1345；另完整读hook53、root184、render/index66、TUI入口9与package.json73。共11个实际source/contract rows、963声明行，warn9只hash；这是本reviewer独立阅读，不归为Root正式化新增阅读，也不能与重叠作者覆盖相加成独有阅读量。精确读前pins/范围/结束hash在 [checks](review-aggregate-independent-checks.json) 的 `.files`；hook此前rg摘录先于direct-read pin，initialSemanticReadSha256保持null。

源码把每个cell.char单独toLowerCase后拼接，两个消费者对整query小写。[ECMAScript toLowerCase](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.tolowercase)采用包含locale-insensitive SpecialCasing的Unicode默认转换；[SpecialCasing](https://www.unicode.org/Public/UCD/latest/ucd/SpecialCasing.txt)给出词尾sigma条件映射；独立补读 [Unicode17 Table3-17](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-3/)确认条件需要前置cased字母且后方没有cased字母。因此相同的两个窄cell `Ο`、`Σ`和整query `ΟΣ`，按规范/源码静态推导会分别形成`οσ`与`ος`，indexOf无法匹配。此处没有执行语言表达式、Intl、产品函数、fixture或终端，也没有观测安装的Node/Bun/ICU行为。

入口事实支持Root的边界：[entry报告](../entry-report.md)与本次直接阅读均显示Ink query初值空，hook只是转调setter/scan，root的Instance/Root和返回对象未暴露这些方法，render/index及package entry也未提供搜索API。源码/测试rg库存只找到定义、注释和hook内部转调，没有建立App非空query producer。测试源码供应具体query不等于普通生产入口；不能由有限引用检索断言动态、生成或外部consumer绝对不存在。

一个措辞问题已落实：hook源文件确实有module-level `export function`。reviewer指出后，Root将active报告/候选的“未导出”限定为“未由公共barrel/package入口导出”。这是文档精度修正，不改变source、静态原因或候选数量。

## 终态材料与保留记录

按作者freeze后再pin/读的顺序，核Root新10-row、entry4-row、source-review7-row三份active收据，21份active artifacts及receipt自身均匹配；28份prep copies（Root11、entry5、source-review12）逐字相同。Root7、entry12、source-review8共27条作者source rows的字节、范围和原prep字段一致；Root warn late-null、source-reader只打印到真实EOF814等限制均未被倒填或扩大。current31 artifacts与实际source rows另列，不声称它们是4dad基线原blob；Root负责Git绑定。

Root初版report/candidate/receipt三组完整原件与本reviewer原始pins逐字匹配，修正notes保留原因；active限定措辞已核。原prep及parent19ef不动。source-review同时保留prep source-reader请求不存在815行后的诊断，以及formal finalizer漏import re的独立NameError；两次均为审计bookkeeping，原始完整raw未持久化的限制明确，不能合并成产品尝试或测试失败，也没有借机恢复旧动态方向。

Root当前历史2921项保留原2851项全部row/hash，仅新增70份冻结Round30路径，排除current31；与source-review的终态history metadata口径一致。本reviewer核库存差集/边界，没有重复长正则或scalar扫描；624924strings/926095scalars、6/0/5293 occurrence与capped contexts依然是作者扫描口径，不能称为历史语义穷尽。三份报告的11/5/10个本地链接均存在，Root两项外部规格引用已独立只读核对。

最终没有未解决的分类或metadata阻塞。所有作者产品执行为0，reviewer同样 **0产品/import/函数/语言fixture/测试/TTY/native/Git，0pass/expect**；只读官方规格浏览与审计JSON/hash不是运行时验证。结论只支持声明的helper静态原因和当前生产入口证据边界，不扩张为全仓无bug或实际UI已经复现。
