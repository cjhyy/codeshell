# useLatestMessages：已知选段的滚动/DOM静态补充

结果 **0正式 / 0候选 / 0新增关联**。这次补读83明确排除的scroll/following/ResizeObserver静态源，不称“从未读frontier”，不修改83、旧索引或总体覆盖数字，也没有运行浏览器、DOM、React或时钟实验。

目标仍为173行/6078B、SHAd0938a8b58bff0aaba7bc301b5f9c5a5cc4a8f306cc9ab3a3d424782e647ed71；Workbench也与83同SHA。[current初始pins](initial-pins.json)先于本次body。own[fresh history](history.json)纳冻结49排50+，2026-10-17 16:45:56–59 UTC：4693=1457MD+3236JSON，2129441strings/3168045scalars，169archive/_archive、0parse错误。机器path190/cap100保留100、SHA56/cap100保留56，不等于读尽。49个机器字段对象只[选读4个canonical简表](coverage-gate-selected.json)，[正式49原83两条selected](prior-same-sha-selected.json)保留purpose和范围：hook97行、Workbench65行；未建立目标同SHA module full。不会因为正文曾完整显示或reviewMode词命中而升full。[方法](history-method.py)、[窗口原件](history-contexts.json)保留，本次未逐读这些保留窗口。

## 静态普通路径与反证

新读hook66–173：snap给实际listRef赋scrollTop并记录实测top/宽高；resume清通知、恢复following并snap。onScroll只在active时工作，原following且尺寸变化的分支保留跟随决定；同已记录programmaticTop差≤2的事件不当作读者离开尾部，其他情况按距底≤100判断near，再更新following/showJump，near时清通知。这里的数值是原代码条件，不是捏造DOM输入或测量结果。

layout effect在scope变化时重置跟随/提示，active且following才snap；ResizeObserver观察list与content，following时snap，否则near时resume、离尾时显示jump，并在effect清理时disconnect。显式jump先resume再focus preventScroll。没有从这些正常源分支建立新反例；事件投递顺序、scrollTop实际取值/钳制、ResizeObserver布局反馈、真实帧及浏览器差异均未运行验证，不能据此宣称普遍正确。

Workbench757–782实际把listRef/onScroll接到tabIndex=0的.messages，把contentRef接.transcript；863–894的button调用jumpToLatest，aria-controls引用同messageListId。Workbench18实际导入app.css。所选CSS将.message-viewport设为flex相对容器，.messages为overflow-y:auto，.transcript为列流；jump和announcement绝对定位等规则与绑定相符。CSS仅静态声明，不冒充computed style或实际布局；没有展开auth/连接、房间鉴权/身份、真实用户数据或native机制。

## 覆盖、重叠和冻结

[manifest](source-manifest.json)3份产品均selected，含1份CSS；没有module full或测试声明。hook本次108行与83重叠36、相对83新增72；Workbench包含import和控件59行，与83重叠14；CSS55行只是相对83未登记，不表示整个历史从未阅读。三份本次222语义行中50行与83重叠、172行在83所列范围之外，不能把两次阅读直接相加当新唯一覆盖，更不把CSS加入旧4643个TS/TSX分母。body260行、含rg导航并集264行，分别记录在[显示前pins](source-display-pins.json)和[摘录](source-excerpts.txt)。

[current结束哈希](ending-checks.json)仅核owned原版3源、2instructions和原4693历史成员；Root报告7dcd41b…为formal49版本，reviewer Git0、不独立认证HEAD或未来状态。CODESHELL/AGENTS当前同SHA沿用旧全文instruction阅读，不重复计222行。未读取Root84可变输出或别的task变动。无本轮metadata错误或工具截断，cap只是保存上限；[validation](validation.json)明确产品/helper/import、fixture/test、React/DOM/timer/真实网络、用户数据/native/模型及Git执行0。冻结见[receipt](reviewer-receipt.json)。
