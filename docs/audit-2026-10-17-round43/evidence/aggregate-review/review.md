# 正式43预备：46/47 冻结包元数据聚合

四包的有限结论一致：**0新增 formal / 0 candidate / 0新增 related**；47两方记录的是同一个 **D5/R04 旧因排除1项**，不重复计数，不新编号、不改变旧状态。当前复核只支持材料内部一致性，没有重新验证产品行为。

已核 **85份输入文件、81条自排除收据记录**，所有bytes/SHA一致，没有遗漏或额外文件；Root提供的46报告/source/receipt三项与作者46原冻结三项SHA均匹配。36个输入Markdown本地链接均存在，其中32个相对链接在各自canonical目录内；4个绝对链接仅核目标存在，没有打开产品或旧文档正文核行内容。5个 source/consumer excerpts或导航源码输出只按不透明字节哈希，未解码。

| 冻结材料 | 当前产品语义 | 测试语义 | 旧报告语义 | 已声明显示范围 |
| --- | ---: | ---: | ---: | --- |
| 作者46 | 742行 | 283行 | 0 | 1025选定正文行；额外截断导航总量未声明 |
| Root46复核 | 361行 | 0 | 0 | 410行，含导航 |
| 作者47 | 448行 | 0 | 39行 | 742行，另有2测试文件仅标题导航 |
| peer47历史排除 | 0 | 0 | 20行 | 66行旧文档显示 |

这些是输入原声明，当前新增产品阅读为0。24个manifest rows的full/selected/hash-only、范围长度及所给行数上界自洽；显示与语义分别核算，Root46额外navigationOnlyDisplayLines包含在canonical displayed union中。Root46的361行全部与作者46范围重叠，peer47的20行旧报告也与作者47重叠。仅按相同path/SHA/range去重的报表范围并集为1190产品+283测试+39旧文档=1512行，不是本聚合新增或独立覆盖。

角色明确区分：我是46作者，当前对46是 **own-author metadata check**。Root46是在先知阶段意见后另行读源的反证，不称盲审。peer47在精确旧因gate后没有阅读当前产品或测试正文，因此只支持历史D5/R04排除，不能冒称独立复核作者47的448行键盘/草稿范围。作者46的12个完整selected测试声明仅表示阅读过；四包均无本prep产品/测试运行，也不借旧pass证明当前行为。

历史时点保留：作者46原3696=1379MD+2317JSON，纳冻结40、排41–46；Root46与两份47材料原3773=1385MD+2388JSON，纳冻结41、排42–47。递归JSON值含归档参与原gate，keys不当值搜索。前者1130742 strings/1704078 scalars，后者1180902/1782213，均声明0parse、结束字节0漂移；当前只核这些冻结声明和artifact bytes，未重扫仓库历史。作者47的169 exact archive/_archive，与peer47的175 substring archiv、162 exact archive/archives采用不同算法，分别保留，不强行统一。

Root另提到正式43稍后使用3869且纳冻结42，这只是未由本次核验的后续上下文，不倒填原prep、不认证未来Git/head。作者46保留读前pin、显示后文本捕获及未单独采集的exact wall-clock null；这些没有被倒写成新的源读取证据。

原metadata诊断均保留：46多次宽query/截断输出不冒称全contexts阅读；Root46 cap60上下文与19个明确原source对象范围分开；47作者 focused-method 的 else0 编译前SyntaxError首件与修正只属于metadata，修正后是第一次实际focused scan，不算产品重试；peer47三次截断也不算产品失败。旧失败方向继续skip。

[checks](checks.json) 的 `files=[]`：当前0产品源码bytes/语义读取、0产品函数/import/helper/fixture/测试/React/browser/native/network/Git操作，只写本exact tmp。没有解码源码摘录、调用产品或修改四份作者冻结包。结论不扩展到整组件、整个Lab或运行时正确性。冻结明细见 [artifact receipt](artifact-receipt.json)。
