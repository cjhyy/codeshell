# Round32 context/model selection 静态前置

**0 formal / 0 candidate / 0 new-related**。原parent context4dad999bd43b776995b5d212dde275dab86a1ddd仅作此次prep上下文，不是未来正式baseline。没有运行产品、React、浏览器、真实UI、fork/session/Engine、设置、模型、权限/identity或Git。

contextSelection全文218与modelSelection全文21已按当前bytes先pin后读。旧inventory的prior-version-only/pin-only仅作选择提示，不证明历史从未语义审查。对照 [旧source metadata](prior-source-comparison.json)：contextSelection旧UI记录SHA与当前不同；modelSelection及其test的当前SHA与R13相同，R13已经全文/自有内存回调执行且明确未找到真实产品caller。本次不是它们的首次覆盖，旧pass不转作本次验证。

普通选择DTO合同：context helper以真实raw事件组成turn，display分组用durable event/client anchors对齐，拒绝歧义/不连续/倒序窗口，不以重复文本或UI位置补猜。selectedTurnRange检查起止顺序和端点存在，返回closed event IDs。App2040–2090确实调用copyContextPackageOverrides，source override优先、否则default，并将target goal清false。permission值只当静态DTO复制边界，不实验或声称验证真实权限路由。

实际caller已找到：MessageStream284–309在idle/local条件下读getSessionRawEvents并buildTurns；363–405以selectedTurnRange形成forkSession(summary)参数；444–448先要求display alignment。App2200–2245提供selection可用条件，2565–2595传入当前request/callback。没有调用这些函数，没有原生或UI观察。model helper仍只在定义和既有test中被名称检索到；它user-scope浅复制defaults并覆盖text，未建立新的App保存合同，不能制造孤立DTO/竞争输入来新增bug。[引用原文](consumer-reference.txt)保留实际命中。

初始ordering猜想已撤销：早期协调消息把旧/外围“turn_boundary在loop开始”描述当作当前producer断言，推想可能漏掉前一段assistant。随后读取当前turn-loop554–570发现appendTurnBoundary在finalizeModelTurn，明确只close completed model turn且幂等；1140–1215在model返回后1199设置completed，1945–1985包含on_turn_end后1961 finalize及catch1978补finalize。当前producer直接反证loop-start前提，因此未形成finding/candidate。[metadata notes](metadata-notes.json)记录撤销，不把它当产品失败或另造验证。没有继续读Core fork后端range展开/拒绝，也没有以未审后端证明正确。

[来源清单](source-manifest.json)共10pins、6full/4selected、1186声明行：1132当前产品/test/消费者/producer范围+54旧R13报告。App2924只选158、MessageStream928只选153、turn-loop2412只选275、transcript1377只选31，不冒称完整生命周期。MessageStream专用pin晚于rg caller snippets、两份R13报告pin晚于history excerpts，3项initial保持null；direct selected/full text前的first durable pin与finish一致，其余7项读前pin与finish一致。范围不包括额外rg导航行的语义审查。

[全历史metadata](history.json)扫描docs/bugs全部MD与递归JSON value scalars，含archive/_archive，排除当时mutable31/future32：2921文件=1295MD+1626JSON，624924字符串/926095标量，169exact archives，0parse。exact59/turn-contract59/old-failed2，cap100，全部保留59/59/2无截断；扫描文件bytes/SHA及canonical库存SHA完整保存。已看全部exact、selected turn-contract MD与两个old-failed contexts，R13 search45+review9全文；关键词/保留contexts不等于历史语义穷尽。

R13已记录model无产品caller；R6 modelPicker grouping失败继续SKIP；旧上下文取消/文件root问题仅为历史边界，不重复报告或新增related。当前11个既有test声明（context9+model2）只读源码，0执行。[validation](validation.json) runs为空，0pass/expect/import/function/fixture/native/network/真实UI或Git；仅文件/hash/JSON/regex元数据操作。这个negative只限已读普通选择合同，不扩大成完整context fork、权限、settings或全仓无bug。
