# 第十三轮：Desktop 会话删除、重命名、归档与迟到状态

> 主报告收束：本附录候选 W23 正式编号为 **R60 / W23 / P3**。root 已将便携脚本复制到报告目录，并在 84740 与 a66f 两基线分别 guarded 复跑成功。下文“仅 latest”描述的是代理首次实验范围，不能用来覆盖这次补充验证。


审查基线：`a66f4ef291f304ee4df9da8095a90671d9a8f140`（0.9.33）。开始前阅读 `CODESHELL.md`、主报告 R01–R57、`progress.md` 和 `flow-coverage.md`。产品、主报告和目标均未修改，无 build/clean、无 Electron/原生 worker 实验。

本轮确认 **1 个新问题，建议 P3，暂称 W23**；另外验证 3 条正常恢复/身份保护路径。所有路径均为真实 React 组件或生产 hook + 实际持久服务；MiniDOM 不等同实际浏览器/Electron。最终原始日志总计另见下方。

## W23 / P3：侧栏删除失败仍永久移除 catalog 行，且只写日志，失去原位置的重试入口

**主要位置：** `packages/desktop/src/renderer/app/useSessionNavigation.ts:255–303`，尤其 `259` 和 `285–290`。先调用 `deleteSessionLocal`，持久化本地删除，再异步调用 Main；失败仅 `window.codeshell.log`，没有错误通知、回滚或保留待删行。

**真实入口与调用链：**

- `Sidebar.tsx:317–359`：会话右键菜单的删除项打开实际确认框；确认后传入闭包捕获的 `projectId` / `s.id`。
- `App.tsx:1300–1317,2223–2226`：实际接线是 `useSessionNavigation(...).handleDeleteSession`。
- `transcripts.ts:890–903`：立即从索引移除目标、将 active 清为 null，并 `clearTranscript`；`775–778` 将 renderer snapshot 的 null 写入 persistence。
- `sessionPersistence.ts:270–275,334–347`：本地删除 diff 被作为持久 patch 自动提交。
- `session-catalog-store.ts:138–153`：删除 ID 放入永久 tombstone，后续同 ID upsert 被忽略。
- `session-transcript-cache.ts:109–119`：renderer snapshot 删除也有 tombstone，阻止迟到保存恢复它。
- `preload/index.ts:971` → `main/index.ts:6787–6789` → `deleteDesktopSession:6748–6785`。Main 先等待 `bridge.closeSession:6759`，再 `await deleteSession:6767`；没有吞掉该服务异常。
- `packages/server/src/sessions-service.ts:124–143` 的真实 `fs.rm` 可拒绝；如 owned 会话目录不可写，当前 fixture 得到实际 `EACCES`。

**可复现操作时序：**

1. 用实际 `SessionManager.create` / `appendMessage` / `updateSessionState` 创建已完成普通 Desktop 会话 A，完整 Core state 与两条消息可独立 resume；通过实际 `SessionCatalogStore` / `SessionTranscriptCache` / `SessionPersistence` 建立当前 active 的侧栏 A 和 renderer snapshot。
2. 挂载实际 `Sidebar`、`DialogProvider`、`ToastProvider`、`useSessionIndices` 和 `useSessionNavigation`。调用实际行的右键处理器，点击实际菜单删除项，实际确认对话框出现；确认前删除 IPC 未调用。
3. 将测试自有 A 目录及其 sessions 父目录临时改为 `0500`，因此原始文件未被删除；确认删除。`window.codeshell.deleteSession` 接到真实 `deleteSessionDir(id, ownedRoot)` 服务，发生真实 EACCES。此桥替身只代替 Electron transport，Main 的 `await` 异常传播另作静态接线核对，不宣称完整 native Desktop 删除实测。
4. 生产 hook 捕获该错误并只记 `session.delete.session.failed`。界面 A 行消失，未显示 EACCES/删除失败；实际 Main catalog 为 0 行并永久记录 A tombstone，实际 renderer snapshot 读回 null。
5. 独立 `new SessionManager(...).resume(A)` 仍读回原两条 Core 消息；实际 `listDiskSessions` 仍列 A。但对同 project/key 的正常 `upsertImportedSession` 重建，实际 catalog 忽略它，flush 完成后仍 0 行。

**影响与恢复：**用户确认的是删除；实际删除失败，界面却表现为已删除，并失去该侧栏行的可见重试入口。持久 tombstone 使同键的普通 disk 重建也不能稳定恢复它。Core 权威 state/transcript 在这个可复现故障里保留，**不是历史文件丢失**。实际 SessionsView 仍能从 Core 目录列出 A；修复目录权限后，到该历史管理页再次删除可完成原操作。本轮已实际验证该恢复。没有声称 SessionsView 提供打开原会话或撤销 catalog tombstone 的入口。

**正常对照：**从实际 `SessionsView` 发起同一真实文件系统故障，`SessionsView.tsx:158–175,451–469` 保留行，展示真实 EACCES，并提供原 ID 重试按钮；在 success 之前不调用 `onSessionDeleted`，实际 catalog 行和 renderer snapshot 均保留。恢复 owned 权限后点击实际重试，删除完成、成功回调只报 A 一次。

**修复建议：**侧栏可沿用 SessionsView 的顺序：先显示目标的 pending-delete 状态，Main 删除成功后才提交 catalog/snapshot tombstone 和清理 renderer 状态；失败保留行、展示错误并允许同 ID 重试。永久 tombstone 不能在后端接受删除前作为乐观 UI 标记使用。

**信心与限制：**高。生产 UI、确认框、hook、catalog/cache 与真实 fs 拒绝均验证；Main IPC/close/cleanup 的完整 Electron 原生生命周期只静态追踪。fixture 无活动运行，不依赖 worker/模型。此根因不同于 R57 的 Core orphaned 下载过滤、R24 的项目 tombstone/worktree 时序、R39 的恢复导航 busy，以及 R55 的迟到打开覆盖新选择。建议 P3 是因为有历史管理页继续删除入口，且没有在该故障中损坏 Core 历史。

## 正常保护：新增 0 的路径

1. **SessionsView 删除失败保留并重试。** 如 W23 对照所述，失败不发布删除成功，也不先写永久 tombstone。
2. **历史页迟到重命名保持原身份。** 实际 SessionsView 对 A 提交标题，真实 `createSessionTitlesStore` 完成写入后控制 IPC 回包等待；随后离开历史页并通过真实 `handleSelectSession` 选择 B。释放旧回包后，实际 `useSessionHistorySync.onSessionRenamed` 用最新 indices 更新 A，B 的选择、标题及未发草稿保留，Main catalog 的 active 也为 B。`SessionsView.tsx:123–138` 冻结 id/draft；成功通知在 mounted 检查之前发送；`useSessionHistorySync.ts:41–64` 通过 latest ref 更新目标。没有把卸载后成功同步误报为错误。
3. **归档 A 的等待不会改成 B，也不覆盖较新 B 修改。** 真实 `handleArchiveSession(A,true)` 控制 workspace-release await；期间选择 B 并重命名 B。释放等待后，真实 `archiveDiskSession` / Core `setSessionArchived` 只设置 A 的 durable marker，catalog 从最新 index 读取，B 仍 active 且保留新标题；再恢复 A，B 仍 active。`useSessionNavigation.ts:239–252` 捕获 A 的 id，await 后 `archiveSession` 用 `loadSessionIndex` 最新值；`transcripts.ts:975–993` 只在归档对象恰好仍 active 时清 active。

额外静态反证：SessionsView 初次/刷新读用 `readVersion` 和 mounted guard（51–80）；编辑期间禁用刷新/其他行操作（244,413,424）；同步 `savingRef` / `deletingRef` 防同一 mounted 页重复 Enter/点击（121–130,158–160）；失败 draft 保留并定向错误（141–150）。侧栏菜单/确认闭包捕获具体目标（Sidebar 325–330,352–358），没有使用完成时 activeSessionId 作为删除/重命名目标。归档前的实际 durable setArchived 接线存在于 `workspaceArchiveRelease.ts:26–42`，未将归档误当成纯 UI 字段操作。

## 可便携复现与原始日志

证据目录 `/tmp/codeshell-review-20261012-session-actions-round13/`：

- `session-delete-recovery.test.tsx`：4 个测试，W23 与 3 个正常对照，`const repo = process.cwd()` 动态定位源码。
- `session-delete-recovery.log`：guarded runner 完整原始输出。最终 **4 pass / 0 fail / 0 skip / 71 expect**（运行时长以原始日志为准）。

从任一审查基线 checkout 根目录运行：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-session-actions-round13/session-delete-recovery.test.tsx
```

`/tmp` fixture 目录的 `node_modules` 为 latest 审查快照根依赖 symlink；复制到报告 reproductions 时复用该目录已有依赖解析方式即可。需要非 root 用户执行真实权限拒写实验（当前 UID=501，fixture 会断言）；不使用用户数据。fixture 只修改自有临时目录权限并在 finally/afterEach 恢复。

在任何 Core/持久服务导入之前已拒绝 fetch、http/https request/get、net connect/createConnection、tls connect；assert `CODE_SHELL_TEST_HOME` 和 guarded HOME。没有使用外网、第三方代码、付费提供方、真实账户或硬件。它是进程内调用守卫，不是 OS 网络沙箱。MiniDOM 补齐了 select、animation-frame、viewport 和弹出菜单尺寸；未替换 Sidebar、确认菜单、历史页、业务 hooks 或持久服务。

相关主要源码从 `84740d56..a66f4ef2` 的 diff 为空（Sidebar、Navigation、SessionsView、HistorySync、transcripts、catalog/cache 与 server sessions service）；不依赖 0.9.33 新 API。本轮仅在 latest 实际运行，旧基线待 root 便携复跑，不把源码相同写成已运行证明。git 产品工作区未改，现有 `?? docs/review-2026-10-12/` 为 root 所有。
