# 第十三轮：合法工作区的终端与首次提交审阅

本轮在冻结 `a66f4ef291f304ee4df9da8095a90671d9a8f140` 上发现两项，并将便携证据复制到初始 `84740d56e55517b004948a0a0e07649ad6fbf998` 后分别运行。两基线均 **2 文件、2 测试、33 断言、0 fail/skip**。产品代码未修改。

## R58 / P2：合法 managed worktree 新建终端被 Main 的项目路径门禁拒绝

主要位置：[Main PTY IPC:6460](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6460)。`pty:start` 校验 terminal 句柄后，只用 `requireRendererProjectPath(cwd)` 授权。该门禁按已注册 project roots 校验；CodeShell 为会话创建的 managed worktree 是合法 Session workspace，正常切换不会把它另存为一个 project root。

正式入口和支持意图：[WorkspaceIndicator:604](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:604) 可切到/创建工作区；[session-workspace-service:511](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:511) 写入会话工作区；[文件权威门禁:452](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:452) 正常接受仍在真实 Git worktree 列表中的 CodeShell managed root。实际 [usePanelWorkspaceRoot:45](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts:45) 使用该会话权威，[PanelArea:184](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:184) 和 [PanelRegistry:171](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelRegistry.ts:171) 将当前 workspace root 交给内置终端。[现有组件契约:80](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.workspace.test.tsx:80) 也要求首次终端使用 worktree cwd；它 stub preload，未覆盖 Main 的拒绝。

触发条件：项目和会话合法，已成功切到 CodeShell 创建的 worktree，再新开终端 tab。实际 [TerminalPanel:87](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/TerminalPanel.tsx:87) 正确请求 worktree cwd，但 Main 抛 `project path is not registered with CodeShell`，组件 catch 将启动失败显示在终端内。此时 PTY 尚未启动。

[便携 fixture](reproductions/terminal-review-round13/terminal-worktree.test.tsx) 使用真实自有 Git 仓库、ProjectStore、SessionManager、`switchSessionWorkspaceForUi`、`getSessionWorkspaceAuthorityForUi` 和 `requireSessionFileRootForUi`。明确断言 rootStatus=ok、文件权威接受、project roots 尚无该 managed root。挂实际 workspace hook 和 TerminalPanel，精确 AST 提取 Main `pty:start` 回调，以真实 path validator 执行；只有 xterm 绘制和 native `ptyStart` 边界用替身。观察到正确 cwd 的一次请求、可见错误、native 边界调用零次。

正常和恢复对照：已注册 primary、secondary roots 均能到达启动边界；任意未注册目录正确拒绝。切回 main 后重新挂载同一实际 hook/终端成功到达该边界。已有终端有意保留创建时 cwd 并提示工作区已切换，不列为缺陷。此项不泛化为全部多根项目终端失效，也不声称执行了真实 PTY、泄漏进程或运行了错误命令。

与 R22 独立：R22 是**已注册 secondary root** 在 installed Panel binding 受拒；此处内置终端不走该 bind，问题是 **Session managed worktree** 在 PTY IPC 缺少会话权威。独立只读反证见 [多窗口附录](multiwindow-round13.md)，没有“必须先另行 OpenProject”前置规则。

修复方向：为 PTY 请求提供独立的 engine session authority，再由 Main 校验 renderer/session access 和真实当前工作区。当前 `sessionId=term:<bucket>:<tab>@windowToken` 是终端句柄，不能当成 Core session ID。保留每窗口 owner、primary/secondary/no-repo 兼容和未注册路径拒绝；不要放宽通用项目路径门禁来绕过问题。

## R59 / P3：审阅仓库首提交时显示“no changes”

主要位置：[ReviewService:155](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/review-service.ts:155) 对所选 commit 一律拼 `${hash}^..${hash}`，默认用 `HEAD~1..HEAD`；root commit 无父提交。[getGitRangeDiff:621](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/desktop-services.ts:621) 把 Git 错误吞成空串，fan-in 得到 diff=""、errors=[]；实际 [UnifiedDiffViewer:180](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx:180) 因此显示“no changes”。

触发入口：[ReviewPanel 提交子菜单:233](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/ReviewPanel.tsx:233) 直接列出 `getRecentCommits` 返回的最近 20 项，没有过滤其中的首次提交；选择后以 [rootId + hash:151](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/ReviewPanel.tsx:151) 发请求。新仓库仅一个提交时默认 committed scope 也受影响。

[便携 fixture](reproductions/terminal-review-round13/review-first-commit.test.tsx) 创建真实自有 Git 首提交，`git show --format= --root HASH` 确认有新增正文。ReviewService 只注入一个合法授权 root，Git discovery、recent commits、range diff 均用生产实现。真实提交列表包含 root；显式选择和单提交默认请求都返回空 diff、无 errors。实际 UnifiedDiffViewer 接真实 service 回包显示“no changes”，没有新增正文或 Git 失败提示。

正常对照：创建第二个真实提交后，选第二提交可显示新增正文；再选 root 仍为空，不会因仓库多了一次提交而修复。显式给 viewer 真实 root diffText 可显示首提交正文，证明渲染器能显示该内容；这只是渲染正常对照，**不代表现有菜单提供恢复按钮或自动备份**。完整 ReviewPanel 下拉交互和 Electron Main 本轮未挂载，正式菜单接线静态核对，动态范围是实际 service + viewer。

影响仅首提交差异无法从该菜单查看，历史和文件保留，后续提交正常。外部 `git show --root` 可查看；若恰有对应的 turn snapshot，也可能走已有快照查看，但不保证每个历史 root commit 都有快照。建议 P3。修复应对 root commit 使用 empty-tree 或等价 `git show --root`，并让失败 range 显式返回错误，避免把失败显示为成功无变化。

## 验证与限制

两个脚本都要求 guarded HOME，在 Core/Host 导入前安装 exact-origin `http://127.0.0.1:9` 网络守卫；没有请求该 origin、真实模型或账户。Git 仅操作脚本自建临时目录，配置隔离，finally 清理。Review fixture 的 Electron shell 替身会拒绝任何 OS 动作。MiniDOM 与 xterm 替身不等同完整 Electron 原生交互。

两基线分别通过后的完成日志位于 `reproductions/terminal-review-round13/*.test.tsx.log` 与 `validation/latest-a66f4ef2/repro__terminal-review-round13__*.log`。相关生产文件在两基线 diff 为空；已运行两次的证据与源码相同是分开确认的事实。

开发中修正了三个 fixture 适配：await 异步 store.list、补 Electron shell 导出、使用 MiniDOM 的 nodeValue/textContent 读取文本。没有修改产品使测试通过；正式数量只计最终 guarded 完成记录。两项均经独立只读因果与范围复核，不额外计测试。

## 第十四轮 R58 同根因扩展

合法 managed worktree 的目录与文本经 Session authority 正常读取，但普通 PNG 预览仍传 `{cwd:root}`，在 Main 图片 handler 被相同注册根门禁拒绝。两基线真实 FilesPanel/Main AST/文件服务证据及 primary、secondary、显式单文件恢复见[文件导航第十四轮](file-navigation-round14.md)。这是 R58 的另一个内置面板表现，不另加发现；不能通过放宽任意目录校验修复。
