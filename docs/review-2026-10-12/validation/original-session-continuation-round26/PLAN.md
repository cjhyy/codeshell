# Round26 fork→Review 可行性 PLAN（未执行）

当前正式审查阶段 85 findings / 250 tests。本目录仅为第26轮只读预审；没有新编号或通过收据。冻结产品树 primary84740d56 与 latesta66f4ef2，不改产品、不 build/install，不访问真实用户 HOME，不启动模型/Engine/worker/Git 或外部服务。当前授权只准备源码与本计划；首次 guarded 运行必须等 root 完整核源码和 guard 后明确安排。

## 窄候选和真实入口

健康本地项目由 A（primary、非 Git 文件夹）与 B（secondary、Git 仓库）组成，source 是已绑定项目 A 的普通 Desktop 会话。用户通过 MessageStream 的上下文选择生成摘要新会话；摘要成功后 App 把合法 target 注册进原 UI 项目并选中。在 target 第一条普通 follow-up 发送前打开 Review，target 的持久化 state.project 缺失，Main 把它作为 legacy 单根 A，Review 不发现 B，availability=false，普通 Review 入口隐藏。若 A/B 都是 Git，则更窄可描述为只聚合 A、遗漏 B；首 fixture 只选 A 非 Git/B Git，避免多个效果。

此时文件与 transcript/summary 保留，cwd/workspace 保持 A。不能称丢项目、丢文件、错 cwd、首 send 失败、永久失败或安全越权。Full fork 使用同一个 state helper，但普通顶层 UI 首场景只验证 summary；Quick Chat full side fork 不扩大为普通顶层入口。

真实调用链（latest 行号；关键源码两冻结树 hash 核查见 source-manifest-preflight.json）：

1. renderer/MessageStream.tsx:322–346 的实际按钮 handler 调 forkSession(mode=summary,sourceSessionId,闭合 range)。Core/protocol/server.ts 的摘要成功分支调用 SessionManager.createSummaryFork；已有 R74 取消和 R17 摘要失败恢复不重复。
2. core/src/session/session-manager.ts:2144–2184 actual createSummaryFork 从 source.state 经 buildForkState(:2429–2458) 原子发布 context_transfer；该明确字段白名单无 project，但保 cwd/workspace/model/provider/origin，target 独立 parentSessionId=null。
3. desktop/renderer/App.tsx:2018–2032/2044–2072 把 result.sessionId 绑定到 activeProjectId 的新 UI 行，hydrate 成功或失败均保可达，没有在这里写 Core project binding。现有 operation/session epoch 防止迟到结果抢选择，不把 R55/R74 导航行为重复报项。
4. desktop/main/session-workspace-service.ts:143–151 读取实际持久化 binding；:209–241 无 binding 返回 projectId/mainRootId null；:396–431 只有绑定时展开完整当前 roots，否则单个 legacy:<sid>/workspace.root。目录存在、注册身份健康仍 rootStatus=ok。
5. desktop/main/review-service.ts:168–220 只 fan-out workspace.roots；:74–104 汇总 Git status。singleton:290–292 正式使用上述 Main resolver。main/index.ts:6294–6297 的 review:status 只传经过验证的 sessionId。
6. preload/project-authority-api.ts:29–30 传 sessionId；renderer/panels/useReviewAvailability.ts:30–47 也只传 sessionId，workspaceKey 是 identity/dedupe key，不注入 renderer project roots。:23–27 空 repositories/errors → unavailable。
7. App.tsx:315–325 与 PanelArea.tsx:185–203 传当前 session authority；PanelRegistry.ts:157–168 的 enabled 明确只有 gitReviewAvailable===true。此 UI 入口链仅静态，不导入整个 App/PanelRegistry。

## 设计反证与正常控制

- session-fork.md:274–288 的旧设计字段白名单没有现代 project，不凭字段缺失单独宣称违约。multi-folder-local-project-plan.md:187/217–221/520/538–541 明确普通 renderer fork 首 run 单点回读、真实 context 写 binding；这是正常兼容流程。Review 聚合当前全部 roots 是 :304/865 的目标，故本候选只评首 send 前可见 Review 体验空档，不要求改写 fork 所有字段。
- FilesPanel 有真实 UI project/root fallback；source main==current primary 时其他 roots 仍可选可读，不能扩大为 Files 多根全部不可见。child 静态反证 /tmp/session-continuation-round26/fork-binding-counterreview.md。Make primary 旧source 条件仅静态边界，不另列实验/发现。
- source 正常控制：同一个实际 ProjectStore A+B、实际 bound source，Main roots 数量2，Review DI 回 B 仓库状态，实际 readReviewAvailability 返回 available。
- target 正常保持控制：actual createSummaryFork 后读取新 id、cwd/workspace、parentSessionId=null、forkedFrom/sourceRange、context_transfer summary/source 原文 bytes，不要求重复全套 Core fork 单测。
- 恢复控制：通过 actual SessionManager.saveStateOrUpdateFields 在 owned target 显式写入 source 相同的有效 binding，再调用完全相同 Main resolver/ReviewService/preload/availability，恢复 roots2/available。这是受控绑定正常控制，不是用户公开修复或真实首 send 动态证明。
- 首 send 正常恢复仅静态：useRunController.ts:354–357 传 UI projectId；agent-run-metadata.ts:118–150 cold lookup/resolveProjectRun；project-store.ts:655–677 按 persisted cwd 精确命中 root 并给 workspaceContext；core/run-session-open.ts:88–93 在 resume 缺 binding 时保存。已有 agent-run-metadata.test.ts:372+、project-store.test.ts:759+ 为测试源码，不称本轮已运行。
- retryHistory 正常反证：ChatView.tsx:1339–1340 把 historyFailed 排除于 new-chat；:1503–1535保留失败状态/Retry button，useTranscriptBuckets.ts full retry 与分页 generation guard 均在生产路径，不强造新缺陷。
- Hub export 静态审查无独立新项；见本目录 hub-export-static.md。R76 async-followup isRunning gate 不重报。

## 拟议最小 fixture（尚未写成执行收据）

一文件一 test 足够。使用 maintained guarded runner、隔离 HOME，在第一 import 安装本目录 network-guard.ts，精确复用 round25/round23 强 guard SHA6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d；连 dummy http://127.0.0.1:9 也 deny，所有 Node/Bun network/listener/child/worker deny。没有 realGit 例外、没有 Memory provider 需求。fixture 所有 imports 必须动态且位于 guard 后；import 的包 source/dist provenance 分层记录。

1. 注册 afterAll/receipt 初始化在 source manifest hashing 之前，早期失败也写 phase/error/attempts/isolatedHOME/ownedPaths。仅在 runner HOME 下创建 private ownedRoot、A/B/sessions、registry/recents/migration/noRepo，源文件只读。
2. actual Core SessionManager 使用明确 package dist 构造；actual Desktop ProjectStore/SessionCwdIndex 从绝对 cwd 源路径加载，ProjectStore 显式传全部 owned paths 与 resolveProjectRoot:(ownedA/B)=>same-realpath DI，其他路径 throw。注册真实 A、addRoot B；actual mounted-directory身份校验保留。
3. seed 使用 actual SessionManager.create + actual saveStateOrUpdateFields 添加合法 source binding（与 run-session-open182–183 真实 writer相同），actual Transcript.appendMessage 写 user/assistant。actual selectContextPackage 冻结闭合 event range，再 actual createSummaryFork 接收固定摘要结果。固定摘要是已经完成模型输出的受控 seam，不运行 Core protocol摘要/LLM/Engine。
4. Main 私有 findMainWorktreeRootIfUsable 没有 public DI；只在编码包 Git export seam 提供严格 ownedA/B adapter：A 抛标准 not-a-git-repository 错误供真实 helper正常降级；B 可返回B。必须注明并记录调用；未调用的其他 Git/worktree exports 直接 deny，不能放开 subprocess。actual ProjectStore folding 为上条显式DI，实际ReviewService resolveGitTopLevel/getGitStatus使用publicDI：ownedA→null、ownedB→B、status只有B→固定branch/entries。它证明 Main roots/Review聚合及UI分类，**不证明实际Git发现/status**。
5. actual session-workspace-service test setters注入实际SM/store，actual getSessionWorkspaceAuthorityForUi/resolveSessionReviewWorkspaceForUi；ReviewService用实际resolver与上述Git DI。ReviewService默认依赖 desktop-services 在模块边界可用最小 deny adapter，以免Electron/Git默认逻辑进入；不能替换ReviewService/getStatus/roots解析。若保留实际 desktop-services，Electron shell最小deny mock，并静态核 imports 无自动副作用；选定后完整PLAN记录，不能在失败后擅改。
6. actual createProjectAuthorityApi 的内存 invoke 只接受 review:status 和固定 source/target IDs，直接转 actual service.getStatus；window.codeshell设置为这个实际 API；actual readReviewAvailability 保留 production分类/dedupe。无需 MiniDom/hookmount/ReactSSR，App/PanelRegistry/ReviewPanel为静态消费证据，不引庞大UI mocks。
7. 依次读 source正常、fresh target候选、owned显式binding后target正常。记录 actual authority、workspace roots、DI Git调用、IPC IDs、Review results、availability、target/source transcript hashes。断言网络/child attempts[]，source bytes保持、owned root finally移除。
8. afterAll即使业务失败也清 Main test setters/window及owneddirs，receipt里 ownedFilesRemoved=true/cleanupErrors=[] 为成功必要条件；runner finally删除HOME由run后独立核查。fixture证据输出位置用 import.meta.dir，first/second作者与root两基线各自不同目录，不覆盖；首次失败保全精确 source/guard/PLAN/log/observed/manifest，不擅改或连跑。

## 待 root 决定

独立静态反证已到 /tmp/codeshell-review-20261012-fork-authority-quality-round26.md，支持窄 Review P3 候选但未编号。本计划仅说明可行性；未完成fixture审读、未运行真实Git、未执行产品 import/fixture/runner；本轮动态验证0。是否安排首轮由 root 阅读最终fixture和本PLAN/guard后决定。
