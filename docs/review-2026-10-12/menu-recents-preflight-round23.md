# 第23轮：macOS 最近项目菜单更新的独立只读预审

> 阶段说明：本文原计数/未执行候选段属于菜单owner收束或Recent运行前阶段；当前已收录R83，最终83项及83/247见[主报告](README.md)与[Recent双基线收据](menu-recents-round23.md)。历史运行数量不回写。

结论：**排除“现代项目不写 legacy recents”这一根因；支持保留一个独立的 P3 静态候选：成功项目变更后未失效/重建已安装的 Recent 菜单快照。** Completed，新增执行0、正式新增0；没有改产品、fixture或主报告，没有运行测试/Core/worker/模型/CLI/native/Electron/浏览器/网络。当前81项及81文件243个通用Bun测试/基线计数不变。正式纳入与否由root决定。

只读冻结a66f4ef2源码、当前R01–R81主报告和相关迁移计划；不是任意修改mock数组的实验，不声称实际OS菜单已点击或双基线已运行。

## 关键反证：现代存储有完整的降级投影桥

`ProjectStore`默认主文件是`desktop/projects.json`，兼容文件是同目录`recents.json`（[project-store.ts:155](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:155)）。

- `createFromPath→registerFromPath→mutate`创建新项目或显式恢复tombstone，设置name/primaryRoot/lastOpenedAt等；见 [project-store.ts:209](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:209)。
- 每次成功`mutate`在V2写入后调用`projectRecents(readRegistryFile(...))`，见 [project-store.ts:822](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:822)。初始化创建V2时也投影，见 [project-store.ts:763](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:763)。
- 投影逐项目写primary.path、project.name、lastOpenedAt、pinned、deletedAt；该桥注释明确是一个发布周期的rollback输出，只有projects.json缺失时才从recents导入。见 [project-store.ts:839](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:839)。健康写入时现代项目变化会更新legacy来源，不能称其永久断开或错误地把recents当现代权威。
- projection失败会记录日志，不回滚已成功的V2 mutation（:866）；本候选**不依赖拒写、坏文件或该容错边界**，仅用健康存储路径。
- 仓库已有 [project-store.test.ts:979](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.test.ts:979) 的V2权威/rollback projection控制源码；本轮未运行，不能称通过或加入计数。

计划 [multi-folder-local-project-plan.md:614](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/todo/multi-folder-local-project-plan.md:614) 明确V2/recents迁移与每次V2写入后的投影。计划在todo目录不等于所有相邻缺陷都获准后置；对本轮检查的Recent live刷新，未找到明确延期契约。相反 [menu.ts:8](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:8) 要求recents变化时重装菜单。

## 剩余候选：已安装菜单只持有一次读取的快照

`installAppMenu`只在调用时`await loadRecents()`，随后`recents.map`创建固定label/sublabel和闭包payload，再设置macOS application menu。来源：[menu.ts:18](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:18)、[menu.ts:56](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:56)、[menu.ts:143](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:143)。没有menu-will-show动态读取，也没有项目广播修改已建MenuItem的路径。

全仓生产安装只有createWindow末 [Main index.ts:2711](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:2711)；`refreshAppMenu`只有定义及内部调用，没有生产调用者。现代create/rename/remove接线实际调用store后仅广播registry及mobile projects，见 [project-authority-ipc.ts:60](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:60)、[project-authority-ipc.ts:82](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:82)、[project-authority-ipc.ts:165](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:165)。实际Main依赖注入没有其他menu updater，见 [index.ts:5553](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5553)。renderer registry subscription也不会调用Main菜单刷新。

**自然生产时序，单个窗口即可：** 等A正常完成菜单安装；使用A的正式Sidebar添加项目/重命名/移除；等成功mutation及正常registry广播应用；再次展开系统Recent菜单。没有新建窗口/重启，因而没有新的installAppMenu。健康磁盘recents已更新，但当前MenuItem仍是安装时的数据。

| 操作 | 真实写入及菜单静态结果 |
| --- | --- |
| 首次/新增项目 | Sidebar `onAddProject→useSessionNavigation.addProject→projectRegistry.createFromPicker`，见 [Sidebar.tsx:411](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:411)、[useSessionNavigation.ts:120](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:120)。V2和recents成功保存，Sidebar选择新项目；旧菜单仍`(空)`或不含新项目，直到重装。 |
| 重命名已列出的项目 | [useSessionNavigation.ts:174](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:174) 调实际IPC，健康store在 [project-store.ts:487](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:487) 更新name/displayName，投影的新name正确；已建菜单仍旧label。旧payload仍按同一个path定位，所以不能称菜单打开了别的项目。 |
| 移除已列出的项目 | [useSessionNavigation.ts:138](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:138) 调remove；[project-store.ts:514](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:514) 写tombstone并投影。新读 [recents-store.ts:276](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/recents-store.ts:276) 会排除deleted项，但旧MenuItem未删除。正常renderer已应用移除后，点击该旧项在 [App.tsx:1429](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1429) 重读live registry，target缺失便return，缺明确反馈；不会调用createFromPath或清Main tombstone。 |

上述是实际路径推导，没有动态DOM/Menu receipt；不会把作者随意换loadRecents mock列表的控制直接当成这些store操作的端到端实证。若后续验证，需实际store/自有目录成功变更及磁盘投影控制，菜单adapter层另列，不需要真实用户数据或OS操作。

## 现代“使用”时间与删除保护的范围

`touchProject`更新updatedAt/lastOpenedAt/revision（[project-store.ts:1166](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:1166)），调用来自项目mutation；新建/显式恢复也更新lastOpenedAt。没有找到普通selectProject/open-recent专门touch IPC，旧`pushRecent`亦无生产调用。`loadRecents`按存储lastOpenedAt排序并限制10项（[recents-store.ts:239](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/recents-store.ts:239)、[recents-store.ts:282](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/recents-store.ts:282)）。本轮**不另报排序语义缺陷**，也不把10项上限、多root只投影primary等既有设计算问题。

旧Recent点击先调用`unmarkProjectPathRemoved`，只改renderer本地removed-path标记；真正list默认过滤Main tombstone（[project-store.ts:169](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:169)）。因此不要描述成绕过用户删除、恢复授权或重新创建项目；删除后残留无效菜单及静默return是合适的窄影响。还未测试删除期间旧renderer缓存尚未更新的竞态，不作扩大。

## 正常反证、恢复、去重与分级

正常静态控制：健康mutation后**重新调用installAppMenu**会重新读已投影的recents，loadRecents过滤tombstone、当前name和10项列表可被反映。真实生产重装入口是新建窗口；重启/关闭全部主窗口后activate再createWindow同样会重装。仅展开菜单、聚焦原窗口或reload renderer没有该Main调用，不称其自动恢复。Sidebar仍可访问健康项目与名称，不影响Core项目权威或历史。这里恢复接线仅静态，没有启动/重启实际App。

与同轮窗口closure候选独立：本项单窗即可，dispatch到正确A也会看到陈旧列表；按click选择focused窗口不能刷新数据。反之重建菜单可更新列表，却不消除后续焦点变化后的capturedwin误投。可以同PR处理，根因/触发/必要修复独立；应在项目变化时失效/重建或菜单展开时读当前投影，并同时遵守正确窗口归属。

与R29独立：R29是启动legacy transcript迁移await覆盖renderer的新registry广播，Main持久项目仍在；本项无需迁移/await冲突，Main与renderer正确而菜单快照过期。与R71失败重命名独立：本项限定成功重命名，磁盘name已新，旧label只在menu。与R24移除worktree清理也独立，本项不涉及session/worktree/文件损失。

**R29恢复措辞的相邻限制：** 既有“Open Recent可重读registry协调投影”只在菜单本来已有目标path时成立，或者菜单在新项目创建后已重装。如果B是在菜单安装后新添加，本候选意味着当前菜单未必有B，不能把Open Recent写成所有R29触发都可立即使用的恢复。此前R29重命名A的真实广播恢复证据仍成立；本轮不执行其fixture，也不自行改主报告。

建议仅P3候选：在正常成功操作后菜单陈旧，新增项目无法通过该菜单选择、旧名/已移除项误导，但Sidebar和持久权威正常，已有重装恢复；没有重要运行中断、数据损失或身份越权证据。当前是可信生产静态接线，尚未动态复现，不建议提前计正式或升P2。

Completed，新增执行0，正式新增0。
