# Round31 search 高亮实际入口检查

未建立普通 App/UI 的非空 query 入口，也未建立 package 对外支持的 search API；不能把 Greek 上下文 lowercase 线索升级为生产 UI formal。本子任务不新增独立 candidate/related，保留父任务的 helper candidate / unused boundary 分类。父提供 baseline19ef 只作上下文，0 Git 命令。

真实接线与边界如下：

- use-search-highlight.ts 全文53：setQuery48 -> Ink.setSearchHighlight；scanElement49 -> Ink.scanElementSubtree。它需要真实 Ink instance，但本次源码引用库存没有该 hook 的导入或 App 调用，只有其本身的 export 声明。
- Ink selected123–205/700–727/1280–1365：searchHighlightQuery186 初值空串，setter1293–1297写入并调度。onRender719 会消费该字段；scanElementSubtree1310 在 query 空时直接返回[]，1336才调 scanPositions。因此引擎有内部消费链，尚缺实际提供非空 query 的普通生产入口。内部 public method 或模块 default export 不等于 package 对外合同。
- render/index.ts 全文66 没有导出 hook、scanPositions 或原始 search helpers；TUI src/index.ts 全文9 仅导出VERSION。TUI package.json 全文73 的 exports仅 . / ./cli，没有 renderer/hook 子路径。root.ts 全文184中 Instance46–60 / Root67–71与97–104/152–156返回对象都不暴露 setter/scan。
- 根 package.json 全文129仅exports .，build-meta.ts 全文38 的26–30写入Core re-export与TUI CLI shim，未暴露上述 TUI search 方法。只读了脚本源码，没有运行 build 或操作 dist。

[完整引用导航](reference-navigation.txt) 在默认rg非忽略仓库文本中排除docs/bugs，共30行、6文件：hook、Ink、render-to-screen、searchHighlight、searchMatches和tests/search-highlight.test.ts。没有把注释提及VML误当成真实App consumer。此库存不穷尽动态属性、生成文件、外部deep import或未纳入的消费者，不能绝对证明功能永远不可达。

目前唯一直接提供具体非空 query 的已找到调用位于 tests/search-highlight.test.ts：2–3直接导入内部 scanPositions/applySearchHighlight，124–141按fixture数据调用。全文143行是1个参数化test声明、9个case entries，仅源码意图（ASCII、CJK、emoji、combining、İ等），全部未执行。它支持 helper 的case-insensitive合同，但不能替代App入口或真实屏幕结果证据。

searchMatches56、searchHighlight52、render-to-screen198已全文静态读；能看见 row按cell.char.toLowerCase而query整体toLowerCase的不同源码位置。Greek内容由父任务提出，本入口子任务没有执行Greek字符串、语言eval、React、Bun、renderer或任何产品函数，也未重新取规范文本；不声称观察到匹配结果或用户可见漏搜。

[来源清单](source-manifest.json)保留12个文件读前SHA/结束SHA，全部一致，11 full / 1 selected，共1198声明行：815产品源码、143既有test源码、202 package JSON、38 build脚本文本。Ink整体1968行只选读197行，另rg import31/34只作导航。无新全历史扫描/首次审查宣称；父任务与snapshot负责旧根因去重，本方向只给出入口证据，[分类说明](entry-decision.json)不会重开历史失败方向。

0产品/import/测试/fixture/JS语言eval/React/TTY/native/网络/Git/auth/identity实验。只做源文本/文件hash/JSON/regex元数据操作，只写exact /tmp/codeshell-audit-round31-search-entry/，未改产品或任何已冻结Round30材料。
