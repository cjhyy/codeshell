# 第十四轮：文件目录、预览权威和失败恢复

冻结审查基线：`a66f4ef291f304ee4df9da8095a90671d9a8f140`。产品、主报告和目标状态均未改动，无 build/clean。先读 `CODESHELL.md`、R01–R62 索引和既有 files/transfer/Panel 报告后去重。本轮建议新增 **1 项 P3（W25）**，另给 **R58** 补同一根因的图片表现；目录 pending 旧行只记边界，不另计问题。

## R65 / W25 / P3：展开读取失败的目录会静默显示为空

主要位置：[FilesPanel.tsx:468](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:468)。`DirNode` 对目录读取拒绝只执行 `setEntries([])`，没有保存或呈现错误。后续渲染和真正空目录同样没有子项。

实际入口：内置 Files Panel 在 [PanelRegistry.ts:118](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelRegistry.ts:118) 挂真实组件；用户点击 [FilesPanel.tsx:507](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:507) 的目录行，展开子级 `DirNode` 后调用 Main。未绑定 Session 时走 [index.ts:6492](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6492) `fsRoot:readDir`，验证 project/root ID 后，真实 [fs-service.ts:54](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/fs-service.ts:54) `fs.readdir` 仍可能返回真实权限错误。Session 模式也使用同一个 `DirNode` catch；本轮动态失败证据限定 project-root 模式。

已复现时序：

1. 注册自有临时项目，创建 `denied/retained.txt` 和真正空目录 `empty/`。
2. 在非 root UID 501 下将 `denied/` 设为 `000`，保留父目录可读。实际主目录列表仍能正常列出两个目录。
3. 挂实际 FilesPanel，依次展开 `empty` 和 `denied`。AST 提取生产 `fsRoot:readDir` 回调，执行真实 `requireRendererProjectRoot` 和 `readDirectory`；后者对 `denied` 返回 `EACCES`，不是模拟拒绝。
4. 两个展开后的目录都只显示目录名，没有子项、错误、权限提示或 retry。真实文件仍保留。
5. 权限改回 `700` 后点击现有工具栏“刷新”，`retained.txt` 正常出现，内容完整。

用户影响是无法区分“空目录”和“未能读取”，也没有提示应修复权限后刷新。恢复入口已经存在，故建议 P3；不声称文件被删、不可恢复、任意读拒绝都影响整个文件面板。建议在失败节点保留可见错误与重试动作，成功空结果另呈现为空。现有 [FilesPanel.workspace.test.tsx:254](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.workspace.test.tsx:254) 等覆盖的是预览失败/恢复，目录 catch 没有同等错误反馈断言。信心高。

复现：[desktop-files.test.tsx](reproductions/file-navigation-round14/desktop-files.test.tsx) 的 `CANDIDATE directory EACCES...`；原始成功日志：[desktop-files.log](validation/original-file-navigation-round14/desktop-files.log)。

## R58 扩展：合法 managed worktree 的普通图片预览也被项目根门禁拒绝

同一 Session-workspace authority 缺口，建议补 R58，不加新编号。图片和终端的 Main 调用点不同，但共同问题都是合法 Session managed root 被当作必须另行注册的 project root；不能通过放宽通用门禁解决。

入口与根因：[FilesPanel.tsx:178](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:178) 对目录和文本使用 `readSessionDir`/`readSessionFileContent`，图片却复用 [FilesPanel.tsx:113](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:113) 的 `readImageDataUrl(path,{cwd:root})`。[Main index.ts:5108](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5108) 在调用图像读取服务之前强制 `requireRendererProjectPath(cwd)`，没有 Session root authority 分支。

动态证据使用自有 Git/ProjectStore/SessionManager 和实际 `switchSessionWorkspaceForUi` 创建合法 managed worktree，真实 `getSessionWorkspaceAuthorityForUi` 返回 `rootStatus=ok`，`requireSessionFileRootForUi` 接受工作区，项目 roots 尚无该 managed root。挂实际 `usePanelWorkspaceRoot` 和 FilesPanel：目录正常、点击文本经真实 Session fs 服务显示正文；再点击同目录真实 1×1 PNG，实际 AST Main 图片回调拒绝 `project path is not registered with CodeShell`，UI显示无法预览图片，刷新仍失败。直接调用图片服务可以读取同一 PNG，排除了文件或格式损坏。

正常与恢复对照：

- 切回 main 后，主目录独有的 PNG 通过相同 FilesPanel/Main 回调正常显示；注册 secondary root 的 PNG 也正常显示。
- 任意未注册目录仍正确拒绝；在 managed cwd 请求中补 `sessionId` 也无效，因为该字段在 cwd gate 后才传给图片服务。把 cwd 假改为合法 primary 也不能读取其外部兄弟 worktree 图片，图片服务正常保持包含关系校验。
- 当前 worktree 内普通点击和刷新都未调用 `readLocalFilePreview`。切回 main 后显式打开原 worktree 图片的绝对链接，此文件在当前授权根外，FilesPanel 正常转入显式 single-file preview。实际 `registerLocalFilePreviewIpc` owner/frame 校验通过后，真实单文件服务可以预览；伪造 subframe 正确拒绝。这是已有显式恢复入口，不代表当前工作区图片读取会自动 fallback。
- 普通 `readImageDataUrl` 其他 renderer 调用没有替代的 Session authorization：Markdown 图片 [Markdown.tsx:663](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Markdown.tsx:663)、附件卡 [AttachmentCard.tsx:126](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/tool-cards/AttachmentCard.tsx:126) 同走该 Main 回调；[App.tsx:402](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:402) 虽传 `sessionId`，仍不能绕过先发生的 cwd gate。这里只静态核对其他调用，不增加未挂载组件的动态影响声明。现有“用其他应用打开”仍是用户可用操作，本轮未启动 OS 应用。

证据边界：真正的 Git/workspace/file service，实际 React component/hook 与 Main AST callback；Electron IPC 运输和 renderer owner 对象由 fixture 提供，没有启动 Electron、PTY、worker、模型或外部应用。相比既有终端测试，本轮增加的是独立图片操作与恢复对照，不重复计入终端用例。

## 正常保护及未列新项的边界

`desktop-files.test.tsx` 第三个用例验证真实注册 primary/secondary root：第二根的目录响应尚待交付时，picker 已显示 secondary，但旧 primary 行暂时保留，没有再次加载状态。这是现有 `DirNode` 不清 entries 的表现；本轮只固定生产 handler 的真实成功结果在 IPC 交付边界的等待顺序，没有测量自然延迟或执行错误文件操作。改回 primary 后，释放所有 secondary 旧响应，旧响应被 cancelled 标志正确丢弃，最终树保持 primary。仅此边界不升格为跨会话执行或数据损失，也不新增正式项。

跨 Session 切换不直接复用一个有状态 FilesPanel：[SessionPanelDock.tsx:181](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/SessionPanelDock.tsx:181) 按 `panelBucket` 保留独立 PanelArea，[PanelArea.tsx:457](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:457) 明确每个 tab 固定会话归属。工作区 authority hook 还有 target/request 序号；目录、图片和文本 effects 均有取消标志。现有预览失败能显示错误、同文件刷新可清错误，与 W25 目录 catch 不同。本轮未把“同一组件直接替换成另一个 Session”的非生产测试当发现。

第二个独立 fixture [hub-files-recovery.test.tsx](reproductions/file-navigation-round14/hub-files-recovery.test.tsx) 挂真实 HubFiles，用实际 `createHubFiles` 和一个自有 ephemeral loopback HTTP server 验证：

- fixture 未授权请求 401，父路径、外部 symlink 和 `.env` 正确403；文件页面只有 GET，POST 405。本轮没有文件编辑/写入 UI，未把未实现写入能力当 bug。这里执行真实服务的授权回调门禁，未重跑完整 Hub 登录/配对握手。
- 列表出来后真实重命名文件，点击旧行得到可见“文件不存在或已移动”404；刷新列出新名，再点击成功预览。
- 真实普通文件 chmod000 产生可见403权限提示；恢复600后重选成功，错误清除。
- A 的真实 HTTP 预览正文已经接收，在受控 transport 交付边界暂缓；打开 B 后交付 A，A 不覆盖 B，下载链接仍指向 B。为严厉测试 guard，仅这个已完成请求的 fixture transport 故意不遵守 AbortSignal，证明组件自身的 aborted 检查有效；不声称复现浏览器网络自然时序。
- 撤销 fixture authorization 后，刷新触发 onAuthLost，真实内容 API 返回401；恢复授权后刷新可读。

生产 Workbench [Workbench.tsx:865](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/Workbench.tsx:865) 还按 workspaceKey 挂文件页；服务端 [headless-server.ts:668](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:668) 按 Host 的 workspace cwd 创建文件服务。Hub 文件页浏览的是当前项目工作区，不携带 Desktop Session fileRootId；没有把该页面的既定 workspace 范围误判为缺少 Session API。错误映射和 finally close 在 [files.ts:256](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/files.ts:256) 可核对。

## 可便携证据、总计与隔离

两个 fixture 都以 `process.cwd()` 解析仓库，无个人目录或固定快照引用；证据目录 `node_modules` 仅为本地 test dependency symlink，不须提交。运行命令均从目标冻结 checkout：

```sh
node scripts/run-bun-test-shard.mjs --timeout 45000 docs/review-2026-10-12/reproductions/file-navigation-round14/desktop-files.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/file-navigation-round14/hub-files-recovery.test.tsx
```

| 文件 | 最终原始结果 | 日志 |
| --- | --- | --- |
| desktop-files.test.tsx | 3 pass /48 expect /0 fail/skip，3.65s | desktop-files.log |
| hub-files-recovery.test.tsx | 1 pass /22 expect /0 fail/skip，336ms | hub-files-recovery.log |
| 合计 | **4 pass /70 expect /0 fail/skip** | 两份均有 guarded Completed Bun shard |

仅本轮最新 a66f 动态重跑；没有把旧基线算进次数。相关 FilesPanel/fs-service/image-read-service/session-fs-service/renderer-project-path/local-file-preview-ipc/session-workspace-service/HubFiles/Hub files 在 `git diff 84740d56..a66f4ef2 -- <paths>` 为空。未依赖0.9.33新增 API；Main callback 用 AST 从运行目标实际源码提取，便于 root 再做两基线复跑。

每份 fixture 首先要求 guarded runner 的 `CODE_SHELL_TEST_HOME` 与隔离 HOME，再于 Core/Host 导入前安装 exact-origin 网络守卫并拒绝 direct net/tls：Desktop 仅允许未使用的 `http://127.0.0.1:9`，Hub 仅自有 ephemeral origin。守卫是进程级入口保护，不宣称 OS sandbox/network confinement。Git 只操作 owned 临时目录并隔离全局/系统配置；后续 root 明确授权复用真实 Git 会话 fixture。除自有 Git 命令外未启动 Electron/PTY/worker 或第三方任务进程，没有真实模型、凭据、他人文件或外部代码下载。

原始日志保留 plain-folder ProjectStore 探测 Git 的 `not a git repository` 诊断及 MiniDOM 异步 act 提醒；均非产品失败，本轮正式计数仅以最后两个完整零失败 guarded 结果为准。开发中修正了 addRoot 返回对象解析、真实中文权限提示断言和 primary 对照必须等待独有新目录行（避免把仍可见旧树行当 primary 图像入口）。没有修改产品来通过复现。

## 主审收束与便携复跑

正式新增 **R65 / W25 / P3**；图片表现扩展既有 **R58 / P2**，没有另加编号。两个便携文件在84740d56和a66f4ef2分别guarded通过，均4测试70断言、0失败/跳过；主审复跑日志见[Desktop](reproductions/file-navigation-round14/desktop-files.test.tsx.log)、[Web](reproductions/file-navigation-round14/hub-files-recovery.test.tsx.log)及[新快照Desktop](validation/latest-a66f4ef2/repro__file-navigation-round14__desktop-files.test.tsx.log)、[新快照Web](validation/latest-a66f4ef2/repro__file-navigation-round14__hub-files-recovery.test.tsx.log)。上述“仅a66f动态重跑”描述的是代理原始执行范围；本节补上主审的两基线证据，不重复累加。

[独立只读质量复核](file-navigation-quality-round14.md)保留R65/P3与R58合并归因，未新增执行计数；目录折叠后再展开也会重新挂载并读取，属于源码可见的额外重试入口，本轮动态恢复仍仅权限修复+刷新。
