# 全部报告复核、优先队列与覆盖缺口

本次按用户追加要求复核截至 11:00 交付的报告，整理优先顺序和覆盖范围。正式结论仍为 **86 项：1 P1、52 P2、33 P3**。审查基线是 `84740d56` 和 `a66f4ef2`；这里的排序以已有证据为依据，未新增产品发现或执行测试。原始阶段结论、失败日志和未采用候选保留在各附录。

## 优先顺序

**R35/P1 最先修。** 重复 Enter 创建同名 worktree 时，失败调用的回滚可删除成功调用的目录、分支；未提交文件损失需要文件在成功创建至失败回滚之间产生。修复要同时约束重复调用并证明清理资源属于本次调用。完整触发与真实 Git 时序见[第三轮 Desktop](desktop-round3.md)及[高风险复核](high-risk-quality-round17.md)。

P2 内按数据/目标归属、权限显示、Host 可用性、任务推进和恢复阻断给出建议队列；工程可并行安排。同一组不表示同一根因，后组 P2 也不应被前组 P3 阻塞。P3 暂按原编号排列，具体频率可按实际用户反馈调整。[原六组交接建议](repair-handoff.md)保留验收场景，下表补齐全部 86 项。

### P1：立即处理：并发回滚归属（1项）

| 顺位 | 级别 | 编号 | 流程与实际影响 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | P1 | R35 | 重复 Enter 并行创建同名 worktree，失败请求强制回滚成功请求的目录、分支及未提交文件 | [Desktop D13，第三轮](desktop-round3.md) |

### P2：先阻止覆盖、重复或错目标执行及权限误导（12项）

| 顺位 | 级别 | 编号 | 流程与实际影响 | 证据 |
| --- | --- | --- | --- | --- |
| 2 | P2 | R09 | 第二个 Hub 启动失败前删除第一个实例仍在使用的上传文件 | [Server S1](server-round1.md) |
| 3 | P2 | R42 | 新增 Cookie 账号用名称生成 ID，默认名或中文名碰撞会覆盖旧账号及权限 | [Credentials C1，第五轮；实际 Electron/IPC/store](credentials-round5.md) |
| 4 | P2 | R02 | CLI 房间实际免审批，界面却显示“逐次确认”；更改选择器也不改变 CLI | [Web W4](web-round1.md) |
| 5 | P2 | R66 | 旧观察视图接管显示default，仍复用并发重开的bypass实例，同default重开不恢复 | [CLI接管 C15-1](cli-recovery-round15.md)，第十五轮 |
| 6 | P2 | R81 | Core Stop已结束且尚无Input时，Main旧浏览器点击仍等待并在按钮启用后提交真实输入 | [Browser停止 B22-1](browser-stop-round22.md)，第二十二轮；提交后动作不回滚 |
| 7 | P2 | R37 | 离线新建 B 项目请求丢失，重连首条任务可沿旧的未落盘 A 会话进入 A 项目 | [Web W13，第三轮；限定 freshNative 场景](web-round3.md) |
| 8 | P2 | R03 | 已执行任务丢失 ACK 后恢复可重发草稿，重试生成新意图 ID 并重复执行 | [Web W1](web-round1.md) |
| 9 | P2 | R33 | 新会话 ACK 前收到后台原生输出，自动绑定错误会话并把新草稿迁走 | [Web W11，第三轮](web-round3.md) |
| 10 | P2 | R40 | 发送明确被拒绝前已输入后续稿，原失败文本不在草稿、聊天或历史中，无法直接恢复 | [Web W15，第五轮；限定预入队拒绝](web-round5.md) |
| 11 | P2 | R41 | Hub 未确认送达的意图不计入刷新保护，实际未接受时刷新会丢掉唯一内存副本 | [Web W16，第五轮；真实认证 Hub 补强](web-round5.md) |
| 12 | P2 | R52 | 市场相对路径源更新校验失败前删除旧插件，旧注册指向不存在目录 | [Agent Plugins W19，第七轮；有效新源可重新安装恢复](plugins-round7.md) |
| 13 | P2 | R28 | 插件设置初次加载尚未完成时可切开关，写入空旧列表并重新启用之前禁用的插件/Skill | [Desktop D11，第三轮](desktop-round3.md) |

### P2：Host可用性与资源生命周期（7项）

| 顺位 | 级别 | 编号 | 流程与实际影响 | 证据 |
| --- | --- | --- | --- | --- |
| 14 | P2 | R36 | worker 退出与 JSON-RPC 写入交叉时，stdin 的异步 EPIPE 没有监听，Node Host 随之退出 | [Runtime T3，第三轮](runtime-round3.md) |
| 15 | P2 | R77 | Hub数据目录dataDir失去写权限，认证锁对EACCES同步重试约30秒，健康路由与Host定时器也被阻塞 | [原生文件锁 FM19-1](file-mutex-round19.md)，第十九轮；修权限后重试正常 |
| 16 | P2 | R68 | 配对端慢连接的直播/设备发送绕过已有backlog门禁，实际队列增长仍保持在线 | [连接 W26](connection-recovery-round15.md)，第十五轮 |
| 17 | P2 | R31 | Node Hub 关闭先返回并退出，忽略 SIGTERM 的 Panel 原生进程来不及强制终止而遗留 | [Runtime T2，第三轮；已验证 POSIX](runtime-round3.md) |
| 18 | P2 | R57 | worker崩溃后恢复的后台下载被closeSession/killAll过滤，成功ACK后仍继续写盘 | [下载生命周期 C1](download-round11.md)，第十一轮；Core原生实证 |
| 19 | P2 | R50 | 等待麦克风启动时双击创建两份录音，停止及组件卸载只释放最后一份 | [Voice W17，第六轮；同一 renderer document 存活期间](voice-round6.md) |
| 20 | P2 | R30 | 后台工具任务完成时终态写盘失败被吞掉，结果丢失并持续显示运行中、阻塞配置修改 | [Runtime T1，第三轮；存储恢复后可取消/重试](runtime-round3.md) |

### P2：任务、审批、停止和Goal能否继续（14项）

| 顺位 | 级别 | 编号 | 流程与实际影响 | 证据 |
| --- | --- | --- | --- | --- |
| 21 | P2 | R01 | 连续两个并行审批复用卡片，第二个显示“已批准”而无法操作 | [Desktop D4](desktop-round1.md) |
| 22 | P2 | R10 | CC 房间切换或离线后无法恢复待审批卡片，服务端一直等待直到超时 | [Server S6](server-round1.md) |
| 23 | P2 | R12 | CC 一次多题澄清仅能回答首题，后续题目随控制请求被消费 | [Server S2](server-round1.md) |
| 24 | P2 | R13 | 切换澄清题后旧选择索引残留，选项数变少时提交抛异常 | [Desktop D6](desktop-round1.md) |
| 25 | P2 | R73 | 配置保存窗口内回答idle异步问题，lease已提交却未派发，重试和重连无法恢复旧题 | [Hub路由 H17-1](server-routing-round17.md)，第十七轮；取消后重新提问可恢复 |
| 26 | P2 | R78 | 无live worker恢复暂停Goal仅持久改为active并回成功，实际没有启动或派发续接 | [Goal冷启动 G20-1](goal-sleep-round20.md)，第二十轮；编辑/暂停/删除正常 |
| 27 | P2 | R79 | worker活着但bound会话非resident时，Goal续接缺WorkspaceContext，模型前失败却未回滚或提示 | [Goal bound冷恢复 G20-2](goal-sleep-round20.md)，第二十轮；正常授权run可恢复 |
| 28 | P2 | R44 | 续接自动化超过 120 秒后提前结算，worker 仍执行时保留的非once计划可以再次排入 | [Automation A1，第五轮；实际 ChatSession FIFO](automation-round5.md) |
| 29 | P2 | R45 | worker 明确拒绝续接运行，网关/生命周期仍宣告 completed | [Automation A2，第五轮](automation-round5.md) |
| 30 | P2 | R07 | Core worker 退出清掉仍在运行的外部 CLI busy 状态，停止按钮消失 | [Desktop D7](desktop-round1.md) |
| 31 | P2 | R08 | 配对浏览器 CLI 房间的停止按钮发送原生 run.stop，实际房间继续运行 | [Web W3](web-round1.md) |
| 32 | P2 | R15 | 外部 CLI 后续消息只在当前会话推进，切到别处后队列停住 | [Desktop D3](desktop-round1.md) |
| 33 | P2 | R18 | CLI 启动失败留下“运行中”句柄，安装/修复后同模式重开仍不能恢复 | [Server S4](server-round1.md) |
| 34 | P2 | R14 | 可稍后回答的异步问题在任务完成后仍阻塞新的独立任务 | [Web W5](web-round1.md) |

### P2：项目、会话、根目录和配置一致性（10项）

| 顺位 | 级别 | 编号 | 流程与实际影响 | 证据 |
| --- | --- | --- | --- | --- |
| 35 | P2 | R04 | 在 A 执行斜杠命令后切到 B，迟到的展开结果覆盖 B 草稿 | [Desktop D5](desktop-round1.md) |
| 36 | P2 | R05 | A 会话拖入的文件随切换残留到 B，发送因附件所属会话不符失败 | [Desktop D2](desktop-round1.md) |
| 37 | P2 | R16 | CC 打开回包广播到同设备全部页签，也会覆盖用户较新的会话选择 | [Web W2](web-round1.md) |
| 38 | P2 | R24 | 移除项目先删除项目权威，再释放冷会话 worktree；重加项目后旧归档会话仍占用 worktree | [Desktop D10，第二轮](desktop-round2.md) |
| 39 | P2 | R72 | 设置页取消归档只恢复桌面catalog，Core仍归档，随后可移除恢复行仍绑定的secondary root | [会话操作 SO17-2](session-operations-round17.md)，第十七轮；历史和物理目录保留 |
| 40 | P2 | R69 | 原secondary目录缺失，正式修复到健康primary仍被旧source全roots校验阻断 | [项目目录 PR16-1](project-recovery-round16.md)，第十六轮 |
| 41 | P2 | R58 | 合法 managed worktree 新开终端及普通图片预览被 Main 注册根门禁拒绝，文本读取正常 | [终端](terminal-review-round13.md)、[图片与恢复](file-navigation-round14.md) |
| 42 | P2 | R22 | 多根项目会话迁移到合法 secondary root 后，已绑定 Panel 被错误视为跨项目而打不开 | [Desktop D8，第二轮](desktop-round2.md) |
| 43 | P2 | R23 | 一个无效的已追踪项目目录让全部健康项目的 Panel 消失；65 个健康项目也触发批量上限 | [Desktop D9，第二轮](desktop-round2.md) |
| 44 | P2 | R25 | 两个已打开的默认模型表单先后保存，后一个未改过的旧字段回滚前一个更新 | [Web W7，第二轮](web-round2.md) |

### P2：首次可用、恢复、安装和自动化状态（9项）

| 顺位 | 级别 | 编号 | 流程与实际影响 | 证据 |
| --- | --- | --- | --- | --- |
| 45 | P2 | R21 | Hub Web 新会话首次运行中刷新，完整输出日志的 legacy anchor 被空基线裁掉，前端拒绝恢复 | [Root R21](README.md:136) |
| 46 | P2 | R06 | 原生运行回包错误被当作普通结果，发送失败无可见解释，草稿已清空 | [Desktop D1](desktop-round1.md) |
| 47 | P2 | R32 | 新设备浏览器存储配额耗尽时，配对和认证生成不同 secret，配对流程必然失败 | [Web W10，第三轮](web-round3.md) |
| 48 | P2 | R34 | 手机 PUT 已开始后无法随断线取消，重连在线仍被旧上传阻塞独立文本发送 | [Web W12，第三轮；主机正常收到请求时有 5 分钟票据上限](web-round3.md) |
| 49 | P2 | R17 | 删除草稿附件不释放上传配额，空输入框仍被 16 个文件上限卡住 | [Server S3](server-round1.md) |
| 50 | P2 | R51 | 成功安装后卸载，旧 installed 任务仍禁用市场重装，实际目录和注册已不存在 | [Agent Plugins W18，第七轮；同一 Main 生命周期](plugins-round7.md) |
| 51 | P2 | R53 | 从文件夹预览安装把临时快照记成更新源，快照已删，原文件夹仍在也无法更新 | [Agent Plugins W20，第七轮；旧安装内容保留](plugins-round7.md) |
| 52 | P2 | R46 | 自动化执行历史按名称/时间认领，遗漏真实实时记录并混入同项目其他任务的结果 | [Automation A3，第五轮；合并身份关联根因](automation-round5.md) |
| 53 | P2 | R47 | 任务异步自动停用后，当前自动化页面仍显示活跃和旧下次运行时间 | [Automation A4，第五轮](automation-round5.md) |

### P3：随后处理：窄窗口、可恢复和体验问题（33项）

| 顺位 | 级别 | 编号 | 流程与实际影响 | 证据 |
| --- | --- | --- | --- | --- |
| 54 | P3 | R11 | 连接失效但界面尚显示在线的短窗口，CC 审批发送失败仍删卡 | [Server S7；正常离线有禁用及 handler 保护](server-round1.md) |
| 55 | P3 | R19 | 同步审批未被处理且请求仍 pending 时交付失败，错误本身不恢复卡片 | [Web W6；下一次有效 resync 可恢复](web-round1.md) |
| 56 | P3 | R20 | Hub 接受超过 10、至多 20 MiB 图片，发送阶段才因 10 MiB 限制失败 | [Server S5](server-round1.md) |
| 57 | P3 | R26 | Skill 保存遇到 409 后按提示刷新，编辑器仍用旧 revision，无法继续保存 | [Web W8，第二轮](web-round2.md) |
| 58 | P3 | R27 | MCP 配置已更新，迟到的旧 probe 响应却给新配置显示旧的成功结果与工具列表 | [Web W9，第二轮](web-round2.md) |
| 59 | P3 | R29 | 启动迁移旧会话时，旧项目初始快照覆盖已到达的新项目广播；新项目从界面消失 | [Desktop D12，第三轮](desktop-round3.md) |
| 60 | P3 | R38 | 退出设备必须等 HTTP logout 请求结束，响应卡住时本地界面和连接也不退出 | [Web W14，第三轮](web-round3.md) |
| 61 | P3 | R39 | 恢复归档会话已成功，却被自身 busy 守卫误判为未保存修改，需额外确认才能打开 | [Files/History F1，第四轮](files-round4.md) |
| 62 | P3 | R43 | Token 保存遭遇真实存储拒写时没有可见错误，草稿保留但用户不知道失败原因 | [Credentials C2，第五轮](credentials-round5.md) |
| 63 | P3 | R48 | 自动停用原因在 Desktop 摘要中丢失，重开详情只能看到普通暂停 | [Automation A5，第五轮；底层原因仍持久保留](automation-round5.md) |
| 64 | P3 | R49 | 共享资料集跨文件查询吞掉已知原件变更的恢复指引，用户无法确定需更新哪个文件 | [Collection，第六轮；0.9.33 新可达路径](collections-round6.md) |
| 65 | P3 | R54 | Quick Chat 收到文件面板 PNG 的内部拖放数据后静默丢弃，不产生图片或路径引用 | [Quick Chat Q1，第八轮；系统图片拖入可用](quickchat-round8.md) |
| 66 | P3 | R55 | 较早的磁盘会话打开迟到完成，覆盖后来已成功的全局搜索导航；重选可恢复 | [搜索与导航 W21](search-routing-round11.md)，第十一轮 |
| 67 | P3 | R56 | 全文搜索仅扫描最近500个候选，漏掉更早匹配却返回完整的空结果 | [搜索 W22](search-routing-round11.md)，第十一轮 |
| 68 | P3 | R59 | Review 选择首提交显示“no changes”，Git range 无父错误被吞为空结果 | [终端与 Review](terminal-review-round13.md)，第十三轮 |
| 69 | P3 | R60 | 侧栏删除遭遇真实权限失败仍移除行并持久 tombstone，仅日志无提示；历史页可重试删除 | [会话操作 W23](session-actions-round13.md)，第十三轮 |
| 70 | P3 | R61 | 同项目两个窗口普通选择互相覆盖当前会话，无法稳定各看 S1/S2 | [多窗口 M1](multiwindow-round13.md)，第十三轮 |
| 71 | P3 | R62 | 离开 CLI 房间后已有审批仍全局阻塞新稿，重选原生会话可恢复 | [Web 生命周期 W24](web-lifecycle-round13.md)，第十三轮 |
| 72 | P3 | R63 | 普通通知等待频率窗口时占住串行队列，后来的 urgent 停用通知也被延迟 | [通知 N1](notification-round14.md)，第十四轮 |
| 73 | P3 | R64 | Reload 恢复的终端先关闭再新建可复用旧壳；再次关闭重开可恢复 | [终端生命周期 TL1](terminal-lifecycle-round14.md)，第十四轮 |
| 74 | P3 | R65 | 目录实际 EACCES 被显示为空树，无错误提示；修权限后刷新可恢复 | [文件导航 W25](file-navigation-round14.md)，第十四轮 |
| 75 | P3 | R67 | 另一窗口开启LAN后，已挂载远程设置仍显示关闭、禁用停止；重挂或再开启可恢复 | [远程设置 MR1](remote-settings-round15.md)，第十五轮 |
| 76 | P3 | R70 | 自定义指令自动保存拒写后清掉pending，存储恢复也不重试，离开丢未保存稿 | [设置保存 S16-1](settings-recovery-round16.md)，第十六轮 |
| 77 | P3 | R71 | 项目重命名拒写后仍显示新名称，无失败提示，普通同步后回旧名 | [会话操作 SO17-1](session-operations-round17.md)，第十七轮 |
| 78 | P3 | R74 | 上下文摘要期间没有可用取消按钮，30秒RPC超时恢复UI却未取消后台摘要 | [上下文取消 C18-1](context-cancel-round18.md)，第十八轮；Core取消正常 |
| 79 | P3 | R75 | 另一已打开项目窗口保存自己的会话模型，旧整图抹掉先前窗口已存偏好，重开回默认 | [模型偏好 M18-1](model-switch-round18.md)，第十八轮；重新选择可恢复 |
| 80 | P3 | R76 | 异步答案已接受并触发续接运行，Hub误判空闲而允许归档、隐藏当前历史行 | [Hub会话 HS18-1](hub-session-operations-round18.md)，第十八轮；实际恢复API正常 |
| 81 | P3 | R80 | Chrome闲置断线后正常轮询仍显示正在使用，需先断开再重新授权；动作门禁正确拒绝 | [浏览器连接 B21-1](browser-lifecycle-round21.md)，第二十一轮 |
| 82 | P3 | R82 | macOS前台A显式菜单操作仍发往最后安装菜单的B，后台窗口被打开Search/Palette或切项目 | [菜单窗口 D23-1](menu-routing-round23.md)，第二十三轮；无真实OS菜单/快捷键实测 |
| 83 | P3 | R83 | macOS项目成功创建、改名、移除后Recent菜单不刷新，新项目缺项、旧名和已删项残留 | [最近项目 D23-2](menu-recents-round23.md)，第二十三轮；权威磁盘与广播正常 |
| 84 | P3 | R84 | 从未发布输出日志的旧配对原生图片会话恢复时，把内部路径和模型提示当正文，没有安全附件摘要 | [旧历史 F24-1](legacy-history-round24.md)，第二十四轮；正文和图片原件保留 |
| 85 | P3 | R85 | 现代图片会话在普通Desktop冷恢复后缺附件提示，纯图片用户气泡不显示；正确metadata和原件均保留 | [现代图片 D25-1](modern-desktop-image-round25.md)，第二十五轮；Web及inline UI控制正常 |
| 86 | P3 | R86 | 换项目primary后摘要分叉的Files把新根ID配旧workspace路径，新主目录文件无法显示；旧根及原件正常 | [Files映射 F27-1](file-root-round27.md)，第二十七轮；Main拒读正确 |

## 哪些模块仍需补审

“没有专项记录”表示这批报告没有给出对应模块的审查证据，不表示模块一定存在缺陷。完整构建、类型检查、既有单测、静态调用链、带替身的组件/服务实验、真实 native/Electron 场景是不同证据层级。

既有 **706 文件 / 6286 测试**只包括 Server 100 文件、Web 41 文件、Desktop 565 文件，见[原字节归档](baseline-evidence-round28.md)。Core、Coding、Pet 等有专项触达，但不能由这 706 份日志推导它们的整包自有测试已执行；工作区构建和 12 包类型检查通过也不能替代专项审查。下表是模块矩阵，不是代码行覆盖率。

| 模块 | 报告已经覆盖的部分 | 未覆盖或验证不足的部分 |
| --- | --- | --- |
| Server | Hub 认证/配对、房间、提交/审批、上传、输出恢复、worker stdin、关闭、慢连接、认证文件锁；[服务端](server-round1.md)、[认证](auth-round7.md)、[路由](server-routing-round17.md)、[锁](file-mutex-round19.md) | `project-runtime` 的既有单测不等于专项流程审查；remote-relay 重连/轮换为[静态预审](server-preflight-round23.md)。公网 tunnel、真实 relay 部署、反向代理和长期运行仍缺完整验收。 |
| Web / 配对端 | 草稿/回执、审批、上传、会话恢复、配置冲突、文件导航、Link/MCP、Panel 音频正常控制；[Web](web-round1.md)、[文件](file-navigation-round14.md)、[录音](voice-round6.md) | Environment/多环境切换、service worker/PWA 缓存升级与离线、Panel 视频采集等主要停留在既有测试或没有专项记录；真实移动浏览器、系统相机/麦克风权限及后台恢复未完整验证。 |
| Desktop | 日常聊天/设置/项目/Panel/搜索/凭据/模型/菜单/终端/浏览器取消，有分层专项及部分真实 Electron 场景；[流程地图](flow-coverage.md) | task inbox、IM gateway、logs/runs/subagents 独立交互、媒体 custody 全流程、实际 Chrome 扩展完整链路及独立 Playwright 后端仍不足。终端 PTY、OS 菜单/原生拖放、真实账号/设备不应由组件替身结果推定全部通过。 |
| Core | Session/Engine 的特定续接、上下文、输出日志、Goal、下载、权限/owner 控制、插件/Link/MCP 恢复等局部专项；[上下文](context-recovery-round17.md)、[Goal](goal-sleep-round20.md)、[插件](plugins-round7.md)、[MCP](command-recovery-round16.md) | LLM provider/模型请求边界、重试/限流/流解析、cost ledger/预算、hooks、完整工具执行与子代理组合生命周期等没有系统专项覆盖；现有安全正常对照不能替代完整权限边界审计。 |
| Coding | 真实 Git/worktree 回滚、释放，Review 首提交及外部 runtime 路由局部；[工作区](workspace-quality-round11.md)、[终端与 Review](terminal-review-round13.md) | LSP、coding 工具集、external agents/runtimes、quota 和完整真实 CLI 执行/恢复未全面覆盖。Web/桌面 CLI 房间审查不是整包 Coding 或终端 TUI 审查。 |
| Link 独立包 | Core/Host/Web 的授权与连接流程有[专项](link-recovery-round16.md) | `packages/link` 自身 provider manifest/授权指南正确性和所有真实服务授权没有独立专项；不能把同名 Links UI/服务审查视为整个 manifest 包已覆盖。 |
| TUI | 插件命令共用服务有静态衔接，部分 Core 行为可供参考 | 真实 TTY/Ink 输入、多行/IME、终端缩放、快捷键、语音、退出与恢复没有完整专项。 |
| Chat | 自动化通知到 relay 的局部静态衔接；[自动化复核](automation-quality-round18.md) | 各聊天平台 adapter、真实消息发送/编辑、附件、会话/thread 映射、重连、限流和去重没有渠道级专项。 |
| Pet | 搜索/disclosure/导航局部有动态证据；[搜索](search-routing-round11.md)、[搜索复核](search-quality-round12.md)；Desktop 数字人另有 Electron UI 验证 | 完整委派、projection observer、行为 profile 与长任务生命周期没有全流程专项。数字人页面测试不等于整个 Pet capability 已审完。 |
| Optimization Lab | Desktop 部分既有单测；构建/类型检查 | 没有专项审查报告。私有、默认关闭，排在在用主流程之后补审。 |
| CDP 兼容包 | 浏览器专项触达维护中的 Desktop driver，部分预审提及协议/alias | `packages/cdp` 兼容层没有独立专项；不能把 Puppeteer/Browser Stop 结果外推到全部兼容导出。 |
| Arena | 类型检查门禁内的保留源码；根 build 不包含 Arena | 没有专项审查。私有保留、Host 不加载，不是当前日常流程的高优先补审项。 |
| 根 scripts / 打包发行 | install、工作区 build/typecheck、Desktop build 已有记录 | `test:package-release`、安装后 SDK/export/bin/assets 合同、版本一致性、升级/回滚与跨平台发行缺专项；成功构建不等于可安装包及发行流程已验收。 |

## 建议补审顺序

这里排的是下一轮审查工作，不给尚未证实的模块缺陷分配 P1/P2。

| 顺序 | 补审范围 | 为什么排在这里 |
| --- | --- | --- |
| 1 | 当前本地 `main` 新账号入口及云登录可用性差异 | 本轮只读核对时本地 `main=62a58ac8`，比冻结 `a66f4ef2` 多 3 个提交、13 个 Desktop 产品/测试路径。`6034df8a` 仅有[旧静态预审](sidebar-account-local-round22.md)，`62a58ac8` 的 availability 改动尚无本次报告验证。`origin/main` 本轮 fetch 仍是 `a66f4ef2`。 |
| 2 | Core 请求/权限/计费边界，以及 hooks/子代理/工具组合生命周期 | 共享底层影响多个入口，现有专项只覆盖局部；先用隔离本地 fixture 补控制，不默认启动真实付费请求。 |
| 3 | 已有高风险发现的完整生产链：Stop、worker 退出、Goal 冷恢复、终端和多窗口 | 分层复现已支持发现；真实 App/worker/PTY、macOS OS 事件、Windows/Linux 和崩溃恢复仍有边界。 |
| 4 | Server 部署与 project-runtime、Web PWA/多环境/移动设备 | 已有 suite/静态链，缺实际组合流程及部署恢复证据；长时间压力、容量和跨实例恢复也应另设验收。 |
| 5 | Panel Host 通用接口与独立 Panel 业务 | 本次检查安装/恢复、项目权威和部分 bridge/资源接口。独立 `codeshell-panel-apps` 的各业务、SDK/native tools、视频/音频处理不能由 Host 报告宣告覆盖，需要对应仓库专项。 |
| 6 | Chat 渠道端到端、TUI 真实交互、Coding LSP/外部工具 | 当前主要缺渠道和独立终端的用户流程审查，不只是补同一 Host handler 的测试。 |
| 7 | Pet 完整生命周期、Optimization Lab、Arena、CDP 兼容面 | Pet 按实际启用频率安排；默认关闭/不加载/兼容源码排在在用流程之后。 |

## 全部报告复核的口径

本轮纳入启动时顶层 **140 份**报告/汇总；136 份专项、质量稿、预审和反证分三组交叉复核，另四份主汇总对照。文件索引见[全部报告清单](report-inventory-postreview.md)。`validation` 和 `reproductions` 是原始证据及运行材料，引用时核对，不把它们的重复历史版本计作新的产品发现。

最终级别按主报告：R11/R19/R29 为 P3；R53 保留 P2，独立审计的边缘 P3 意见及主审裁定都有记录。预审的“0 执行”、正常控制的“0 新问题”和正式缺陷复现需要分别解释；后轮已经补证的 Browser Stop 不再列为完全未覆盖。

本轮澄清三处文字：R29 的 Open Recent/重启仅有静态衔接，菜单还需已有对应路径或已刷新；第十六轮 `Node22` 指 22 个 Node 手工断言，运行时是 Node v25.8.1；旧图片质量稿标题的 `R25` 改为“第25轮”，避免混淆正式 R25。R02 原作者的附条件升级意见作为历史保留，最终仍为 P2。旧源码基线、原始日志和执行计数未改，详情和前后 SHA 见[本轮核对收据](validation/postdelivery-report-review.json)。

所有模块的“已覆盖”均限于对应报告给出的基线、触发条件和实验层级。本次只整理报告与覆盖缺口；原目标已完成、heartbeat 保持暂停，未新增产品测试、产品代码变更或修复。
