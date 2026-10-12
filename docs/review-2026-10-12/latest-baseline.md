# 0.9.33 主分支差异复查

01:30（Asia/Singapore）拉取发现 origin/main 从初始审查基线 `84740d56e55517b004948a0a0e07649ad6fbf998` 更新至 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，版本 0.9.33。主要新增 Panel 稳定项目身份与共享 Collection 跨文件查询，另有发行记录和版本号更新，共 54 个路径变化。没有将新产品代码合入原报告分支。

新隔离工作区：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，分支 `codex/review/latest-20261012`。原始报告与证据继续保留在 `server-desktop-review-20261012/codeshell`。两者产品均无手工改动；Desktop build 自动生成的 tracked extension bundle 已核对并只还原该构建产物。

## 已完成验证

| 范围 | 最终结果 | 记录 |
| --- | --- | --- |
| frozen install、workspaces build、Desktop build、typecheck:workspaces | 全部通过 | `validation/latest-a66f4ef2/{install,build,desktop-build,typecheck}.log` |
| 8 个新增或修改测试文件 | 156 项实际执行、0 失败、0 跳过 | `validation/latest-a66f4ef2/changed-test-results.json` |
| 既有便携缺陷表征和正常契约 | 83 文件、247 测试、0 失败、0 跳过 | `validation/latest-a66f4ef2/reproduction-results.json` |
| 凭据实际 Electron/IPC/store | 4 场景通过 | `validation/latest-a66f4ef2/credentials__credentials-e2e.mjs.log` |

复现“通过”表示当前仍观察到被测缺陷。83 个文件并非与问题项一一对应，一份文件可能覆盖多项发现，也包含正常对照。新快照结果没有加到原基线 6286 个现有测试的总数中，以免重复计数。

## 两处测试入口适配

1. Panel bindGuest 从同步改为异步，原 VM fixture 未提供 AbortController 和可重复检查的 owner/guest 身份，首次新快照跑失败。仅改审查 fixture，使它同时支持同步和异步接口，并提供稳定的模拟身份。原基线、新快照均重跑通过。生产方法仍在进入新 scope resolver 前拒绝合法 secondary root，R22 未被修复。
2. `packages/desktop/tests/panel-app-main.test.ts` 必须经 `panel-app-protocol.test.ts` 子进程入口设置内部标记。直接 guarded 运行注册 69 项但全跳过；环境变量直接传入也会被外层隔离器清除。随后运行正式 spawner 成功，并用同样子进程机制的 `validation/panel-fixture-counts.test.ts` 展开日志，确认 69 pass、0 skip。最初的跳过日志保留，最终结果指向 `panel-fixture-expanded.log`。外层仍使用 guarded runner，子进程继承其隔离 HOME 和无凭据环境。

## 适用范围

主报告 R01–R48 的源码行号仍指初始基线；新快照可能因新增 import/声明发生行号偏移。既有便携证据和实际凭据 UI 场景在 0.9.33 下仍成立。R21 的二次验证复用初轮真实 native Hub 捕获，并执行新快照的生产恢复函数与 replay；本轮没有重新宣称完整原 native Hub smoke 已通过。

凭据脚本原始 observations 中保留了 fixture 作者写死的 `84740d56` 标签；本次实际执行入口、工作区和构建为新快照，已在 `validation/latest-a66f4ef2/summary.json` 单独记录，避免将旧标签误认成运行目录。模拟 Cookie 和 plain cipher 回退等限制与原附录相同。

第六轮已确认共享 Collection 恢复指引 R49/P3、旧录音生命周期缺陷 R50/P2；Panel scope 没有正式新增，R22仍适用。新功能的2文件7测试另见 latest-reproductions/，录音9测试已在两基线分别通过。第七轮身份/连接正常契约 3 文件13测试、Agent Plugins 1文件7测试均已在两基线通过，R51–R53 是旧缺陷新发现；不把旧基线尚无的新功能测试塞入默认入口。

第八轮 Quick Chat R54/P3 及其正常对照7测试也已在两快照分别通过；正式范围限定已送达组件的内部图片 payload，未实测原生跨窗口拖动。更新器 shutdown 候选因平台模拟不符未列正式发现。

第十轮新增六份便携正常/恢复控制，两快照各14测试112断言通过；原有发现新增0，R11/R19依据实际门禁降P3并收窄。总通用46文件125测试。Core关闭28测试和审批正常20测试为现有套件专项复跑，另存validation，不计入该便携总数。

第十一轮新增通用4文件8测试108断言，两快照分别通过，当前50文件133测试。stable scope恢复对照另1文件1测试9断言仅新快照，总新功能专项3文件8测试。真实Electron搜索UI与下载恢复native smoke均仅新快照执行并单列，不加入Bun计数。R55/R56两快照复现；R57原生实验仅a66f，关键5文件旧新diff为空。

第十二轮文件传输、导出、图片保存与磁盘导入正常控制：新增2个通用文件5测试136断言，两基线分别通过；正式新增0。通用总52文件138测试。Bun取消诊断超时单列为不确定harness结果，不计通过或Node产品缺陷。

第十三轮终端、首次提交Review、侧栏删除、多窗口目录与配对Web离开审批：新增6个通用文件48测试304断言，两基线分别guarded通过；当前通用58文件186测试0fail/skip。新正式R58/P2、R59–R62/P3，均旧实现本轮新发现，未归因于0.9.33变更。多窗口33个既有保护测试通过wrapper计在6文件中，不额外再加一次。

第十四轮新增4个通用文件13测试130断言，两快照分别guarded通过；通用累计62文件199测试0fail/skip。新增R63–R65/P3，R58补同根因图片操作，不另加编号。真实Electron reload身份另仅在a66f/macOS验证1场景、两次reload，无worker或真实PTY；native实验不并入Bun总数。03:43再次fetch，origin/main仍为a66f4ef2。

第十五轮新6文件12测试142个Bun断言在两快照分别guarded通过，通用累计68文件211测试0fail/skip。R66/P2接管实例mode、R67/P3远程设置LAN状态、R68/P2直播outbound backlog均旧实现新发现。R68每快照wrapped native另33断言，不另加Bun测试；84740与a66f各在24MiB负载上限停止，精确backlog数值和恢复记录见连接附录/归档json，不把TCP缓冲差异当产品行为差异。无真实CLI/Main worker/付费模型或OOM实验。

04:23再次fetch，origin/main仍a66f4ef2；两冻结产品快照没有更新或混写产品代码。

第十六轮4个新通用文件10测试104个Bun expect在两冻结快照分别guarded通过，当前72文件221测试0fail/skip。R69/P2为已登记secondary物理缺失时修复迁移被全roots校验阻断，R70/P3为自定义指令自动保存拒写后pending清空导致离开失稿；均旧实现新发现，两个独立审计通过。Link5测试及真实HubAuth/MCP正常控制新增0；后者wrapped Node22断言、设置owned Bun helper27手工assert另列，不重复增加测试。无完整Electron/HeadlessServer/真实OAuth、模型或CLI实验。

05:07再次fetch，origin/main仍a66f4ef2。第十七轮4新文件7测试77个Bun expect两基线分别通过，当前通用76文件228测试。R71/P3项目rename拒写、R72/P2设置恢复漏Core writer、R73/P2配置早退污染approval lease均旧实现新发现。owned Bun helper91手工assert只包含在一个wrapper，不是native。上下文实际Engine使用自有内存provider；Hub实际HTTP/WS使用内存worker桥、Core配置控制fake engine/runtime，未启动真实worker/付费模型。三份独立审计及严重问题反证新增执行0。

第十八轮上下文取消/模型偏好/Hub续接三项P3，新增通用3文件8测试165个Bun expect，两冻结快照分别guarded通过，当前通用79文件236测试。作者latest-only记录与root双基线收据各自保存，不把源码相同替代执行。三份独立质量审计新增执行0；无真实模型/worker/Electron或新native/helper计数。

05:50再次fetch，origin/main仍a66f4ef2，两个冻结快照不切换；第十八轮三份portable源码两快照SHA256完全相同，见validation/round18-portable-source-sha256.json。

第十九轮R77/P2原生文件锁权限恢复：84740/a66f各一次maintained Node isolator/38 Node assert/Completed，正式首因是HubAuth认证锁data/hub.lock EACCES，不是title store。fresh /health分别约30.02/30.03秒，权限修复后重试及真实短跨进程争用正常。Node25.8.1/darwin arm64边界，不泛化只读盘/其他系统；通用Bun仍79文件236测试，native独立列账，见[file-mutex](file-mutex-round19.md)。

第二十轮R75/P3原生存储契约补证仅latest Electron33/macOS：作者与主审同源脚本各一次31 Node断言/Completed、owned Main exit0及privateHOME清理；纯HTML不加载产品Main/preload/hook。并未在两个产品基线各跑完整App，不增加Bun或finding；见[补证](model-native-round20.md)。

第二十轮[Goal/Sleep](goal-sleep-round20.md)两根因R78/R79均P2，原关键实现两快照相同，root仍分别guarded复跑4tests72expect并保留两份日志；通用80文件240测试。无worker Main fallback与cold bound Core权威缺失分层，真实Engine只用内存provider，正常resident/legacy/普通authorized run恢复控制正常，无实际worker/Electron/提供方。

第二十一轮[Browser闲置失联反馈](browser-lifecycle-round21.md)R80/P3关键源码两基线相同，root同源分别guarded复跑1文件3测试40expect/Completed，累计81文件243测试。实际2秒轮询/显式重新配对/动作门禁正常控制，无真实Chrome/Electron/native relay/网络；见[双基线收据](validation/round21-browser-results.json)。

第二十二轮[Browser Stop](browser-stop-round22.md)新增R81/P2，十二个关键产品source两基线及作者manifest同SHA；root同源分别maintained native通过66 Node断言/Completed，作者latest另66独立账本，不合并198 suite。三次已知Main/renderer共9PID均已退出、privateHOME清理；只读info重试作者0/root旧2/root新1，mutation未重试。Bun仍81文件243测试，详见[分账收据](validation/round22-browser-stop-results.json)。

第二十三轮R82收束阶段（历史）：R82/P3菜单owner在两冻结基线各guarded1文件3测试39expect通过，当前通用82文件246测试；actualmenu/preload/App full SHA与提取SHA相同，owned Menu/window IPC/recents适配，不冒充native OS或完整App。当时Recent刷新仍待实验、不计数；其最终R83验证见下一段。

第二十三轮[Recent刷新](menu-recents-round23.md)再增R83/P3及1文件1测试43个Bun expect，两冻结基线修正版分别guarded通过，通用83文件247测试；与owner合计本轮2/4/82。原作者first1/43和root两次原版便携失败0/1/41独立归档，修正版作者0次，未启动native或实际产品子进程。
