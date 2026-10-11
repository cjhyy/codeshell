# 用户流程覆盖与修复顺序

这是截至第十五轮的流程地图；正式编号、级别和触发条件以 [主报告](README.md) 与各附录为准。正常路径通过不代表相邻失败路径已正确处理。缺陷表征测试通过表示复现成立，没有实施产品修复。

| 用户要完成的事 | 已检查的正常路径及证据层级 | 仍有的问题与可见影响 |
| --- | --- | --- |
| 启动服务、连接和配对设备 | Server/Web 既有套件；隔离真实 Hub/worker 与认证恢复控制；[连接审查](auth-round7.md) | R09 第二实例启动失败前清理正在使用的附件；R32 新设备存储失败令配对身份不一致；R38 logout 卡住时本地退出也等待；R67另一已挂载设置缺LAN成功启动广播；R68配对端直播/设备发送缺backlog上限，真实Node慢读增长、健康peer正常 |
| 新建会话并发送第一条消息 | 隔离原生输出日志与手机输出恢复 smoke；[首轮运行恢复](README.md) | R21 首次任务运行中刷新无法恢复；R33 新会话ACK前后台流绑定错误；R37 特定离线新建路径沿用旧项目身份 |
| 发送失败后重试或刷新 | [发送恢复控制](web-round5.md)、[现代日志反证](web-quality-round10.md)；本地模拟服务/可控client，无真实提供方 | R03 不确定回执被变成可新ID重发的普通稿；R06 原生错误回包未解释失败；R40 原失败稿被后续稿挤掉；R41 未确认意图缺刷新保护 |
| 同意审批、回答澄清并继续任务 | 真实 Core 审批与并行卡片；[审批独立复核](approval-quality-round10.md) | R02受信任cwd的CLI实际bypass与“逐次确认”显示不一致；R66旧观察视图接管把metadata改default却复用既存显式bypass实例；R01/R10 连续或重连待审批卡片不可用；R12/R13 多题/旧索引问题；R14 可选问题阻塞新任务；R11/R19仅保留已明确的窄窗口P3；R62已有普通审批离开CLI后仍阻塞新稿，重选可恢复 |
| 在多个项目/会话之间切换 | 真实 Electron导航E2E；真实组件和Core完整磁盘session的[搜索导航复现](search-routing-round11.md) | R04 展开回写覆盖新会话草稿；R05 附件未按会话隔离；R16 配对页签广播和迟到打开；R55 当前renderer索引缺目标会话时，磁盘打开迟到抢回新选择；R61同项目双窗口共享选择，彼此抢当前会话 |
| 搜索旧对话并打开结果 | 真实 Electron搜索：焦点、IME、滚动、选择、重试、快捷键、三种宽度；内容IPC为本地可控回复 | R56 实际内容搜索超过500候选未标覆盖不足，空结果可误导；有界扫描本身是既有设计 |
| 拖入文件、上传并发送 | 真实组件输入引用、Core拒绝错误会话附件；[Quick Chat](quickchat-round8.md)、[上传审查](server-round1.md) | R17 删除chip不释放配额；R20 接收/发送图片大小限制不一致；R34 断线旧上传继续阻塞；R54 内部PNG payload已送达Quick Chat后静默丢弃，原生跨窗口拖动未实测 |
| 停止任务或切到别处让其继续 | 原生Hub smoke剩余流程、Core关闭屏障正常控制；[运行时复核](resource-quality-round8.md) | R07 外部CLI仍忙却失去busy；R08 Web CLI停止协议错误；R15 外部队列依赖前台选择；R18 启动失败句柄阻止同模式重试；R36 Node Host EPIPE退出 |
| 关闭/删除会话，回收后台资源 | Core正常close barrier现有28测试；[下载原生实验](download-round11.md)包含普通任务与专用kill对照 | R30 终态拒写令任务持续running；R31 Node Hub未等Panel强制终止；R57新worker已恢复的orphaned下载被close/killAll跳过，完整Desktop删除仅静态接线；R60侧栏fs删除失败先tombstone，历史页可修复权限后重试 |
| 创建worktree、移除项目、再恢复 | 真实Git并发与恢复；[工作区复核](workspace-quality-round11.md) | **R35/P1** 失败请求回滚能删除成功请求的worktree/branch，特定窗口可丢未提交文件；R24冷owner需重加项目、恢复原会话后再释放 |
| 打开和管理Panel | 真实Electron安装/恢复E2E；真实ProjectStore和权限边界控制 | R22合法secondary root被拒；R23单目录失败或65项目批次使当前renderer Panel App entries清空；包、绑定、内置面板仍在 |
| 在工作区开终端并审阅提交 | [真实Git+实际终端hook/Main门禁、ReviewService+viewer](terminal-review-round13.md)，native PTY边界替身 | R58合法managed worktree新终端被注册根门禁拒绝；R59最近20内首提交差异被错误显示为无变化；R64恢复后先关tab再新建可能接回旧壳，再次关闭重开恢复 |
| 浏览目录和图片、修复读取失败 | [实际FilesPanel/HubFiles+真实文件服务](file-navigation-round14.md)，Desktop Main AST与Web自有HTTP服务 | R58合法managed worktree普通PNG预览被注册根门禁拒绝，文本正常；R65目录EACCES静默空树，修权限刷新恢复；Web移动/权限/重试与迟到结果控制正常 |
| 修改模型、Skills、MCP、凭据 | 真实Electron模型/设置/凭据；真实store写盘与恢复 | R25旧完整表单回滚他端字段；R26冲突刷新没更新编辑revision；R27旧probe覆盖新配置；R28初始设置未到时开关写空列表；R29旧项目投影覆盖新广播；R42账号ID碰撞；R43拒写无反馈 |
| 安装插件、更新和重装 | 真实Plugin服务、本地Git及review显式覆盖；[插件复核](plugin-quality-round9.md) | R51卸载后旧installed任务卡住重装；R52相对源校验失败前删旧cache；R53文件夹临时快照被持久保存为更新源 |
| 运行自动化、看进度和历史 | 实际ChatSession FIFO与调度/展示控制；[自动化审查](automation-round5.md) | R44超时提前结算仍可重复排队；R45拒绝运行却向网关/生命周期发布completed；R46历史归属错误；R47界面未订阅自动停用；R48缺disabledReason；R63普通通知等待占住串行队列，urgent停用通知也被延迟（实际notifier/route+注入时钟，无OS通知） |
| 恢复归档、查询资料集、录音 | 历史恢复、真实Collection Engine本地client；真实录音组件模拟设备 | R39成功恢复后自busy误挡导航；R49已知原件变更指引丢失；R50同document双pending启动录音，stop/unmount只释放最后一份 |

建议先修 R35 的创建/回滚所有权，同时处理会话与输入身份、审批待处理状态和不确定回执。之后处理关闭资源屏障、持久写入/更新原子性与配置冲突，再修搜索范围提示、状态同步和恢复时多余确认。这个顺序依据数据风险和用户能否继续任务，不依据发现时间或问题数量。

实际验证一直使用隔离应用状态。真实Electron、native Node、Bun组件/服务测试与静态接线在各附录分别标注；没有将模拟设备当作真实麦克风验证、将mini DOM当作完整Electron输入、或将Core RPC当作完整桌面删除实测。

第十四轮终端证据组合真实a66f/macOS reload身份与两基线组件/Main/service替身，未启动真实PTY；通知为实际生产默认限流参数的受控时钟，不把注入10秒写成实测墙钟等待或全局延迟上限。

第十五轮新增[CLI接管](cli-recovery-round15.md)、[远程设置状态](remote-settings-round15.md)、[配对端慢连接](connection-recovery-round15.md)，两基线新6文件12测试分别通过；native queue实验每次最多24MiB，不宣称真实Main worker/OOM。CLI为实际组件/真实Main callback与内存agent，设置为双MiniDOM组件+实际preload/IPC/controller/loopback Host，未运行真实CLI或Electron双窗。三项独立质量复核分别链接在专项附录。
