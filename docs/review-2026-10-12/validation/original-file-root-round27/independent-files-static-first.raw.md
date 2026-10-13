# Round27 Files fallback 独立纯静态质量审

结论：**支持一个窄 P3 候选进入最小隔离验证，当前不新增正式 finding、不把源码推导计为已复现。** 当已有 Session 固定 main=A、同项目后来 Make primary=B，而普通 summary target 继承 workspace=A、尚未首 send 补绑定时，Files 已有生产 project/root fallback，却把 B.id 与 A.path 配成同一根；正确 Main 授权 B 后会拒绝读取 A。根因是 Files 根选项构造错误，而不是 fork 必须提前继承 durable project 的合同缺失。目录拒读后无提示已是 R65，此处不再重复计项。

审计 clock 回包为 UTC2026-10-12 01:24:36，即 SG2026-10-12 09:24:36；这是只读审计时间，不是测试执行时间。本稿只读冻结 84740d56/a66f4ef2 产品树、既有审查和测试源码，写入 /tmp。产品 import、fixture/test、Git subprocess、模型/CLI/worker、Electron/浏览器、网络、构建/安装均为 **0**。正式统计仍 **85=1P1/52P2/32P3；通用85文件250测试**。

## 可信的正式生产前提

1. 项目 P 有两个 live、mounted、路径身份未变的根 A/B。为排除包含关系和 symlink 旁支，最小验证宜使用两个不同的 owned sibling directories；A、B 都能正常列目录。
2. source Session 已合法绑定 P/A，workspace={root:A,kind:main}。这不是 renderer 任意提交 sessionId/path 的伪造目标。
3. 用户通过 Sidebar 项目文件夹对话框把 B 设为 primary，B 已 trusted。[Sidebar.tsx:219](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:219) 先检查 trust，[Sidebar.tsx:548](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:548) 的 onMakePrimary 和 TrustGate 接到正式 API；[project-authority-ipc.ts:139](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-authority-ipc.ts:139) 在 Main 再校验 mounted root 与 trusted，才执行 ProjectStore.setPrimary。
4. [project-store.ts:471](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:471) 只更新项目 primaryRootId，并不改旧 Session。[multi-folder-local-project-plan.md:271](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/todo/multi-folder-local-project-plan.md:271) 明确 Make primary 后旧 Session 的 mainRootId/cwd/SessionWorkspace 不变，仍属于原项目；因此 source main=A/current primary=B 是正常支持状态，不是迁移损坏或非法旧状态。
5. 同一个 source/项目保持当前选择，用户创建一个成功的 summary context package 后选中 target，尚未发 target 的首条 follow-up。此处不依赖异步切项目错路由，也不依赖 R55；最小验证可以从“正常摘要已成功”的实际 createSummaryFork 开始，不需要真实模型。

## target 可达性与 UI 门禁

真实 producer 在 [MessageStream.tsx:322](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/MessageStream.tsx:322)：有 engineSessionId 和合法 selection 后调用 forkSession(mode=summary)，成功再调用 onContextPackageCreated。[session-manager.ts:2144](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:2144) 的 createSummaryFork 实际调用 buildForkState 并原子发布 state/transcript；[session-manager.ts:2429](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:2429) 的当前白名单复制 cwd/workspace，但没有 source.project。这里只确认缺绑定状态可以由现行生产创建，不把这个白名单本身定为 bug。

[App.tsx:2018](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2018) 在 active UI project 下创建 catalog row、绑定 engine ID、hydrate transcript，再选择 target；没有同步写 Core state.project。[App.tsx:669](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:669) 的 panel materialize 看到已有 UI Session 就返回原 bucket，不会替 target 运行一次 Engine。

实际面板链完整：[SessionPanelDock.tsx:161](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/SessionPanelDock.tsx:161) 从 bucket.projectId 找完整 panelProject；:185 给当前 project.path（B），:212 给 target engine ID。[PanelArea.tsx:132](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:132) 挂实际 workspace consumer；[PanelArea.tsx:488](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:488) 把 resolved cwd/mainRootId、完整 UI project、engine ID 传给 PanelBody；[PanelRegistry.ts:102](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelRegistry.ts:102) 的 Files 是 alwaysEnabled，:118 挂真实 FilesPanel，并把 null mainRootId 转成 undefined。

Main [session-workspace-service.ts:143](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:143) 读取真实持久化 mainRoot 和 project binding。目标存在、A 健康且无 binding 时，:209–241 返回 rootStatus=ok/mainRoot=A/mainRootId=null/projectId=null。[usePanelWorkspaceRoot.ts:91](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts:91) 读取这个 authority，:110–120 令 cwd=A、mainRootId=null、ready=true。[PanelWorkspaceRootConsumer.tsx:8](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelWorkspaceRootConsumer.tsx:8) 允许 ready body 挂载。没有 Review 的 availability 把 Files 遮掉；也没有在此把 legacy mainRootId 自动补成 A.id。

这条链支持“合法 current project + 成功持久化 target + 正常 authority 后打开 Files”，不是仅手工向 FilesPanel 拼一个不可能的 props 对象。

## 单一根因与用户可见下限

[FilesPanel.tsx:140](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:140) 的构造是：

```ts
const mainRootId = sessionMainRootId ?? project.primaryRootId;
const primary = project.roots.find((root) => root.id === mainRootId);
// primary 元数据包含 B.id，但其 path 被 workspaceCwd=A 覆写。
{ ...primary, path: workspaceCwd ?? primary.path }
```

在该合法状态下实际 rootOptions 推导为 `[B.id/A.path, A.id/A.path]`，B.path 不再有正确选项。:153–176 的默认选择是 B.id，:320–335 仍把该项标为 B（primary）。这不是选错 project、root 已移除或真实权限不足。

:177–194 只有 `engineSessionId && sessionMainRootId && activeRoot` 成立才用 Session API；target 的 engine ID 存在但 mainRootId 缺失，因此进入已经实现的 Project API fallback。:190 调用 `readProjectDir(P,B,A)`；:345–347 的初始 DirNode dir/root 都是 A。实际 preload [project-authority-api.ts:100](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/project-authority-api.ts:100) 逐参数转发 fsRoot:readDir。

Main latest [index.ts:6492](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6492)（初始基线对应6486）先按 P/B 调 requireRendererProjectRoot，再 readDirectory(root.path,dir)。[renderer-project-path.ts:59](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/renderer-project-path.ts:59) 只接受 live project；:73–83 读取 Main registry 中 B、校验 mounted 身份，授权实际 B.path。[fs-service.ts:30](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/fs-service.ts:30) 对 sibling A 做正确 lexical containment 拒绝，错误 `path escapes workspace root`。**拒绝是正常安全控制，不能修成接受 renderer A.path，也不能称成功越权读取。**

用户下限是：刚创建并选择的新 summary Session 内，默认显示的 B 根不能列文件；切到 A 正常，切回 B 仍用错误配对，B 的真实路径不在 selector 中。DirNode :461–470 将拒绝降成 []，后续只 map 子项，所以会留下空树；没有“目录为空”文案或 toast 的新证据。这个吞错反馈复用既有 R65，不另拆一项。即使给 R65 补 error/retry，重复读取 `(P,B,A)` 仍失败，故错误根映射有独立修复价值。

## 正常与恢复控制，应分清静态/动态

本轮下列全部是源码控制，未运行：

| 状态 | 根选项/读取推导 | 审查意义 |
| --- | --- | --- |
| 旧 source bound P/A，project primary=B | sessionMainRootId=A；A/A 与 B/B，走正确 Session API | Make primary 本身没有破坏既有 Session Files |
| 普通 blank/draft，project primary=B | authority immediate cwd=B/mainRootId=null；B/B 与 A/A，走 Project API | 缺 binding 本身不等于所有 Files 不可用 |
| summary source main=current primary A | target fallback A/A 与 B/B，走 Project API | 普通 summary 多根浏览并非普遍失败 |
| 候选 target 选 A | A.id/A.path 正常 Project API | 当前 Files 的可见局部替代，不代表已恢复 B |
| 候选 target 选 B 或刷新 | 仍 B.id/A.path | 单纯重试不会修正参数 |

既有 [FilesPanel.workspace.test.tsx:334](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.workspace.test.tsx:334) 覆盖 unbound project selector 读取 secondary；:362–392 覆盖 Make primary 后 **已绑定 old-main** 的正确根集合。这些是已读测试源码，不是本轮新增动态通过。[session-workspace-service.test.ts:69](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.test.ts:69) 还明确分别保留旧 A 和新 B 的 authority。

首条正常 follow-up 是已知静态补绑路径：[useRunController.ts:355](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useRunController.ts:355) 带 UI projectId；[agent-run-metadata.ts:118](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-run-metadata.ts:118) 使用持久化 Session 查询解析；[project-store.ts:649](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:649) 对 legacy Session 按 session.cwd 找 A；[run-session-open.ts:88](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/run-session-open.ts:88) 在无 project 时保存合法 binding。随后 workspace refresh 可提供 A.id，使 Files 根集合恢复正确。**没有运行首 send/真实 Engine，不称已动态证明的一键用户恢复；也不能称永久丢根、运行错 cwd 或续聊失败。**

## 与 fork Review 设计观察、现有正式项的去重

- Round26 fork Review 已裁定仅设计/体验观察：blank/lazy binding/authority 合同不足以认定 Review 应在首 send 前扩大 roots。本候选不撤回该裁定；Files 自身已经使用 UI project 的正式 root API，错误是该 API 的 opaque rootId 与 path 配错。
- R22 是合法 secondary 被 Panel binding 错当跨项目；此处未调用该 Guest binding，Files body 正常挂载。
- R58 是合法 managed worktree 被图像/终端的 registered-root gate 拦下；此处只需普通 main roots，目录路径是 renderer 为 B.id 选错，Main root gate应保持。
- R65 是目录读取错误被展示为空树；本候选不重复报反馈，只报告 root mapping。源码修复映射与补目录错误状态是两处独立修改。
- R69 是失效 source 阻断迁移；此处 A/B 都健康，不用迁移、缺目录或 mount 故障。

## 最小 guarded 验证建议（仅方案，未写/跑 fixture）

建议在 root 审核隔离方案后，采用 maintained guarded runner，隔离 HOME/TMP、仅 owned sibling roots/fixtures，preimport 同时拒绝并记录 fetch/http(s)/net/tls/child/Bun subprocess；不启动真实模型/CLI/worker/Git/Electron。用 actual SessionManager.createSummaryFork 表示正常摘要成功后的 producer，source 的初始 P/A binding 必须真实持久化，并经 actual authority 读取；用 actual ProjectStore.setPrimary 和正式 setPrimary IPC/trust callback 确保 B 的 mounted/trust 门禁并未绕过。

UI 最小层建议 actual usePanelWorkspaceRoot/consumer + FilesPanel + actual preload project API 的内存 invoke，通过实际 Main fsRoot callback（可源码提取）+ requireRendererProjectRoot + fs-service。App registration/SessionPanelDock 层可保留源码接线，不必声称 full App/OS E2E。不要只手填 `(engineId,A,null)` 然后假装已验证 source/fork/authority；不得用 fake readDir.reject 替代真正 B/A containment 失败。

若普通目录触发 authority 中 Git 探针，允许的安全支架应只把 owned non-Git 查询映成真实 normal not-a-Git 结果，并严格 deny 其他 coding/git exports；保留 mounted-root identity 检查。ProjectStore 目录发现 DI 仅 owned identity，不能把授权函数改成接受任意 path。resolve-only/源码审计与实际 loaded graph 分开记录。

最少断言应包括：A/B 内各有独有文件且直接正常授权均可读；source A bound authority 正常；Make primary 后 source 仍 A；实际新 target 无 binding/authority ok+A；UI 默认 active B，实际请求为 P/B/A，被真实 FS 拒绝；A selector 能显示 A 文件，B selector 仍无 B 文件；ordinary blank B、bound source A、main==primary unbound target 正常。可用实际 Core 写入合法 P/A binding 做内部正常控制，确认 B/B 恢复，但必须标为 **internal binding control**，不能冒充真实 first-send 用户恢复。

## 证据与冻结范围

先前反证输入：[fork-binding-counterreview.md](/tmp/session-continuation-round26/fork-binding-counterreview.md)。本稿是其 rootId/path 边界的独立质量复核，未用它冒充动态收据。

[24份产品/设计源 SHA 清单](/tmp/codeshell-review-20261012-files-fallback-quality-round27.sources.json)，SHA256 `f5429f6ef922d440d0859d25ce6fdbe29640773c0617fd431b87ee71366ca6ee`。23份两冻结树逐字节一致；Main index.ts 不同，fsRoot callback 按各基线实际行号读取，不能声称整个 Main 相同。文件 hash 是 read_bytes 的静态事实，不是 import cache/执行 graph 收据。

新增正式项0；新增动态执行0。窄 P3 仅为候选建议，等待实际 producer/authority/UI/FS 的安全最小实验与 root 去重裁定。
