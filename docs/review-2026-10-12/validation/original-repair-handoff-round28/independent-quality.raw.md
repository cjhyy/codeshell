# 最终修复交接分组只读质量复核

核对时钟：2026-10-12 SG 10:02:00（clock UTC 02:02:00）。结论：六批交付主题可保留；原稿编号及级别无错误，但应把 R58、R68、R77 明列，并收窄 R36 的平台与时序表述。建议优先补出 R09、R01、R06。新增发现 0，新增产品/fixture/import/原生/模型/网络执行 0；本稿和建议补丁仅写 /tmp，没有修改交接原稿、产品或任务 docs。

原稿 SHA256：25121bfb04fb42b3c7371365a937f897303841f531dcf2bc75275fbb7e791e54。核对主报告当前为 86 项＝1 P1 / 52 P2 / 33 P3，通用 86 文件 / 251 测试。这些是既有证据口径，不是本次执行结果。标准库读取、编号提取及哈希属于文档核对，不是产品测试。

## 分组判断与必要收窄

| 批次 | 判断 | 建议及证据边界 |
| --- | --- | --- |
| 1 | R35 首修正确；应补 R09 | 两项共同涉及资源归属，实际根因和修复分别是并发 Git 创建失败回滚、Hub 启动前误清理 live uploads。R35 仅特定并行时序可删成功请求的 worktree/branch，未提交文件损失还需在窗口内写入；R09 是另一健康 Hub 的上传 spool，不是会话 transcript 或任意仓库文件。不得用一次“路径不存在”证明创建所有权。 |
| 2 | R42/R81/R36 都值得早处理，但应分别交付 | R42 是新增名称 ID 碰撞，不影响显式更新的正常合同；R81 是 Core Stop 成功且 Input 尚未提交、旧 click 仍在真实 readiness 等待，不承诺回滚先前已提交的浏览器动作。R36 应写“worker 写入/退出交叉的 stdin 异步错误”，动态仅原生 Node v25.8.1 + actual Core；完整 Hub/serve 入口静态衔接，不能写 Electron Main 已验证退出或所有普通退出必然受损。 |
| 3 | 身份/草稿/审批分组合理；建议明列 R01、R06 | R01 首卡处理后第二卡应保持独立按钮和 request 状态；显示已批准不等于 Core 真已代用户批准。R06 错误 envelope/拒绝应可见；原用户气泡仍在，不能与 R40 的原失败文本在后续稿出现后无可恢复副本合称“所有输入丢失”。R03 ACK 不确定后重试不得新建执行意图；R41 未确认送达的唯一内存意图仍需刷新保护。上述问题可同批，不能假设单一 request ID 改动修复全部。 |
| 4 | 编号与控制基本准确 | R44 非 once 的 120 秒提前结算可再次排入；actual ChatSession FIFO 使其不是两个 Engine 并行。R45 是明确续接拒绝被生命周期宣布 completed，不泛指任意 provider 结果。R57 的 close 后仍写是下载退役边界，R31 的 POSIX owned process 强制退役也应独立验收。R78 无 worker 与 R79 live worker/bound 非 resident 是两个冷恢复根因，不能仅改 Goal paused 标志就称恢复成功。 |
| 5 | 必补 R58；R86/P3 可随相邻权威工作修，但不阻塞 P2 | R58 合法 Session managed worktree 已通过 Session 文件权威，PTY/普通 PNG 却走一般注册根 gate；文本正常。应该引入独立 engine session authority，保留每窗口 owner、非法路径拒绝；terminal handle 不是 Core session ID。R86 是 summary 首 send 前、source main A 与当前 primary B 不同导致 B.id/A.path 元组错误；Main outside gate 正确拒绝，不能放宽此 gate。R65 只解释拒读被渲染成空树，不能作为 R86 新根因或另计。普通 blank 全 App 路径与首 send 补绑定仍是静态边界；内部 binding setter/remount 是正常控制，不是已证用户恢复按钮。 |
| 6 | 应明确 R68/R77，避免高影响 Host 故障被“其余”掩盖 | R68 是 RemoteHost 直播/设备发送绕过已有 cap；authenticated OPEN 慢 peer 的队列在 24 MiB 上限实验内增长，不等于实测 OOM/Main crash。保留健康 reader、selected-viewer cap、重认证、撤权及合法大历史分页。R77 是已初始化 dataDir 对非 root 进程失去写权限、hub 子目录仍可读/遍历/可 chmod 的真实认证锁 EACCES；同进程 /health 与 timer 约 30 秒被同步阻塞。认证锁早于 title handler，不应写已到 title mutation 或永久死锁；修权限后同稿 API 重试与短跨进程争用正常。 |

六批是交付主题，不是严格串行依赖。建议补一句可并行推进：R68/R77 的 Host 可用性工作不必等所有第五批或 P3 完成。原稿开头已明确同批不等于同根因，末段已正确区分“表征测试通过”与“已修复验收通过”，这两句应保留。平台边界应在关键行保留，不只依赖末尾笼统免责声明。

## 其余 P2 的覆盖提醒

原表显式 35 项＝1 P1 + 33 P2 + 1 P3；19 项 P2 只被第六行的“其余”覆盖：R01、R02、R06、R09、R14、R16、R17、R21、R32、R34、R46、R47、R50、R51、R53、R58、R66、R68、R77。这不是正式遗漏发现，但交接表不应被当成逐项验收清单。

建议补丁只将其中 R09/R01/R06/R58/R68/R77 明列，保留六批结构，避免一次扩写成 52 项长表。若后续工程必须压缩人力，还应单独安排以下已有 P2：

- R02/R66：显示的 CLI 权限模式与实际进程一致，降级需获确认的重开/重启，不把 metadata 改 default 当成实际撤销已有显式 bypass。R02 要 trusted cwd，R66 要并发重开/接管场景；没有新增未授权提权结论。
- R50：双 pending 麦克风启动同 renderer document 内的第一 recorder/track 退役，保留单次录音、拒权、迟到卸载控制。没有真实硬件或 Electron document 销毁后继续录音证据。
- R14/R21/R32：分别是可稍后回答的问题阻塞独立新任务、首次运行刷新后的合法输出恢复失败、新浏览器存储配额耗尽导致配对 secret 分叉。它们是继续操作/首次可用性的既有 P2，不应只按发现时间排到低频展示 P3 之后。

## 证据与产物

引用依据为主工作区既有 [README](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/README.md)、[flow-coverage](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/flow-coverage.md)，以及定向核对的 [runtime-round3](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/runtime-round3.md:40)、[R35/R36 独立反证](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/high-risk-quality-round17.md)、[Hub 重复启动](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/server-round1.md:6)、[原生回包/审批](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/desktop-round1.md:6)、[自动化](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/automation-round5.md)、[终端](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/terminal-review-round13.md:7)、[图片](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/file-navigation-round14.md)、[慢连接](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/connection-recovery-round15.md:7)、[认证锁](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/file-mutex-round19.md:18)。R86、Goal、Browser Stop 及已有修复控制延续本代理此前的专项与最终整合只读审核，不把历史运行算成新增执行。

[建议 unified diff](/tmp/codeshell-review-20261012-repair-handoff-suggested.patch) 未应用；相对链接保持目标 review 文档目录语境，不能将 /tmp 本身当链接基目录。本次只另写质量稿、建议 diff 和源快照哈希收据。没有改主报告、fixture 或交接原稿，没有启动任何产品/runtime/CLI/模型。
