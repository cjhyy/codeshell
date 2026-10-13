# 第十三轮独立复核：W23 侧栏删除失败

**建议保留 P3。** 实际侧栏确认入口会先持久删除目录行与 renderer cache，之后才请求 Main 删除；Main 失败只进入日志，正常同键重建不能撤销墓碑。用户在原侧栏失去目标行及定向重试入口。原 fixture 同时证实 Core 两条消息仍在，并可从正式 SessionsView 在故障修复后继续删除，故不能写历史损坏、全部恢复入口丢失或不可恢复。与 R24 不重复。

独立复核仅阅读 `/tmp/codeshell-review-20261012-session-actions-round13.md`、原脚本/成功日志及冻结快照 `a66f4ef291f304ee4df9da8095a90671d9a8f140` 源码；**没有新运行测试、修改目录权限、调用 Main、运行原生进程或构建**。原日志是 **4 pass / 71 assertions / 0 fail / 0 skip**，本审计不把它计作自己新执行的测试。

## 生产入口和错误传播成立

- [Sidebar.tsx:317](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:317) 的真实会话菜单，在 [352](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:352) 打开 destructive confirm，确认后才以闭包捕获的 projectId / s.id 调用删除。App [1300](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1300) 使用生产 navigation hook，[2226](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2226) 把该 handler 传入 Sidebar。不是绕过确认的调用。
- [useSessionNavigation.ts:255](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:255) 在 backend 请求前调用 `deleteSessionLocal` 并移除 panel 状态；[285](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:285) 捕获 Main 拒绝后仅调用 log，没有 rollback / toast / pending 行。普通已绑定会话的 [sessionDeletionPlan.ts:30](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionDeletionPlan.ts:30) 选择 engineSessionId，原用例的 id 与 engineSessionId 都为 delete-A，因此不是自动化 UI ID/引擎 ID 错配。
- [preload/index.ts:971](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:971) 返回 `sessions:delete` invoke promise；Main [index.ts:6787](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6787) await `deleteDesktopSession`。后者 [6759](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6759) 等 closeSession，[6767](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6767) await deleteSession，没有捕获此文件删除错误；server [sessions-service.ts:124](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/sessions-service.ts:124) 的 `fs.rm` 在安全 ID、已存在目录上可真实拒绝。`force:true` 只使不存在目标不报错，原日志已经实证本目录 EACCES 没有被吞掉。

因此“生产 Main 拒绝会传回此 hook”有静态证据；**完整 Electron/bridge.closeSession 生命周期仍未实测**。原 fixture 的 deleteSession 适配器直接调用真实 server 删除服务，没有执行前置 Main 资源清理；不应把这 4/71 描述成完整 Desktop Main 删除测试，也不能据它判定所有资源均保持原状。普通完成会话且 owned sessions 目录不可写，是原实验实际验证的限定条件。

## 墓碑与重建：永久限定到同 project key / row id

[transcripts.ts:890](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/transcripts.ts:890) 把行从 index 移除、清当前选择并清 renderer transcript；[sessionPersistence.ts:270](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionPersistence.ts:270) 立即排入删除 diff，自动 writer [334](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionPersistence.ts:334) 不等待后端删除结果。Main catalog [session-catalog-store.ts:138](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-store.ts:138) 将 ID 加入 durable tombstone，并在后续 upsert 前过滤该 ID；不存在普通删除 patch 的撤销接口。cache [session-transcript-cache.ts:109](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-transcript-cache.ts:109) 同样写 deleted tombstone，[64](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-transcript-cache.ts:64) 拦截迟到写入。这些反复活保护本身正确，侧栏提前发布它们是问题。

原测试在真实权限拒绝之后 flush，读取实际 catalog 文件确认墓碑，调用实际 [upsertImportedSession:952](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/transcripts.ts:952)，再次 flush 后同键仍 0 行。这足以证明 **同 project key / local row id 的普通导入不能持久恢复**；不要求记录“全局永远不可恢复”。生产正常 disk hydration [useAutomationSessionImport.ts:121](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useAutomationSessionImport.ts:121) 也用 `upsertImportedSession`，Main 墓碑过滤是最终保护。没有证据排除更换 project key/新 UI ID、手工修目录状态或未来专门 restore 机制，因此不能把永久措辞扩大到所有身份或 Core 文件。

恢复时 Core 文件无需依赖 renderer cache：原实际 `new SessionManager(...).resume` 读回两条 Core 消息，`listDiskSessions` 仍列出 delete-A。cache 为空不代表 canonical transcript 被删除；原 UI snapshot 的文本和 Core 文本刻意不同，本实验没有量化 renderer-only 状态丢失，不能据此额外报草稿或独有内容损失。

## SessionsView 确有继续删除入口，不能写成无恢复

正式 [PageRegistry.ts:182](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/pages/PageRegistry.ts:182) 注册 sessions 页面，App [2294](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2294) 传入历史变更回调。该页面 [SessionsView.tsx:51](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessions/SessionsView.tsx:51) 从 Main `listSessions` 而非侧栏 catalog 读取，所以被侧栏墓碑过滤的 Core 会话仍可出现。

[SessionsView.tsx:158](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessions/SessionsView.tsx:158) 先 await backend 删除，成功后才通知 `onSessionDeleted` 并移除行；拒绝时保留行，具体目标错误展示与 retry button 在 [451](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessions/SessionsView.tsx:451)。失败不会提前调用 [useSessionHistorySync.ts:66](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionHistorySync.ts:66) 的 catalog/cache 清理。原 fixture 第一项在权限恢复后实际挂载 SessionsView，再次删除成功；第二项从历史页直接触发同种失败，错误可见、行/cache/catalog 保留，原 ID 重试成功。两项正常恢复与差异均有执行证据。

该页提供的是重命名/删除/创建新会话，未发现打开目标旧会话或撤销目录墓碑的入口。可以写“到会话管理页继续完成删除”，不能写“到该页恢复原侧栏会话”。重新启动或普通同键导入不会自动清除已写入的 catalog tombstone。

## 去重、分级和最小修复

| 既有项 | 与 W23 的差异 |
| --- | --- |
| R24 | 先移除 project 权威导致 cold session worktree 释放失败，随后归档；project 恢复后处理旧 owner 可恢复。W23 是单会话文件删除失败仍提前提交目录/cache 墓碑，不需要项目移除、worktree 或 cold/resident 差异。 |
| R57 | Core closeSession / killAll 过滤恢复 orphaned shell，成功 ACK 后仍下载。W23 原 fixture 无 worker 或下载，backend 明确拒绝；错误没有反馈才是假完成体验。 |
| R39 / R55 | 分别是恢复归档后的 busy 误判、迟到打开覆盖新选择；都不涉及失败删除的永久目录提交。 |

建议 P3：文件权限拒绝属于受限故障，UI 原位置丢重试且错误不可见，但 canonical 历史保留，正式管理页可继续删除。不要升为永久数据丢失或后台资源泄漏问题。推荐标题“侧栏删除后端失败仍提交目录墓碑，原位置不再提供错误或重试”，将永久性放入同键限定描述。

最小修复是等待 Main 成功再提交 catalog/cache tombstone，期间以可撤销 pending 状态显示；失败保留行并显示目标错误，允许同 ID 重试。沿用 SessionsView 的成功后通知约定，不应移除墓碑或允许任意迟到 upsert 复活删除。若保留乐观隐藏，仍必须保留独立待删记录与失败恢复，不以 permanent tombstone 代替临时状态。

原证据可选择复制：

- [session-delete-recovery.test.tsx](/tmp/codeshell-review-20261012-session-actions-round13/session-delete-recovery.test.tsx)
- [session-delete-recovery.log](/tmp/codeshell-review-20261012-session-actions-round13/session-delete-recovery.log)
- [专项报告](/tmp/codeshell-review-20261012-session-actions-round13.md)

原脚本 guard 在所有 Core / 业务动态导入前阻断 fetch/http(s)/net/tls，并要求 guarded HOME，真实 EACCES 只来自自有临时目录；测试需非 root UID。本文只核对该证据，不重跑。原脚本未走真实 Electron transport 或 Main 前置 cleanup 的限制必须随证据保存。
