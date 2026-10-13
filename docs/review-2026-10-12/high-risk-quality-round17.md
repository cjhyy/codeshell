# 第十七轮：R35 / R36 独立只读质量复核

复核时间：2026-10-12 SG 05:05。结论：**保留 R35 / P1、R36 / P2；两项不合并。正式新增发现 0，新增测试执行 0，新增 native / worker / Git 实验 0。** 未修改产品、主报告、goal，未 build / clean，未创建代理。

已读冻结 latest 的 CODESHELL.md，以及主报告 README、quality-audit、runtime-round3、resource-quality-round8、workspace-quality-round11、flow-coverage，和两份便携 fixture / 四份既有成功日志。产品比较使用 Git 对象 `84740d56e55517b004948a0a0e07649ad6fbf998` 与 `a66f4ef291f304ee4df9da8095a90671d9a8f140`；latest HEAD 是后者。主报告资料所在 checkout 当前 HEAD 为 `2ea4832a`（docs(review): record project repair and autosave failure recovery），其下列产品文件对 84740d56 无差异，未将文档 HEAD 误记为旧产品基线。

## 判断摘要

| 条目 | 建议 | 保留依据 | 必须保留的范围 |
| --- | --- | --- | --- |
| R35 | 保留 P1 | 正常 Desktop 输入能发起两个同目标请求；失败者未证明创建归属便强制删除成功者资源，真实 Git 证据包含已成功返回后的未提交文件损失 | 两个创建预检重叠；未提交文件损失还要求文件在成功与失败回滚之间写入。恢复会话工作区不恢复这些内容 |
| R36 | 保留 P2 | 真实编译 Core 在原生 Node 中写后异步 EPIPE，Socket 无 listener，Host exit 1；生产 local Hub/serve 直接使用相同 Core | 写与 worker 关闭重叠；实测 Node v25.8.1，不扩成全部 Node/OS、Docker 外层 Host 或 Electron Main 已证实退出 |

R35 是 Git 创建/回滚资源所有权缺失，R36 是进程 stdin 流错误没有被隔离。修复边界与恢复机制不同，不应合并；也没有理由把 R36 提升为已验证的数据删除或所有客户端永久不可恢复。

## R35：入口、时序、保护与恢复

1. **正式 UI 入口仍可达。** [WorkspaceIndicator.tsx:604](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:604) 的 switchTo 在 605–608 检查 session/project、sessionBusy、当前 authority；629–636 的 createNew 只再检查 sessionBusy / 非空 slug。838–846 的输入未 disabled，842 直接调用 createNew。854 确实禁用 Create 按钮，却没有在函数或输入事件处拒绝 busyAction。因此不是按下 disabled 按钮的虚构入口，也不要求跨项目或恶意 renderer。
2. **preload 与 Main 没有去重。** [project-authority-api.ts:40](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/project-authority-api.ts:40) 原样 invoke；[project-authority-ipc.ts:286](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:286) 的真实 handler 在 289–298 验证 sessionId / cwd / target 后并行 await service，307 仅在成功后广播。该 handler 与 [session-workspace-service.ts:511](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:511) 均没有同资源锁；529–542 先 list，再决定创建。live worker 的 setWorkspace 位于创建完成之后（556），不能保护先前发生的 Git 创建/失败回滚竞争。
3. **身份和目录保护存在，且不消除同 owner 的竞争。** service 的 `_cwd` 不参与根选择；518 requireKnownSession、521 mainRootFor，后者 137–151 读取持久化主根，154–241 检查项目绑定、挂载身份、目录 / Git 可用性，256–263 fail closed。300–306 拒绝未知/无有效 state 的 session。fixture 使用真实 SessionManager 的合法 legacy session 和临时仓库（脚本 172–174），没有动态验证 project-bound 根分支；project-bound 的适用性由上述真实生产保护静态衔接，不能把 fixture 宣称成完整 mounted-project / Electron 测试。
4. **真正缺口是失去所有权的 rollback。** [crud.ts:126](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/coding/src/git/worktree/crud.ts:126) 的 branch-occupied / branch-exists / path-exists 预检是正常保护，但 136–144 仍 await Git 操作，两个调用可都通过。149–154 的 add 失败同样进入 176–181 catch；[crud.ts:79](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/coding/src/git/worktree/crud.ts:79) 首先尝试 `worktree remove --force`，87 再尝试 `branch -D`。133 的 preexisted Boolean 只限制 82–83 的递归 rm fallback，不限制这两个 Git 删除操作，不能证明该调用创建了目标。这里删的是共享目标 worktree/branch，不是原始主仓库；未证明越权删除任意路径。
5. **Git barrier 是合法调度证据，不是自然频率。** 便携脚本 175–180 在所有生产预检之后的 add 进程入口同步两次调用，只延后第二次启动和其真实 Git 失败的输出/退出。没有伪造成功、错误或直接调用 cleanup。206–234 在成功 IPC 返回后写文件并确认 path/file/branch 存在，最终确认三者被移除、session 指针仍旧、仅一次成功广播。UI 部分 134–148 在第一次 Enter / React 刷新之后先确认按钮 disabled，再调用实际 Enter handler，确认为两份相同请求。两个测试分开闭环，不是完整 Electron 单次操作。
6. **正常反证限定触发。** 如果第二次在成功 branch/checkout 建立后才开始预检，[query.ts:60](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/coding/src/git/worktree/query.ts:60) 会拒绝已 checkout 分支，crud 127–128 也拒绝已有 branch，这些 throw 不进入 add 的 catch。既有 crud.test.ts:42–68 覆盖顺序重复及预存未注册目录；这里只读测试，不新增执行。普通预存目录不等于并发注册后的 checkout。普通显式 cleanup 还有 managed / other-session / dirty 检查及先 rebasing 的保护（service 628–660），但创建失败 rollback 没调用该流程。
7. **会话可恢复，内容不能靠此流程复原。** [session-manager.ts:816](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:816) 明确主根从 state.cwd 读取，独立于 workspace.root；service 525–526 可设 main，556–560 更新 owner/index/handoff。UI 主根行通过 937 / 968 映射到 `main` 并调用 switchTo；archive release 也有正式入口（workspaceArchiveRelease.ts:26–41，Main IPC 311–323；service 563–590）。这些是静态恢复依据，本轮没动态验证恢复。只要原主根仍有效、session 不忙、相应磁盘/worker 操作可写即可恢复指针并重新创建；恢复权限、重开窗口或重建 checkout 不会重建被删的未提交文件。不能将此恢复描述成找回工作内容，也不能说 session 永久无法继续。

**级别判断：维持 P1。** 条件性竞争降低发生范围，不消除普通用户操作触发破坏性删除的严重性。主报告 README:100–102 与 desktop-round3:33–34 已保留两层时序和恢复限制，无需提高级别或新增条目。表格简写宜继续由详细段落限定，不可改写成“每次重复 Enter 都会丢失文件”。修复应同时覆盖 UI 同步 in-flight gate、Main/创建操作串行与 rollback 的实际资源归属证明；只禁用按钮或关闭 rm fallback 不足。

## R36：Node Host 边界与正常恢复反证

1. **真实生产 local Hub/serve 使用被测 Core。** [code-shell-serve.ts:1](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/bin/code-shell-serve.ts:1) 为 Node 入口；[serve/cli.ts:170](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/cli.ts:170) 的 local 分支 189–204 启动 HeadlessServer 并提供真实 stdio worker 入口（resolveWorkerEntry 140–144）。[headless-server.ts:507](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:507) 直接 new WorkerBridgeCore；1170–1178 对合法请求 ensureWorker / canSend / inject，Core 350–369 再转 sendLine。Docker 分支是另一 Host/control-server 边界，本轮不扩张该影响。
2. **认证、工作区与负载限制正常。** HeadlessServer 782–793 检查 WS origin / auth或passcode；823–825 每条消息复查 Hub 登录，827–830 1MiB 上限；900–918 检查请求 ID / pending 上限；1034–1062 强制工作区；1173–1178 才写入。fixture 的约 256KiB task JSON 低于生产帧上限，不需要攻击或身份绕过。fixture 直接驱动真实 Core，未动态走完整 Hub 登录、WS 或模型；生产可达性由这条静态调用链支持。
3. **失败发生在另一对象、另一个时刻。** [worker-bridge-core.ts:197](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/worker-bridge-core.ts:197) 至 265 监听 ChildProcess error/exit、stdout/stderr，但没有 stdin Socket 的 error listener；336–340 只检查缺少/destroyed，再无 callback write 后返回 true。262–265 outbox flush 有相同边界。request 的 440–457 try/catch 与 HeadlessServer 1192–1198 Promise catch 能接同步 throw / rejected handler，接不到之后 Socket 自己发出的 error；CLI 顶层启动 Promise catch 也不是该 Socket 的 listener。没有据此把另一个流错误或 pending timeout 独立计数。
4. **既有原生证据足够而窄。** 便携 worker-pipe-close.test.ts:14–25 创建自有 worker，首次 data 后 exit 23，真实编译 Core sendLine 256KiB JSON-RPC；28–48 在 Node 记录 exit 1、EPIPE、无 survived。原/最新 log:4 都显示 `sent:true` 后 Socket Unhandled error，Node v25.8.1；不是 mock Writable 或人为 throw。它只证明原生 Node + Core 的进程退出，完整 HeadlessServer 应用退出是经静态调用链推得，不能写成已跑完整认证 Hub smoke。
5. **普通退出和 spawn 权限失败已有处理。** Core 186–193 捕获同步 spawn throw，224–239 接 ENOENT / EACCES 等 ChildProcess error、清 child/outbox、结算 opt-in pending；240–260 正常 exit 关闭 readline、清 child/outbox、按 clean/crash 回调。315–319 只结算 `settleOnExit` 的 correlated 请求，其余仍有 request 的 timeout（402）；不能泛称所有 Core pending 都立即结算。HeadlessServer 501–505 / 524–537 失败结算其 pending route、清 leases、通知 workerExit；下次合法请求 1173 ensureWorker 产生新 worker。权限恢复后满足正常 spawn 条件即可再试；R36 不等于所有 EACCES / worker exit 都杀 Host。
6. **范围中的恢复限制。** canSend 159–160 / sendLine 338 的 destroyed 检查覆盖已完成关闭，不能原子覆盖检查后关闭或大写入中关闭；发生已观察的未处理 EPIPE 时 Node Host 会退出，内存里的普通 worker-exit 恢复不能让已退出的进程复活。必须重新启动 Host（外部监督器若有可负责重启）后再连接；本轮没有证明内置 Host 自重启、自动重放任务或全部 live state 持久恢复。也没有证据说明凭据被撤销、磁盘历史被删、模型任务一定重复执行。

**级别判断：维持 P2。** 一个 worker 的生命周期失败可以跨进程隔离边界终止负责多客户端的 Node Host，影响超过单任务；但已有明确 race 条件和重启恢复，未验证数据删除，不提升 P1。runtime-round3:45、README:154 已正确限定 Node Hub/serve 且明确 Electron Main 未验证。Desktop AgentBridge 共享 Core（agent-bridge.ts:348），仍不足以承诺 Electron 主进程也退出；不需要据猜测增加 Desktop 影响。

## 两基线与证据计数

`git diff 84740d56..a66f4ef2` 确认下列根因/入口文件无差异：Coding crud.ts、Desktop WorkspaceIndicator.tsx、project-authority-ipc.ts、session-workspace-service.ts、Server worker-bridge-core.ts、serve/cli.ts、bin/code-shell-serve.ts。HeadlessServer 的差异仅增加 Panel project-scope import / 配置，未增加 stdin listener 或改变转发链；此前插入导致当前行号有偏移，本报告统一引用 latest 源码。

既有日志全部含 Completed、0 fail / skip；这里只读，不加入任何累计测试或新缺陷计数：

| 证据 | 84740 原记录 | a66f 验证记录 |
| --- | --- | --- |
| R35 | [原日志](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/reproductions/desktop-round3/worktree-duplicate-create.test.tsx.log:9)，2 tests / 15 expect | [最新日志](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/validation/latest-a66f4ef2/repro__desktop-round3__worktree-duplicate-create.test.tsx.log:9)，2 tests / 15 expect |
| R36 | [原日志](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/reproductions/runtime-round3/worker-pipe-close.test.ts.log:7)，1 test / 3 expect | [最新日志](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/validation/latest-a66f4ef2/repro__runtime-round3__worker-pipe-close.test.ts.log:7)，1 test / 3 expect |

本轮唯一写入为本文 `/tmp/codeshell-review-20261012-high-risk-quality-round17.md`。无需撤销、合并、升降级；维持已有详细限定，并建议提及 R36 的动态证据是 native Core fixture、完整生产 Host 入口为静态衔接，避免“Hub/serve 已跑整条网络退出”歧义。
