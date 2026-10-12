# Round23 Recent 菜单快照候选：独立只读审计

> 阶段与路径说明：前部为执行0的历史静态审查，末部为对实际收据的独立只读核验；均未另执行fixture。当前R83及83/247见[主报告](README.md)与[专项](menu-recents-round23.md)。本文件不把resolve-only记录当module-cache证明。

结论：**支持保留独立窄P3候选，待作者actual store/IPC/recents/Menu隔离动态证据及root裁定后正式收录。** 正常项目成功创建、重命名、移除会更新V2与legacy磁盘投影，但已安装的macOS Recent MenuItem没有失效/刷新路径，单窗也可发生。没有“现代项目不再写recents”的问题；没有删除项目被旧菜单重新注册的证据。本审计新增执行0、正式新增0，不改产品/fixture/主报告，不启动native/模型/CLI/浏览器/网络。当前正式82=1P1/52P2/29P3、通用82文件246测试保持不变。

本审计读CODESHELL、预审 `/tmp/codeshell-review-20261012-menu-recents-preflight-round23.md`、当前README/flow-coverage、R29优先级恢复边界、actual ProjectStore/ProjectAuthority IPC/recents/Menu/App消费、相关tests与迁移计划。冻结latest a66f4ef2源码；执行开始clock实读UTC2026-10-11 23:55:45（SG2026-10-12 07:55:45）。预审文件开头81/243是R82收录前历史计数，不能沿用作当前统计。

## 反证优先：磁盘更新链是健康的

ProjectStore默认 `desktop/projects.json`与同目录 `recents.json`（project-store.ts155–156）。`createFromPath`209–213经register/mutate完成合法picker授权注册，`rename`487–500更新name/displayName，`remove`514–522写deletedAt；mutate822–836在V2成功原子写后调用projectRecents。projectRecents839–865逐项写primary path、当前name、lastOpenedAt、pinned、deletedAt，不能描述为“现代来源完全断开”。投影失败仅log的边界866–869存在，本候选限定健康写入，不依靠该容错路径立项。

recents-store.ts213–214的canonicalizeProject保留已有非空p.name，单项目正常重命名后的新name能够被loadRecents读取；重复canonical path合并的basename命名不属于本候选。loadRecents282–284每次重读、过滤deleted及不存在目录（isLive277–278）、限制10项。项目上限、排序、multi-root只投影primary等设计不另报。

既有project-store.test.ts979的rollback-only projection测试源码验证V2权威与后续setPinned投影；recents-store.test.ts60的softDelete测试验证重新loadRecents会排除删除项；project-authority-ipc.test.ts93–101只验证rename返回与registry/mobile广播。三者没有挂已经安装的Menu对象，不能反证实时菜单刷新，也不能把本审计只读它们称为新增通过测试。

## 正式用户可达门禁与缺失刷新

menu.ts8–9明确说明窗口创建及recents变化后应再次安装；18仅在install时读一次，56–67把数组映射为固定label/sublabel及payload闭包，143–144安装为全局菜单。未找到menu-will-show的重新读取、MenuItem动态更新或文件watcher。

全仓生产安装仅Main index.ts2711 createWindow末尾（初始冻结2705）；refreshAppMenu148–149只有定义/内部调用，无生产consumer。实际ProjectAuthority IPC在60–66广播registry与mobile，82–87 createFromPicker、165–168 rename、178–180 remove成功后均调用该广播。Main5553–5569的依赖注入没有菜单更新函数，ProjectStore onChanged没有生产菜单subscriber；renderer useProjectRegistrySync.ts31–43/93只协调renderer投影。

可用单窗A完整自然时序证明：A完成菜单安装→用户通过Sidebar添加/重命名/移除→实际mutation成功且广播完成→仍在A展开系统Recent菜单。Sidebar添加接 `useSessionNavigation.ts120–135`，重命名通过Sidebar270–277的prompt→hook174–179→实际IPC；移除hook138–152触发实际remove。无需升级迁移、并发窗口、人工await、不可能的假Host或不合法authority。对移除只主张**成功且renderer已应用广播后的稳定状态**，不利用void IPC和旧renderer快照之间的临时race。

| 成功操作 | 磁盘/renderer正确状态 | 已装菜单静态结果 |
| --- | --- | --- |
| 首次/新增项目 | live registry与recents有新项目，Sidebar可选 | 原菜单仍空或没有新项 |
| 重命名 | currentname与projection已变，Sidebar新名 | 原MenuItem仍旧label/payload name；path没变，所以旧项仍打开同一项目，不称跨项目错路由 |
| 移除 | Main tombstone，loadRecents排除，renderer不含该项目 | 原MenuItem仍可见；已应用删除后点击重读live list、找不到target，静默return |

## 删除保护、恢复与R29措辞

App.tsx1429–1445的Open Recent先调用unmarkProjectPathRemoved，随后按path找当前projects；不存在时读projectRegistry.list。该Main list默认过滤tombstone（project-store.ts169–176）；target不存在在App1439 return，没有createFromPath、picker注册或Main tombstone清除。projects.ts203–205的unmark只删除renderer本地removed-path标记，不赋予Main注册权。**不能称点击旧item复活删除项目或绕过授权**。没有测试移除广播尚未应用的短窗口，不扩大为deleted Session执行/历史恢复问题。

健康store变更后重新installAppMenu会重新读取实际投影，新项目/新名/删除过滤应恢复；这属于必要正常控制。实际生产重装入口是新建窗口，以及全部主窗关闭后activate新建或重启。单纯展开菜单、聚焦旧窗或renderer reload不会重新进入Main createWindow；不能把内部refreshAppMenu调用冒称现有用户按钮。Sidebar与Main权威始终可用，本候选是菜单陈旧与无效残留项，缺少严重运行/持久损失证据，适合P3。

R29的Open Recent源码恢复必须加前提：**菜单本来已含目标path，或项目创建后已经重装菜单**。若升级迁移等待期间新添B发生在初始安装之后，当前Recent未必有B，故不能写成R29所有触发都能立即通过Recent恢复。R29既有真实hook→Main重命名广播恢复证明仍成立，不受此候选影响。本审计未运行或改动R29 fixture。

## 去重与TODO判断

与R82 owner闭包独立：该候选单窗、命令投递正确A仍有陈旧列表；只按focusedWindow分发不能刷新快照。与R29独立：不需旧transcript迁移/初始化await覆盖，Main和renderer正确而菜单旧。与R71失败重命名独立：限定成功写入；与R24工作区清理无关。可在同一菜单修复中处理，但现有触发、修复条件及影响可分别成立。

已读TODO、multi-folder-local-project-plan及architecture近期项目条目，未找到明确将已实现macOS Recent实时刷新延后的契约。multi-folder计划614起描述V2迁移，628规定每次V2写入的rollback投影；它位于todo目录不足以自动豁免当前Menu缺失调用，实际menu.ts8–9反而明确刷新要求。本项不是要求新增OS文件关联、recent访问时间语义或新导航能力。子审browser_cancel_gate另做纯源码TODO/tests核对，结论一致，0执行0写文件。

## 后续证据标准（本审计0执行）

作者若用owned目录、actual ProjectStore及ProjectAuthority callback完成create/rename/remove，应保留V2/recents/loadRecents三层健康结果与原Menu对象不变、internal rebuild恢复控制。Electron适配、Git根解析/Session依赖guard和实际App回调抽取范围应分层；仅替换mock recents数组不足以证明正式store变更。没有OS实际菜单点击不影响JS快照根因，但报告必须称owned Menu适配，不称完整native/App E2E。

本审计完成时未读取任何尚未给定的最终fixture运行结果，也不预写其通过。建议root在最终作者及两基线收据核完后按窄P3收录，保留上述删除保护/恢复限定。Completed；新增执行0、fixture0、正式finding0。

## 后续只读便携性账本（仍执行0，尚待修正版最终）

在前述纯静态阶段完成后，收到作者与root原始材料再做只读核对，未执行任何fixture。作者 `validation/original-menu-recents-round23/author-first/first-run.log` 的首次版本test SHA `e7be6ae20e849cfb6423b1e2d6da23d13f3ba8a05927fef3da39137d1f2afe34`、guard SHA `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`：latest一次1pass/0fail/43expect/Completed，observations completed=true、rootAdapterCalls有1项、networkOrChildAttempts=[]。

root把同source复制仓库docs便携目录后，两冻结基线**初次均0pass/1fail/41expect、exit1，不是Completed/通过**。原件在primary `validation/original-menu-recents-round23/root-first-portability-failure-{initial,latest}/`。失败断言是rootAdapterCalls.length>0实际0；observations completed=false、三个create/rename/remove业务phase已记录、unusedLeafCalls=[]，guard分别阻止一个Bun.spawnSync尝试，cleanup收据HOMEremoved、actualChildStarted=false。真实coding/git resolveProjectRoot会在Git探测异常后回退realpath，所以业务阶段能完成并不代表guard完整通过。此为fixture specifier解析/适配未命中的可移植性失败，不新增产品finding，也不将阻止的尝试称为真实子进程启动。

原因边界：源内repo tsconfig paths配置 `@cjhyy/code-shell-capability-coding/git`到 `packages/coding/src/index.git.ts`；旧版本仅按bare specifier注册mock，repo内运行与/tmp位置解析不一致。Core也有到源入口的tsconfig配置，但**存在配置不等于实际已经加载src**；fixture显式注入的SessionManager则直接从 `packages/core/dist/index.js`取。失败根因应称bare/tsconfig/exports地址解析及mock适配不一致，不能确定地说actualCore必走src。旧作者“所有Core公共/内部入口来自dist”也没有cache/加载探针支持，不能统一断言whole graph来自dist或src。应保留source/pathmap、显式dist两层及manifest，不扩大为真实Engine/worker；是否未构造Engine仍是fixture源码审计声明，而非module-cache/运行探针。

待修正版准确SHA与作者/root最终日志到齐后继续只读整合审。当前不把旧43expect作者通过与root两个41expect失败混成双基线通过，不预写R83或增加82/246计数。

## 修正版最终收据只读复核（执行仍0）

作者修正版test SHA `9983cb4dc9ec1d89ea58ddca6c785cfe0f7344f3f404f5f8e331a2b2766f9430`，guard仍 `6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d`。已逐段核portability-correction.diff：只将同一owned coding/git factory注册到bare及绝对src/dist reviewed barrel，并在产品import前增加Bun.resolveSync allowlist解析与manifest；原43业务expect、store/menu调用和guard未变，没有放松产品门禁。作者未再执行修正版，不冒称/tmp最终重复通过。

本审计直接读取root两树 `docs/review-2026-10-12/reproductions/menu-recents-round23/` 的最终log、fixtureSHA与observations：

| 主审独立基线 | 最终同源运行 | 守卫/阶段 |
| --- | --- | --- |
| initial84740 | 1文件1测试43expect，1pass/0fail/0skip、Completed | completed=true，rootAdapterCalls1、attempts[]、unused[]，create/rename/remove/rebuild四phase齐 |
| latesta66f | 1文件1测试43expect，1pass/0fail/0skip、Completed | 同上；内部正常rebuild次数1→4，非用户动作 |

两份productResolutions三项全部返回coding/Core public/internal **dist路径**。这只是Bun.resolveSync解析API收据，不是实际加载的module-cache证明；本审计不把tsconfig配置推断成actualsrc，也不把resolver结果推断成wholegraph统一dist。显式dist SessionManager构造与source-audited无Engine/LLM调用范围保持。ProjectStore注入该manager后不构造默认class，本次create/rename/remove未进入sessionMainRoots/removeRoot/migrate等SessionManager业务方法；不存在必须通过同一class instanceof的被测路径。

动态结果支持静态P3影响：实际V2/recents磁盘与fresh load随成功操作变化，已装菜单各phase仍保留旧空项/旧名/删除旧项；internal重装恢复当前磁盘内容。App未执行，删除后实际旧menu只发送A、live registry仍空及tombstone保留，用户端静默return仍是actualApp源码衔接。无native/fullApp OS菜单E2E，不能扩大。

root另说明其首轮最终metadata QC错误预期解析必须src而assert失败，属于只读元数据检查假设错误，不是第三次fixture失败，不应重跑已Completed的两基线业务fixture。该元数据诊断与上述两次旧源码0/1/41可移植性失败分开记账。

现在支持在root完成清理receipt与主报告整合后正式收录窄P3；正式编号/全局计数仍由root统一结算。作者旧first1/43、root旧first各0/1/41、root修正版final各1/43四类收据不互相替代、不累计为suite。本审计全程新增测试/原生/模型/网络执行0、未改fixture/产品/主报告。
