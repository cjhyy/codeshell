# Round27 Files root mapping 最终独立质量审

本文保留 09:39 独立审核时的拟收录语气；主审随后已收录，当前总数与证据以 [主报告](README.md) 为准。原字节另存于文末归档链接。

clock：UTC2026-10-12 01:39:00 / SG09:39:00。**支持root拟收录单一 R86 / F27-1 / P3。** 实际三份独立run收据一致支持：正常Make primary B后，从固定A的旧source创建普通summary target，尚未首send时，Files用B.id配A.path，Main正确按B授权并拒绝。A可读、真实B健康；不是权限绕过、原件丢失、所有root不可用或fork必须提前绑定的设计缺陷。

本独立审核只有标准库读文件/哈希/审查元数据断言，**新fixture/product import/test/Git/模型/worker/Electron/网络执行0**。作者与root的已有执行分别列账，不重复运行、不相加成3个新测试。若root收录，新正式总数86=1P1/52P2/33P3；新通用86文件251测试。Sidebar手工标题双store分歧仍为0exec设计/体验观察，不在此再加项。

## 实际stdout与冻结来源

| 独立执行者/基线 | 实际stdout | 完成及scope |
| --- | --- | --- |
| 作者首次latest a66f | 1文件1pass、0fail、0skip、29 expect；Completed | source28f4202、guard6e1f；author result-summary exit0 |
| root初始84740 | 1文件1pass、0fail、0skip、29 expect；Completed | 同源同guard，parent实读exec exit0 |
| root最新a66f | 1文件1pass、0fail、0skip、29 expect；Completed | 同源同guard，parent实读exec exit0 |

独立实际读取三个完整stdout和observed.json，不用parent“通过”消息替代expect/Completed验证。两个root stdout路径是各自checkout `docs/review-2026-10-12/reproductions/file-root-round27/file-root.test.ts.log`；作者在 `/tmp/...file-root-round27/first-authorized/first-authorized.log`。一开始rg默认列表未列最新log是*.log忽略规则，不是日志缺失或失败；之后精确路径已读。无需重跑。

精确fixture SHA256 `28f4202efc90bedbd67f39f60bd7e9370a3b8557872ae841edb856e3720a13d2`；guard `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`。三份均逐字节匹配。旧55d3准备源从未执行，prepared-initial只是unexecuted准备阶段；本轮 **无首次fixture失败/无author rerun/无执行后修源**。

[独立逐run收据核验](validation/round27-independent-quality-receipts.json)，SHA256 `89b0dddf501a05f838bcce38beb0df7d23cbfe209899140479080b26d29f2f51`，列精确路径、stdout/observed/source/guard SHA、元数据、HOME与owned根现场不存在事实、API语义及分账。Node assert和guard检查不加到Bun打印的29expect。

## 来源、正常门禁与单一根因

独立只读生产链与前置条件见 [静态质量摘要](file-root-quality-preflight-round27.md)；[归档静态原稿](validation/original-file-root-round27/independent-files-static.raw.md) SHA256 为 `069656e94ae4af793007abaf841875a5b5a413a2c7aa2844f1d806a8ea1e816a`。source必须正常持久化、P/A绑定有效；A/B为两个健康、不同的mounted根；用户B通过Make primary的trust gate；source未被迁移/删根/改workspace；摘要成功后保持同P，target真实持久化，尚未首send。该流程不依赖旧response抢焦点、R55race、文件权限失败或异常await替身。

Make primary保留旧SessionmainA是明确合同。Core summary fork白名单继承cwd/workspace、缺project是现行lazybinding合法状态，本项不把该状态独立定罪。UI App将target放在原项目，真实authority返回rootStatus=ok、workspaceA/mainRootId=null；actualpanelhook可挂Files，Files本身alwaysEnabled并有project API fallback。

根因在 actual `packages/desktop/src/renderer/panels/FilesPanel.tsx:140–153`：缺sessionMainRootId时fallback currentprimaryB.id，随后把该注册B项的path覆盖成workspaceCwdA。选项是B.id/A.path、A.id/A.path，B真实path缺项；默认B仍有B标签。`:177–194`因缺sessionMainRootId走projectAPI，`:345–347`的实际DirNode请求A.path，形成fsRoot(P,B,A)。

Main fsRoot:readDir按真实B.id从Mainregistry读取B.path（最新index6492/初始6486），actual renderer-project-path:73–83检查mounted root，actual fs-service:30–32拒绝A越出B。安全门禁正确，修复建议应保持它，只确保renderer里rootId/path同属一个注册根；没有必要从本证据推导改变所有fork的绑定设计。

R65目录catch吞错空树只是下游旧表现；即使给R65补错误提示/刷新，错误tuple仍不变，root映射有独立修改价值。不要再拆一个“空树”新finding。R22是PanelGuestsecondary归属，R58是managedworktree图片/终端授权适配，R69是坏source迁移门禁，均与本次普通健康mainroot错配不同。

## 三次实际观察均核对一致

每run都记录：51source/dist指纹、4项resolve-only、2个实际Main AST回调、3个codingmock地址、10次ownednotGit查询、15次IPC/API调用、5组UI/正常控制观察；这些是收据结构计数，不是loadedmodules或test数。

独立逐项核三套51source实际文件SHA；四项resolved文件也核SHA。两个Corepublicbarrel与Main整文件两基线不同，其他48整文件相同。`Bun.resolveSync`四项回包不证明实际loadedgraph；显式注入SessionManager来自actualCore dist，bareCore包的src/dist选择仅source-audited。没有模块cache探针或统一graph的额外声称。

两个callback保存的block确在当前实际Main source内唯一存在、行号和SHA准确：

- fsRoot:readDir：SHA `2820bebc653dec326e7a816ff53ad14969983f1f94c1fb0e4178db564d300f9a`；初始6486/最新6492；真实依赖requireRendererProjectRoot/readDirectory。
- fsSession:readDir：SHA `a94993aa3251ef2d8c1fb2d4ad1422737efe0e9124cf2aecc6743cf79e93338e`；初始6500/最新6506；真实依赖assertDesktopSessionId/readSessionDirectoryForUi。

每run候选记录workspaceA/null/ready=true和actualreconciledcurrentprojectB；实际defaultCall为P/B/A，两次P/B/A均有真实 `path escapes workspace root`。候选DOM有 `root-b (主目录)root-a`，没有两个独有文件名；选A后有unique-a.txt，选回B仍无unique-b.txt。没有伪造空目录成功或在adapter中预填失败tuple。

每run正常对照：

1. 同primary时actualsummary无binding也能正常用A/A读出unique-a.txt，说明lazy状态本身不普遍损坏Files。
2. Make primary后boundsource仍authorityA.id，actualsessionAPI读A和B都显示独有文件。
3. 候选选A可读；direct actualpreload/Main/FS的P/B/B正常返unique-b.txt，证明B健康且授权允许。
4. actualCorewriter显式补P/A，再remount后authorityA.id，actualFiles经sessionAPI读A/B均正常。这是 **内部binding控制**，不是完整first-send用户修复，也不是即时mountedrefresh证明。
5. 断言实际A/B原件正文仍各为 `A original\n` / `B original\n`。只证明两份owned原件，不外推全面用户数据。

对动态UUID/ownedHOME路径做纯文本规范化后，三个run全部15次API调用及其结果/错误逐字节一致；规范化trace SHA `974c1fd82827117ec87865edffe63cfa6e7b9ba3ca3bb677229da9ee4d7096a0`。这个静态收据比较不算新增fixture执行。

## 支架边界与cleanup

actualCoreSessionManager/Transcript/selectContextPackage/createSummaryFork、actualProjectStore/create/addRoot/setPrimary、actualworkspaceauthority/registeredIPC/preloadfacade、actualPanelWorkspaceRootConsumer/hook/FilesPanel、actualrootvalidator+FS均在已有run中执行。source初始binding由实际writer写入，对应静态Engineproducer；摘要为声明已成功的受控文本。ProjectStore.resolveProjectRoot只为ownedA/B目录折叠DI；coding仅exactA/B标准notGit错误adapter，真实Maincatch处理。各run的10次adapter调用实际全部在ownedA；bare/dist/src3地址声明和命中记录不当runtimegraph证据。其他codingexports转发真实实现，child/network仍强deny。

transport、store.list validatorDI、DOM/Reacthandler选择和panelwrapper是明确支架；Corepublication/rootOptions/read/effect/FS错误没有mock。没有真实Git/Electron/完整App/worker/model/provider。动态setPrimary直接store方法，**正式Sidebar/trust/preloadsetPrimaryRPC/registry广播上游仅静态**；完整TopBar/MessageStream/RPC/模型/App注册上游仅静态。不能把写sourcebinding当真实LLMturn。

普通blank完整App会materialize尚未持久化UI sid的边界保留，fixture没有它的动态断言；仅无engineID的组件合同静态正常控制。首条正常send确有Main按持久cwdA解析、Core写P/A的静态补绑路径；不声称实际send/自动刷新被跑过，不宣称所有后续修复都立即生效。

三套attempts全[]；各cleanup ownedFilesRemoved=true/errors=[]。独立现场check三份privateHOME和各ownedRoot均不存在。cleanup先unmount/settleIPC，重置actualworkspace setters，再删除自己的privateownedroot；runnerHOME回收另证。guard是in-process，明确非OS万能隔离。

## 历史材料和统计

[55d3首稿独立预审](validation/original-file-root-round27/independent-fixture-preflight.raw.md)仅历史；[28f4202最终预审](file-root-fixture-preflight-round27.md)关闭了src地址mock与notGitcatch两项准备修正，准备修改前后test主体/断言/cleanup与guard原字节相同。author [report.md](validation/original-file-root-round27/report.md) SHA `f15cb911837b17616eaac33e1853fd04ca24d554c0e1fe603a4d58678a7949a2` 的动态scope/正常控制/阶段账本与真实收据相符；其“等待root”是作者冻结时的历史状态，本最终稿补上root两run。

只有1个新portable文件/1个新test/每run29Bunexpect；作者latest与root两基线分别核验，不加成3tests/87expect suite。正式建议仅新增1P3 rootmapping，title观察不收项。独立审核新增执行0；产品代码和fixture未修改。

归档说明：[原字节](validation/original-file-root-round27/independent-final-quality.raw.md)保留；canonical调整本任务链接及历史状态、来源标签；原字节保留。独立review本身新增执行0，后续主稿整合QC另附。

## 最终整合核验

[独立整合审计原稿](validation/original-file-root-round27/independent-integration-quality.raw.md)及[只读收据](validation/original-file-root-round27/independent-integration-quality.receipts.json)确认86=1/52/33、双common86/251、三次各1/29和55d3未执行分账一致，范围、R65去重、正常控制与原字节归档无实质矛盾。新增执行0；两处来源/历史状态标签小修已关闭。该审计10份相关文档296链接均存在，主审全局链接及行号机械结果另见round27-report-audit。
