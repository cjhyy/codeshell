# Round28 Root 方向独立静态复核

支持 **0 formal /0 candidate /0 new-related**，未发现需要新增问题或修正分类的证据。本 review 仅新增本文；没有执行产品函数、import、测试/fixture、VM、React/browser、native、模型、网络、Git 或 Root verifier。R27 的失败运行不用于证明本方向行为，原 Lab prep15pins 未改。

实际读 [Root 报告](../root-report.md)、冻结8材料及分类/validation/初始3pin；重新阅读 canonical-json、store-paths、sessionStatus 六份实现/测试全文，以及 report、candidate、App 声明选段。九个 product/test 来源共359行；另两份指令的222行按现有读取与当前 bytes/SHA 一致核对。保存的11pins /581行、full/selected范围与 coveredLineCount 均一致。逐项重算当前11文件 SHA/bytes/行界、8份作者材料 SHA/bytes，全部匹配；原3个 before-read pin 值与最终manifest一致，其余8个 initial 为null，没有倒填不存在的起始SHA。只检查保存记录的一致性，不由hash反推作者实际阅读时序。Root 的 baseline Git-blob 绑定归Root证据，本review未执行Git，也不借其flag冒称独立读取Git对象。

[canonicalJson](../../../packages/optimization-lab/src/contracts/canonical-json.ts:7) 对 finite JSON标量、plain/null-prototype object、dense array 的支持及不支持的形状有显式分支。非JSON/非finite、非plain object、symbol key、getter/非enumerable属性与sparse/extended array均有拒绝路径；ancestors在finally删除，所以共享正常子对象不被当成祖先cycle。现有测试明确接受 `-0`→`0`，不能仅因广义“distinct inputs”注释再算一个缺陷。report/candidate选段实际使用序列化文本进行断言比较或稳定摘要，当前没有建立符合普通合同的新反例。以上是源码和未执行测试的意图核对，不是调用JSON encoder、crypto、descriptor或性能验证。

[store-paths](../../../packages/optimization-lab/src/store-paths.ts:1) 确有 native realpath、extension/codeShellHome依赖，Root将它限制为14行静态阅读及fixture定义的说明准确。没有运行symlink、HOME或store/custody方向，不能把测试源中预期的root/alias结果冒称本轮实测。

[sessionStatus](../../../packages/desktop/src/renderer/sessionStatus.ts:16) 的asking/busy/unread查询顺序直接对应公开asking >running >unread >none优先级，不改写sets。7个it声明覆盖该优先级和其它bucket；App678–730仅证明选段构造asking集合并给每个bucket调用helper，不能升级为所有审批/后台路由已验证。报告没有作这种外推。

独立重读同一 [2677-path历史库存](root-dedup.json) 并逐文件重核bytes/SHA、重新解析JSON值标量和匹配：1262MD /1415JSON、506929 strings /740424 scalars、0 parse errors、169 exact archive/_archive目录路径；canonical25/storePaths21/status3为occurrence计数，cap80下 contexts 均完整，和原收据一致。没有把关键词检索或byte inventory当成语义穷尽。status的三处确含旧R18收据与 [既有设计文字](../../todo/mobile-remote-optimizations.md:268) 对同优先级的提及，因此“无structured manifest row”不等于历史未读。报告已保留这个边界。

Root报告8个本地Markdown链接的目标和行号均存在。分类、0动态validation、copy Lab prep与Root当前阅读范围相互独立，没有借旧测试通过或R27失败提升证据等级。当前没有未解决阻断；最终聚合索引、暂存/commit/主checkout字节保全仍由Root完成，本文不预称已集成或全仓目标完成。
