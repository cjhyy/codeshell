# Desktop review round 2 — baseline 84740d56

Review snapshot: `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`.
Read-only product review; fixtures and logs are temporary. No paid providers, user services or user HOME were used. Each test ran through the project guarded shard runner.

## D8 [P2] A valid secondary-root Session cannot open its project's installed Panel Apps

- Root cause: `packages/desktop/src/main/panel-app-bridge.ts:983–985`.
- Supporting path: `packages/desktop/src/renderer/app/SessionPanelDock.tsx:185` passes the project's primary path; `PanelArea.tsx` obtains `cwd` from the persisted Session workspace; `PanelAppHost.tsx:113–114` turns the bind rejection into a load failure. `packages/core/src/panel-apps/bindings.ts:40–63` only maps Git worktrees to their Git main checkout and does not resolve V2 project membership across independent roots.
- Trigger: create a project with primary root A and unrelated secondary root B, bind any installed Panel to A, then migrate an existing conversation's main root to B using the supported project-root UI. The conversation authority remains valid (`rootStatus=ok`, same project id), but every installed Panel receives `projectPath=A, cwd=B`. The Host rejects that valid same-project context as a different project.
- Impact: Panel webview is replaced by “Panel App failed to load: Panel App workspace does not belong to its bound project”. Retrying repeats the failure. Multi-root chat/files can continue, but installed Panels are unusable for conversations assigned to secondary roots.
- Verification: `panel-multiroot.test.tsx` uses actual ProjectStore and SessionManager to create and migrate a Session, verifies actual workspace authority, executes the production `bindGuest` AST method with real filesystem roots (the existing repository bridge-test strategy), and mounts actual PanelAppHost to verify failure rendering and webview unmount. Same-project primary-root control succeeds. Final log: `panel-multiroot.test.tsx.log` — 1 pass, 0 fail, 8 assertions.
- Confidence: high. Existing repository `session-workspace-service.test.ts` independently establishes that changing a project's primary root preserves older conversations' original roots, which can produce the same mismatched pair when a Panel is bound on the new primary.
- Suggested correction direction: resolve and validate the Session's current root against Main's V2 project authority when authorizing the Panel context. Keep installed-package/storage scope explicit; do not simply permit arbitrary cwd.

## D9 [P2] One unavailable tracked project clears installed Panels in every healthy project

- Root cause: `packages/desktop/src/main/project-panel-ipc.ts:133–146`, particularly `Promise.all` at 142–144; renderer `packages/desktop/src/renderer/App.tsx:588–599`.
- Trigger: keep healthy project A with a bound Panel, and another tracked project B on a detached external drive or a moved/deleted directory. App submits all tracked primary paths as one discovery request. `requireRendererProjectPath(B)` rejects, so no healthy project is discovered. App's catch calls `replacePanelApps([], projectPath)`, removing all installed Panel entries from the global renderer registry.
- Impact: A's installed Panels vanish from its dock and launcher, despite A and its Panel being valid. App does not expose the batch error, so users cannot identify the unrelated broken project responsible. Removing B or restoring its directory is required before an ordinary refresh can recover A's Panels.
- Additional reproducible manifestation: 65 healthy tracked projects trigger the same total clearing because this IPC hard-limits the list to 64; renderer sends the full list without batching while ProjectStore supports 5,000 projects (`project-store.ts:44`).
- Verification: `panel-registry-batch.test.ts` extracts and executes the actual production IPC callback and App effect callback, uses the actual filesystem authority guard with real temporary paths, and checks the actual PanelRegistry. Two healthy roots expose the current Panel; a missing unrelated root causes 0 discovery calls and no Panel; 65 healthy roots cause the same result with the IPC length error. Final log `panel-registry-batch.test.ts.log`: 3 pass, 0 fail, 7 assertions.
- Confidence: high. No Panel feature/business package is involved.
- Suggested correction direction: isolate unavailable tracked projects during discovery and batch within the IPC bound. Preserve authority validation and surface per-project failures without discarding healthy projects' installed Panels.

## D10 [P2] Removing a project tombstones its authority before idle worktree conversations detach

- Root cause: `packages/desktop/src/renderer/app/useSessionNavigation.ts:145–152` starts `projectRegistry.remove` before `releaseWorkspacesForArchiveMany`. ProjectStore.remove durably tombstones synchronously (`main/project-store.ts:514–523`).
- Trigger: a project has an idle conversation attached to a CodeShell worktree, and that conversation has not been loaded in the current worker (ordinary after Desktop startup). Remove the project from the sidebar.
- Impact: Main's worktree release requires usable project authority (`session-workspace-service.ts:580` → `mainRootFor`), which now returns root_removed. The renderer logs this error and still archives the conversation. The worktree remains attached to that archived conversation. Re-adding the same project and opening worktree management shows the archived session as an occupying owner; trying to clean up the worktree fails with “worktree is occupied by another session”.
- Verification: `remove-project-workspace.test.ts` uses a real temporary Git repository and real created worktree, actual ProjectStore/SessionManager, actual renderer navigation function and actual release service. It records calls `remove → release → archive`, verifies release returns root_removed, durable session and UI index are archived while the worktree is still attached, re-adds the project and verifies a new session sees that archived session in occupiedBySessionIds. Actual cleanupSessionWorktreeForUi then rejects cleanup because that archived session owns it. Final log `remove-project-workspace.test.ts.log`: 1 pass, 0 fail, 10 assertions.
- Confidence: high for idle disk-only sessions. A resident worker can release through releaseLiveWorkspace first; that path is deliberately excluded from this finding.
- Suggested correction direction: await successful release/archive bookkeeping before removing project authority, and handle removal failure visibly so renderer and Main remain consistent.

## 第十一轮恢复范围复核（权威补充）

[独立工作区/Panel复核](workspace-quality-round11.md)保留D8/R22、D9/R23、D10/R24的P2。R23仅移除当前renderer Panel App entries，内置面板、健康项目、磁盘包与绑定仍保留；恢复缺目录或65→64并刷新能恢复。R24限定cold/evicted durable fallback，真实resident Core helper能在Main后续root_removed前先将workspace写回main，不计遗留owner。冷owner恢复路径已用真实Git和实际Settings回调验证：重加原项目、恢复旧归档会话、重新归档释放，随后新会话可安全清理；不是永久不可恢复或文件丢失。
