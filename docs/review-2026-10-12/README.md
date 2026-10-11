# CodeShell 服务端与桌面端审查

本次审查覆盖服务端、Electron 桌面端、配对 Web 与移动端的日常流程，重点检查消息发送、审批、取消、切换会话、恢复和项目上下文。问题只在有代码证据或可复现结果后列入正式发现。

审查进行中，截止时间为新加坡时间 2026 年 10 月 12 日 11:00。当前基线为 `84740d56e55517b004948a0a0e07649ad6fbf998`，对应最新 `origin/main`。产品代码保持原样，报告保存在独立分支 `codex/review/server-desktop-20261012`。

## 当前结论

当前已收束 39 项问题：1 项 P1、33 项 P2、5 项 P3。优先处理审批状态、任务回执和会话身份；这些问题会让任务无法继续、重复执行，或把用户输入带到另一个会话。P1 表示有未提交文件丢失风险、应优先修复；P2 表示正常使用可触发、应安排修复；P3 表示影响较小的失败反馈或一致性问题。尚未证实的候选不计入数量。

**最先修 R35：创建工作区时重复 Enter，失败请求的回滚可以删除另一个已成功请求的 worktree、分支和未提交文件。** 此项已由独立代理复查入口与真实 Git 时序，见 [独立质量复核](quality-audit.md)。

以下是持续审查的阶段记录，截止前还会补充。复现测试的“通过”表示已稳定观察到当前缺陷，并不表示缺陷已经修复。所有问题均针对上述基线。

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
| R11  | P2   | CC 审批离线点击后未发出响应却移除卡片，重连后仍无法操作                               | Server S7                                            |
| R12  | P2   | CC 一次多题澄清仅能回答首题，后续题目随控制请求被消费                                 | Server S2                                            |
| R13  | P2   | 切换澄清题后旧选择索引残留，选项数变少时提交抛异常                                    | Desktop D6                                           |
| R14  | P2   | 可稍后回答的异步问题在任务完成后仍阻塞新的独立任务                                    | Web W5                                               |
| R15  | P2   | 外部 CLI 后续消息只在当前会话推进，切到别处后队列停住                                 | Desktop D3                                           |
| R16  | P2   | CC 打开回包广播到同设备全部页签，也会覆盖用户较新的会话选择                           | Web W2                                               |
| R17  | P2   | 删除草稿附件不释放上传配额，空输入框仍被 16 个文件上限卡住                            | Server S3                                            |
| R18  | P2   | CLI 启动失败留下“运行中”句柄，安装/修复后直接重开仍不能恢复                           | Server S4                                            |
| R19  | P2   | 同步审批发送后遇到 worker 响应错误，卡片不恢复，缺少直接重试入口                      | Web W6，影响取决于请求仍在等待                       |
| R20  | P3   | Hub 接受 10–20 MiB 图片，发送阶段才因 10 MiB 限制失败                                 | Server S5                                            |
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

第一轮完整分析：[Desktop](desktop-round1.md)、[Server](server-round1.md)、[Web/配对端](web-round1.md)。后续专项分析会继续补充到本目录。

第二轮完整分析：[Desktop 项目/Panel](desktop-round2.md)、[Web 配置/Skills/MCP](web-round2.md)。所有已收束脚本和日志保存在 [reproductions](reproductions/README.md)，可在当前工作区或相同基线的其他 checkout 重跑。

第三轮持续补充：[Desktop 插件/项目初始化](desktop-round3.md)、[手机配对/草稿/上传](web-round3.md)、[后台任务与 Node 主机退出](runtime-round3.md)。第四轮：[文件与历史流程](files-round4.md)。

## 需要先修的边界

### 工作区回滚必须证明资源归属

R35 的界面创建按钮已禁用，但输入框 Enter 没有 busyAction 检查，实际发出两个相同 IPC 请求。Main 同一会话允许两次创建并行进入，两个预检都可以看到路径/分支不存在。某一创建成功后，另一真实 Git 错误返回触发无条件 `git worktree remove --force` 和 `git branch -D`，删掉成功请求的资源。成功广播已经发出，会话仍指向已删除路径。

复现的 barrier 只固定真实 Git 完成顺序，没有伪造返回结果。未提交文件丢失需要文件在成功返回至失败回滚之间产生，不声称每次重复 Enter 都有该文件损失；自然并发也观察到回滚干扰仍在 checkout 的成功进程。应同时阻止 UI/Main 重复工作区修改，并用此次调用实际创建资源的凭据决定能否回滚；仅依赖事前不存在检查不能提供并发归属证明。

### 审批必须以请求身份保存和恢复

R01 的触发是两个并行 GenerateImage 请求：批准第一个后，第二个复用 ApprovalCard 的已决定状态，没有剩余按钮。真实 Core 的并行工具队列已经确认会同时产生这两个审批，并非人为构造的不可能状态。R13 是同类身份缺失在 AskUserMessageView 的表现，但会直接触发提交异常。

R10、R11、R19 分别缺少待审批快照、传输失败保留和回包错误恢复。修复时应保留请求 ID 与待提交状态，按服务端 resolved 回包清除，房间激活与重连时补齐 pending snapshot。单独补一个前端按钮无法解决重连丢失。R14 还需把真正阻塞的审批与可异步回答的问题分开。

### 重试必须保留原意图，切换必须保留会话身份

R03 已用实际客户端和真实 Engine 分别验证：同 ID 重试只调用模型一次，新 ID 会执行第二次。当前丢 ACK 路径恢复普通草稿并重新生成 UUID，缺少不确定回执状态与历史核对。建议沿用 Hub 控制器的意图保留思路，先确认 durable receipt，再允许重发。

R04、R05 分别涉及迟到的异步展开和组件内附件状态。发起操作时应冻结会话 ID；回写时检查该 ID，不能使用完成时的 activeBucketRef。附件、引用和文本草稿应采用一致的会话归属。R16 同时需要 viewer 定向回包及导航请求关联，避免跨页签和迟到回复改变目标。

### 控件必须对应实际运行时

R02 和 R08 的共因是 CLI 房间仍使用原生会话的权限和停止回调。界面需要显示房间实际启动模式，并用显式房间协议取消或重启 CLI。R07 则需要记录每个运行的 runtime 来源，Core worker 退出只能清理 Core 活动。R15 的后台队列推进应独立于当前显示的会话。

### 新会话首次运行中的恢复不能裁掉日志基点

R21 的真实 native Hub + Core + 本地模拟模型响应中，`outputJournal.status=ok`、`legacyBaseComplete=true`，但 `transcript=[]`。服务端 [run-replay.ts](../../packages/server/src/hub/run-replay.ts) 第 192 行按开始运行前的 `baselineEvents=0` 裁掉随后生成的 `session_meta`；[headless-server.ts](../../packages/server/src/serve/headless-server.ts) 第 1460–1478 行将该结果用于日志恢复。真实 [chat.ts](../../packages/web/app/chat.ts) 第 102–107 行因此抛出 `Output recovery has no complete legacy base`。

这不是日志损坏：读取 legacy base 已返回 complete，随后才被 RAM overlay 规则裁空。应让 durable journal 的恢复基点与旧 RAM stream overlay 的运行前切片分开处理，并补真实 worker 首次创建会话的刷新测试。运行结束后 RAM replay 释放，影响窗口主要是首次运行尚未结束的阶段。

### 主机启动与资源回收要保持正在使用的资源

R09 中第二个实例因端口占用退出，第一个实例仍健康，但其附件已被删除。应在任何清理前取得数据目录的独占租约，或按实例分区并只回收已证明不再使用的文件。R17 则需要显式丢弃上传的接口；单纯从草稿 UI 删除不等于释放服务器资源。R18 应在 failed spawn 的 error 路径也退役对应 ChildProcess，允许正常重开重试。

R22 已用真实 ProjectStore、SessionManager 和生产 bindGuest 方法复现：会话权限判定为同项目且 rootStatus=ok，但 Panel binding 只接受 primary path。应以项目 ID 与授权根集合校验所属项目，而不能把合法 secondary root 当作其他项目。

R23 需要逐项目处理失败并按 IPC 上限分批，不能因一个离线目录丢弃全局健康结果。R24 需要先释放 worktree 再 tombstone 项目，且不能把资源释放失败当成已成功移除；当前冷启动后尚未加载到 worker 的磁盘会话会留下占用，恢复项目后新会话清理也会报 `worktree is occupied by another session`。

### 配置冲突需要可完成的恢复路径

R25 用完整认证 Hub 和真实配置写入门禁验证：两端从同一快照打开表单，第一份请求已完成、门禁释放后才提交第二份旧表单，仍发生未改字段回滚。需要字段级 patch 或 revision/CAS；互斥锁只能防止同时执行，不能识别已过期的用户表单。

R26 应提供保留草稿的差异核对和读取最新版本操作，不能只刷新列表并清掉错误。R27 应把 probe 结果绑定被测配置的 revision，配置刷新后拒绝旧结果；服务端取消已经结束的 probe 不能撤回网络中迟到的成功响应。

R28 的初始状态把禁用列表设为空，但插件列表独立先加载完成，开关已经能写整个配置。应在设置快照可用前禁用修改，并按修改字段或最新 revision 更新；旧初始化响应也不能覆写更新的设置。R29 则发生在真实旧会话迁移等待磁盘写入时，新增项目 B 的广播先应用，迁移结束后旧列表 A 又覆盖它。应给项目初始快照和广播统一的版本检查，避免 Main 有 A+B、界面只剩 A 而 activeProjectId 仍指向 B。

### 后台任务和主机退出要给出真实终态

R30 已用实际目录权限失败验证：执行器已经完成，终态提交却遇到 EACCES；异步拒绝被 pump 吞掉，内存与磁盘继续显示 running，没有结果或错误通知。权限恢复不会自动补写；显式取消后可重试，重启会标 interrupted。因此应保留可恢复的终态并呈现存储失败，避免将不存在的活动任务长期计入配置门禁。

R31 用真正 Node v25.8.1 Host、真实认证 Hub API 和临时 Panel 原生进程验证。server.close 约 1ms 返回，CLI 随即退出；应在 3 秒后强制终止的进程在 3.3 秒后仍存活。关闭接口应等待进程组退出或强制终止完成。测试仅操作自己创建的临时进程，并验证最终清理完成；未验证 Windows 路径。

### 手机连接恢复要稳定身份和操作归属

R32 的 localStorage 读取仍可用、写入抛 QuotaExceededError 时，safeSet 吞错但没有跨调用的内存身份，导致 pair.complete 和 auth.device 使用不同 secret。应提供页面级稳定后备并说明存储限制。R33 的新建草稿迁移只能由对应 clientRequestId 的创建确认触发，后台其他会话的正常 stream 不能抢占新建状态。

R34 需给每个上传绑定 AbortController 和 connectionGeneration。重连成功只说明 WebSocket 可用，不能证明先前 HTTP PUT 已结束；旧请求仍占用全局 sendingRef，界面没有独立上传取消入口。主机已有票据到期中止，不能据此省略客户端恢复路径。

R36 还需监听每个 worker stdin 的异步错误并结算相关请求。现有 ChildProcess error/exit 处理不能替代 Socket 的 error listener；真实 Node fixture 在 sendLine 返回 true 后因 EPIPE 退出 1。已验证请求大小低于生产 WS 上限。

R37 不能泛化为任意已保存会话误执行：已保存会话有 authority gate；已由本设备创建但尚未落盘的 freshNative 会话有合法例外，离线新建丢包后恰好仍指向旧 A。应拒绝离线新建或保留并重发同一个创建意图，在确认目标 B 前不能发送任务。R38 应把即时本地退出与有界的服务端撤销请求分开，HTTP 黑洞不能让本地退出悬住。

R39 的记录已经正确恢复，额外“放弃修改并离开”也能完成导航，因此按 P3 流程缺陷处理。应在成功提交且 busy 导航门禁真正结算后打开会话，保留对真实草稿和仍在提交操作的保护。

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
| Desktop renderer 现有逐文件测试 | 282 文件、2397 测试、0 失败                                               | `validation/desktop-renderer-results.json`               |
| Desktop main 现有逐文件测试     | 283 文件、2461 测试、0 失败                                               | `validation/desktop-main-results.json`                   |
| native Hub smoke                | 未通过，不计成功；先遇到过期工具 fixture，再暴露 R21                      | `/tmp/codeshell-review-20261012/hub-smoke*.log`          |
| Hub 其余真实 worker 流程        | 通过；已显式排除 R21，临时适配 ToolSearch fixture                         | `validation/hub-smoke-remaining.log`                     |
| 原生输出日志恢复                | 通过；含大日志分页、并发追加、Hub/Desktop/stdio 重启、真实 worker receipt | `validation/output-journal-smoke.log`                    |
| 手机原生输出日志恢复            | 通过；含实际发送、同意图重试、认证重连、分页、损坏阻断和授权撤销          | `validation/mobile-output-journal-smoke.log`             |

所有测试使用隔离应用状态和项目规定的测试入口。模型流程使用本地模拟服务，不调用真实付费模型或第三方账号。

现有 Server/Web/Desktop main/renderer 测试合计 **706 个文件、6286 个测试、0 失败、0 跳过**。上述 Electron 验证与专项复现另计，不把它们混入单元测试数量。

## 后续检查

继续核验模型默认值并发修改、Skills 冲突后的恢复、MCP 测试结果过期、项目初始化与插件刷新竞态，以及 worker 生命周期。已有 TODO 中明确后置的能力与尚未发行的修复单独核对，不将其重复列为新缺陷。

未进行真实付费模型、真实第三方账号、生产数据迁移或发行部署。CLI 模型行为通过可控 fixture 与实际 Host 路由验证，无法据此声称所有真实提供方端到端流程均已通过。静态候选及测试 harness 自身问题单独记录，不冒充产品发现。
