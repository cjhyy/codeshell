# Round23 Recent 菜单快照候选：独立只读审计

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
