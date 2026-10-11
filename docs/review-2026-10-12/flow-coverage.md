# 用户流程覆盖与修复顺序

这是截至第二十二轮的流程地图；正式编号、级别和触发条件以 [主报告](README.md) 与各附录为准。正常路径通过不代表相邻失败路径已正确处理。缺陷表征测试通过表示复现成立，没有实施产品修复。

| 用户要完成的事 | 已检查的正常路径及证据层级 | 仍有的问题与可见影响 |
| --- | --- | --- |
| 启动服务、连接和配对设备 | Server/Web 既有套件；隔离真实 Hub/worker 与认证恢复控制；[连接审查](auth-round7.md) | R09 第二实例启动失败前清理正在使用的附件；R32 新设备存储失败令配对身份不一致；R38 logout 卡住时本地退出也等待；R67另一已挂载设置缺LAN成功启动广播；R68配对端直播/设备发送缺backlog上限，真实Node慢读增长、健康peer正常 |
| 新建会话并发送第一条消息 | 隔离原生输出日志与手机输出恢复 smoke；[首轮运行恢复](README.md) | R21 首次任务运行中刷新无法恢复；R33 新会话ACK前后台流绑定错误；R37 特定离线新建路径沿用旧项目身份 |
| 发送失败后重试或刷新 | [发送恢复控制](web-round5.md)、[现代日志反证](web-quality-round10.md)；本地模拟服务/可控client，无真实提供方 | R03 不确定回执被变成可新ID重发的普通稿；R06 原生错误回包未解释失败；R40 原失败稿被后续稿挤掉；R41 未确认意图缺刷新保护 |
| 同意审批、回答澄清并继续任务 | 真实 Core 审批与并行卡片；[审批独立复核](approval-quality-round10.md) | R02受信任cwd的CLI实际bypass与“逐次确认”显示不一致；R66旧观察视图接管把metadata改default却复用既存显式bypass实例；R01/R10 连续或重连待审批卡片不可用；R12/R13 多题/旧索引问题；R14 可选问题阻塞新任务；R73合法配置保存窗口内回答idle异步问题，lease已提交却未派发，重试/重连不能交付旧题，取消后重新提问可恢复；R11/R19仅保留已明确的窄窗口P3；R62已有普通审批离开CLI后仍阻塞新稿，重选可恢复 |
| 在多个项目/会话之间切换 | 真实 Electron导航E2E；真实组件和Core完整磁盘session的[搜索导航复现](search-routing-round11.md) | R04 展开回写覆盖新会话草稿；R05 附件未按会话隔离；R16 配对页签广播和迟到打开；R55 当前renderer索引缺目标会话时，磁盘打开迟到抢回新选择；R61同项目双窗口共享选择，彼此抢当前会话 |
| 搜索旧对话并打开结果 | 真实 Electron搜索：焦点、IME、滚动、选择、重试、快捷键、三种宽度；内容IPC为本地可控回复 | R56 实际内容搜索超过500候选未标覆盖不足，空结果可误导；有界扫描本身是既有设计 |
| 拖入文件、上传并发送 | 真实组件输入引用、Core拒绝错误会话附件；[Quick Chat](quickchat-round8.md)、[上传审查](server-round1.md) | R17 删除chip不释放配额；R20 接收/发送图片大小限制不一致；R34 断线旧上传继续阻塞；R54 内部PNG payload已送达Quick Chat后静默丢弃，原生跨窗口拖动未实测 |
| 停止任务或切到别处让其继续 | 原生Hub smoke剩余流程、Core关闭屏障正常控制；[运行时复核](resource-quality-round8.md) | R07 外部CLI仍忙却失去busy；R08 Web CLI停止协议错误；R15 外部队列依赖前台选择；R18 启动失败句柄阻止同模式重试；R36 Node Host EPIPE退出；R81 Core Stop已完成但Main自然ready中的旧点击继续发出Input，真实owned Chromium复现 |
| 关闭/删除会话，回收后台资源 | Core正常close barrier现有28测试；[下载原生实验](download-round11.md)包含普通任务与专用kill对照 | R30 终态拒写令任务持续running；R31 Node Hub未等Panel强制终止；R57新worker已恢复的orphaned下载被close/killAll跳过，完整Desktop删除仅静态接线；R60侧栏fs删除失败先tombstone，历史页可修复权限后重试 |
| 创建worktree、移除项目、再恢复 | 真实Git并发与恢复；[工作区复核](workspace-quality-round11.md) | **R35/P1** 失败请求回滚能删除成功请求的worktree/branch，特定窗口可丢未提交文件；R24冷owner需重加项目、恢复原会话后再释放；R69旧secondary物理缺失时正式修复到健康primary仍被全roots校验阻断，恢复旧路径或多步服务级workaround可恢复 |
| 打开和管理Panel | 真实Electron安装/恢复E2E；真实ProjectStore和权限边界控制 | R22合法secondary root被拒；R23单目录失败或65项目批次使当前renderer Panel App entries清空；包、绑定、内置面板仍在 |
| 连接已登录Chrome并恢复断线 | [实际BrowserPanel/preload/Main callbacks/Backend](browser-lifecycle-round21.md)，受控Native transport，无真实Chrome/Electron | R80/P3闲置断线时connected=false仍显示正在使用、仅提供断开；显式断开→新hello→重配恢复，动作正确NEEDS_HUMAN，新grant高层只读RPC正常 |
| 在工作区开终端并审阅提交 | [真实Git+实际终端hook/Main门禁、ReviewService+viewer](terminal-review-round13.md)，native PTY边界替身 | R58合法managed worktree新终端被注册根门禁拒绝；R59最近20内首提交差异被错误显示为无变化；R64恢复后先关tab再新建可能接回旧壳，再次关闭重开恢复 |
| 浏览目录和图片、修复读取失败 | [实际FilesPanel/HubFiles+真实文件服务](file-navigation-round14.md)，Desktop Main AST与Web自有HTTP服务 | R58合法managed worktree普通PNG预览被注册根门禁拒绝，文本正常；R65目录EACCES静默空树，修权限刷新恢复；Web移动/权限/重试与迟到结果控制正常 |
| 修改项目名称、模型、Skills、MCP、凭据 | 真实Electron模型/设置/凭据；真实store写盘与恢复 | R25旧完整表单回滚他端字段；R26冲突刷新没更新编辑revision；R27旧probe覆盖新配置；R28初始设置未到时开关写空列表；R29旧项目投影覆盖新广播；R75另一已打开窗口保存自身模型旧整图抹掉先前窗口持久偏好，重开回默认、重新选择恢复；R71项目rename真实拒写仍显示新名且无提示，普通广播回旧名、再次rename恢复；R42账号ID碰撞；R43拒写无反馈；R70自定义指令autosave失败清pending，存储修复后blur/离开不重试、未保存稿消失 |
| 安装插件、更新和重装 | 真实Plugin服务、本地Git及review显式覆盖；[插件复核](plugin-quality-round9.md) | R51卸载后旧installed任务卡住重装；R52相对源校验失败前删旧cache；R53文件夹临时快照被持久保存为更新源 |
| 运行自动化、看进度和历史 | 实际ChatSession FIFO与调度/展示控制；[自动化审查](automation-round5.md) | R44非once续接超时提前结算仍可重复排队；R45拒绝运行却向网关/生命周期发布completed；R46历史归属错误；R47界面未订阅自动停用；R48缺disabledReason；R63普通通知等待占住串行队列，urgent停用通知也被延迟（实际notifier/route+注入时钟，无OS通知） |
| 暂停目标后继续执行 | [实际Main/preload/Goal组件与Core/Engine/磁盘](goal-sleep-round20.md)，内存provider，合法Host权威正常对照 | R78无worker Resume只写状态并成功回执，不驱动任务；R79有worker但bound会话非resident时漏WorkspaceContext，模型前拒绝却无失败结算；普通authorized run服务恢复正常，完整Desktop发送未执行 |
| 恢复归档、查询资料集、录音 | 历史恢复、真实Collection Engine本地client；真实录音组件模拟设备 | R76异步回答的Core续接仍运行而Host判空闲，允许归档隐藏当前历史行，实际API恢复正常；R39成功恢复后自busy误挡导航；R72设置取消归档漏权威Core writer，renderer live但Core仍归档，正式folders可移除仍绑定secondary后resolver拒绝root_removed，历史/物理目录保留；R49已知原件变更指引丢失；R50同document双pending启动录音，stop/unmount只释放最后一份 |

建议先修 R35 的创建/回滚所有权，同时处理会话与输入身份、审批待处理状态和不确定回执。之后处理关闭资源屏障、持久写入/更新原子性与配置冲突，再修搜索范围提示、状态同步和恢复时多余确认。这个顺序依据数据风险和用户能否继续任务，不依据发现时间或问题数量。

实际验证一直使用隔离应用状态。真实Electron、native Node、Bun组件/服务测试与静态接线在各附录分别标注；没有将模拟设备当作真实麦克风验证、将mini DOM当作完整Electron输入、或将Core RPC当作完整桌面删除实测。

第十四轮终端证据组合真实a66f/macOS reload身份与两基线组件/Main/service替身，未启动真实PTY；通知为实际生产默认限流参数的受控时钟，不把注入10秒写成实测墙钟等待或全局延迟上限。

第十五轮新增[CLI接管](cli-recovery-round15.md)、[远程设置状态](remote-settings-round15.md)、[配对端慢连接](connection-recovery-round15.md)，两基线新6文件12测试分别通过；native queue实验每次最多24MiB，不宣称真实Main worker/OOM。CLI为实际组件/真实Main callback与内存agent，设置为双MiniDOM组件+实际preload/IPC/controller/loopback Host，未运行真实CLI或Electron双窗。三项独立质量复核分别链接在专项附录。

第十六轮[目录修复](project-recovery-round16.md)、[自动保存恢复](settings-recovery-round16.md)、[Link授权](link-recovery-round16.md)、[MCP取消](command-recovery-round16.md)新增4文件10测试两基线通过。项目/设置各新增一项；Link授权与真实HubAuth+owned HTTP MCP模块的取消/断线/logout/重试控制正常。项目无历史/文件删除，归档绕过仅服务步骤；设置仅未保存自定义指令失败稿。组件与Main callback本地桥不冒充完整Electron；内存OAuth句柄和本地MCP协议fixture不冒充真实提供方。

第十七轮另补[上下文打包失败/取消/迟到控制](context-recovery-round17.md)：实际MessageStream/Core/Engine/磁盘+owned内存provider，四正常控制无新增；完整App注册和Desktop Stop未动态验证。[R35/R36严重问题反证](high-risk-quality-round17.md)保留原分级，无新增执行，不泛化平台或恢复。当前正式73=1P1/49P2/23P3，便携76文件228测试分别在两基线通过。

第十八轮[上下文取消](context-cancel-round18.md)新增R74/P3：summary期间composer隐藏且退出禁用，没有正常用户cancel；30秒RPC超时只恢复UI，实际Core仍运行。服务级cancel/正常完成正常；迟到target发现仅源码，不称历史丢失。[模型偏好](model-switch-round18.md)与[Hub续接归档](hub-session-operations-round18.md)新增R75/R76各P3。当前正式76=1P1/49P2/26P3，便携79文件236测试分别在两基线通过；本轮无真实模型/完整Electron/worker。

第十九轮[原生认证锁权限恢复](file-mutex-round19.md)新增R77/P2：正常已初始化Hub的dataDir（hub的parent）失去写权限而hub仍可读/可chmod，真实EACCES在认证锁发生，Core无差别同步重试阻塞同process /health与timer约30秒。两基线各standalone38 Node assert，修权限后同稿API重试和真实跨进程短争用正常。正式77=1P1/50P2/26P3，common Bun仍79文件236测试；不称titlehandler已抵达、所有只读存储都会阻塞、永久死锁/数据丢失或完整UI/其他平台实测。

第二十轮[原生模型存储补证](model-native-round20.md)新增发现0：latest owned Electron33/macOS的两个独立defaultSession窗口、同精确file URL真实localStorage共享、storage event及reload成立，晚开窗口/独立partition正常。作者与主审各31 Node断言独立记录，Bun0；与第十八轮实际组件证据分层，不冒充完整App/hook原生E2E或真实模型请求。

第二十轮[优先级交叉复核](r29-priority-round20.md)将R29由P2降P3，缺陷及其项目配置阻断仍保留；没有持久项目/对话丢失或错项目执行证据，真实重命名广播恢复已证明。当前77=1P1/49P2/27P3；旧轮50/26为当时分级，不回写历史执行记录。

第二十轮[Goal冷恢复](goal-sleep-round20.md)经独立审计新增R78/R79各P2，两个不同Main/Core根因；两基线各新增1文件4测试72个Bun expect，通用80文件240测试。当前79=1P1/51P2/27P3。目标/历史保留，合法workspace安全拒绝正常，不声称真实worker、完整App/Electron、错项目执行或提供方错误。

第二十一轮[Browser生命周期](browser-lifecycle-round21.md)新增R80/P3，主审双基线各1文件3测试40expect，累计81/243、正式80=1/51/28；[取消/owner关闭盘点](browser-cancel-gates-round21.md)新增执行0/正式0。只将idle连接反馈收录，不把parent Stop静态边界或已正确阻断动作当缺陷。

第二十二轮[Browser Stop输入边界](browser-stop-round22.md)新增R81/P2，作者与主审两基线各standalone native66 Node断言分账，Bun增量0、通用仍81/243；formal81=1P1/52P2/28P3。Core正确终结任务及拒绝旧reply，问题限Main未传播请求取消、尚无输入的ready窗口；不是已提交动作回滚、完整App/worker/Chrome或危险操作实测。[本地6034侧栏账号差异预审](sidebar-account-local-round22.md)新增0/执行0、仅local commit。
