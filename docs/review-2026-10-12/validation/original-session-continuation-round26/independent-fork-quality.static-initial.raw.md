# Round 26 fork authority independent static counter-review

记录时间：实际 clock 2026-10-12 01:08:31 UTC / Asia/Singapore 09:08:31。独立审计新增执行 0；没有导入产品或运行 fixture、测试、Git、Engine/provider、worker、Electron、浏览器或网络。仅阅读两个冻结树与现有报告，写本 owned `/tmp` 文件。当前正式85项（1P1/52P2/32P3）、通用85文件250测试保持不变。本稿不是新的 Completed 收据，也不把已有测试源码当本轮动态通过。

## 判断

支持继续最小验证一个窄 P3 候选：一个已绑定、健康多根项目的普通 Desktop Session 经“选择上下文并新建”成功创建并选中 summary target 后，在 target 首次发送前，Review 只枚举继承 workspace 的一个仓库，漏掉项目其它独立仓库。原 source 的同一 Review 请求可枚举多根。此时 sidebar 仍将 target 归入原项目；它并非无项目草稿。当前证据仅静态可达，不提前计正式 finding。

不支持“fork 永久丢项目/跑错 cwd/后续发送失败/所有 Files 不可用”等范围。fork 的历史白名单明确继承 cwd/workspace/model/provider/origin，并没有现代 project 字段必须复制的明文合同；多根迁移设计还明确普通 renderer fork 首次 run 才单点回读并补绑。因此缺陷应落在新建成功后、首条 followup 前的项目级 Review 连续体验，不能单凭 buildForkState 不拷贝字段判为安全或运行授权缺陷。修复也不能让 renderer 路径绕过 Main 权威；是否由可信 fork 结算保留 binding 或 Main 校验后补齐，应另行设计。

## 真实生产链及必要前提

1. source 已经通过正常 run 获得有效 `state.project={projectId,mainRootId}`；live 项目有至少两个挂载根，目标 cwd 精确匹配一个挂载根，目录身份均健康。为最小清晰案例，source main 与项目 primary 相同、无 worktree，两个根属于不同 Git 仓库；第二仓库存在可见修改。两个根属于同一 Git 仓库会被正常去重，不是本候选。source 空闲、已有合法闭合可选上下文范围，用户保持当前项目/Session，summary 正常成功，不依赖人为并发切项目。
2. MessageStream 实际 handler 发送 `agent/forkSession mode:"summary"`，不附 QuickChat claim；成功后调用 App 的普通注册 callback。Core 在 summarization 成功后调用 `createSummaryFork`，`buildForkState` 复制 cwd/workspace 而不写 project，原子发布后才响应。这是成功 target，不是 absent draft。
3. App 创建普通 UI row、`bindEngineSession`、磁盘 hydrate、保存 projection、选择 target。SessionCatalog 的 projectKey 是 sidebar 索引分组，其 apply 只更新 catalog 行，不写 Core state.project。普通 fork 不符合 qchat target/claim 条件，QuickChat fork router 的 settlement 不是普通 summary 的补绑钩子。
4. Main authority 对已存在 target 读 persisted binding；缺失则返回 projectId/mainRootId null，但继承的健康根仍 rootStatus ok。renderer `useSessionUiAuthority` 对成功已有 authority 不拿当前 UI 项目覆盖；loading/confirmed absent 的 project fallback 不适用这个目标。Review availability 请求只传 Session id，UI 的 project.roots 只参与失效 key，不参与 Main roots 决策。
5. Main `resolveSessionReviewWorkspaceForUi` 对 bound source 展开当前全部 roots；对 unbound target 给唯一 `legacy:<target>`/workspace.root。ReviewService 只遍历返回 roots 做仓库发现/状态/diff/recent commits，所以它无从读取另一仓库。Review launcher/command 路径需 availability=true；选择 primary 为有效 Git 仓库可保证入口仍可见，窄候选是正常打开后的范围缺失。若 main 非 Git 而只有 secondary 是 Git，入口可能 unavailable，但本稿未据此扩大第二表现。历史 turn snapshot 单独可显示，不能将它当 live 全项目 Review 已恢复。

关键源码：
- [packages/desktop/src/renderer/MessageStream.tsx:322](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/MessageStream.tsx:322)
- [packages/desktop/src/renderer/App.tsx:2018](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2018)
- [packages/core/src/protocol/server.ts:1805](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:1805)
- [packages/core/src/session/session-manager.ts:2144](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:2144)
- [packages/core/src/session/session-manager.ts:2429](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:2429)
- [packages/core/src/session/session-manager.ts:2287](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:2287)
- [packages/desktop/src/main/session-catalog-store.ts:126](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-store.ts:126)
- [packages/desktop/src/main/agent-bridge-fallback.ts:69](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge-fallback.ts:69)
- [packages/desktop/src/main/agent-bridge.ts:847](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:847)
- [packages/desktop/src/main/session-workspace-service.ts:143](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:143)
- [packages/desktop/src/main/session-workspace-service.ts:209](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:209)
- [packages/desktop/src/renderer/sessionUiAuthority.ts:188](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionUiAuthority.ts:188)
- [packages/desktop/src/renderer/panels/useReviewAvailability.ts:30](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/useReviewAvailability.ts:30)
- [packages/desktop/src/renderer/App.tsx:315](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:315)
- [packages/desktop/src/main/session-workspace-service.ts:396](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-workspace-service.ts:396)
- [packages/desktop/src/main/review-service.ts:168](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/review-service.ts:168)
- [packages/desktop/src/renderer/panels/PanelRegistry.ts:156](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelRegistry.ts:156)
- [packages/desktop/src/renderer/app/usePanelBuckets.ts:705](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/usePanelBuckets.ts:705)

## 正常恢复与反证

- **普通 first followup 是正常补绑路径**：useRunController 给 targetProject.id；Main prepareAgentRunMetadata 对 cold target 单点 lookup，ProjectStore 在无 binding 时按 persisted cwd 精确寻找此项目挂载根，保留 workspaceRoot；它生成合法 WorkspaceContext。Core openRunSession 在 resumeForRun 后、后续模型工作前保存缺失 project binding。`session_started`/workspace 订阅使 renderer authority 与 Review availability 再读。这里只是源码确认，未运行一次真实 followup、模型或完整 App；不能把保存 binding primitive 当动态用户恢复收据。
- **Files 不支持扩大**：FilesPanel140–153 在 mainRootId 为空时仍以 UI project.primaryRootId 生成完整 project.roots；177–193 选择正式 `readProjectDir/readProjectFileContent`，只有 mainRootId 存在才走 Session 文件 RPC。PanelRegistry118/PanelArea498 真实接线。因此不能把 Main 的 `requireSessionFileRootForUi` 对 unbound 拒绝直接称实际 Files 入口失败。source 位于不同 secondary/managed worktree 的默认标签/路径匹配另有边界，需要单独自然可达证明，本稿不升项。
- **legacy 单根是有意正常设计**：session-workspace-service391–394 与其 legacy 测试127明确该策略；任意 legacy/no-repo Session 没有自动扩大全项目访问权的要求。新 summary 的可疑点是 source 已绑定并且 UI 仍在同一项目，而不是 legacy helper 本身错误。
- **fork 清控制态是有意行为**：session-fork101、274–288 白名单清 usage/goal/run 控制；没有证据应继承目标 Goal、成本或活动任务，本候选不碰这些字段。Summary target 是普通 top-level durable Session，非自动清理 qchat。
- **迁移文档明确 lazy 绑定**：multi-folder-local-project-plan187、217–221、520、538–541说明首次 run 才补绑。该规则足以排除永久运行故障；它没有明确将普通项目新会话首 send 前的 Review 故意降为单仓库。文档304/865仍给出项目多 repo Review 目标。此点支持暂时 UI 范围不一致的 P3 下限，但不是“必须盲目复制安全身份”的合同。

正常/反证源码：
- [packages/desktop/src/renderer/app/useRunController.ts:349](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useRunController.ts:349)
- [packages/desktop/src/main/agent-run-metadata.ts:118](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-run-metadata.ts:118)
- [packages/desktop/src/main/project-store.ts:649](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/project-store.ts:649)
- [packages/core/src/engine/run-session-open.ts:88](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/run-session-open.ts:88)
- [packages/desktop/src/renderer/sessionUiAuthority.ts:122](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionUiAuthority.ts:122)
- [packages/desktop/src/renderer/panels/useReviewAvailability.ts:113](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/useReviewAvailability.ts:113)
- [packages/desktop/src/renderer/panels/FilesPanel.tsx:140](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:140)
- [packages/desktop/src/renderer/panels/FilesPanel.tsx:177](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/FilesPanel.tsx:177)
- [packages/desktop/src/renderer/panels/PanelRegistry.ts:118](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelRegistry.ts:118)
- [packages/desktop/src/renderer/panels/PanelArea.tsx:488](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/PanelArea.tsx:488)
- [docs/todo/small-features-2026-07-10/session-fork.md:99](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/todo/small-features-2026-07-10/session-fork.md:99)
- [docs/todo/small-features-2026-07-10/session-fork.md:274](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/todo/small-features-2026-07-10/session-fork.md:274)
- [docs/todo/multi-folder-local-project-plan.md:217](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/todo/multi-folder-local-project-plan.md:217)
- [docs/todo/multi-folder-local-project-plan.md:301](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/todo/multi-folder-local-project-plan.md:301)
- [docs/todo/multi-folder-local-project-plan.md:520](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/todo/multi-folder-local-project-plan.md:520)

## 已有测试与去重

这里只读以下现有测试源码，未新增动态执行：`agent-run-metadata.test.ts372–449`明确 ordinary fork cold followup 单点回读；`project-store.test.ts746–765`明确未绑定 fork cwd 命中 secondary 后 run 正常；`session-workspace-service.test.ts69–125`验证 bound 多根 Review（Make primary 仍保主身份），127–135验证 legacy 单根，245–283验证 bound managed worktree+secondary；`review-service.test.ts201–219`保留 legacy 单仓库；`ReviewPanel.workspace.test.ts100–118`说明实际请求只信 Session id，不信 renderer cwd。它们未组合“正常 summary target → 首 send 前 Review”。这不是声称已有测试失败。

与 R22（合法已绑定 migrated secondary 的 Panel 门禁）、R58（已绑定 managed worktree 终端授权）、R72（Core/catalog 归档失配后错误移除根）、R74（summary 取消/timeout）不同；没有重复追报它们。现有 Review R59 的首提交 range 错误也不是 scope 枚举问题。未观察/推断历史丢失、目录删除、越权访问、目标未发布或后续运行失败。

## 建议最小验证边界

若主审决定继续，可隔离创建真实 ProjectStore/SessionManager 的健康双根并合法绑定 source，先用真实 workspace resolver/ReviewService 正常控制，调用实际 summary publish primitive（不做真实付费 summarization），再验证 target 已存在且 project absent、Main authority ok/null、Review 单根，最后用正式 Main run metadata + Core session-open primitive 补绑后验证双根恢复。Git discovery/差异如用内存 adapter应明确其范围；不能将它称 OS/full App/worker E2E 或已执行真实 summary model。若涉及真实 owned Git 操作须由 root另行授权，本审计不执行。实际 App/menu/preload 路由静态链可以配合较窄 fixture；没有动态 Completed 前保持候选。

## 双冻结源码一致性与执行账本

只读 SHA256 比较28个相关完整文件，两个冻结树28/28一致；下表仅源码字节审计，不是模块加载/缓存图证明。所有测试、产品 import、模型、worker、Electron、Git、网络执行增量均0；没有本轮 fixture 失败或通过，正式计数仍85/250。

| 文件 | SHA256（两树相同） |
|---|---|
| packages/core/src/session/session-manager.ts | 0ebe5458e6f5701e286c552e43e0dd707177fb97b1e8726a94ae5dbcfdedcb10 |
| packages/core/src/protocol/server.ts | 001212e386311d24bd7b19bf67012bfb8d9f42d58fbdbdf7f1258a04c89a159a |
| packages/core/src/engine/run-session-open.ts | 4ac92021afc249a3e33482691e867b689024db9fcf86aaab9f07ea344183a9ae |
| packages/desktop/src/main/session-workspace-service.ts | 0a914d59780852a949e6d8349b51f5a8e40762c4e89911c56c601522af95e134 |
| packages/desktop/src/main/agent-run-metadata.ts | 1ab3344d5df117d4f064ede2fd344936cbe1e7b4256c09fd7c886e6052e68102 |
| packages/desktop/src/main/project-store.ts | 7a8af164418c7884c55d081e47005ed1f73b018755a650e215e927eee9bbdddb |
| packages/desktop/src/main/agent-bridge.ts | 33c0a745ec8011b3be9d2a798cc9dfcf2c808a204f581d00a7e6a9f73ea2d329 |
| packages/desktop/src/main/agent-bridge-fallback.ts | 554c19e65d41f5ba69ef30034c8cde5a0508c7ef45a83d6a28f6f865acf26a05 |
| packages/desktop/src/main/session-catalog-store.ts | ef65f3a16d50f79abb567a89b94e2e76f442ef2826fe434282fdfd56fe24b4d8 |
| packages/desktop/src/main/session-catalog-ipc.ts | aad3c4b51359942e5d177d4da03963040fdd026dea2bbddf76515d00cbb0cfca |
| packages/desktop/src/main/review-service.ts | bb370d6dba86126fd5ac3c662c0ed99b82a71fae1d5a7c57a17cd5bcefdc71d1 |
| packages/desktop/src/renderer/MessageStream.tsx | b77d1f48611f798d17942030bc6e7d928e581c08216bf470ba9a3aaf7a8798d6 |
| packages/desktop/src/renderer/App.tsx | 556e985d3c0898b5915c713a2a0a280f59bf504b4797e89278143bdcdfd265b8 |
| packages/desktop/src/renderer/sessionUiAuthority.ts | 3c9f357c7e7cc9a52dfab14ca5fcdddcfc3d53712674ff8b969f50351ecf7850 |
| packages/desktop/src/renderer/panels/useReviewAvailability.ts | c25b41aa6099aee42f6786432222fcc0d2cfe7dca94c82d117b9d3e7ba827862 |
| packages/desktop/src/renderer/panels/PanelArea.tsx | b7b292627c1f54b0928983df20c3d85b159fce9729def903800dcef4338f9026 |
| packages/desktop/src/renderer/panels/PanelRegistry.ts | c440f537f5918a16842dd32ca52761e5f54d6b2e2d6e951c48aa6022290fd3f1 |
| packages/desktop/src/renderer/panels/FilesPanel.tsx | 525f58f77436ab8e84f8df46942925feffbd5a118f91556884db924a3d90d0d3 |
| packages/desktop/src/renderer/panels/ReviewPanel.tsx | 38a8cb9839e163b0b64fd6ff3559b9b841ed1db4249a0c6d3f858744aaf2d3f4 |
| packages/desktop/src/renderer/app/useRunController.ts | 5bcf8b21e139ddd644175d0eedd528c7a32789f67771d056c3c71f52bd3cf5b2 |
| packages/desktop/src/renderer/app/usePanelBuckets.ts | 3fd2e6d8b7f37f09e23614278bc1f0f5ee9673f954bacf9b9d0313dd4762887b |
| packages/desktop/src/main/agent-run-metadata.test.ts | 3d3c46e5ccf1b43027eb25968d5c191943fa5865a014f7b289d781064f4a7b27 |
| packages/desktop/src/main/project-store.test.ts | 942aa06f1a1871487c884d95ccb1d6d591b680ea63f9207be34fbfc4b76e0ac8 |
| packages/desktop/src/main/session-workspace-service.test.ts | 3d72ec5f52033278831c40bf2eb25a2c24c3262142f7b0d61bb0b97de9e722a1 |
| packages/desktop/src/main/review-service.test.ts | c3b5c596d6e42e16270772972512277f0bc69c7bf059d2295c075e236a97c363 |
| packages/desktop/src/renderer/panels/ReviewPanel.workspace.test.tsx | c8151db775cdef57e2b55981cc6b5d1ca611fdbf8ef23a8c91f56dc84dc9e69b |
| docs/todo/small-features-2026-07-10/session-fork.md | 36c4759dd9ddc87a07091cddee060936813db24bea274189e5df1a2f5fbac123 |
| docs/todo/multi-folder-local-project-plan.md | 440edd29d618f7871f5e490ebf11afd4df7937bb8b834f64c66dee9c586d7961 |
