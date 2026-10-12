# 修复交接建议（审查结论，未实施修复）

此表用于从已确认的 86 项中安排修复顺序，不新增发现、不调整级别，也不将同批问题视为同一个根因。各批次是交付分组，可并行推进；不得因排在第六批就延后 R68/R77 等 Host 可用性修复，P3 也不应阻塞同批 P2。此表不是 52 项 P2 的逐项验收清单。正式触发条件、源码行号、正常对照与平台限制以 [主报告](README.md)、[流程覆盖地图](flow-coverage.md)及专项附录为准。

| 顺序 | 建议先交付的结果 | 相关已确认项 | 修复验收应保留的场景 |
| --- | --- | --- | --- |
| 1 | 创建或启动失败只清理本次调用拥有的资源 | **R35/P1**、R09/P2：[真实 Git 并发证据](desktop-round3.md)、[Hub 重复启动](server-round1.md) | 输入框连续 Enter 与 Main 并行请求都应有一致处理；失败请求不得删除成功请求的 worktree、分支或未提交文件。事前“路径不存在”不足以证明回滚归属。第二个 Hub 使用同一 dataDir 启动失败时，第一个健康实例仍在使用的服务器上传文件应保留并可发送。两项分别验收，不共用回滚归属假设。 |
| 2 | 新增账号不覆盖旧账号；用户停止后不再提交旧浏览器输入；worker 写入/退出交叉产生的 stdin 异步错误不带走 Node Host | R42、R81、R36/P2：[凭据](credentials-round5.md)、[Browser Stop](browser-stop-round22.md)、[Host pipe](runtime-round3.md) | 默认名和中文名两次新增保留两份独立记录；取消尚在 readiness 等待的请求后 enable 不产生旧 Input；写入与 worker 退出交叉时隔离该 child generation 的流错误并结算受影响请求。R36 动态证据为原生 Node v25.8.1 中的生产 WorkerBridgeCore，完整 Hub 入口为源码衔接，Electron Main 退出行为未验证。保留显式账号更新、已提交动作不回滚和正常退出控制。 |
| 3 | 一次提交有稳定身份，草稿、附件与审批都留在所属会话 | R01、R03、R04、R05、R06、R10、R12、R13、R33、R37、R40、R41/P2：[会话与提交证据索引](README.md) | 丢 ACK 后核对同一意图；后台输出不能抢新会话绑定；离线新建尚未确认项目时不能沿用旧目标；并发/重连审批按 request ID 隔离卡片状态，处理首张后第二张仍可独立批准/拒绝；原生 error envelope 及拒绝有可见原因和可重试入口，不把仍在聊天中的 user message 说成彻底丢失；预入队失败稿和新稿均可取回。 |
| 4 | 长任务的接纳、取消、完成和关闭都反映实际执行 | R07、R08、R15、R18、R30、R31、R44、R45、R57、R73、R78、R79/P2：[运行时](runtime-round3.md)、[自动化](automation-round5.md)、[Goal](goal-sleep-round20.md) | 不同 runtime 使用对应 Stop；后台队列不依赖前台选择；终态拒写有可恢复诊断；关闭等待 owned 资源退役；冷 Goal 续接完成合法权威重建并结算 resolved 失败；非 once 续接超时不能误报完成并重复排入。 |
| 5 | 项目、根目录和存储更新保持同一份权威 | R22、R23、R24、R25、R28、R52、R58、R69、R72/P2，以及 R86/P3：[项目恢复](project-recovery-round16.md)、[归档恢复](session-operations-round17.md)、[根映射](file-root-round27.md)、[终端](terminal-review-round13.md)、[图片](file-navigation-round14.md) | 合法 secondary/worktree 保持可用；Session managed worktree 应可新开终端和预览普通 PNG，保留文本读取正常对照；单项目故障不清空健康 Panel；资源释放先于权威删除；旧表单不能覆盖他端新字段；新源校验失败保留旧插件；恢复同时写 Core 状态；root ID 与 path 必须来自同一个注册根。保留独立 engine session authority、每窗口 owner、trust、symlink 和越界拒读门禁；终端句柄不能充当 Core session ID，也不能通过放宽通用路径门禁修复 R58/R86。 |
| 6 | 连接有发送上限，存储故障不扩大为整个 Host 无响应；后台状态与失败反馈能让用户继续操作 | R68、R77/P2：[连接发送](connection-recovery-round15.md)、[认证锁](file-mutex-round19.md)；其余 P2 按正式影响排入，P3 按使用频率处理：[全部编号与级别](README.md) | R68：已认证、仍 OPEN 的慢 peer 通过直播/设备发送时，单 socket 及聚合 backlog 有界；保留健康 peer、合法历史分页、重新认证和撤权控制。不把 24 MiB 内的队列增长说成已测 OOM/崩溃。R77：已初始化 dataDir 失去当前非 root 进程写权限且 hub 子目录仍可读/遍历/修权限时，认证锁应立即分类真实 EACCES 并给出上下文，避免同步耗尽约 30 秒预算拖住同进程健康路由和 timer；保留认证、互斥写、短跨进程争用和失败不写保护，修权限后同稿重试。其余失败重试保稿、恢复步骤可见，展示范围与持久状态一致；不能用静默吞错作为恢复。 |

上表是基于当前证据的工程排序建议，并非实施方案或已通过的修复验收。现有表征测试通过只证明问题复现；修复时应把对应缺陷断言改为正确行为，并保留正常路径、去重和资源归属控制。平台只在报告已验证的范围内成立，各附录中未动态执行的完整 App、产品 worker、提供方等边界不能据此当成端到端验收完成。

[独立排序复核](validation/original-repair-handoff-round28/independent-quality.raw.md)与[源快照收据](validation/original-repair-handoff-round28/independent-quality.receipts.json)新增发现/执行0。主审采用建议并收窄上述Host/上传文件措辞；原稿、建议diff原字节与质量稿均保存。其余P2应按主报告逐项安排：CLI实际权限模式R02/R66、录音资源R50、可选问答/首次恢复/配对R14/R21/R32等不应因未在本表展开而排到低频P3之后。

用户追加的全报告复核已整理[全部86项优先队列与覆盖缺口](priority-and-coverage.md)，补齐本交接分组未逐项展开的P2/P3；本文件的六组验收建议及非已修复边界保持。
