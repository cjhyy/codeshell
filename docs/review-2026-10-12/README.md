# CodeShell 服务端与桌面端审查

本次审查覆盖服务端、Electron 桌面端、配对 Web 与移动端的日常流程，重点检查消息发送、审批、取消、切换会话、恢复和项目上下文。问题只在有代码证据或可复现结果后列入正式发现。

审查进行中，截止时间为新加坡时间 2026 年 10 月 12 日 11:00。初始审查基线为 `84740d56e55517b004948a0a0e07649ad6fbf998`，对应启动审查时的 `origin/main`。01:30 拉取发现主分支已更新至 `a66f4ef291f304ee4df9da8095a90671d9a8f140`（0.9.33）；已另建隔离快照复查差异，原始复现和行号仍按初始基线保存。46 个便携 Bun 复现文件共 125 测试，以及实际 Electron 凭据 4 场景，已在新快照复查成立；详见[0.9.33 差异复查](latest-baseline.md)。产品代码保持原样，报告保存在独立分支 `codex/review/server-desktop-20261012`。

## 当前结论

当前已收束 54 项问题：1 项 P1、42 项 P2、11 项 P3。优先处理审批状态、任务回执和会话身份；这些问题会让任务无法继续、重复执行，或把用户输入带到另一个会话。P1 表示有未提交文件丢失风险、应优先修复；P2 表示正常使用可触发、应安排修复；P3 表示影响较小或触发条件较窄、已有恢复入口的问题。尚未证实的候选不计入数量。

**最先修 R35：创建工作区时重复 Enter，失败请求的回滚可以删除另一个已成功请求的 worktree、分支和未提交文件。** 此项已由独立代理复查入口与真实 Git 时序，见 [独立质量复核](quality-audit.md)。第五轮九项也已[独立复核](quality-round5.md)，均保留，网关通知等条件已收窄。

以下是持续审查的阶段记录，截止前还会补充。复现测试的“通过”表示已稳定观察到当前缺陷，并不表示缺陷已经修复。R01–R48 的原始分析针对初始基线，并已在 0.9.33 复查；R49 针对新快照；R50–R54 在两基线均存在并已分别复现，行号按各专项附录的基线解释。

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
| R29  | P2   | 启动迁移旧会话时，旧项目初始快照覆盖已到达的新项目广播；新项目从界面消失              | Desktop D12，第三轮                                  |
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
| R44  | P2   | 续接自动化超过 120 秒后提前结算，worker 仍执行时同一计划可以再次排入                   | Automation A1，第五轮；实际 ChatSession FIFO        |
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

R09 中第二个实例因端口占用退出，第一个实例仍健康，但其附件已被删除。应在任何清理前取得数据目录的独占租约，或按实例分区并只回收已证明不再使用的文件。R17 则需要显式丢弃上传的接口；新登录仅可能绕过 owner 配额，旧文件仍占全局 32 槽/128 MiB，并非可靠恢复；TTL/sweep 或重启才回收此批文件。单纯从草稿 UI 删除不等于释放服务器资源。R18 应在 failed spawn 的 error 路径也退役对应 ChildProcess，允许同模式重开重试。当前侧栏新鲜 probe 通常挡住缺少 CLI 的选择；已验证触发限定成功/陈旧 probe 后的真实异步启动失败。显式 close 或更改模式可触发重新 spawn，是现有恢复入口。

R22 已用真实 ProjectStore、SessionManager 和生产 bindGuest 方法复现：会话权限判定为同项目且 rootStatus=ok，但 Panel binding 只接受 primary path。应以项目 ID 与授权根集合校验所属项目，而不能把合法 secondary root 当作其他项目。

R23 需要逐项目处理失败并按 IPC 上限分批，不能因一个离线目录丢弃全局健康结果。R24 需要先释放 worktree 再 tombstone 项目，且不能把资源释放失败当成已成功移除；当前冷启动后尚未加载到 worker 的磁盘会话会留下占用，恢复项目后新会话清理也会报 `worktree is occupied by another session`。

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

R37 不能泛化为任意已保存会话误执行：已保存会话有 authority gate；已由本设备创建但尚未落盘的 freshNative 会话有合法例外，离线新建丢包后恰好仍指向旧 A。应拒绝离线新建或保留并重发同一个创建意图，在确认目标 B 前不能发送任务。R38 应把即时本地退出与有界的服务端撤销请求分开，HTTP 黑洞不能让本地退出悬住。

R39 的记录已经正确恢复，额外“放弃修改并离开”也能完成导航，因此按 P3 流程缺陷处理。应在成功提交且 busy 导航门禁真正结算后打开会话，保留对真实草稿和仍在提交操作的保护。

### 失败稿与未确认提交必须保留可访问副本

R40 中保护新稿 B 的 revision 检查是合理的，但恢复原稿 A 失败后，Hub 同时删除原气泡和 submission；配对端 ACK 前也没有气泡，仍提示“内容已保留”。服务端预入队门禁尚未持久化 A，所以没有历史可取。应保留独立失败稿或失败消息，让用户复制、恢复或重试，并只在实际恢复成功时提示已保留。

R41 已用完整认证 Hub 验证实际未接受时的断线窗口：页面有 uncertain 意图却 hasUnsent=false，beforeunload 不拦截，刷新前后主机均为 0 个会话。应把待核对提交也纳入离开保护。此项不声称已持久化任务无法恢复，与 R03 的已执行后重复重试分开计数。

### 新增凭据必须有独立身份和可见失败反馈

R42 的两条正常新增流程均通过真实 Electron、IPC 和 CredentialStore 验证：普通站点没有 suggestedLabel 时产生相同默认 ID；“工作账号”和“个人账号”也都变成 browser__account。第二次新增会整体替换旧 Cookie、名称、权限和策略，旧账号须重新登录捕获。应为新增生成唯一 ID，只有明确更新旧账号时复用 ID。R43 则应捕获 Token 保存拒绝并显示可访问的错误；当前草稿仍在，存储恢复后重试可完成，因此按 P3。

### 自动化应按真实终态和任务 ID 呈现

R44 的 120 秒是等待最终结果的整轮超时，收到 runAccepted 也不会解除；超时后 scheduler 清除同 job 运行保护，真实 ChatSession 仍 busy。第二次触发会 FIFO 排入同一提示，第一轮结束后再次执行。应区分 admission 与 completion，并在实际 worker 终态或明确取消前保留运行占用，不能只扩大超时。R45 是独立的即时失败：JSON-RPC error 被转换成普通 reason，最终映射 automation.completed；应保留失败语义。

R46 应以 cronJobId 关联实时及持久执行记录。日期标题完整相等会漏掉真实记录，同项目 24 小时回退又会认领其他任务；去重不等于确认归属。R47 需要让已打开的自动化详情订阅生命周期更新，R48 需要透传持久的 disabledReason，避免自动停用与手动暂停无法区分。底层调度器及 Hub 的相应保护已单独核对，没有把这些桌面展示问题泛化为整个自动化系统失效。

R49 中拒绝变更原件与整次查询不返回部分正文都是正确保护；缺陷仅是跨文件父结果吞掉已知、安全的更新指引。实际 Engine 流和下一轮消息都只收到通用错误，而单文件读取能明确建议更新资料集。建议提供错误分类与已选择文件的身份，避免一概回传任意子错误。正常 Desktop refresh 后同 ID 查询可恢复。

R50 需要在首个 await 前阻止并发录音启动，并在取消/卸载时使 pending generation 失效。现有逻辑只保存最后一份 recorder/stream，第二次成功会覆盖引用并清掉首份最大录制时长定时器；按停止及切走聊天视图都未回收首份。真实组件+模拟设备在两基线均复现；未使用真实硬件，结论不包括 document unload 或窗口销毁之后。Web Panel 录音已有 requesting/generation 与取消保护，正常对照通过。

R51 的成功任务必须与当前安装清单核对，卸载后不能再用历史 job 表示“已安装”。R52 只在市场相对路径源中复现：先删除同一个 `local` cache 目录，再校验新 manifest；无效更新丢掉旧文件，却留旧注册。应先暂存校验再原子替换。R53 则是从文件夹的 review 安装：内容快照保持审核一致性是正确的，但持久更新来源必须保留原目录，不能保存随后已清除的临时 snapshot。三项触发与修复位置独立。R53 可从原文件夹重新预览并显式覆盖安装，将内容更新到 v2；无需先卸载，但新的更新源仍是临时快照，后续“更多→更新”继续失败。

R54 限定文件面板产生的内部图片 payload 已送达 Quick Chat：缺少 `onAttachImagePath`，图片分支 optional call 后直接返回，没有图片 chip、路径引用或错误。PDF 内部拖入与系统 PNG 拖入对照正常。真实组件 handler 已复现，尚未实测原生 Electron 跨窗口拖动，不声称原文件字节丢失。

## 验证范围

| 验证                            | 结果                                                                      | 证据                                                     |
| ------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| 冻结依赖安装                    | 通过                                                                      | `bun install --frozen-lockfile`                          |
| 完整工作区构建                  | 通过                                                                      | `/tmp/codeshell-review-20261012/build.log`               |
| 工作区类型检查                  | 通过，12 个包及 Web/桌面配置                                              | `/tmp/codeshell-review-20261012/typecheck.log`           |
| Electron 桌面完整构建           | 通过                                                                      | `/tmp/codeshell-review-20261012/desktop-build.log`       |
| Server/Web 现有逐文件测试       | 141 文件、1428 测试、0 失败                                               | `/tmp/codeshell-review-20261012/baseline/results.json`   |
| Electron 导航                   | 通过，含窗口宽度、抽屉、焦点、重载及快捷键                                | `/tmp/codeshell-review-20261012/navigation.log`          |
| Electron 设置                   | 通过，3 种宽度、2 种语言、主题                                            | `/tmp/codeshell-review-20261012/settings-e2e.log`        |
| Electron 工作区页面             | 通过，扩展、凭据、自动化及键盘操作                                        | `/tmp/codeshell-review-20261012/workspace-pages-e2e.log` |
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
| Desktop renderer 现有逐文件测试 | 282 文件、2397 测试、0 失败                                               | `validation/desktop-renderer-results.json`               |
| Desktop main 现有逐文件测试     | 283 文件、2461 测试、0 失败                                               | `validation/desktop-main-results.json`                   |
| native Hub smoke                | 未通过，不计成功；先遇到过期工具 fixture，再暴露 R21                      | `/tmp/codeshell-review-20261012/hub-smoke*.log`          |
| Hub 其余真实 worker 流程        | 通过；已显式排除 R21，临时适配 ToolSearch fixture                         | `validation/hub-smoke-remaining.log`                     |
| 原生输出日志恢复                | 通过；含大日志分页、并发追加、Hub/Desktop/stdio 重启、真实 worker receipt | `validation/output-journal-smoke.log`                    |
| 手机原生输出日志恢复            | 通过；含实际发送、同意图重试、认证重连、分页、损坏阻断和授权撤销          | `validation/mobile-output-journal-smoke.log`             |

所有测试使用隔离应用状态和项目规定的测试入口。模型流程使用本地模拟服务，不调用真实付费模型或第三方账号。

现有 Server/Web/Desktop main/renderer 测试合计 **706 个文件、6286 个测试、0 失败、0 跳过**。上述 Electron 验证与专项复现另计，不把它们混入单元测试数量。

## 后续检查

0.9.33 的 Panel 项目身份与跨文件 Collection 查询差异、已有便携复现适用范围已核对。认证连接与 Agent Plugins 安装恢复已收束；Quick Chat 生命周期已收束；第十轮独立反证已完成审批、Web意图/配置/草稿和Desktop异步状态，详见 [Web复核](web-quality-round10.md)、[审批复核](approval-quality-round10.md)。继续审查工作区/Panel保护、搜索与导航、下载生命周期，核对可恢复方式与平台边界。已有 TODO 中明确后置的能力与尚未发行的修复单独核对，不将其重复列为新缺陷。

未进行真实付费模型、真实第三方账号、生产数据迁移或发行部署。CLI 模型行为通过可控 fixture 与实际 Host 路由验证，无法据此声称所有真实提供方端到端流程均已通过。静态候选及测试 harness 自身问题单独记录，不冒充产品发现。
