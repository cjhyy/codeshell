# Round26 fork binding 独立反证：FilesPanel 限定补核

本稿按父任务后续分工仅补 FilesPanel；Review/design 由另一独立代理核查。只读冻结 84740d56/a66f4ef2，当前正式 banner 85/250。新增 fixture、产品 import、Git subprocess、模型、worker、coding/provider CLI、网络、构建安装及动态验证均为 0。不提升 finding，不改产品或主报告。

## 结论

不能把“summary target 首 send 前缺 project binding”扩大为“其他 mounted roots 文件浏览全部不可见”。FilesPanel 有真实生产 projectId/rootId fallback：当源会话 main 路径仍等于当前 UI 项目的 primary 路径时，target 首 send 前仍显示多根 selector，并可读取其他 secondary roots，不需要先补 durable binding。

这一正常控制**有边界**：source 固定 main root 与项目当前 primary 不一致（例如 Make primary 后旧 source）时，缺少 sessionMainRootId 会令 FilesPanel 把当前 primary option 的 path 覆盖成 source workspace 路径。此时不能声称所有 Files 行为正常；该错配可使新 primary 的正确路径不在 rootOptions 内。该条件是源码推导，未执行、未升级、未另编号。Review 的 legacy 单根路径仍需由负责代理独立判断。

## 真实 UI 传值和 fallback

1. summary 注册仍保留原 UI project bucket。`packages/desktop/src/renderer/App.tsx:2018–2032` 用 activeProjectId createSession/bindEngineSession、构造 bucket；`:2044–2072` 仅 hydrate transcript、更新 index、选新 target，没有在这里补写 Core state.project。
2. `App.tsx:2624–2644` 把完整 projects 与 engine resolver 传给 SessionPanelDock。`packages/desktop/src/renderer/app/SessionPanelDock.tsx:161–186` 从该 bucket 的 projectId 查出 panelProject，传 `projectPath` 和完整 `project`；`:212` 传 target engine ID。因此不存在“Files 只有 engine ID、看不到 UI project”的断链。
3. 无 binding 的原生 state 在 `packages/desktop/src/main/session-workspace-service.ts:143–151,209–241` 返回 projectId/mainRootId=null，但 workspace.root 仍由持久化会话解析。`packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts:110–120` 保留该 root、令 mainRootId=null，不做 cwd→project 的自动 durable backfill。
4. `PanelArea.tsx:488–502` 把 project、cwd、workspace.mainRootId 继续传下；`PanelRegistry.ts:118–122` 将 mainRootId=null 转为 undefined 后交给 FilesPanel。
5. FilesPanel 的根集合来自 **UI project**，不是 resolveSessionReviewWorkspaceForUi：`packages/desktop/src/renderer/panels/FilesPanel.tsx:140–153` 使用 `sessionMainRootId ?? project.primaryRootId`，保留 project.roots 中其余根。`:320–335` 在多根时实际渲染 `<select>`，选择会改变 activeRoot（`:164–176`）。
6. 文件 API 选择位于 `FilesPanel.tsx:177–194`：只有 `engineSessionId && sessionMainRootId && activeRoot` 同时成立才走 readSessionDir/readSessionFileContent。target engine ID 虽已存在，但 rootId 缺失使这一分支不成立，随即以 **project.id + activeRoot.id** 调 readProjectDir/readProjectFileContent。不是调用会拒绝 unbound session 的 requireSessionFileRootForUi。
7. preload `packages/desktop/src/preload/project-authority-api.ts:100–109` 明确 fsRoot 与 fsSession 两组独立 IPC。Main `packages/desktop/src/main/index.ts:6486–6493` 的 fsRoot 分支仅授权 live project/root，再读取；`packages/desktop/src/main/renderer-project-path.ts:59–83` 验证 Main registry 中 project 与 mounted root，完全不依赖 target session.project。

因此，在健康 UI 项目 A(primary)+B(secondary)、source main=A 的普通 summary 场景，target mainRootId 缺失时 FilesPanel 仍列出 A+B，选 B 会走 fsRoot(project,B,B.path)。这是一条完整静态正常生产路径，**不是本轮已运行的 UI 结果**。

## 不能泛化的 source main≠current primary 条件

`FilesPanel.tsx:142–150` 先以缺失 mainRootId 回退 current project.primaryRootId，再把该 root 的 `path` 替换为 workspaceCwd。设 source main=A，而项目已 Make primary 到 B，target workspaceCwd 仍 A：rootOptions 中 B.id 的 path 被替换为 A.path，后面仍保留 A.id/A.path；B.path 不再有正确 option。

选伪 B 时 fsRoot 仍按真实 B.id 授权到 B.path（`renderer-project-path.ts:80–83`），随后 `fs-service.ts:30–32,52–54` 发现请求 dir=A.path 越出 B.path 而拒绝，不能称越权读取成功。这是 UI rootId/path 错配及范围缺失的静态条件，不能说所有 secondary 都失败或永久失败。工作树 main 浏览也不能从普通 main=A 正常控制外推；本稿没有扩大它。

`docs/todo/multi-folder-local-project-plan.md:271–276` 规定 Make primary 不改变旧 Session mainRootId/cwd/workspace，且仍属原项目；`:589–595` 给文件面板明确 project/root 授权接口。既有 `FilesPanel.workspace.test.tsx:362–392` 的源码正常控制正是靠 **已有 sessionMainRootId=old-main** 避免 Make primary 后重复根，并正确读取 old-main/new-primary。此测试本轮没有执行，也不能冒充新 summary unbound 变体的动态证据。

另一个已有测试 `FilesPanel.workspace.test.tsx:334–360` 覆盖 project fallback 的 secondary selector/readProjectDir。该测试 engineSessionId 与 sessionMainRootId 都 undefined；新 summary 的 engineSessionId 存在而 rootId 缺失，因真实 `&&` 条件仍进入相同 fallback，但这个变化只是本稿静态推导，未执行测试。

## 补齐与范围边界

本路径没有发现 lazy durable backfill；Files 的普通 multi-root 可用是 UI project API fallback，并不反驳 Review 只信 state binding 的单根候选。首条普通 send 的正常 Core backfill `packages/core/src/engine/run-session-open.ts:88–92` 以及 ProjectStore cwd→root 解析是已知恢复路径，不可称为永久丢根、错 cwd 或普通 run 必然失败。

Core buildForkState/source.project 未复制、Review resolver legacy 行为本稿只读核对，未再扩设计审查或与另一代理重复升项。

## 双基线/执行边界

Python 标准库 read_bytes/hash 比较：FilesPanel、PanelRegistry、PanelArea、usePanelWorkspaceRoot、session-workspace-service、project-authority-api、SessionPanelDock、App、renderer-project-path、FilesPanel.workspace.test 共 10 文件两冻结树逐字节一致。本稿仅源码及旧测试源码阅读，没有测试/fixture/产品 import。新增动态验证 0；新增正式 finding 0。
