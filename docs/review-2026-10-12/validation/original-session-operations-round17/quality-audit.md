# 第十七轮 Desktop 会话/项目操作：独立只读质量审核

结论：**SO17-2 建议独立 P2，SO17-1 建议独立 P3，均可收录；本审核不分配正式编号。** 取消归档是 Desktop restore 漏写 Core durable marker，项目重命名是未消费失败结果的乐观显示；两者不合并，也不与 R39 / R24 / R69 / R60 / R70 合并。报告对真实运行、恢复、文件保留与替身边界基本准确。**审核新增执行 0**，未测试、启动进程实验、创建代理或修改产品/主报告/原脚本。

已读 CODESHELL.md、最终 `/tmp/codeshell-review-20261012-session-operations-round17/report.md`、219 行 helper、13 行 wrapper、最终及中间日志，并核对实际源码和既有发现。此时 root 已复制并完成两快照便携执行；本审核只读两份既有最终 receipts，计数见末节。

## SO17-2：取消归档漏写权威状态，P2 成立

**正式入口与状态缺口确切。** [App.tsx:2723](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2723) 和 2747 两个 restore callback 完全相同，只执行本地 archiveSession(false) 与 setSessionIndices。SettingsPage:835–840 交给 ArchivedConversationsSection；[AdvancedSections.tsx:1380](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:1380) 只按 renderer archived 过滤，1467 点击调用 callback。helper:71–77 从生产 AST 提取且校验两个 callback 文本相同，114 将实际 callback 传给真实 SettingsPage。未装完整 App，但关键 callback 不是重写替身。

**正常归档/正确恢复 primitive 形成直接反证。** Sidebar:345–347 → [useSessionNavigation.ts:239](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:239) 先 await releaseWorkspaceForArchive，再更新目录；workspaceArchiveRelease.ts:32–41 使用 canonical engineSessionId 后调用 setSessionArchived。preload:969–970 → [Main index.ts:6742](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6742) 真实 callback 校验 ID / boolean，写 archiveDiskSession 并刷新 CwdIndex；sessions-service.ts:458–479 → SessionManager:1158 使用字段级 CAS 更新，不是全 state 覆盖。

helper:153–174 动态验证实际 Sidebar 归档，Core archivedAt 为 number、真实 desktop catalog archived=true；Settings 取消后 catalog=false、归档列表消失、重挂 Sidebar live 行出现，但没有 Main false 调用，Core archivedAt 和默认磁盘目录过滤保持。使用真实 UI 别名 U→engine S，验证没有误用 UI ID。177–181 直接调用真实 navigation false 控制，Main 清 marker、listDiskSessions / sessionMainRoots 恢复、同 Main removeRoot 拒绝。该 false 调用是服务/handler 正向控制，不是点击可见 Desktop 恢复按钮，报告明确这一点。

**正式文件夹移除链也成立，安全门禁本身正确。** [ProjectStore.ts:189](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:189) 的 sessionMainRoots 在 195 跳过 durable archived；306–322 的 removeRoot 同样仅保护 unarchived bindings，326–327 仍禁止 primary/唯一 root。Sidebar 内实际 ProjectFoldersDialog:590–607 查询 usage，711–720 走 confirm 再调用 removeRoot。helper:183–200 再次复现状态分裂，实际编辑文件夹 UI 不显示 binding 计数，实际移除确认/Main/Store 成功，旧 durable binding 不变；随后实际 [resolveRunProjectSync:649](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:649) 找不到旧 root，在 662 正确拒绝 root_removed。AgentBridge:664–677 生产 run metadata 确实使用这个 resolver；该最终接线是静态核对，未执行后续 worker/send/run。

这是正常无存储故障恢复流程中的持久状态不一致，还会让仍显示 live 的会话错失根使用保护，超过仅一次多余确认的 P3 摩擦，P2 合理。移除仍需要用户显式确认，不是自动删目录、越权操作或 root gate 漏校验；修复应补恢复 writer，不应弱化 Main 权威检查。

## 自动清 marker 与恢复限制

全 packages 生产源码 archivedAt 检索未见 Engine.run / renderer 打开会话显式自动取消归档。进一步静态核对：[Engine.ts:1657](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/engine.ts:1657) 调 openRunSession，run-session-open.ts:88–92 对已有 session 用 resumeForRun，245 调 startSessionRun；[SessionManager.ts:1629](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:1629) 读取 latest，仅合入 runId/clientMessageId/status/lastCompletionKind/turnSeq，未清 archivedAt。updateSessionState:1584–1603 和 runtime saveStateOrUpdateFields:1870–1884 也是合并所拥有字段，而非用缺少 archivedAt 的运行对象覆盖整份 state。这个静态反证支持“没有找到普通 run 自动修复”的表述；没有新增实际 run，不把所有 provider/worker 运行后的标记状态写成动态实测。

正确 navigation/Main restore 已动态证明可以清 marker、恢复默认目录和同 root guard，但当前 Desktop 可见 Settings restore 本身仍缺 writer。Sidebar live 过滤在 976 只显示 !archived；即使其菜单有 archived false 分支，也不能把被过滤掉的归档行当真实可点恢复入口。SessionsView 是重命名/删除页，没有 restore 按钮。不能承诺“再次取消归档”或“只重开 Sidebar”能修 Core；fixture 正好证明重挂仍有分离。

既有 R39 的配对 Web PATCH restore 确实清 Core marker（files-round4.md:16–18）；这是可参考的已有正式途径，但本轮没有重跑 HTTP/Web，不能计成本轮恢复 UI 控制。root 被移除之后，单清 archivedAt 不重建 mount/绑定；需要再走合法 root 注册/会话修复，完整 UI workaround 尚未动态闭环。

helper:200 明确读取原始持久消息仍为 `durable round17 conversation`；ProjectStore.removeRoot 仅修改 registry roots，没有物理目录删除。没有历史/文件损失证据，也没有实际聊天发送失败实验。分级依据是 durable restore 未完成和已动态闭环的 root guard 状态失配，而不是臆造数据丢失。

## 去重

- **R39**：Web 恢复已清 archivedAt，问题是随后导航被 busy guard 多问一次；本项 Desktop Settings 根本未调用权威 restore，平台/状态/修复点不同。
- **R24**：整个项目先 tombstone，冷 worktree release 失败；本项项目始终 live、无 worktree，仅漏清会话 marker 后允许健康 secondary 的显式移除。
- **R69**：仍挂载但物理 missing 的旧 root 使迁移到健康 root 被全 roots 校验阻断；本项物理 root 健康，因恢复状态缺口而被显式移除 mount。迁移校验修复不补 Settings restore writer。
- 不借自动化 picker 人工塞入 archived row 推演影响；默认 listDiskSessions 已过滤。R55/R61 导航竞争、R60 删除 tombstone 未参与这条复现。

## SO17-1：项目 rename 拒写仍显示新名，P3 成立

实际 Sidebar:270–277 prompt 返回非空输入后调用 navigation；[useSessionNavigation.ts:174](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:174) 先本地 displayName 更新，再 void projectRegistry.rename，没有 await/catch/回滚。App:2203 接真实 handleRenameProject。Main project-authority-ipc.ts:165–168 等 Store.rename 成功后才广播；ProjectStore:487–499 正常验证 live project/name 并实际提交。

helper:134–149 使用真实组件/prompt/hook/Main registration/Store，chmod 自有 registryDir=0500 造成真实 EACCES；磁盘旧名与无成功广播是正确服务结果，UI 乐观新名和无 role=alert/错误文字来自未消费失败。监听 unhandledRejection 是 fixture 记录与继续控制的方式，不代表 Electron 崩溃或白屏，报告没有扩张该影响。

恢复权限后通过真实 setPinned 成功广播，useProjectRegistrySync:32–44 / 93 以 Main 权威 snapshot 覆盖投影，UI 回旧名；再次正式 prompt rename 成功。取消 prompt、未知项目拒绝且 registry bytes 不变也有控制。P3 合理：窄存储失败、名称未持久化却误示成功，能重试，无路径/稳定 ID/历史删除。它与 R60 删除先 tombstone 或 R70 debounce 消耗失败稿的根因不同；可以单列，不因都涉及写失败就合并。

正常 SessionsView title 拒写控制在 helper:204–214：保留 draft、显示错误、不通知成功，恢复权限同稿重试成功。这验证另一个正式 UI 的可恢复契约，不证明项目 rename 已具有相同保护。正常广播回权威旧名是同步恢复，不能另列迟到 promise 覆盖导航问题。

## 隔离、清理、便携性与最终计数

helper:8–14 在 Core/Host import 前要求 guarded 非 root HOME，装 exact dummy loopback HTTP/fetch guard 与 net/tls deny；实际读写/chmod 都是 guarded HOME/round17-owned。ProjectStore:81 的 resolveProjectRoot 恒等适配器避免真实 Git discovery；Main/Store/CwdIndex/marker mutation 和 mounted root 身份机制实际运行。workspace release、目录探测、git status 和 window.codeshell 是边界替身；无 Electron/native IPC、worker、模型、真实 picker。AST VM 有受控依赖，不等于启动完整 Main/App。

helper:216–219 恢复 chmod、unmount、dispose persistence、reset project snapshot、删 owned 数据；wrapper:6–10 只拥有一个 Bun child，设 16s kill 并等待 exited、收集 stdout/stderr。guard/provider/global monkeypatch 随 owned helper 进程结束，不宣称同进程全部还原。fixture setup 的所有失败分支并非独立回收测试；此前三个 selector/MiniDOM harness 失败已单列，不混作产品缺陷。

最终只读证据：

- [原快照 wrapper 日志](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/reproductions/session-operations-round17/session-operations.test.ts.log)：1 test / 2 Bun expect / 0 fail / skip / Completed；[helper 日志](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/reproductions/session-operations-round17/session-operations.fixture.log)：PASS / **91** 手工 assertions。
- [最新快照 wrapper 日志](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/review-2026-10-12/reproductions/session-operations-round17/session-operations.test.ts.log)：同样 1 / 2 / Completed；[helper 日志](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/review-2026-10-12/reproductions/session-operations-round17/session-operations.fixture.log)：PASS / **91** 手工 assertions。

91 是独立 helper 的 node:assert 手工计数，不能加为 Bun expect、测试数或第三个 fixture。原 tmp 最新日志同为 91，早先 71 / 85 和 initial/second/third 诊断不重复累计。root 初始任务里的 90 已被最终增加 root_removed assertion 的 91 版取代。root 已补两基线执行，不再局限为“仅 latest 已运行”；代理原 report.md 的“本代理仅 a66f”可保留其归属限定，整轮最终汇总应引用两份 receipts。审核没有执行任何测试，新增执行严格 0。
