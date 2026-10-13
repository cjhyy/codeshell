# 第十六轮：项目目录消失与会话主目录修复

冻结快照 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，只改本任务 `/tmp` 证据，没有产品修改、build/clean、真实模型、CLI、worker、Electron 或外部账号/服务。已读 CODESHELL.md、主报告 R01–R68 与工作区/终端附录。暂确认 **PR16-1/P2 候选**，等待独立质量复核和正式编号。

## PR16-1 / 建议 P2：原目录实际缺失时，修复到健康目录仍被旧目录校验挡住

核心位置：[project-store.ts:367](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:367) 在准备迁移 commit 时，无条件构造全项目 `workspaceContext`；[同文件:886](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:886) 遍历所有已登记 roots 并调用 `requireMountedProjectRoot`。这包含此次要离开的、已物理缺失的原主目录。

触发流程：项目有健康 primary A 与 secondary B，会话绑定 B；B 因外部重命名或离线挂载而不再存在原路径。真实 Sidebar 显示 `dir_missing`，并在 [Sidebar.tsx:1079](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:1079) 选择已登记的 A 为修复目标，[Sidebar.tsx:1111](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:1111) 的正式按钮只向 Main 发送精确 sessionId 与 targetRootId。真实 [project-authority-ipc.ts:107](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:107) 再由 durable session 解析所属项目并调用迁移服务。

目标 A 本身通过 [project-store.ts:358](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:358) 挂载校验、属于同项目；失败来自随后全 roots 校验中的 B。Sidebar catch 正确显示错误 toast，不是静默失败；但是页面提供的修复无法完成。该错误在 owner 分支之前发生，不依赖 worker、传输故障、并发、真实模型或错误目标。

不能直接在项目目录管理中删除仍被该活跃会话绑定的 B：[project-store.ts:316](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:316) 检查 live session 主目录并拒绝删除。于是“从缺失目录迁到可用目录”的常规修复路径要求先恢复本来需要摆脱的旧路径，或执行额外归档/移除/恢复步骤。

建议 P2 的依据是明确提供的缺失目录修复流程在正常 target 下仍无法继续，而不是单纯错误标签。没有观察到会话 state、索引、聊天历史或原目录文件被这次失败删除；Main 失败前未写迁移状态，也未发成功 workspace 广播。

## 实际组件/Main/磁盘复现

[root-repair.test.tsx](/tmp/codeshell-review-20261012-project-recovery-round16/root-repair.test.tsx) 与 [最终日志](/tmp/codeshell-review-20261012-project-recovery-round16/root-repair.test.log)：**3 tests / 27 Bun expect / 0 fail/skip**，有完整 `Completed Bun shard`。

- 实际完整 `ProjectGroup`、`useVisibleSessionWorkspaces`、I18nProvider、ToastProvider 在 MiniDOM 挂载；调用真实 repair button 的 handler，没有复制候选判断、手改 authority 或伪造 Main 错误。
- 实际 `registerProjectAuthorityIpc` 注册 handler，实际 ProjectStore、SessionCwdIndex、Core SessionManager 和 session-workspace-service。只读/写自有临时项目与隔离 HOME；两个自有目录初始化为本地 Git 仓库，未调用远程 Git。
- `renameSync(B, parked)` 造成真实旧路径 ENOENT，保留原目录。实际 workspace authority 返回 `dir_missing`，UI 显示修复，target 为健康 primary A。按钮抵达 Main 后因旧 B 抛错；state.json 字节不变、索引仍绑定 B、没有成功广播，error toast 包含 dir_missing/旧路径。实际 removeRoot 同时拒绝活跃绑定。
- 恢复原目录到 B 后，再点同一个真实按钮：实际 Main/service 迁移到 A，durable cwd/project/mainRootId/workspace 与索引均同步，发出 `workspace:changed`。没有把界面自身强制设成迁移成功。

替身边界：MiniDOM 不是 native Electron，window.codeshell 是分派到真实 Main registration 的本地接口桥，未执行 actual preload/IPC transport 或完整 Main bootstrap。`getBridge` 为 undefined，所以动态只跑 cold/no-worker durable 迁移；错误在 `options.owner` 之前发生是源码事实，不把 resident worker 分支算实测。project/session Git branch 展示用本地返回值替身；没测试真实 Git branch UI、原生文件选择器、TrustGate 或网络卷。

## 正常保护、恢复和边界

1. **原路径恢复 + 正式按钮重试**：上述第一用例实际执行成功。若目录只是外部移动或临时离线，可恢复原路径后再迁移；不能声称必须应用重启或永远无法恢复。
2. **正常健康迁移**：第二用例执行真实 Main/service 成功；迁移后原 secondary 不再被活跃会话绑定，可通过真实 removeRoot 删除登记。
3. **正确拒绝非法目标/替换**：未知 targetRootId 拒绝，state 不变；把原 B 改为指向 A 的真实符号链接，迁移仍因 `root_replaced` 拒绝，恢复原 direct directory 后才成功。此处验证现有防护，不把安全拒绝本身当漏洞，也不建议忽略 symlink/归属检查。
4. **不恢复旧路径的 service 级 workaround**：第三用例在 B 仍缺失时，用实际 Core `setSessionArchived` 归档该 owner，经实际 Main `removeRoot` 移除坏 secondary，再实际 Core 恢复 owner；此时 authority 为 root_removed，Main migrate 到 A 成功且回到 rootStatus=ok。**没有完整点击 Desktop 的归档、目录管理、历史恢复 UI**；这些入口存在，接线只读核对，不能把组合服务步骤冒充完整 UI 验收。归档前 renderer 的 workspace release 允许错误日志后继续归档，见 [workspaceArchiveRelease.ts:36](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/workspaceArchiveRelease.ts:36)。
5. **scope**：fixture 是两根项目、缺失的原 secondary、本地普通 session、cold Main，目标 healthy primary。未测试真实媒体卷断连、Windows、worktree 用户文件、迁移中的活跃工具/模型或完整重启。不能据此声称所有文件夹修改都失败或有历史丢失。

## 去重与修复方向

与 R22 的 Panel secondary root 归属判断、R23 的 Panel 批量 all-or-nothing/IPC上限、R24 移除项目先 tombstone 后释放 worktree，以及 R58 managed worktree 的 renderer 根门禁不同。此处修复按钮已进入正确项目和健康 target 的专用迁移后端，错误是构造迁移 workspaceContext 时重新要求将被离开的坏 root 有效。修上述 Panel/终端或移除项目的路径不会修复此处。全 roots 发送前校验的其他可用性影响本轮不拆成第二项，也不扩展为已证实的越权。

应为修复迁移建立明确的可用根集合与失效根处理规则，保留精确项目/session/target 身份、健康 target 挂载验证以及 owner fence。不能仅删除全部 root 校验，把失效或符号链接路径继续交给 worker；若必须先安全卸载失效挂载，应让修复流程完成这一步并保留 provenance，而不是让“修复”重新要求坏源根可用。现有 `root_removed` 路径可以成功，不能把它与 `dir_missing` 混同。

## 隔离与执行

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-project-recovery-round16/root-repair.test.tsx
```

脚本入口检查 guarded HOME；Core/Host 动态导入之前安装 exact-origin `http://127.0.0.1:9` HTTP/fetch guard，且拒绝 direct net/tls；没有请求该 origin。仅 Git init 运行自有本地 subprocess，guard不是OS confinement，不宣称任意子进程网络隔离。afterEach 卸载实际组件/Toast定时器，清测试注入，删自有临时目录；没有外部 listener、模型/worker 子进程或用户账号操作。

首份 `root-repair.harness-failed.log` 是错误地在组件 container 中查找位于 portal/document.body 的 Toast，并且 MiniDOM 文本 helper 没读取 element.textContent；原错误已从实际 Main 返回，不是产品错误的替身。修复测试断言后 2/20 通过保存在 initial-pass，增加 service workaround 后最终 3/27；开发重跑不累计。四个关键产品文件在84740..a66f的diff为空，但当前原始动态只跑a66f，旧基线便携复核待主审另记。
