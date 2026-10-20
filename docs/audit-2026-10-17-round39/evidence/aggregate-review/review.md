# Round39 rename-fields 聚合metadata复核

支持 Root 将同一项 **MCP-R39-01 / P3** 汇总：普通用户自行配置、可编辑stdio server已有合法`connectTimeoutMs`、`connectRetries`或`inlineImages`，只把Name改成尚不存在的新名，表单白名单构成的新record写到新key，完整旧key被删除，受支持非表单字段没有随改名迁移。作者、独立reviewer与Root只是同一项的三个意见，不新增独立ID/candidate/related。

本review只读冻结audit材料、核bytes/hash/范围，**checks.files=[]，新增产品语义读取0行**。没有打开当前产品源码、解码/打印5.53MB原始历史对象或展开authority；0产品/helper/schema/import、语言fixture、测试、React/browser、MCP/连接/命令、实际设置/HOME、native/network/Git。源码事实归各原作者，不能借作本review第二遍产品阅读。

先pin已冻parent20文件与Root5文件：[initial pins](initial-frozen-artifact-pins.json)。独立目录此前只定位，收到最终freeze信号后才pin其20文件并读终态：[independent pins](independent-frozen-artifact-pins.json)。45个输入结束全同bytes/SHA；三份receipt19/4/19条全匹配，28个原报告链接有效。同路径source声明SHA无冲突。详见[checks](checks.json)；它们不是本review独立Git/current-product绑定。

普通producer的依据不限于schema接受数据：schema-export明文支持手改user/project settings；有效字段读入、raw展开及实际DTO/默认值消费均在作者/独立范围内。README只是通用背景，未建立通用JSON编辑器UI入口。full editor的Name可改、校验唯一；next和helper只编写表单字段，新key没有旧record可递归继承，old:null又删除原完整记录。没有发现阻断此普通条件的反证，静态配置遗漏即可成立，不需要观察连接结果。

反证必须保留：同名deepMerge会保留缺省patch字段，故不能扩大为所有save；plugin override锁Name，排除；有意的helper白名单本身不等于bug，缺口在rename迁移。没有承诺保存任意未知键，不能盲目持久化UI source/editable元数据。只支持三个受支持字段遗漏与源定义的缺省回退，不声称实际timeout/retry/图片、安全或权限后果。旧38 args往返在不改名时也能成立、修复点不同；38中的rename-fields是未完成边界，39补足普通合同后登记，不是重复旧formal。

覆盖逐组分开：parent29 rows实际6full+12selected+11navigation-only；1561观察行=1340全文/选段范围行+221额外导航行，后者含11纯导航rows的129行和18body rows中的92行。183其他产品pins仅hash，2指令仅carry-forward；raw counts字段称semantic pins不把11导航升级为active semantic。Root4selected/123行，helper既有full62本轮只hash复用。独立12pins中11有语义范围，3full/8selected/1hash-only，561行=504产品+34测试声明+23docs；README初次locator早于专用pin，null诚实保留。三组重复范围不相加为新、独有或首次覆盖。现有测试声明与lifecycle列举case均不是运行或pass。

历史口径同样不扩大。两份初始3413 inventory逐path/bytes/SHA完全一致（1352MD/2061JSON，887511strings/1329022scalars），含冻37、排当时mutable38/future39。parent初12/9/4无cap的25contexts归作者；后147无cap只完整读108–146共39，其余导航。首69-object raw5530631B/SHA836a1815…只做hash/provenance，本review没有JSON解码、打印或全读；直接file/path缩为12objects与旧headers记录另列。独立69/77/11/12均低于160cap，实际读12字段contexts、5same-SHA rows及61条selected locator去重后的7段完整文字，不称全61或全历史语义阅读。

独立结束仍同3413集合，3412 unchanged；release TODO从189803B/c8cdef20…变为199956B/8c1b9ca1…，完整dated差异留存，初始扫描不改写。Root另提供正式3509（1361MD/2148JSON，975542strings/1464542scalars）、+96冻38、扫描时0changed/removed，以及新材料14/8/3共25bounded contexts全读；这部分归Root，没有冒称我重扫。Root又提供main刷新037c2af…、9incoming与parent29+183+2pins无交集、post-refresh历史单列；incoming修复未语义审。本review不执行Git或认证这些Git事实，原prep bbad…/formalBaseline=null与后来42683054…上下文分别保留。

旧headers显示、September11 atomic rename/disabled/delete标记测试、Round4 inline-image结果序列化均有不同边界；不借旧pass或恢复失败方向。metadata诊断包括parent三次过宽输出截断、独立TypeError exit1及61条输出截断，随后7个去重文本完整读取；这些不是产品失败/重跑。我本次metadata命令无失败。Root读前pin早于direct display但已知peer摘录/38重叠，首次语义SHA仍null。冻结见[receipt](reviewer-receipt.json)，没有修改作者原件或产品。
