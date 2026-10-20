# Round28 聚合独立静态复核

支持 **1 formal（STREAMING-R28-01 / P3 static）/0 candidate/0 new-related**。已读README、RootQC、assembler/verifier源码、报告/分类/validation与独立复核，核当前材料、source范围、原副本和索引。没有执行产品、函数、import、parser、React、测试、fixture、VM、native、Git、网络、模型或Root assembler/verifier，只新增本文件；这不是产品gate或全仓完成证明。

formal的普通可达值流成立。本review额外阅读全文fence-aware leaf124和StreamingMarkdown173，并选读普通assistant text/done producer与AssistantMessageView。闭合代码围栏内部有空行，后面仍有prose tail、done=false，是正常流式输入；leaf在闭围栏后的blank boundary切出完整stablePrefix，组件143–148却再次无条件按连续newline分块。两段各自传给独立ReactMarkdown，没有共享fence上下文，违反140–142的self-contained closed block合同。无需猜测某库最终生成几个HTML节点即可确认传入文档结构已被拆开。该文字边界是人工源码推导，不是JS/Python镜像、parser或UI观察。

影响只限实际呈现的rich streaming阶段：done分支把原全文交回Markdown，rich=false和未闭fence activeTail有反证；极快完成未展示对应throttle帧时可能不可见。没有120ms时序实验、HTML/截图、剪贴板或磁盘观察；组件流式本就无代码copy控件，不能扩为最终代码丢失/复制错误。旧C2reference/footnote限制、R19固定外层prompt fence/UTF16、旧parseDocument及R27失败方向均未混入本项或恢复运行。两份独立formal复核和作者都保持这一有限P3。

其它方向negative边界准确：Root canonical JSON/paths/status、Dialog与Lab没有凭缺少structured coverage或宽泛边缘猜测凑问题。Lab15pins/2012行是此前9b同一次prep阅读的继续，32c归档只hash复核；不是新加15次全文。Dialog653行产品/test/consumer与222指令行有明确范围；tests与interaction/foundation fixture均只读定义。Lab作者reported12 links与本review此前actual13（含fragment与selfreceipt）分别记录，不猜旧checker，不改作者；实际目标均有效。

**2026-10-17 11:32:54 UTC** 独立metadata核验：

- [source manifest](../source-manifest.json) **74 unique source/meta pins**当前filesystem byte/SHA与保存的frozen/current/main三列一致；**65 active source checks**分别为Root11+Lab15+Dialog8+Streaming13+Rootformalreview7+independentformalreview11，全部与原manifest的SHA及合法range交叉一致。74和65含重复路径、指令、旧合同及hash-only库存，不能称74/65个新全文产品文件。本review未读取Git对象，Root的冻结blob与真实main来源仍由其自己的检查负责。
- **51 prep hash-only checks=Lab48+coverage shortlist3**与当前字节一致；[worker integrity](../worker-integrity.json) **60artifact checks=42author（8+7+11+12+4）+18copies（10+8）**全部byte/SHA匹配。18copy另与各自exact originalPath/source逐字节相同，原9b/时间/initial-finish/readScope保留；Root对32c的绑定不回填作者未做的Git、read-start或语义阅读。
- [package inventory](coverage-prep/package-inventory.json) **4087个TS/TSX**也独立逐项核当前filesystem bytes/SHA，与dated inventory及Root current recheck一致，0changed/missing。这纯属hash-only，不新增4087个语义阅读或Git绑定。coverage分类96full/59selected/869pin-only/27old-version/3036no-row合计4087，是只接受162份特定structured manifest的规则结果，不是全仓真实审完比例；旧status prose已有提及正是no-row不等于未读的反例。

当前2677份history库存与较早Lab2596份库存分别再逐文件重核byte/SHA，全同；当前1262MD/1415JSON、506929strings/740424scalars和旧1250MD/1346JSON、468104strings/676635scalars保留两时点。两者都包含档案，当前exact archive/_archive目录169；关键词总数、context cap和byte inventory不能代替历史语义穷尽。没有把旧Lab检索伪称已搜Round27新增文档。

已处理的metadata错误保留完整：[first manifest](review-streaming-root-source-manifest.first.json) SHA与notes一致，原1–30确超过27行EOF；active版本仅改为1–27，总671→668，原source SHA不变。65 active checks中不含first错误版本，它只作diagnostic，不是被遗漏或偷偷覆盖的产品失败。旧locator的outer0/未捕获innercode与人工diagnostic摘录也明确分开。没有产品重跑或用metadata修正冒充功能验收。

本时点 [index](../evidence-index.json) **91项集合和全部byte/SHA正确**（含index本身实际92文件）；现有 **93个本地Markdown链接及行界**全部通过。README到本待创建review当时预期暂缺，本文件随后创建会解开该链接并新增索引项；Root需统一重建最终index后执行其metadata verifier，不能拿91当最终stage文件数。本review没有运行过期verifier。

[validation](../validation.json) runs为空，所有产品/test/import/fixture/pass/expect/rerun总数为0；不存在应保留却被遗漏的本轮产品raw/exit。没有把26个Streaming现有test声明或旧绿色suite当本次通过。保存的initial/premerge/before快照一致，recorded main/frozen32c和0source delta也与RootQC相符；本review不调用实际primary Git状态，最终必须由Root临FF重取样并核dirty路径disjoint、cached/blob、commit/primary与当前源码字节。后续如并行状态变化，必须保留真实新时点。

未发现本轮分类、计数、影响、来源、材料归属或现有链接的未解决阻断。Review ready；最终stage/commit/FF与dirty保全由Root外部收据证明，目标继续active，产品未修。
