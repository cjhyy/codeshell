# CodeShell 服务端与桌面端审查

本次审查覆盖服务端、Electron 桌面端、配对 Web 与移动端的日常流程，重点检查消息发送、审批、取消、切换会话、恢复和项目上下文。问题只在有代码证据或可复现结果后列入正式发现。

审查进行中，截止时间为新加坡时间 2026 年 10 月 12 日 11:00。初始审查基线为 `84740d56e55517b004948a0a0e07649ad6fbf998`，对应启动审查时的 `origin/main`。01:30 拉取发现主分支已更新至 `a66f4ef291f304ee4df9da8095a90671d9a8f140`（0.9.33）；已另建隔离快照复查差异，原始复现和行号仍按初始基线保存。86 个便携 Bun 复现文件共 251 测试，以及实际 Electron 凭据 4 场景，已在新快照复查成立；详见[0.9.33 差异复查](latest-baseline.md)。产品代码保持原样，报告保存在独立分支 `codex/review/server-desktop-20261012`。

用户流程、正常对照与修复顺序见[流程覆盖地图](flow-coverage.md)。 可直接用于安排工程工作的[修复交接建议](repair-handoff.md)列出六组交付结果和应保留的验收场景。

## 当前结论

当前已收束 86 项问题：1 项 P1、52 项 P2、33 项 P3。优先处理审批状态、任务回执和会话身份；这些问题会让任务无法继续、重复执行，或把用户输入带到另一个会话。P1 表示有未提交文件丢失风险、应优先修复；P2 表示重要流程持续受阻、状态被错误持久化或有错误执行风险，应安排修复；P3 表示影响较小或触发范围较窄、可通过现有操作恢复的问题。分级同时考虑影响与触发条件，不能只按是否可重试判断。尚未证实的候选不计入数量。

**最先修 R35：创建工作区时重复 Enter，失败请求的回滚可以删除另一个已成功请求的 worktree、分支和未提交文件。** 此项已由独立代理复查入口与真实 Git 时序，见 [独立质量复核](quality-audit.md)。第五轮九项也已[独立复核](quality-round5.md)，均保留，网关通知等条件已收窄。

以下是持续审查的阶段记录，截止前还会补充。复现测试的“通过”表示已稳定观察到当前缺陷，并不表示缺陷已经修复。R01–R48 的原始分析针对初始基线，并已在 0.9.33 复查；R49 针对新快照；R50–R56 在两基线均存在并已分别复现；R57 关键源码两基线相同，原生实验仅在 0.9.33 执行。R58–R65 的便携证据在两基线分别复现并通过正常对照；R64 的真实 Electron reload 身份门禁仅在 a66f/macOS 补证，未运行真实 PTY。R66–R68 的便携证据也已在两基线分别通过；R68包含真实Node/ws慢读实验，每次最多24MiB输出，没有真实Main worker或OOM实验。R69/P2与R70/P3及第十六轮正常控制也已在两基线分别通过。R71/P3、R72/P2、R73/P2及第十七轮正常控制已在两基线分别guarded通过；本轮没有真实worker/模型或Electron实验。R74–R76/P3及第十八轮正常控制也在两基线分别guarded通过；实际Core/Engine范围与React/IPC/worker替身按附录区分，未启动真实模型。R77/P2用maintained Node isolator在两基线分别原生复现，各38个Node assert独立计数，不增加通用Bun测试。R78/R79/P2的Goal冷恢复及正常控制已在两基线各guarded通过1文件4测试72个Bun expect；实际Main callback/App closures/renderer/preload与Core/Engine分层，内存provider，无完整App/worker/Electron。R80/P3的Chrome闲置断线反馈已在两基线各guarded通过1文件3测试40个Bun expect；实际Panel/Backend与preload/Main callbacks，Native传输及owner目录为内存适配器，没有真实Chrome/Electron。行号按各专项附录的基线解释。

| 编号 | 级别 | 流程与实际影响                                                                        | 详细证据                                             |
| ---- | ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| R35  | P1   | 重复 Enter 并行创建同名 worktree，失败请求强制回滚成功请求的目录、分支及未提交文件    | Desktop D13，第三轮                                  |
| R01  | P2   | 连续两个并行审批复用卡片，第二个显示“已批准”而无法操作                                | Desktop D4                                           |
| R02  | P2   | CLI 房间实际免审批，界面却显示“逐次确认”；更改选择器也不改变 CLI                      | Web W4                                               |
| R03  | P2   | 已执行任务丢失 ACK 后恢复可重发草稿，重试生成新意图 ID 并重复执行                     | Web W1                                               |
| R04  | P2   | 在 A 执行斜杠命令后切到 B，迟到的展开结果覆盖 B 草稿                                  | Desktop D5                                           |
| R05  | P2   | A 会话拖入的文件随切换残留到 B，发送因附件所属会话不符失败                            | Desktop D2                                           |
| R06  | P2   | 原生运行回包错误被当作普通结果，发送失败无可见解释，草稿已清空                        | Desktop D1                                           |
| R07  | P2   | Core worker 退出清掉仍在运行的外部 CLI busy 状态，停止按钮消失                        | Desktop D7                                           |
| R08  | P2   | 配对浏览器 CLI 房间的停止按钮发送原生 run.stop，实际房间继续运行                      | Web W3                                               |
| R09  | P2   | 第二个 Hub 启动失败前删除第一个实例仍在使用的上传文件                                 | Server S1                                            |
| R10  | P2   | CC 房间切换或离线后无法恢复待审批卡片，服务端一直等待直到超时                         | Server S6                                            |
| R11  | P3   | 连接失效但界面尚显示在线的短窗口，CC 审批发送失败仍删卡 | Server S7；正常离线有禁用及 handler 保护 |
| R12  | P2   | CC 一次多题澄清仅能回答首题，后续题目随控制请求被消费                                 | Server S2                                            |
| R13  | P2   | 切换澄清题后旧选择索引残留，选项数变少时提交抛异常                                    | Desktop D6                                           |
| R14  | P2   | 可稍后回答的异步问题在任务完成后仍阻塞新的独立任务                                    | Web W5                                               |
| R15  | P2   | 外部 CLI 后续消息只在当前会话推进，切到别处后队列停住                                 | Desktop D3                                           |
| R16  | P2   | CC 打开回包广播到同设备全部页签，也会覆盖用户较新的会话选择                           | Web W2                                               |
| R17  | P2   | 删除草稿附件不释放上传配额，空输入框仍被 16 个文件上限卡住                            | Server S3                                            |
| R18  | P2   | CLI 启动失败留下“运行中”句柄，安装/修复后同模式重开仍不能恢复                           | Server S4                                            |
| R19  | P3   | 同步审批未被处理且请求仍 pending 时交付失败，错误本身不恢复卡片 | Web W6；下一次有效 resync 可恢复 |
| R20  | P3   | Hub 接受超过 10、至多 20 MiB 图片，发送阶段才因 10 MiB 限制失败                                 | Server S5                                            |
| R21  | P2   | Hub Web 新会话首次运行中刷新，完整输出日志的 legacy anchor 被空基线裁掉，前端拒绝恢复 | Root R21                                             |
| R22  | P2   | 多根项目会话迁移到合法 secondary root 后，已绑定 Panel 被错误视为跨项目而打不开       | Desktop D8，第二轮                                   |
| R23  | P2   | 一个无效的已追踪项目目录让全部健康项目的 Panel 消失；65 个健康项目也触发批量上限      | Desktop D9，第二轮                                   |
| R24  | P2   | 移除项目先删除项目权威，再释放冷会话 worktree；重加项目后旧归档会话仍占用 worktree    | Desktop D10，第二轮                                  |
| R25  | P2   | 两个已打开的默认模型表单先后保存，后一个未改过的旧字段回滚前一个更新                  | Web W7，第二轮                                       |
| R26  | P3   | Skill 保存遇到 409 后按提示刷新，编辑器仍用旧 revision，无法继续保存                  | Web W8，第二轮                                       |
| R27  | P3   | MCP 配置已更新，迟到的旧 probe 响应却给新配置显示旧的成功结果与工具列表               | Web W9，第二轮                                       |
| R28  | P2   | 插件设置初次加载尚未完成时可切开关，写入空旧列表并重新启用之前禁用的插件/Skill        | Desktop D11，第三轮                                  |
| R29  | P3   | 启动迁移旧会话时，旧项目初始快照覆盖已到达的新项目广播；新项目从界面消失              | Desktop D12，第三轮                                  |
| R30  | P2   | 后台工具任务完成时终态写盘失败被吞掉，结果丢失并持续显示运行中、阻塞配置修改          | Runtime T1，第三轮；存储恢复后可取消/重试            |
| R31  | P2   | Node Hub 关闭先返回并退出，忽略 SIGTERM 的 Panel 原生进程来不及强制终止而遗留         | Runtime T2，第三轮；已验证 POSIX                     |
| R32  | P2   | 新设备浏览器存储配额耗尽时，配对和认证生成不同 secret，配对流程必然失败               | Web W10，第三轮                                      |
| R33  | P2   | 新会话 ACK 前收到后台原生输出，自动绑定错误会话并把新草稿迁走                         | Web W11，第三轮                                      |
| R34  | P2   | 手机 PUT 已开始后无法随断线取消，重连在线仍被旧上传阻塞独立文本发送                   | Web W12，第三轮；主机正常收到请求时有 5 分钟票据上限 |
| R36  | P2   | worker 退出与 JSON-RPC 写入交叉时，stdin 的异步 EPIPE 没有监听，Node Host 随之退出    | Runtime T3，第三轮                                   |
| R37  | P2   | 离线新建 B 项目请求丢失，重连首条任务可沿旧的未落盘 A 会话进入 A 项目                 | Web W13，第三轮；限定 freshNative 场景               |
| R38  | P3   | 退出设备必须等 HTTP logout 请求结束，响应卡住时本地界面和连接也不退出                 | Web W14，第三轮                                      |
| R39  | P3   | 恢复归档会话已成功，却被自身 busy 守卫误判为未保存修改，需额外确认才能打开            | Files/History F1，第四轮                             |
| R40  | P2   | 发送明确被拒绝前已输入后续稿，原失败文本不在草稿、聊天或历史中，无法直接恢复          | Web W15，第五轮；限定预入队拒绝                     |
| R41  | P2   | Hub 未确认送达的意图不计入刷新保护，实际未接受时刷新会丢掉唯一内存副本                | Web W16，第五轮；真实认证 Hub 补强                  |
| R42  | P2   | 新增 Cookie 账号用名称生成 ID，默认名或中文名碰撞会覆盖旧账号及权限                   | Credentials C1，第五轮；实际 Electron/IPC/store     |
| R43  | P3   | Token 保存遭遇真实存储拒写时没有可见错误，草稿保留但用户不知道失败原因                 | Credentials C2，第五轮                             |
| R44  | P2   | 续接自动化超过 120 秒后提前结算，worker 仍执行时保留的非once计划可以再次排入                   | Automation A1，第五轮；实际 ChatSession FIFO        |
| R45  | P2   | worker 明确拒绝续接运行，网关/生命周期仍宣告 completed                 | Automation A2，第五轮                              |
| R46  | P2   | 自动化执行历史按名称/时间认领，遗漏真实实时记录并混入同项目其他任务的结果               | Automation A3，第五轮；合并身份关联根因             |
| R47  | P2   | 任务异步自动停用后，当前自动化页面仍显示活跃和旧下次运行时间                           | Automation A4，第五轮                              |
| R48  | P3   | 自动停用原因在 Desktop 摘要中丢失，重开详情只能看到普通暂停                            | Automation A5，第五轮；底层原因仍持久保留           |
| R49  | P3   | 共享资料集跨文件查询吞掉已知原件变更的恢复指引，用户无法确定需更新哪个文件              | Collection，第六轮；0.9.33 新可达路径               |
| R50  | P2   | 等待麦克风启动时双击创建两份录音，停止及组件卸载只释放最后一份                         | Voice W17，第六轮；同一 renderer document 存活期间 |
| R51 | P2 | 成功安装后卸载，旧 installed 任务仍禁用市场重装，实际目录和注册已不存在 | Agent Plugins W18，第七轮；同一 Main 生命周期 |
| R52 | P2 | 市场相对路径源更新校验失败前删除旧插件，旧注册指向不存在目录 | Agent Plugins W19，第七轮；有效新源可重新安装恢复 |
| R53 | P2 | 从文件夹预览安装把临时快照记成更新源，快照已删，原文件夹仍在也无法更新 | Agent Plugins W20，第七轮；旧安装内容保留 |
| R54 | P3 | Quick Chat 收到文件面板 PNG 的内部拖放数据后静默丢弃，不产生图片或路径引用 | Quick Chat Q1，第八轮；系统图片拖入可用 |
| R55 | P3 | 较早的磁盘会话打开迟到完成，覆盖后来已成功的全局搜索导航；重选可恢复 | [搜索与导航 W21](search-routing-round11.md)，第十一轮 |
| R56 | P3 | 全文搜索仅扫描最近500个候选，漏掉更早匹配却返回完整的空结果 | [搜索 W22](search-routing-round11.md)，第十一轮 |
| R57 | P2 | worker崩溃后恢复的后台下载被closeSession/killAll过滤，成功ACK后仍继续写盘 | [下载生命周期 C1](download-round11.md)，第十一轮；Core原生实证 |
| R58 | P2 | 合法 managed worktree 新开终端及普通图片预览被 Main 注册根门禁拒绝，文本读取正常 | [终端](terminal-review-round13.md)、[图片与恢复](file-navigation-round14.md) |
| R59 | P3 | Review 选择首提交显示“no changes”，Git range 无父错误被吞为空结果 | [终端与 Review](terminal-review-round13.md)，第十三轮 |
| R60 | P3 | 侧栏删除遭遇真实权限失败仍移除行并持久 tombstone，仅日志无提示；历史页可重试删除 | [会话操作 W23](session-actions-round13.md)，第十三轮 |
| R61 | P3 | 同项目两个窗口普通选择互相覆盖当前会话，无法稳定各看 S1/S2 | [多窗口 M1](multiwindow-round13.md)，第十三轮 |
| R62 | P3 | 离开 CLI 房间后已有审批仍全局阻塞新稿，重选原生会话可恢复 | [Web 生命周期 W24](web-lifecycle-round13.md)，第十三轮 |
| R63 | P3 | 普通通知等待频率窗口时占住串行队列，后来的 urgent 停用通知也被延迟 | [通知 N1](notification-round14.md)，第十四轮 |
| R64 | P3 | Reload 恢复的终端先关闭再新建可复用旧壳；再次关闭重开可恢复 | [终端生命周期 TL1](terminal-lifecycle-round14.md)，第十四轮 |
| R65 | P3 | 目录实际 EACCES 被显示为空树，无错误提示；修权限后刷新可恢复 | [文件导航 W25](file-navigation-round14.md)，第十四轮 |
| R66 | P2 | 旧观察视图接管显示default，仍复用并发重开的bypass实例，同default重开不恢复 | [CLI接管 C15-1](cli-recovery-round15.md)，第十五轮 |
| R67 | P3 | 另一窗口开启LAN后，已挂载远程设置仍显示关闭、禁用停止；重挂或再开启可恢复 | [远程设置 MR1](remote-settings-round15.md)，第十五轮 |
| R68 | P2 | 配对端慢连接的直播/设备发送绕过已有backlog门禁，实际队列增长仍保持在线 | [连接 W26](connection-recovery-round15.md)，第十五轮 |
| R69 | P2 | 原secondary目录缺失，正式修复到健康primary仍被旧source全roots校验阻断 | [项目目录 PR16-1](project-recovery-round16.md)，第十六轮 |
| R70 | P3 | 自定义指令自动保存拒写后清掉pending，存储恢复也不重试，离开丢未保存稿 | [设置保存 S16-1](settings-recovery-round16.md)，第十六轮 |
| R71 | P3 | 项目重命名拒写后仍显示新名称，无失败提示，普通同步后回旧名 | [会话操作 SO17-1](session-operations-round17.md)，第十七轮 |
| R72 | P2 | 设置页取消归档只恢复桌面catalog，Core仍归档，随后可移除恢复行仍绑定的secondary root | [会话操作 SO17-2](session-operations-round17.md)，第十七轮；历史和物理目录保留 |
| R73 | P2 | 配置保存窗口内回答idle异步问题，lease已提交却未派发，重试和重连无法恢复旧题 | [Hub路由 H17-1](server-routing-round17.md)，第十七轮；取消后重新提问可恢复 |
| R74 | P3 | 上下文摘要期间没有可用取消按钮，30秒RPC超时恢复UI却未取消后台摘要 | [上下文取消 C18-1](context-cancel-round18.md)，第十八轮；Core取消正常 |
| R75 | P3 | 另一已打开项目窗口保存自己的会话模型，旧整图抹掉先前窗口已存偏好，重开回默认 | [模型偏好 M18-1](model-switch-round18.md)，第十八轮；重新选择可恢复 |
| R76 | P3 | 异步答案已接受并触发续接运行，Hub误判空闲而允许归档、隐藏当前历史行 | [Hub会话 HS18-1](hub-session-operations-round18.md)，第十八轮；实际恢复API正常 |
| R77 | P2 | Hub数据目录dataDir失去写权限，认证锁对EACCES同步重试约30秒，健康路由与Host定时器也被阻塞 | [原生文件锁 FM19-1](file-mutex-round19.md)，第十九轮；修权限后重试正常 |
| R78 | P2 | 无live worker恢复暂停Goal仅持久改为active并回成功，实际没有启动或派发续接 | [Goal冷启动 G20-1](goal-sleep-round20.md)，第二十轮；编辑/暂停/删除正常 |
| R79 | P2 | worker活着但bound会话非resident时，Goal续接缺WorkspaceContext，模型前失败却未回滚或提示 | [Goal bound冷恢复 G20-2](goal-sleep-round20.md)，第二十轮；正常授权run可恢复 |
| R80 | P3 | Chrome闲置断线后正常轮询仍显示正在使用，需先断开再重新授权；动作门禁正确拒绝 | [浏览器连接 B21-1](browser-lifecycle-round21.md)，第二十一轮 |
| R81 | P2 | Core Stop已结束且尚无Input时，Main旧浏览器点击仍等待并在按钮启用后提交真实输入 | [Browser停止 B22-1](browser-stop-round22.md)，第二十二轮；提交后动作不回滚 |
| R82 | P3 | macOS前台A显式菜单操作仍发往最后安装菜单的B，后台窗口被打开Search/Palette或切项目 | [菜单窗口 D23-1](menu-routing-round23.md)，第二十三轮；无真实OS菜单/快捷键实测 |
| R83 | P3 | macOS项目成功创建、改名、移除后Recent菜单不刷新，新项目缺项、旧名和已删项残留 | [最近项目 D23-2](menu-recents-round23.md)，第二十三轮；权威磁盘与广播正常 |
| R84 | P3 | 从未发布输出日志的旧配对原生图片会话恢复时，把内部路径和模型提示当正文，没有安全附件摘要 | [旧历史 F24-1](legacy-history-round24.md)，第二十四轮；正文和图片原件保留 |
| R85 | P3 | 现代图片会话在普通Desktop冷恢复后缺附件提示，纯图片用户气泡不显示；正确metadata和原件均保留 | [现代图片 D25-1](modern-desktop-image-round25.md)，第二十五轮；Web及inline UI控制正常 |
| R86 | P3 | 换项目primary后摘要分叉的Files把新根ID配旧workspace路径，新主目录文件无法显示；旧根及原件正常 | [Files映射 F27-1](file-root-round27.md)，第二十七轮；Main拒读正确 |

第一轮完整分析：[Desktop](desktop-round1.md)、[Server](server-round1.md)、[Web/配对端](web-round1.md)。后续专项分析会继续补充到本目录。已有结论还经[CLI 范围复核](cli-quality-round9.md)与[资源回收范围复核](resource-quality-round8.md)收窄恢复及平台条件。

第二轮完整分析：[Desktop 项目/Panel](desktop-round2.md)、[Web 配置/Skills/MCP](web-round2.md)。所有已收束脚本和日志保存在 [reproductions](reproductions/README.md)，可在当前工作区或相同基线的其他 checkout 重跑。

第三轮持续补充：[Desktop 插件/项目初始化](desktop-round3.md)、[手机配对/草稿/上传](web-round3.md)、[后台任务与 Node 主机退出](runtime-round3.md)。第四轮：[文件与历史流程](files-round4.md)。第五轮：[发送失败与刷新保护](web-round5.md)、[凭据新增与保存](credentials-round5.md)、[自动化执行与状态](automation-round5.md)。第六轮：[共享资料集恢复](collections-round6.md)、[录音生命周期](voice-round6.md)，已[独立复核](quality-round6.md)；[Panel 项目身份差异复查](panels-round6.md)没有新增正式问题。第七轮：[Agent Plugins 生命周期](plugins-round7.md)新增 R51–R53，并经[独立复核](plugin-quality-round9.md)保留；[身份与连接恢复](auth-round7.md)新增 0，正常契约已复现。第八轮：[Quick Chat 生命周期](quickchat-round8.md)新增 R54/P3；[Link 授权边界](links-round8.md)未确认新问题；[更新器候选独立反证](updater-candidate-audit.md)已排除。第十轮[Desktop 异步状态与恢复复核](desktop-quality-round10.md)保留六项P2并收窄影响；[Session 关闭屏障复核](session-close-round10.md)新增 0，现有正常套件 28 测试通过。

## 需要先修的边界

### 工作区回滚必须证明资源归属

R35 的界面创建按钮已禁用，但输入框 Enter 没有 busyAction 检查，实际发出两个相同 IPC 请求。Main 同一会话允许两次创建并行进入，两个预检都可以看到路径/分支不存在。某一创建成功后，另一真实 Git 错误返回触发无条件 `git worktree remove --force` 和 `git branch -D`，删掉成功请求的资源。成功广播已经发出，会话仍指向已删除路径。

复现的 barrier 只固定真实 Git 完成顺序，没有伪造返回结果。未提交文件丢失需要文件在成功返回至失败回滚之间产生，不声称每次重复 Enter 都有该文件损失；自然并发也观察到回滚干扰仍在 checkout 的成功进程。应同时阻止 UI/Main 重复工作区修改，并用此次调用实际创建资源的凭据决定能否回滚；仅依赖事前不存在检查不能提供并发归属证明。

### 审批必须以请求身份保存和恢复

R01 的触发是两个并行 GenerateImage 请求：批准第一个后，第二个复用 ApprovalCard 的已决定状态，没有剩余按钮。真实 Core 的并行工具队列已经确认会同时产生这两个审批，并非人为构造的不可能状态。R13 是同类身份缺失在 AskUserMessageView 的表现，但会直接触发提交异常。

R10、R11、R19 分别缺少待审批快照、传输失败保留和回包错误恢复。第十轮[审批独立复核](approval-quality-round10.md)将 R11/R19 降为 P3：正常离线 UI 有保护，R11 只保留传输已失效而界面仍在线的事件窗口；R19 必须是答复尚未消费且仍 pending，有效 resync 可恢复，普通 worker 忙碌不足以触发。修复时应保留请求 ID 与待提交状态，按服务端 resolved 回包清除，房间激活与重连时补齐 pending snapshot。单独补一个前端按钮无法解决重连丢失。R14 还需把真正阻塞的审批与可异步回答的问题分开。

### 重试必须保留原意图，切换必须保留会话身份

R03 已用实际客户端和真实 Engine 分别验证：同 ID 重试只调用模型一次，新 ID 会执行第二次。当前丢 ACK 路径恢复普通草稿并重新生成 UUID，缺少不确定回执状态与历史核对。建议沿用 Hub 控制器的意图保留思路，先确认 durable receipt，再允许重发。

R04、R05 分别涉及迟到的异步展开和组件内附件状态。发起操作时应冻结会话 ID；回写时检查该 ID，不能使用完成时的 activeBucketRef。附件、引用和文本草稿应采用一致的会话归属。R16 同时需要 viewer 定向回包及导航请求关联，避免跨页签和迟到回复改变目标。

### 控件必须对应实际运行时

R02 和 R08 的共因是 CLI 房间仍使用原生会话的权限和停止回调。R02 限定实际以 bypass 启动的受信任工作区；非受信任 cwd 的 bypass 请求会被服务端降为 default。界面需要显示房间实际启动模式，并用显式房间协议取消或重启 CLI。R07 则需要记录每个运行的 runtime 来源，Core worker 退出只能清理 Core 活动。R15 的后台队列推进应独立于当前显示的会话。

### 新会话首次运行中的恢复不能裁掉日志基点

R21 的真实 native Hub + Core + 本地模拟模型响应中，`outputJournal.status=ok`、`legacyBaseComplete=true`，但 `transcript=[]`。服务端 [run-replay.ts](../../packages/server/src/hub/run-replay.ts) 第 192 行按开始运行前的 `baselineEvents=0` 裁掉随后生成的 `session_meta`；[headless-server.ts](../../packages/server/src/serve/headless-server.ts) 第 1460–1478 行将该结果用于日志恢复。真实 [chat.ts](../../packages/web/app/chat.ts) 第 102–107 行因此抛出 `Output recovery has no complete legacy base`。

这不是日志损坏：读取 legacy base 已返回 complete，随后才被 RAM overlay 规则裁空。应让 durable journal 的恢复基点与旧 RAM stream overlay 的运行前切片分开处理，并补真实 worker 首次创建会话的刷新测试。运行结束后 RAM replay 释放，影响窗口主要是首次运行尚未结束的阶段。

### 主机启动与资源回收要保持正在使用的资源

R09 中第二个实例因端口占用退出，第一个实例仍健康，但其附件已被删除。应在任何清理前取得数据目录的独占租约，或按实例分区并只回收已证明不再使用的文件。R17 则需要显式丢弃上传的接口；新登录仅可能绕过 owner 配额，旧文件仍占全局 32 槽/128 MiB，并非可靠恢复；TTL/sweep 或重启才回收此批文件。单纯从草稿 UI 删除不等于释放服务器资源。R18 应在 failed spawn 的 error 路径也退役对应 ChildProcess，允许同模式重开重试。当前侧栏新鲜 probe 通常挡住缺少 CLI 的选择；已验证触发限定成功/陈旧 probe 后的真实异步启动失败。服务级显式 close 或更改模式可触发重新 spawn；当前可见 UI 恢复入口未动态验证，不能称一键关闭恢复。

R22 已用真实 ProjectStore、SessionManager 和生产 bindGuest 方法复现：会话权限判定为同项目且 rootStatus=ok，但 Panel binding 只接受 primary path。应以项目 ID 与授权根集合校验所属项目，而不能把合法 secondary root 当作其他项目。

R23 需要逐项目处理失败并按 IPC 上限分批；清掉的是当前 renderer 的 Panel App 注册项，健康项目、磁盘包、绑定和内置面板仍在。恢复目录或将65个项目减到64个后刷新可恢复。R24 需要在项目权威有效时完成 worktree release 再 tombstone；影响限定 cold/evicted 的 durable fallback，真正 resident helper 能先脱离。现有恢复是重加原项目、在设置恢复旧会话后重新归档，释放占用后可安全清理。实际 Git 与生产 helper 对照见[第十一轮工作区复核](workspace-quality-round11.md)。

### 配置冲突需要可完成的恢复路径

R25 用完整认证 Hub 和真实配置写入门禁验证：两端从同一快照打开表单，第一份请求已完成、门禁释放后才提交第二份旧表单，仍发生未改字段回滚。需要字段级 patch 或 revision/CAS；互斥锁只能防止同时执行，不能识别已过期的用户表单。

R26 应提供保留草稿的差异核对和读取最新版本操作，不能只刷新列表并清掉错误。R27 应把 probe 结果绑定被测配置的 revision，配置刷新后拒绝旧结果；服务端取消已经结束的 probe 不能撤回网络中迟到的成功响应。

R28 的初始状态把禁用列表设为空，但插件列表独立先加载完成，开关已经能写整个配置。应在设置快照可用前禁用修改，并按修改字段或最新 revision 更新；Main 的 skill 扫描同步，已验证窗口是 renderer 插件行先显示、权威初始 refresh 尚未完成，包含 IPC 和异步设置读取；旧初始化响应也不能覆写更新的设置。R29 则发生在真实旧会话迁移等待磁盘写入时，新增项目 B 的广播先应用，迁移结束后旧列表 A 又覆盖它。应给项目初始快照和广播统一的版本检查，避免 Main 有 A+B、界面只剩 A 而 activeProjectId 仍指向 B。

### 后台任务和主机退出要给出真实终态

R30 已用实际目录权限失败验证：执行器已经完成，终态提交却遇到 EACCES；异步拒绝被 pump 吞掉，内存与磁盘继续显示 running，没有结果或错误通知。权限恢复不会自动补写；显式取消后可重试，重启会标 interrupted。因此应保留可恢复的终态并呈现存储失败，避免将不存在的活动任务长期计入配置门禁。

R31 用真正 Node v25.8.1 Host、真实认证 Hub API 和临时 Panel 原生进程验证。server.close 约 1ms 返回，CLI 随即退出；应在 3 秒后强制终止的进程在 3.3 秒后仍存活。关闭接口应等待进程组退出或强制终止完成。测试仅操作自己创建的临时进程，并验证最终清理完成；未验证 Windows 路径。

### 手机连接恢复要稳定身份和操作归属

R32 的 localStorage 读取仍可用、写入抛 QuotaExceededError 时，safeSet 吞错但没有跨调用的内存身份，导致 pair.complete 和 auth.device 使用不同 secret。应提供页面级稳定后备并说明存储限制。R33 的新建草稿迁移只能由对应 clientRequestId 的创建确认触发，后台其他会话的正常 stream 不能抢占新建状态。

R34 需给每个上传绑定 AbortController 和 connectionGeneration。重连成功只说明 WebSocket 可用，不能证明先前 HTTP PUT 已结束；旧请求仍占用全局 sendingRef，界面没有独立上传取消入口。主机已有票据到期中止，不能据此省略客户端恢复路径。

R36 还需监听每个 worker stdin 的异步错误并结算相关请求。现有 ChildProcess error/exit 处理不能替代 Socket 的 error listener；真实 Node fixture 在 sendLine 返回 true 后因 EPIPE 退出 1。已验证请求大小低于生产 WS 上限；实际退出证据针对原生 Node Hub/serve，未验证 Electron 主进程的退出语义。

R37 不能泛化为任意已保存会话误执行：已保存会话有 authority gate；已由本设备创建但尚未落盘的 freshNative 会话有合法例外，离线新建丢包后恰好仍指向旧 A。应拒绝离线新建或保留并重发同一个创建意图，在确认目标 B 前不能发送任务。第十八轮[独立反证](fresh-project-quality-round18.md)保留P2，明确正式按钮接线静态、实际controller/server/metadata动态、worker止于受控accepted，无真实文件副作用或越权。R38 应把即时本地退出与有界的服务端撤销请求分开，HTTP 黑洞不能让本地退出悬住。

R39 的记录已经正确恢复，额外“放弃修改并离开”也能完成导航，因此按 P3 流程缺陷处理。应在成功提交且 busy 导航门禁真正结算后打开会话，保留对真实草稿和仍在提交操作的保护。

### 失败稿与未确认提交必须保留可访问副本

R40 中保护新稿 B 的 revision 检查是合理的，但恢复原稿 A 失败后，Hub 同时删除原气泡和 submission；配对端 ACK 前也没有气泡，仍提示“内容已保留”。服务端预入队门禁尚未持久化 A，所以没有历史可取。应保留独立失败稿或失败消息，让用户复制、恢复或重试，并只在实际恢复成功时提示已保留。

R41 已用完整认证 Hub 验证实际未接受时的断线窗口：页面有 uncertain 意图却 hasUnsent=false，beforeunload 不拦截，刷新前后主机均为 0 个会话。应把待核对提交也纳入离开保护。此项不声称已持久化任务无法恢复，与 R03 的已执行后重复重试分开计数。

### 新增凭据必须有独立身份和可见失败反馈

R42 的两条正常新增流程均通过真实 Electron、IPC 和 CredentialStore 验证：普通站点没有 suggestedLabel 时产生相同默认 ID；“工作账号”和“个人账号”也都变成 browser__account。第二次新增会整体替换旧 Cookie、名称、权限和策略，旧账号须重新登录捕获。应为新增生成唯一 ID，只有明确更新旧账号时复用 ID。R43 则应捕获 Token 保存拒绝并显示可访问的错误；当前草稿仍在，存储恢复后重试可完成，因此按 P3。

### 自动化应按真实终态和任务 ID 呈现

R44 的 120 秒是等待最终结果的整轮超时，收到 runAccepted 也不会解除；超时后 scheduler 清除同 job 运行保护，真实 ChatSession 仍 busy。仍存在的非once/周期任务第二次触发会 FIFO 排入同一提示，第一轮结束后再次执行；once任务结算会删除，不据此声称同id重复触发。应区分 admission 与 completion，并在实际 worker 终态或明确取消前保留运行占用，不能只扩大超时。R45 是独立的即时失败：JSON-RPC error 被转换成普通 reason，最终映射 automation.completed；应保留失败语义。

R46 应消费现有cronJobId关联实时及持久执行记录；catalog已持久该字段，headless state还可带automation:job:hash的clientMessageId，详情未使用。当前轮clientMessageId会被后续人工run更新，仍需稳定job provenance。日期标题完整相等会漏掉真实记录，同项目 24 小时回退又会认领其他任务；去重不等于确认归属。R47 需要让已打开的自动化详情订阅生命周期更新，R48 需要透传持久的 disabledReason，避免自动停用与手动暂停无法区分。底层调度器及 Hub 的相应保护已单独核对，没有把这些桌面展示问题泛化为整个自动化系统失效。

R49 中拒绝变更原件与整次查询不返回部分正文都是正确保护；缺陷仅是跨文件父结果吞掉已知、安全的更新指引。实际 Engine 流和下一轮消息都只收到通用错误，而单文件读取能明确建议更新资料集。建议提供错误分类与已选择文件的身份，避免一概回传任意子错误。正常 Desktop refresh 后同 ID 查询可恢复。

R50 需要在首个 await 前阻止并发录音启动，并在取消/卸载时使 pending generation 失效。现有逻辑只保存最后一份 recorder/stream，第二次成功会覆盖引用并清掉首份最大录制时长定时器；按停止及切走聊天视图都未回收首份。真实组件+模拟设备在两基线均复现；未使用真实硬件，结论不包括 document unload 或窗口销毁之后。Web Panel 录音已有 requesting/generation 与取消保护，正常对照通过。

R51 的成功任务必须与当前安装清单核对，卸载后不能再用历史 job 表示“已安装”。R52 只在市场相对路径源中复现：先删除同一个 `local` cache 目录，再校验新 manifest；无效更新丢掉旧文件，却留旧注册。应先暂存校验再原子替换。R53 则是从文件夹的 review 安装：内容快照保持审核一致性是正确的，但持久更新来源必须保留原目录，不能保存随后已清除的临时 snapshot。三项触发与修复位置独立。R53 可从原文件夹重新预览并显式覆盖安装，将内容更新到 v2；无需先卸载，但新的更新源仍是临时快照，后续“更多→更新”继续失败。

R54 限定文件面板产生的内部图片 payload 已送达 Quick Chat：缺少 `onAttachImagePath`，图片分支 optional call 后直接返回，没有图片 chip、路径引用或错误。PDF 内部拖入与系统 PNG 拖入对照正常。真实组件 handler 已复现，尚未实测原生 Electron 跨窗口拖动，不声称原文件字节丢失。

R55 的迟到结果来自合法磁盘会话与成功的 Main 项目校验；后台索引导入尚未完成时，Pet 卡与全局选择器仍可用。应关联所有导航意图，使旧打开可完成导入但不覆盖新选择。仅当前索引缺少该会话的异步路径已复现，不声称普通同步点击、输入或文件丢失。R56 应在候选超过500时透传覆盖范围不足；既有设计已明确500候选的有界搜索，修复仅需反馈覆盖不足。现有时间预算和大文件跳过已会设置 truncated，而候选截断未设置。标题搜索/手工打开可缓解，全文重试本身不扩大范围。

R57 的原生本地慢下载在自身 worker 崩溃后恢复为 orphaned；真实 Core closeSession 返回成功后仍增长，killAll 仍跳过，专用 scoped kill 可停止。生产恢复需新 worker 启动并扫描 pidfile；Desktop 不会在崩溃瞬间自动重启。完整 Desktop 删除和退出链仅静态核对，本轮没有实际点击删除或运行 Electron 退出。修复需验证恢复任务身份、提供可终止路径，并让删除 ACK 真实反映清理结果，不能盲杀任意旧 PGID。三项新发现已由第十二轮[搜索复核](search-quality-round12.md)和[下载复核](download-quality-round12.md)独立认可限定分级。


第十三轮新增 R58–R62：合法 managed worktree 的文件权威已经通过，内置终端却只走 project-roots 门禁，需显式传递 engine session 权威；不能放宽任意目录权限。首提交 Review 需处理无父提交，并把 range 失败与真实空差异区分。侧栏删除应在 Main 成功后才提交永久 tombstone，失败保留可见重试；当前 Core 历史仍在，修复权限后 SessionsView 可完成删除。同项目多窗口应共享目录事实，同时保留各窗口选择；现有证据没有证明草稿丢失或错发。离开 CLI 房间应按归属清显示审批，重新进入仍需要 R10 的 pending snapshot。详见[第十三轮独立复核](quality-round13.md)。

第十四轮新增 R63–R65，均按 P3 保留：普通通知在生产默认10秒窗口内排队等待时，urgent 路由也被同一串行队列挡住，需让紧急调度绕开普通等待，同时保留 receipt 去重的串行保护；[独立复核](notification-quality-round14.md)确认与 R45 的错误成功状态独立。Reload 恢复后先关闭旧 terminal tab 再新建，模块 counter 可能重用已删除ID，使同owner/token连接旧壳；再次关闭重开恢复。真实 Electron 只验证身份保持，实际组件/Main/service 链用 native PTY 替身，不声称完整原生壳复现。FilesPanel目录拒读应显示失败和重试，不能用空数组混同空目录；[独立文件复核](file-navigation-quality-round14.md)认可P3及R58合并。R58同时补图片证据：同一个合法worktree文本可读，图片被同类注册根门禁拒绝；切回main后显式打开原worktree图片的绝对链接，可经single-file授权恢复预览，不能据此放宽整个目录权限。

第十四轮[最终只读语义核验](quality-round14.md)已确认分级、去重、两基线计数和原生证据边界一致；命令路径与R58恢复前提已修正文档，不新增执行计数。

第十五轮新增R66/P2、R67/P3、R68/P2，均独立复核。R66需在宣告default前保证实际agent配置一致，不能先改metadata再复用旧实例；与R02选择器发错协议独立，B的bypass须显式选择，未运行真实CLI。正常default重开因metadata已同值不恢复，acceptEdits→default的实际Main/service变更可恢复。R67需广播LAN成功启动事实；服务本身正常，另一已挂载视图重挂或幂等开启可恢复。R68应让所有RemoteHost发送共用有界队列和viewer退役逻辑，当前sendToViewer已有4MiB保护却未覆盖直播broadcast及设备发送；真实Node/ws在有界24MiB负载下已观察队列增长，健康peer与重连/撤权正常，未观察OOM或全局故障。详见[CLI质量复核](cli-recovery-quality-round15.md)、[设置质量复核](remote-settings-quality-round15.md)、[连接质量复核](connection-recovery-quality-round15.md)。

第十五轮[最终只读语义核验](quality-round15.md)通过，三项新增发现、计数、去重、恢复与证据边界无实质冲突；未新增执行。

第十六轮新增R69/P2、R70/P3，均独立复核。R69的合法target已通过验证，迁移前全roots构造却重新要求缺失source有效；应建立安全修复/脱离失效根的契约，保留Main身份、target挂载与owner fence，不可直接删除根安全校验。恢复原目录再点修复成功；不恢复原路径的归档→移除坏root→恢复→迁移仅服务级验证，完整UI接线静态，没有历史/文件删除。R70限定实际自定义指令拒写后失败pending丢失，页面仍可复制/重新输入；存储修复后仅blur/返回无重试，重开旧值。应保留原target/value和保存失败状态，提供同值重试。与R43 Token显式Save仍保稿的恢复契约独立，不称所有设置或已落盘旧数据丢失。见[项目质量复核](project-recovery-quality-round16.md)、[设置质量复核](settings-recovery-quality-round16.md)。

[Link授权恢复](link-recovery-round16.md)和[Server MCP取消/归属恢复](command-recovery-round16.md)正式新增0；前者为实际组件/service配合可控validation/transport/内存OAuth句柄，后者为真实HubAuth与owned loopback HTTP MCP模块，没有真实提供方、完整HeadlessServer或原生Electron。人工延迟owner的取消候选因生产认证同步而剔除，不计问题或最终正常测试。

第十六轮[最终只读语义核验](quality-round16.md)通过；编号、统计、恢复和替身边界一致，新增执行0。Link状态核对指authorizationGet本地桥查询，没有HTTP GET或原生IPC传输实验。

第十七轮新增R71/P3、R72/P2、R73/P2，均经独立质量核对。R71需将项目名称提交与真实持久结果绑定，保留失败稿和重试，不让旧失败回滚覆盖新名称；正常会话标题拒写保稿/同值重试对照通过。R72需按engineSessionId调用权威Main恢复并等成功后更新catalog，现有root保护正确，不能靠放宽失效root门禁修复。Settings“取消归档”后Core marker仍在，正式项目文件夹UI可移除仍绑定的secondary，随后实际resolver拒绝root_removed；没有执行后续真实run、历史或物理目录删除。正确Main恢复primitive动态有效，但没有纯Desktop可见恢复UI workaround；移除root后还需恢复挂载/迁移。见[Desktop独立审计](session-operations-quality-round17.md)。

R73应在配置admission通过后再submit，或对明确未派发早退回滚lease并广播pending；保留正常已派发决策等待ACK的one-shot保护。submitted没有TTL/断线释放，配置完成不重播、重连快照排除；实际controller Stop和分层Core cancel能取消旧题后重问，不交付旧答案。实际Host认证HTTP/WS+React卡片采用内存worker边界，实际Core AgentServer/ChatManager的configure控制采用fake engine/runtime；真实Engine无replay仅静态，未称完整worker E2E。见[Server独立审计](server-routing-quality-round17.md)。

[上下文打包正常控制](context-recovery-round17.md)新增0：实际Engine配owned内存LLMClientBase证明失败保选择可重试、非法输入早拒、Core cancel无半目标、迟到target不激活；完整App注册和Desktop Stop接线未动态验证。[独立控制审计](context-recovery-quality-round17.md)与[严重问题反证](high-risk-quality-round17.md)新增执行0；后者保留R35/P1、R36/P2并限定真实Git/Node25/darwin证据，不扩到全平台。

第十七轮[最终只读整合核验](quality-round17.md)通过；三项分级、去重、恢复、两基线统计和替身边界无实质冲突，新增执行0。

第十八轮[自动化独立反证](automation-quality-round18.md)新增执行0、发现0，保留R44–R46/P2，收窄非once再排队、实际RPC error/已配置授权网关、已有强ID未消费的范围；不称所有provider错误或普通OS通知。

第十八轮新增R74–R76三项P3，均经独立质量核对并在两冻结产品快照分别guarded复现。R74实际ChatView/MessageStream隐藏composer并禁退出，实际preload超时只丢pending、不发Core cancel；实际Engine配内存LLMClientBase证明迟到target仍可落盘，未证明历史丢失或永久锁死。应提供带operation/session身份的摘要取消入口，区分RPC超时和实际运行，避免迟到cancel取消新任务。见[上下文审计](context-cancel-quality-round18.md)。

R75实际ModelPill与偏好hook在两个React roots/shared MemoryStorage复现旧整图覆盖；第十八轮的生产新窗口存储接线仅源码，第二十轮已补独立owned Electron原生存储契约，详见[补证](model-native-round20.md)。当前A仍保留内存选择，重开A回默认；再次选择可恢复。修复按bucket的权威写入及跨窗同步，不能只靠无条件整图read-merge-write。没有实际模型误用/费用或权限绕过。见[模型审计](model-switch-quality-round18.md)。

R76实际Core async-answer enqueue产生续接turn，所有Core帧传给实际Host，但Host只追外部agent/run请求寿命，历史running=false，实际组件和API允许归档并隐藏当前行。恢复API清marker及受控follow-up完成正常；真实Engine transcript flush/完整worker和恢复按钮仅边界未执行。应统一所有run producer的session/generation活动投影，保留async答案admission即ACK的正确边界。正常标题409/非文件registry500/临时会话404均保稿可恢复。见[Hub审计](hub-session-operations-quality-round18.md)。

第十八轮[最终只读整合审计](quality-round18.md)通过，无实质矛盾，新增执行0；三项P3、双基线收据、恢复和替身边界一致。

第十九轮新增R77/P2：真实已初始化Hub的数据目录dataDir从0700变0500、hub子目录仍可读/遍历/可chmod700时，合法标题PATCH先在HubAuth认证锁的data/hub.lock发生EACCES；尚未进入title mutation。Core file-mutex对非争用错误也同步退避整个30秒预算，独立进程发起的fresh /health和Host20ms timer都约30秒不能调度。84740/a66f各原生38断言通过，健康请求分别30,021.92/30,028.49ms；修权限后ENV与同稿标题立即成功，真实跨进程短争用正常，所有owned子进程/目录清理。应分类立即拒绝非争用错误，保留认证及跨进程锁；不能故障时无锁写入。只验证Node25.8.1/darwin arm64、fresh Connection:close请求，不泛指所有只读磁盘、Electron/Linux/Windows、真实worker暂停或数据丢失。四份早期harness诊断单列，独立审计新增执行0；详见[原生报告](file-mutex-round19.md)与[独立核对](file-mutex-quality-round19.md)。

第十九轮[最终只读整合审计](quality-round19.md)通过，新增执行0；认证首因、精确权限/客户端连接前提、恢复及native/Bun分账一致，两个措辞收窄已完成。

第二十轮优先级复核将R29由P2降为P3，缺陷保留：触发限定旧ID/对话迁移等待窗口内新增项目，Main与对话仍在，实际hook→Main的重命名广播可恢复；可见菜单接线、Open Recent及重启恢复仍为源码边界。故障不会自行消失，恢复还会改变A名称，未称纯显示文字或无影响。未证明任务错项目执行或持久损失。见[交叉裁定](r29-priority-round20.md)及[15项优先级抽查](priority-quality-round20.md)。R53旧内容可用且review覆盖能更新，但其公开Update的durable来源持续失效，主审保留P2并排在身份覆盖/文件损失之后；审计的边缘P3意见保留。该抽样裁定后为77=1P1/49P2/27P3，旧轮P2结论作为历史保留；本轮随后新增Goal两项见下。

第二十轮[原生模型存储补证](model-native-round20.md)与[主审核对](model-native-quality-round20.md)完成：latest Electron33/macOS实际defaultSession/同精确file URL共享localStorage、storage event、reload及晚开窗口/独立partition控制成立，作者与主审各一次31 Node断言独立列。纯HTML与复制lookup不称actual产品hook/App E2E，未执行模型；R75/P3及77项数量不变，通用Bun增量0。

第二十轮[Goal/Sleep审查](goal-sleep-round20.md)新增R78/R79各P2：无worker的native Resume只写磁盘paused并回成功，未派发；已有worker的cold bound Resume虽进入Core，却没有Host WorkspaceContext，真实Engine在模型前安全拒绝，resolved失败又被视为续接成功，目标仍active且无诊断。前者需正确启动/admit，后者需合法权威重建和失败结算，两层修复独立。正常resident bound/cold legacy恢复、edit/pause/delete/CAS及普通authorized run对照通过；不称越权、历史丢失或完整Desktop发送E2E。两份独立审计新增执行0，主审同源在84740/a66f各4/72通过，通用增为80文件240测试；当前79=1P1/51P2/27P3。

第二十轮[最终只读整合核验](quality-round20.md)通过，无实质矛盾，新增执行0；分级、80/240与原生31分账、Goal恢复边界及两处历史阶段数措辞已核对。

第二十一轮[浏览器连接与恢复](browser-lifecycle-round21.md)新增R80/P3：已配对Chrome在闲置中Native transport结束且无新hello/动作时，Host已有connected=false，实际Panel两次正常2秒轮询仍显示“正在使用”并仅给断开。下一动作正确NEEDS_HUMAN，显式断开→fresh hello→重新配对恢复；新grant的高层只读listTabs经过owned tab.get正常。保留执行和exact tab/grant门禁，不称离线仍可操作或永久失效。主审两冻结快照各新1文件3测试40expect/Completed，累计81文件243测试；当前80=1P1/51P2/28P3。[独立质量审计](browser-quality-round21.md)及[取消、child/owner关闭盘点](browser-cancel-gates-round21.md)新增执行0，parent Stop仅留未验证边界。

第二十一轮[最终只读整合审计](quality-round21.md)通过，新增执行0；作者latest原始收据与root双基线便携重跑分别归档，唯一证据归属措辞已修正，分级、81/243及恢复边界无未解决实质矛盾。

## 验证范围

| 验证                            | 结果                                                                      | 证据                                                     |
| ------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| 冻结依赖安装                    | 通过                                                                      | `bun install --frozen-lockfile`                          |
| 完整工作区构建                  | 通过                                                                      | [日志或收据](validation/build.log)               |
| 工作区类型检查                  | 通过，12 个包及 Web/桌面配置                                              | [日志或收据](validation/typecheck.log)           |
| Electron 桌面完整构建           | 通过                                                                      | [日志或收据](validation/desktop-build.log)       |
| Server/Web 现有逐文件测试       | 141 文件、1428 测试、0 失败                                               | [日志或收据](validation/server-web-results.json)   |
| Electron 导航                   | 通过，含窗口宽度、抽屉、焦点、重载及快捷键                                | [日志或收据](validation/navigation.log)          |
| Electron 设置                   | 通过，3 种宽度、2 种语言、主题                                            | [日志或收据](validation/settings-e2e.log)        |
| Electron 工作区页面             | 通过，扩展、凭据、自动化及键盘操作                                        | [日志或收据](validation/workspace-pages-e2e.log) |
| Electron 模型设置               | 通过，含读写失败、草稿、焦点、删除与重试；0 renderer errors               | `validation/model-settings-e2e.log`                      |
| Electron 数字人与项目配置       | 通过，含列表、搜索、编辑、团队及 3 宽度/明暗主题                          | `validation/digital-humans-e2e.log`                      |
| Electron Panel 安装与恢复       | 通过，两个项目窗口、更新/恢复/损坏修复及文件保留                          | `validation/panel-recovery-e2e.log`                      |
| 第一轮缺陷专项复现              | 15 文件、29 测试、0 失败                                                  | 各分析附录与 `reproductions/`                            |
| 首次运行恢复专项复现            | 2 测试、0 失败；真实响应违反前端恢复契约                                  | `reproductions/root/first-run-recovery.test.ts`          |
| 第二轮 Desktop 专项复现         | 3 文件、5 测试、25 断言、0 失败                                           | `reproductions/desktop-round2/`                          |
| 第二轮 Web 专项复现             | 1 文件、3 测试、23 断言、0 失败                                           | `reproductions/web-round2/`                              |
| 第三轮 Desktop 已收束复现       | 3 文件、4 测试、29 断言、0 失败                                           | `reproductions/desktop-round3/`                          |
| 第三轮 Web 专项复现             | 1 文件、5 测试、43 断言、0 失败                                           | `reproductions/web-round3/`                              |
| 第三轮 Runtime 已收束复现       | 3 文件、4 测试、0 失败                                                    | `reproductions/runtime-round3/`                          |
| 第四轮文件/历史流程             | 2 文件、3 测试、0 失败；含 1 个缺陷表征及常规契约                         | `reproductions/files-round4/`                            |
| 第五轮发送失败/刷新保护         | 1 文件、9 测试、56 断言、0 失败；含真实认证 Hub                          | `reproductions/web-round5/`                              |
| 第五轮自动化执行/展示           | 2 文件、7 测试、38 断言、0 失败                                         | `reproductions/automation-round5/`                       |
| 第五轮凭据实际 Electron         | 4 场景通过；Cookie 两种碰撞、Token 拒写无提示及恢复后重试                 | `reproductions/credentials-round5/credentials-e2e.mjs.log` |
| 第六轮 Collection 恢复         | 新快照 1 文件、4 测试、32 断言、0 失败；真实 Engine 本地 deterministic client | `latest-reproductions/collections-round6/`             |
| 第六轮 Panel 身份边界          | 新快照自定义 1 文件、3 测试、26 断言通过；R22仍适用，legacy重开是正确保护 | `latest-reproductions/panels-round6/`                  |
| 第六轮录音生命周期/恢复        | 1 文件、9 测试、87 断言，初始/新快照分别通过；含Panel上传重试与取消对照   | `reproductions/voice-round6/`                          |
| 第七轮 Agent Plugins | 1 文件、7 测试、61 断言；初始/新快照分别通过，真实服务与本地 Git | `reproductions/plugins-round7/` |
| 第七轮身份/连接恢复 | 3 文件、13 测试、87 Bun 断言；两基线通过，含 2 个 native Node 子进程 | `reproductions/auth-round7/` |
| 第八轮 Quick Chat 生命周期 | 新增便携1文件7测试53断言，两基线分别通过；其余76既有测试仅单列复查 | `reproductions/quickchat-round8/`、`validation/quickchat-round8/` |
| 第九轮 CLI/插件恢复反证 | 新便携2文件4测试52断言，两基线通过；没有新发现 | `reproductions/quality-round9/` |
| 第十轮 Desktop 恢复反证 | 新便携4文件7测试51断言，两基线通过；六项保留、新增0 | `reproductions/quality-round10/` |
| 第十轮审批与现代日志反证 | 新便携2文件7测试61断言，两基线通过；R11/R19降P3、R03保留P2 | `reproductions/quality-round10/` |
| 第十轮 Session close 正常契约 | 现有3文件28测试通过；未计入便携复现总数 | `validation/session-close-round10/` |
| 第十一轮搜索/导航与工作区恢复 | 新通用4文件8测试108断言，两基线分别通过；stable scope另1文件1测试9断言仅新快照 | `reproductions/search-routing-round11/`、`reproductions/workspace-quality-round11/` |
| 第十一轮真实 Electron 搜索 | 通过；焦点、IME、滚动、选择、重试、快捷键及窄屏；0 renderer errors | `validation/search-routing-round11/search-e2e.log` |
| 第十一轮下载恢复 native | 单次隔离Node smoke通过；Core close/killAll缺陷及专用kill/普通任务对照；仅新快照 | `validation/download-round11/native-run.log` |
| 第十二轮文件传输/历史/保存正常控制 | 新便携2文件5测试136断言，两基线分别通过；新增0 | [传输与恢复复核](transfer-round12.md) |
| 第十三轮终端/Review/会话/多窗口/Web 生命周期 | 新通用6文件48测试304断言，两基线分别通过；5项发现及正常控制 | [独立复核](quality-round13.md)与四份专项附录 |
| 第十四轮通知/终端/文件失败恢复 | 新通用4文件13测试130断言，两基线分别通过；3项新P3，R58图片扩展及正常控制 | [通知](notification-round14.md)、[终端](terminal-lifecycle-round14.md)、[文件](file-navigation-round14.md) |
| 第十五轮CLI接管/远程设置/连接恢复 | 新通用6文件12测试142个Bun断言，两基线分别通过；wrapped native各另33断言，最多24MiB负载，不重复算Bun测试 | [CLI](cli-recovery-round15.md)、[设置](remote-settings-round15.md)、[连接](connection-recovery-round15.md) |
| Electron reload 身份补证 | 仅a66f/macOS；初始+两次reload token、真实WebContents对象均保持，无worker/真实PTY | [脚本及日志](validation/terminal-lifecycle-round14/reload-identity.log) |
| 第十六轮项目/设置/Link/MCP恢复 | 新通用4文件10测试104个Bun expect，两基线通过；Settings Bun helper另27手工断言、MCP Node另22断言，不额外算测试 | [项目](project-recovery-round16.md)、[设置](settings-recovery-round16.md)、[Link](link-recovery-round16.md)、[取消](command-recovery-round16.md) |
| 第十七轮会话操作/Hub路由/上下文正常控制 | 新通用4文件7测试77个Bun expect，两基线通过；owned Bun helper另91手工assert，包含在wrapper内 | [会话](session-operations-round17.md)、[路由](server-routing-round17.md)、[上下文](context-recovery-round17.md) |
| 第十八轮上下文取消/模型偏好/Hub续接 | 新通用3文件8测试165个Bun expect，两基线通过；本轮没有额外native/helper计数 | [上下文](context-cancel-round18.md)、[模型](model-switch-round18.md)、[Hub](hub-session-operations-round18.md) |
| 第十九轮文件锁权限恢复 | 两冻结基线分别standalone原生38 Node assert/Completed，真实30秒；Bun增量0 | [原生脚本/结果](file-mutex-round19.md) |
| 第二十轮Goal冷恢复 | 新通用1文件4测试72个Bun expect，两基线分别通过；实际Core/Engine内存provider，无worker | [两个根因及正常控制](goal-sleep-round20.md) |
| 第二十轮原生模型存储/优先级 | latest owned Electron storage作者/主审各31 Node assert分列，Bun0；15项只读抽样，R29降P3 | [原生边界](model-native-round20.md)、[优先级](priority-quality-round20.md) |
| 第二十一轮Browser idle连接/恢复 | 新通用1文件3测试40个Bun expect，两基线分别通过；无真实Chrome/Electron/native relay | [触发、反馈及恢复](browser-lifecycle-round21.md) |
| 第二十三轮macOS菜单 | 新通用2文件4测试82个Bun expect，两基线分别通过；owned Electron适配，无native OS菜单 | [窗口归属](menu-routing-round23.md)、[Recent刷新](menu-recents-round23.md) |
| 第二十四轮旧图片历史 | 新通用1文件1测试17个Bun expect，两基线分别通过；旧状态实际Workbench SSR，现代仅hook投影 | [历史显示](legacy-history-round24.md)、[分账收据](validation/round24-legacy-history-results.json) |
| 第二十五轮现代图片恢复 | 新通用1文件2测试32个Bun expect，两基线分别通过；实际Desktop及Web SSR，sendhook仅静态 | [附件显示](modern-desktop-image-round25.md)、[分账收据](validation/round25-modern-desktop-image-results.json) |
| 第二十七轮Files根映射 | 新通用1文件1测试29个Bun expect，两基线分别通过；实际producer/authority/hook/FS，upstream仅静态 | [根映射](file-root-round27.md)、[分账收据](validation/round27-file-root-results.json) |
| 第二十八轮正常反证与交接 | 纯静态新增发现/执行0；blankFiles正常回退、既有706/6286原字节归档和六组修复排序 | [空白Files](blank-files-counterreview-round28.md)、[证据归档](baseline-evidence-round28.md)、[交接](repair-handoff.md) |
| Desktop renderer 现有逐文件测试 | 282 文件、2397 测试、0 失败                                               | `validation/desktop-renderer-results.json`               |
| Desktop main 现有逐文件测试     | 283 文件、2461 测试、0 失败                                               | `validation/desktop-main-results.json`                   |
| native Hub smoke                | 未通过，不计成功；先遇到过期工具 fixture，再暴露 R21                      | `/tmp/codeshell-review-20261012/hub-smoke*.log`          |
| Hub 其余真实 worker 流程        | 通过；已显式排除 R21，临时适配 ToolSearch fixture                         | `validation/hub-smoke-remaining.log`                     |
| 原生输出日志恢复                | 通过；含大日志分页、并发追加、Hub/Desktop/stdio 重启、真实 worker receipt | `validation/output-journal-smoke.log`                    |
| 手机原生输出日志恢复            | 通过；含实际发送、同意图重试、认证重连、分页、损坏阻断和授权撤销          | `validation/mobile-output-journal-smoke.log`             |

所有测试使用隔离应用状态和项目规定的测试入口。模型流程使用本地模拟服务，不调用真实付费模型或第三方账号。

现有 Server/Web/Desktop main/renderer 测试合计 **706 个文件、6286 个测试、0 失败、0 跳过**。上述 Electron 验证与专项复现另计，不把它们混入单元测试数量。 [原字节归档与逐日志核对](baseline-evidence-round28.md)不增加测试执行。

## 后续检查

0.9.33 的 Panel 项目身份与跨文件 Collection 查询差异、已有便携复现适用范围已核对。认证连接与 Agent Plugins 安装恢复已收束；Quick Chat 生命周期已收束；第十轮独立反证已完成审批、Web意图/配置/草稿和Desktop异步状态，详见 [Web复核](web-quality-round10.md)、[审批复核](approval-quality-round10.md)。第十一轮工作区/Panel反证新增0，搜索与导航新增2P3，下载生命周期新增1P2；第十二轮独立质量复核保留三个新发现的限定分级，文件传输/导入导出正常控制新增0。第十三轮新增1P2+4P3并已独立核对，新增6份证据两基线通过；第十四轮再补3P3与R58图片扩展，新增4文件13测试两基线通过；第十五轮再补CLI接管/设置状态/慢连接3项，第十六轮再补目录修复/自动保存2项并完成Link/MCP正常控制，第十七轮补会话操作/Hub回答3项及上下文正常控制，第十八轮补上下文取消/模型偏好/Hub续接三项P3，第十九轮补原生认证锁EACCES阻塞1项P2，该阶段通用79文件236测试、native各38断言独立列；第二十轮再补Goal冷恢复两项P2和1文件4测试72expect，该阶段通用80文件240测试、正式79=1P1/51P2/27P3，另有R75原生存储补证与R29降级。第二十一轮补Chrome闲置断线反馈1项P3及1文件3测试40expect，该阶段通用81文件243测试、正式80=1P1/51P2/28P3。继续检查新增主分支差异与尚未覆盖的失败恢复。已有 TODO 中明确后置的能力与尚未发行的修复单独核对，不将其重复列为新缺陷。

未进行真实付费模型、真实第三方账号、生产数据迁移或发行部署。CLI 模型行为通过可控 fixture 与实际 Host 路由验证，无法据此声称所有真实提供方端到端流程均已通过。静态候选及测试 harness 自身问题单独记录，不冒充产品发现。

第二十二轮[本地侧栏账号差异预审](sidebar-account-local-round22.md)仅针对原工作区未合入的 `6034df8a`，新增发现与执行均为 0；不混入两个冻结快照的适用范围。[Browser parent Stop](browser-stop-round22.md)已确认R81/P2，作者latest与主审两基线各standalone native66 Node断言分列；Bun仍81文件243测试。

第二十二轮R81/P2经过实际Core/Engine、真实preload/native IPC、Main源回调与真实Puppeteer/owned Chromium验证：Core已abort/settle且Input仍0后，页面enable才出现旧Input。动态为合法legacy/unbound Session，stdio与BrowserHost工厂是受控适配，无完整App/真实worker/Chrome扩展/提供方；现代bound共享路径仅源码。正常直接driver AbortSignal、新正式turn和已提交输入边界均成立。

第二十二轮经[最终独立质量复核](browser-stop-quality-round22.md)支持窄P2，并保留自然ready默认12秒期限、已提交输入不回滚、旧Core不续跑及所有替身边界。

第二十二轮[最终整合语义核验](quality-round22.md)已完成，新增执行0；R81的三次native各66断言分账、正常恢复及范围限制一致。

第二十三轮[macOS菜单窗口归属](menu-routing-round23.md)与[Recent快照刷新](menu-recents-round23.md)新增R82/R83各P3，两冻结基线分别guarded新增2文件4测试82个Bun expect，当前通用83文件247测试、正式83=1P1/52P2/30P3。Recent磁盘投影及删除保护正常；原版便携首轮两次支架失败已归档，修正版各1/43通过，没有实际产品子进程。[Relay重连预审](server-preflight-round23.md)与[HTTP错误门禁预审](http-error-preflight-round23.md)新增执行/发现均0。

第二十三轮[最终独立整合核验](quality-round23.md)通过，新增执行0；纠正latest当前摘要为83/247，保留R82阶段历史及作者/root成功失败分账。

第二十四轮[旧原生图片历史](legacy-history-round24.md)新增R84/F24-1/P3：从未发布journal的有效paired-native会话走正常history兼容恢复，内部路径块和模型提示被显示为正文、没有安全附件summary；普通文字、assistant和68-byte原件完整。现代首次journal发布后hook投影正常，不是公开修复入口，未再次SSR。主审两个冻结基线各guarded新1文件1测试17个Bun expect/Completed，作者latest另1/17分账、首轮fixture CRC拒绝单独保留，没有打印expect总数。动态authority/auth/WS为明确替身，真实authority仅静态，无Engine/provider/worker/Electron。当前正式84=1P1/52P2/31P3，通用84文件248测试，native增量0。

第二十四轮[最终独立整合核验](quality-round24.md)通过，新增执行0；84=1/52/31、双基线84/248、first CRC与作者/root成功分账、来源/清理及能力边界一致。历史静态反证稿保留当时阶段，当前权威结算以最终稿为准。

第二十五轮[现代图片Desktop恢复](modern-desktop-image-round25.md)新增R85/D25-1/P3：有效现代journal及正确附件metadata到普通MessageStream后被忽略，图文缺附件提示、纯图整条用户bubble不显示；原件/assistant完整。冷paired Session、实际producer/journal/reader/recovery/hydration/renderer及Web和inline UI正常控制，两冻结基线各guarded新1文件2测试32Bun expect/Completed。无sendhook/fullApp/Engine/provider/worker/Electron/真实authority动态验收。首败MiniDom缺matchMedia的0/2/22/noCompleted及唯一支架修正单列。当前正式85=1/52/32、通用85/250、native增量0。

第二十六轮[会话续接静态审查](session-continuation-round26.md)新增正式0/动态执行0：summary fork首run前Review单根覆盖保留体验建议，经blank/legacy/首次run补绑合同反证不升项；Files普通fallback、history重试与Hub导出正常门禁及[云账号取消/退出](cloud-account-static-round26.md)仅读核对。未执行候选PLAN/guard，85=1/52/32与common85/250保持；源码测试不冒充动态通过。

第二十七轮[Files根映射](file-root-round27.md)新增R86/F27-1/P3：合法source mainA/currentprimaryB的summary target首send前，actualFiles把B.id配A.path，Main正确拒读；选择A、directB、bound source、同primarysummary及原件正常，内部补绑/remount仅normalcontrol。两冻结基线各guarded新1文件1测试29Bunexpect/Completed，作者first单列，无失败/rerun，55d3从未执行。正式86=1/52/33、common86/251、native增量0。真实trust/Sidebar/summaryRPC/App/blank/首send静态；[标题双来源](sidebar-title-observation-round27.md)保体验建议，正式0/执行0。

第二十八轮[空白会话Files反证](blank-files-counterreview-round28.md)确认静态正常回退，新增发现/执行0：真实UI ID尚未落盘时panel workspace为null，但完整project独立传给Files，保留当前primary.id/path并走project API；不将中间unknown状态误报为不可读。正式86=1/52/33、通用86/251不变。[早期基线日志归档](baseline-evidence-round28.md)只保存706/6286已有raw收据，没有重跑或增加测试。

第二十八轮[最终独立整合语义核验](quality-round28.md)通过，新增发现/执行0。blank正常回退、原字节归档分账、六组修复建议和当前86/251口径一致；10:35 origin/main仍a66f，两冻结产品快照与原工作区保持。
