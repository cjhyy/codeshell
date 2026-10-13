# 第十四轮文件导航：独立只读质量复核

审查冻结快照 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，已读该 checkout 的 `CODESHELL.md`、原专项报告、两份完整脚本及最终日志，并交叉核对生产 renderer/preload/Main/service 路径与 R58 原附录。**本次执行测试计数为 0；没有重跑既有测试、启动服务/原生进程、构建或修改产品、主报告和目标。**仅新增此 `/tmp` 审计文件。复核时主报告已将 W25 收录为 R65，以下沿用 W25 方便与原证据对应。

结论：**保留 W25/P3；图片表现并入 R58，不另编号。**目录 pending 旧行仍只作为边界记录，Hub 控制不列缺陷。

## W25：正式入口成立，影响与恢复应保持狭窄

实际入口不是测试私有组件：内置 Files Panel 在 [PanelRegistry.ts:118](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelRegistry.ts:118) 挂载 `FilesPanel`；用户展开目录时 [FilesPanel.tsx:507](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:507) 修改 open 集合，[FilesPanel.tsx:524](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:524) 挂载子级 `DirNode`。未绑定 Session 时 [FilesPanel.tsx:190](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:190) 调用 `readProjectDir`，真实 [preload:100](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/project-authority-api.ts:100) 进入 Main 的 [fsRoot:readDir:6492](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6492)。Main 先验证项目/root，再用 [fs-service.ts:54](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/fs-service.ts:54) 实际读取该目录。

项目根有效不能排除其子目录无读取权限。父目录列表使用 dirent，普通目录项不会先读其子目录，因此项目根可读、子目录 `000` 的既有 fixture 能走到上述生产入口。脚本使用真实 ProjectStore 与 Main AST 回调，注入的 validator 和 `readDirectory` 均为生产实现；日志 `uid=501` 与 `EACCES` 对应真实非 root 文件系统拒绝，并非人为构造 Promise.reject。动态证据明确限定 project-root 模式；Session 模式也复用此组件/catch 是源码事实，不额外声称本次动态覆盖了它。

错误在 [FilesPanel.tsx:468](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:468) 被转为 `[]`；该节点没有 error 状态，随后与成功读取的空目录同样渲染零个子项。现有脚本同时展开真正空目录，检查没有子项、权限/失败/重试文字或 alert，对“显示为空”的描述具有正常对照。它没有证明文件删除、整个项目树失效或持续不可恢复；原报告未作这些扩大声明。

恢复已有两类入口：

- **已动态验证**：修复权限后点击 [工具栏刷新:381](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:381)，reloadNonce 改变，[目录 effect:474](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:474) 重新读取，原文件正常出现且磁盘正文完整。
- **仅源码确认**：修复权限后折叠再展开该目录，`isOpen && <DirNode>` 会卸载并重新挂载子节点，读取 effect 再执行；也可隐藏后重开树。不能称为必须重启应用或只能刷新才能恢复。这两条操作未在本次或原专项测试中新增执行。

P3 合理：用户暂时无法区分空目录与读取失败，且 UI 没有提示修复权限/重试；已有恢复、文件完整，影响为错误反馈而非数据损坏或权限绕过。与 R59 的 Git range 失败显示无差异是不同正式操作、不同失败处理实现；与 R58 的工作区 authority 缺口也独立。修复建议可保持小范围：节点保留错误原因与显式重试，成功空结果与拒读分开呈现，不放宽 Main 文件权限或路径边界。

## R58 图片：可达且应去重，补充表现不改变编号

实际 Panel 链会传入 Session workspace 与 mainRootId：[SessionPanelDock.tsx:181](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/SessionPanelDock.tsx:181) 按会话 bucket 保持 PanelArea，[PanelArea.tsx:132](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:132) 解析工作区，[PanelArea.tsx:497](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:497) 向内置面板传入 cwd/mainRootId/engineSessionId。正式 [WorkspaceIndicator.tsx:611](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:611) 可发起工作区切换；Main 服务 [session-workspace-service.ts:542](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:542) 创建 worktree 并写入 Session，不同时注册新的 ProjectStore root。合法 managed worktree 通过 [Session file authority:452](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:452) 的归属/Git 列表核验是受支持路径，无需用户另开为根才可使用内置 Files。

[FilesPanel.tsx:178](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:178) 对该目录和文本走 Session API，但图片仍使用 [FilesPanel.tsx:113](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:113) 的 `readImageDataUrl(path,{cwd:root})`。真实 [preload:902](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:902) 原样发送；[Main:5108](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5108) 先用只接受注册 root 的路径门禁，尚未调用图像服务就拒绝 managed cwd。目录和文本正常、同目录 PNG 被拒且刷新仍失败的既有 fixture 充分排除了“整个 Session 不合法”与“图像损坏”。`files-managed-session` 也符合 [session-validation.ts:1](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-validation.ts:1) 的正式 ID 形状；虽然 fixture 的 Session FS 直连服务未重走该 Main assert，这里不存在被其挡住的假入口。

R58 终端同样把已授权 Session managed root 交给 `requireRendererProjectPath`，漏传独立 engine Session authority。两个 IPC 的最终修复点不同，仍可合并为一项权限适配缺口，正文分别保留受影响动作和验证。不要为图片再增加一项，合并 R58 保持原终端 P2 即可；图片证据本身不证明新增严重影响。

恢复与保护也应明确：

- 主根与正式注册 secondary root 图片正常；任意未注册 cwd 正确拒绝。补 `sessionId` 无法越过先发生的 cwd gate，不能称为可通过该字段恢复。
- 图像服务 [image-read-service.ts:186](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/image-read-service.ts:186) 仍以真实 cwd 做包含关系检查；假用 primary cwd 不能读取外部兄弟 worktree。这是正确保护，修复不应放宽全局 `requireRendererProjectPath`。
- 当前 worktree 普通点击/刷新没有自动 single-file fallback。切回 main 后显式打开原图片绝对路径，FilesPanel 的 [externalPreview:228](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:228) 与 [LOCAL_FILE_SYSTEM:116](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:116) 可用。正式 [usePanelBuckets.ts:879](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/usePanelBuckets.ts:879) 将路径链接事件变成 revealFile；原脚本动态从 revealFile 组件入口验证，未完整点击 Markdown 链接或跑 Electron UI。已有 [local-file-preview-ipc.ts:8](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/local-file-preview-ipc.ts:8) 同时检查主窗口 owner/mainFrame，fixture 的 subframe 拒绝对照成立。

以上组合证据是实际 React/hook、真实临时 Git/Session/ProjectStore/文件服务和 AST 提取的 Main 回调，IPC 运输/owner 为替身。不能写成完整 Electron 图片复现，也不能扩大为所有 Markdown/附件组件已动态确认。建议采用 Session-scoped image 授权或明确通过 Session file-root 校验，并保留现有图片大小、格式、包含关系及显式单文件权限边界。

## 未增加发现的控制与证据计数

Desktop 第三个用例只在真实 handler 结果的交付边界延迟 secondary 响应，确实观察 picker 已变、旧行尚在；之后旧响应被 [DirNode cancelled:471](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:471) 丢弃。未观察错误文件操作或自然浏览器时序，维持非发现合理。跨 Session 仍有独立 bucket、workspace target/request 序号及各 preview effect 取消保护。

Hub 脚本使用真实 `createHubFiles` 与受限自有 loopback，而认证只是 fixture 回调，不能等同完整真实登录/配对验证。源码与日志对以下正常证据一致：服务 [files.ts:146](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/files.ts:146) 授权、响应前再授权、路径/私有文件/符号链接拒绝、仅 GET；[files.ts:256](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/files.ts:256) 将 ENOENT/EACCES 转为可读 404/403，并在 finally 释放文件句柄。客户端 [HubFiles.tsx:60](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubFiles.tsx:60) 报错/触发 onAuthLost，[HubFiles.tsx:140](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubFiles.tsx:140) 显示 alert，重新选择清错误；[HubFiles.tsx:94](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubFiles.tsx:94) 的 aborted 检查防迟到 A 覆盖 B。脚本故意对已收到的 A 正文忽略 transport abort，再延迟交付以挑战此保护，不是未经说明的自然网络竞争复现。

原始证据：

| 输入 | 既有日志记载 | 本次新增执行 |
| --- | --- | --- |
| [desktop-files.test.tsx](/tmp/codeshell-review-20261012-file-navigation-round14/desktop-files.test.tsx) / [日志](/tmp/codeshell-review-20261012-file-navigation-round14/desktop-files.log) | 3 pass、48 expect、0 fail/skip | 0 |
| [hub-files-recovery.test.tsx](/tmp/codeshell-review-20261012-file-navigation-round14/hub-files-recovery.test.tsx) / [日志](/tmp/codeshell-review-20261012-file-navigation-round14/hub-files-recovery.log) | 1 pass、22 expect、0 fail/skip | 0 |

**原始专项合计 4 测试/70 断言；本次审计 0 测试/0 断言，不重复加进任何总计。**两份日志有 guarded Completed 记录。非 Git 临时文件夹的 Git 探测诊断、MiniDOM act 提醒不等于断言失败；本审计没有以此证明完整原生 UI 行为。两个脚本的隔离 HOME/exact-origin 守卫均位于 Core/Host 导入前；本次仅阅读，未触发这些 imports、请求或文件权限实验。
