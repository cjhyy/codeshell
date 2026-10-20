# Round31 search 实际入口静态检查

本方向 **0新增 formal / 0新增 candidate / 0新增 related**；入口证据支持 Root 将 Greek lowercase 线索保留为 helper candidate / unused boundary，未建立普通 App/UI 的非空 query 入口，不能声称生产 UI 已暴露漏搜。独立 source reviewer 的 P3 helper 原意见应单独保留；判断差异在生产可达性证据要求，非对 per-cell/whole-query 源码事实的分歧。

正式 baseline 由 Root 提供为4dad999bd43b776995b5d212dde275dab86a1ddd；复用原 parent19ef 时的同一次 [入口 prep 阅读](evidence/entry-prep/report.md)，正式化0新增产品语义读取/0产品运行，未改产品。5份原始prep含receipt已 [逐字复制](evidence/entry-prep-copy-receipt.json)，原父级、时间、读前pin和finish SHA未覆盖。

决定性入口链：hook全文53在48/49委托Ink setter/scan，但引用库存未找到hook的App import或调用。Ink selected123–205/700–727/1280–1365中searchHighlightQuery186初值空串，1293–1297 setter写入，719将字段交给overlay；scanElementSubtree1310为空时返回[]，1336才扫描。此为内部消费链，尚无实际普通生产consumer传入非空query。

render/index.ts全文66不export hook/raw scanner；TUI src/index.ts全文9仅export VERSION。TUI package.json全文73仅exports . / ./cli，root.ts全文184的Instance/Root与返回对象不暴露搜索方法。根package全文129仅exports .，build-meta.ts全文38只写Core re-export与TUI CLI shim。模块级export或内部class public method不能据此推成package支持的公开搜索API；未执行build、包导入或dist。

[引用导航](evidence/entry-prep/reference-navigation.txt)在默认rg非忽略源码/测试/脚本文本、排除docs/bugs后为30行6文件，无hook实际App引用。目前唯一直接提供具体非空query的找到调用是tests/search-highlight.test.ts直接import内部scanPositions/applySearchHighlight并使用fixture。全文143行只有1个参数化test声明/9个case entries，0执行。注释中VML并非真实caller证据；该库存也不能证明动态/外部/生成消费者绝对不存在。

[正式source manifest](evidence/entry-source-manifest.json)保留12pins（11full/1selected）原scope，共1198声明行=815产品源码+143既有test+202package JSON+38build脚本文本；不是1198新覆盖行。Ink整体1968只选读197，另rg import31/34仅导航。finish/current文件SHA、bytes、EOF和ranges全匹配；formal rows只为同一SHA添加canonical字段，不倒填最初pin。Root独立绑定Git baseline，本作者Git命令为0。

searchMatches/searchHighlight/render-to-screen全文可见按cell lower与query整体lower的不同位置；本入口子任务未执行Greek字符串、JS语言eval或产品函数，也未独立重取规范文本，未观察匹配结果/真实屏幕/用户漏搜。未新增全历史扫描或“首次语义审查”宣称，旧根因去重和候选归属由Root/snapshot汇总。[validation](evidence/entry-validation.json) runs为空，产品/import/test/fixture/React/TTY/native/network/Git/auth/identity实验均为0，旧失败方向继续SKIP。结论仅限入口证据，不断言全部TUI搜索功能无bug。
