# Round26 会话续接静态审查（最终结论）

**正式新增发现0，新增动态执行0；当前总数保持85 findings / 250 tests。** 本轮核查普通 Desktop summary fork、Quick Chat full side fork、Hub export、Desktop retryHistory 的真实入口及迟到/失败保护。仅读冻结 primary84740d56/latest a66f4ef2 产品源码和现有测试源码；只向 owned `/tmp` 写证据，不改产品或主报告，不 build/install，不 import产品，不运行 fixture/guarded runner，不启动 Engine/模型/provider/worker/Git/coding CLI，不访问网络/真实用户 HOME。

本报告是本轮最终结论。先前 `PLAN.md` 是未执行的候选可行性草稿（SHA12d1119c631705b46337b5ad5098f4605608ffc3165b1439a6ef001472da0661），准备于最终强反证之前，原件保留但不代表待收项或通过。只有强 guard 文件复制在本目录（SHA6e1f5f5045f9606086f1b01e6eb988b88c5670f78000b260fcb9e035f1c69b3d），**没有编写可执行fixture，也未安装/执行guard**。该计划不构成产品结果收据。

## Fork→Review：保留体验建议，不列缺陷

源码可推导一个有限过渡：已绑定多根项目的普通 Desktop source 经摘要生成 target 后，首次续聊前 target 缺 state.project；Main Review 按 legacy单 workspace root 解析，所以覆盖范围可暂时缩小。若 main 非Git而 secondary是Git，Review availability 可暂时为 unavailable；source及摘要原文/文件仍在，cwd/workspace继承。该现象没有动态执行，而且当前设计不足以把它判作预期违约，因此不升 R86/P3。

真实生产链：

- `packages/desktop/src/renderer/MessageStream.tsx:322–346` 上下文选择 handler 捕获 sourceSessionId/operation epoch，调 forkSession(mode=summary,闭合range)。摘要成功后 `packages/core/src/session/session-manager.ts:2144–2184` 从真实 source.state 构造新 target；`:2429–2458` 的 buildForkState 明确复制 cwd/workspace/model/provider/origin，创建独立 parentSessionId=null，但白名单没有 project。
- `packages/desktop/src/renderer/App.tsx:2018–2032/2044–2072` 把 target 注册至原 UI project bucket、绑定新的 engine id，保存摘要投影并选择 target；这里不写 Core project binding。摘要读取失败会保可达行供正常重读，不推丢历史。
- `packages/desktop/src/main/session-workspace-service.ts:143–151/209–241` 无binding authority保持null projectId/mainRootId；`:391–394` 明文约定 bound展开当前roots、legacy deterministic single-root；`:396–431` 实现这一分支。`review-service.ts:168–220` 仅发现resolver给出的roots。
- Main `index.ts:6294–6297`（latest）固定 `review:status(sessionId)`，实际preload `project-authority-api.ts:29–30` 与 `useReviewAvailability.ts:30–47` 只传sessionId。UI project roots 只在 opaque workspaceKey 中作为刷新身份，不给Main增权。`useReviewAvailability.ts:23–27` 无repositories/errors判 unavailable；`PanelRegistry.ts:157–168` enabled要求gitReviewAvailable===true。App/PanelArea入口接线为静态证据，没有完整UI实验。

足以阻止升项的正常反证：

1. **空白草稿也先无Review。** `App.tsx:315–325` review hook以activeEngineSessionId为入口；空白尚无engine id时，`useReviewAvailability.ts:63–64/140` 直接UNAVAILABLE。UI归属项目本来不等同于Session拥有多根scope。
2. **既有会话以Main持久化权限为权威。** `sessionUiAuthority.ts:53–58` 明确existing不继承renderer项目路径，草稿才用projectprimary；`:203–224` 保持Main authority的projectId/mainRootId。无binding老会话保单根是明确兼容设计；不能为保持 Review 菜单而主张自动信任 renderer bucket全部roots。
3. **普通fork首次run补绑是已写明流程。** `docs/todo/multi-folder-local-project-plan.md:187/217–221/520/538–541` 明确ordinary renderer fork首run lazy识别并用真实context写binding；旧 `session-fork.md:274–288` 拷贝白名单没有现代project字段。`:304/865` 多repoReview目标未明确要求fork首send前继承scope，没有找到明确现代UX合同反驳该授权过渡。
4. **实际首send恢复链存在（仅静态）。** `useRunController.ts:354–357` 发projectId；`agent-run-metadata.ts:118–150` 对cold persisted target单点lookup后resolveProjectRun；`project-store.ts:655–677` 按persisted cwd精确匹配项目root，保workspace cwd、提供当前context；`core/src/engine/run-session-open.ts:88–93` resume缺binding时真实保存。已有metadata测试`:372+`/ProjectStore测试`:759+` 专门覆盖ordinaryfork，只读源码，不称本轮通过。
5. **Files不是同样的缺根。** UI bucket完整project经SessionPanelDock→PanelArea→FilesPanel；`FilesPanel.tsx:140–153/177–194/320–335` 在sessionMainRootId缺失且source main仍为currentprimary时用project/root fallback，保多根selector及fsRoot读取。child反证详见 `/tmp/session-continuation-round26/fork-binding-counterreview.md`，10文件双树同hash，0执行。Make primary后旧source的rootId/path错配只是另一静态条件边界，没有验证或升项，本轮不扩大为Files全部不可见。

可留给产品的体验建议：在摘要target尚未获得首次run的项目binding时，说明Review当前仅覆盖其工作目录、其他项目仓库将在续聊后纳入；若产品决定fork应立即继承scope，再定义Main认可的绑定事务和相应体验合同。当前证据只支撑这种建议，不建议依靠用户发送一次模型请求作为公开修复步骤。

## 其他路径的正常保护与去重

- **summary迟到/失败：** MessageStream:323–328/346/348–354关联operation epoch/source id，App:2027–2031先保注册但恢复原selection，:2072再次检查shouldActivate；不是只凭按钮disabled推不存在race。R55已有全局导航迟到项与R74摘要取消项保留，不另报。Core selectContextPackage在模型前冻结range，summary成功后才atomic publish；SessionManager:2292–2325 staging/rename/finally清未发布staging为静态保护，不外推OS断电结果。
- **full Quick Chat：** `app/usePanelBuckets.ts:239–307` 持续核creation nonce/claim，迟到结果清理，失败只更新当前nonce；侧会话UI从空messages开始是明确边界。Corefull fork是冻结snapshot，后续parent内容不回灌target，不把此隔离行为当遗漏。没有找到普通顶层full按钮，故不从QuickChat扩大普通Desktop入口。
- **retryHistory：** `ChatView.tsx:1339–1340` 排除historyFailed的新chat英雄分支，:1503–1535始终保失败status/Retry；`app/useTranscriptBuckets.ts:435–449` 未hydrated时增加retryEpoch重试，:465–501页读取Promise.allSettled+generation保护、失败保先前metadata/字节且finally清paging标记，:529–534失败时不被无限spinner遮住。未找到可信新缺陷；未运行现有测试。
- **Hub export：** `hub-export-static.md` 保存完整独立源链。普通静止行固定entry.sessionId构造download href；workspace/project scoping、pairedprincipal/generation再校验、bounded只读snapshot、running409/format400/badline422/限制与finally释放路径成立。导出结果未回写后来活动chat。下载错误在浏览器如何呈现没有原生实验；不能仅凭Hub无toast称新缺陷。R76 async-followup isRunning来源已知不重复。

## 证据范围

`source-manifest-static-final.json` 记录29个主审路径：28个整文件在两冻结树逐字节相同；Desktop Main index整文件因版本改动不同，实际review:status block两树同SHA且分别记录行号。manifest只证明静态读取/hash，不是运行时import graph。child Hub export另10路径同hash、Files另10路径同hash，互有重叠不可相加为动态覆盖。独立最终反证 `/tmp/codeshell-review-20261012-fork-authority-quality-round26.final.md`（SHA5ab007ef246452c1a3e798c2c689a325eb08a55a332313a78e0448dd22a7586e）由root保留，本稿采用其blank/legacy更强最终结论；较早根文件.md为中间阶段，不作为最终结论链接。

本轮没有新增Bun pass/test/expect/Completed、Node业务断言或native收据，不能把已有测试源码写成执行通过。未观察真实Git、Electron、Mainworker、模型摘要、完整App或实际首send。本轮只读结论：可信独立缺陷0，设计/体验观察1，正式总数85/250保持。
