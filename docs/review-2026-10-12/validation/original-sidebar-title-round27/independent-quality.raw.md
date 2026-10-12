# Round27 Sidebar title 独立静态反证

实际clock：2026-10-12 01:17:02 UTC / Asia/Singapore 09:17:02。新增产品import、fixture/测试、Git、模型、worker、Electron、浏览器、账号和网络执行均0；没有修改产品或主报告。当前正式85项=1P1/52P2/32P3、通用85文件250测试保持不变。

## 判断

**仅保留命名来源不一致的设计/体验观察，本轮不正式收项。** 静态链确能说明同一canonical engine Session在Sidebar手动改名后，Sidebar/catalog与SessionsView/Core+title registry可以显示不同名称；SessionsView自身filter可能搜不到仅存在catalog的新名。但普通全局标题搜索SessionSearchModal读catalog，因此可以使用新标题，不能统称“搜索仍旧名/找不到会话”。无执行失败、会话丢失或标题存储失败证据。

合同存在历史争议：June LLM侧栏标题设计明确把SessionsView的另一套session-titles排除在当次改动范围；这是一项历史feature的非目标，并不能证明永久允许manual title不同。当前history rename成功后回填sidebar支持“一次修改同时可见”的方向，但只找到该单向接线/测试，没有当代明确统一全部rename入口的需求。当前architecture inventory说明两处都有rename，没有统一唯一title事实源的合同。因此不凭源码差异直接升P3；若未来明确统一手动命名，可作为迁移缺口跟进。

## 当前生产读写链

1. Sidebar会话右键“重命名…”使用现有Dialog prompt，非空trim后触发onRenameSession。App把callback接useSessionNavigation223–229，调用renameSessionLocal(projectId, UI session id, title, true)。它仅更新对应UI行title/titleManual/updatedAt并saveSessionIndex。
2. 正式Desktop有sessionCatalog bridge时，saveSessionIndex468–475→SessionPersistence.saveIndex270–275→实际Main sessionCatalog:apply→SessionCatalogStore catalog原子patch→changed广播所有主窗口；整个链没有调用sessions:rename/setTitle或写Core state.title。不是只存在当前renderer的localStorage改动；应保留跨窗catalog同步正常对照，不重复R61。
3. SessionsView51–64的refresh并行调用listSessions与listSessionTitles；先以durable session.title建立map，再覆盖title registry。Main sessions:list从Server/storage listSessions导入，当前服务35–109包含现代directory state/transcript，优先state.title/summary。Main sessions:titles读desktop/session-titles.json共享store。它们没有读取SessionCatalogStore。
4. SessionsView96–102只在session id或这个title map过滤；因此若新手动标题只写catalog且与Core/registry旧标题都不同，本页显示/按新名filter不一致。重复本页refresh仍重复这些来源，不会单独修复。
5. 反方向正常控制：SessionsView121–140等待实际sessions:rename成功；Main验证engine id/title后await setTitle。成功callback由App接useSessionHistorySync46–64，按(engineSessionId ?? id)匹配所有loaded aliases，写catalog titleManual=true。此处没有回调到另一轮rename IPC，避免重复写。现有tests164–178覆盖canonical aliases/同名UI id绑定别处时的隔离，属于只读测试源码，不是本轮动态通过。
6. 自动session_title流只更新catalog；useHostSubscriptions348–363检查titleManual，正常保护手动Sidebar标题不被自动覆盖。该保护不能替代registry同步，但能排除“下轮LLM必覆盖手工新名”泛化。

源码（Main index行号按latest；initial对应列表6735、titles6851、rename6852/setTitle6857，latest为6741、6857、6858/6863）：
- [packages/desktop/src/renderer/Sidebar.tsx:317](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/Sidebar.tsx:317)
- [packages/desktop/src/renderer/App.tsx:2223](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2223)
- [packages/desktop/src/renderer/app/useSessionNavigation.ts:223](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:223)
- [packages/desktop/src/renderer/transcripts.ts:1017](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/transcripts.ts:1017)
- [packages/desktop/src/renderer/transcripts.ts:468](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/transcripts.ts:468)
- [packages/desktop/src/renderer/sessionPersistence.ts:270](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionPersistence.ts:270)
- [packages/desktop/src/renderer/sessionPersistence.ts:334](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessionPersistence.ts:334)
- [packages/desktop/src/main/session-catalog-ipc.ts:33](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-ipc.ts:33)
- [packages/desktop/src/main/session-catalog-ipc.ts:45](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-ipc.ts:45)
- [packages/desktop/src/main/session-catalog-store.ts:126](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-catalog-store.ts:126)
- [packages/desktop/src/renderer/sessions/SessionsView.tsx:51](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessions/SessionsView.tsx:51)
- [packages/desktop/src/renderer/sessions/SessionsView.tsx:96](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessions/SessionsView.tsx:96)
- [packages/server/src/sessions-service.ts:35](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/sessions-service.ts:35)
- [packages/server/src/sessions-service.ts:89](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/sessions-service.ts:89)
- [packages/desktop/src/main/index.ts:6857](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6857)
- [packages/desktop/src/main/session-titles-store.ts:1](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/session-titles-store.ts:1)
- [packages/desktop/src/renderer/sessions/SessionsView.tsx:121](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessions/SessionsView.tsx:121)
- [packages/desktop/src/renderer/app/useSessionHistorySync.ts:40](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionHistorySync.ts:40)
- [packages/desktop/src/renderer/app/useHostSubscriptions.ts:348](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useHostSubscriptions.ts:348)

## 正常搜索、恢复与范围排除

- SessionSearchModal54–81的普通标题模式直接从props.sessions/catalog构造hits并匹配session.title；Sidebar rename后这个已加载入口应显示/搜索新名。App2690附近传sessionIndices，非title registry。不得把SessionsView局部filter的不一致推广为全局标题picker失效。
- content mode结果标题为match.title（SessionSearchModal201），来源另有搜索服务，本文未完整审其目录/查找合同，不增加“全文搜索标题也错误”的独立项。
- SessionsView内再次手动改成新名的正常成功路径可使registry和loaded sidebar一致；这是源代码确认的公开恢复，不是本轮用户动作/文件持久化验收。仅刷新history不会读catalog。UI id与engine id不同必须分别使用，各链当前用途不可混同。
- 当前Server/storage listSessions已支持现代目录。PIPELINE-SUMMARY-QCLIFE138–139说仅旧flat是历史阶段说明，被当前实现和其测试15–42反驳，不能据此称普通现代Session根本不在history。空草稿、ephemeral/qchat/pet/child被筛除不在本观察必要前提。
- 当前设计在June明确另一套title存储：llm-session-title-design.md24与plan414；这是旧feature非目标，既不证明当前必须统一，也不授权把任意老实现自动当bug。

## 去重与后续判断门槛

R46是自动化历史按名称/日期错误认领真实运行，而非用户同一Session title override双来源。R71是项目重命名Store拒写后UI仍乐观显示成功；本观察没有拒写或失败回滚，是普通Session标题来源一致性。R61跨窗catalog广播已存在，Sidebar rename同project多窗口正常投影不能重复作缺陷。此前R17 SessionsView标题拒写保稿/原draft重试是正常控制，不证明Sidebar反向同步也有合同。

本轮保留0finding。若未来要求统一标题，应由canonical engine id对接可信Main title store，保留draft尚未有engine id的状态以及catalog aliases语义；不能将UI本地id直接写入engine registry。应以成功Sidebar改名→当前history row/局部filter→全局titlepicker正常→history rename恢复的完整对照核查，但本轮没有执行或编写fixture。

## 来源收据

20个相关完整文件两冻结树均SHA256相同（不含Main/index，后者只核对应callback行号/内容，不能声称整个文件相同）；这是字节来源审计，非module-cache/importgraph或动态测试收据。

| 文件 | SHA256（两树相同） |
|---|---|
| packages/desktop/src/renderer/Sidebar.tsx | 70fbf9da8fa31bcf6d5de1f3f1855623872255b3a944b15468f647541f84cf95 |
| packages/desktop/src/renderer/app/useSessionNavigation.ts | 46ac89b4175e425f7b32e1e7aa24d16bb1bd6b0cf5e79817c0bd9a3a6c1b668f |
| packages/desktop/src/renderer/transcripts.ts | fc74dcbf603c15d9bb27da517ff46b0a7805811e712a0e6a29d5cfb3a974c100 |
| packages/desktop/src/renderer/sessionPersistence.ts | faaa9b7ca3e2b2140542aef7d839a230726a11c19c7f52c1103e68bd1f6f7197 |
| packages/desktop/src/main/session-catalog-ipc.ts | aad3c4b51359942e5d177d4da03963040fdd026dea2bbddf76515d00cbb0cfca |
| packages/desktop/src/main/session-catalog-store.ts | ef65f3a16d50f79abb567a89b94e2e76f442ef2826fe434282fdfd56fe24b4d8 |
| packages/desktop/src/renderer/sessions/SessionsView.tsx | 703caed4accc49ee7bbfe19830a63505c8300ed5472656e0f91095a764b417b1 |
| packages/desktop/src/renderer/app/useSessionHistorySync.ts | 46208d004433ecee2993c7db0a5ac60492f7d09f9ee1ce1aa3628f9016a65b31 |
| packages/desktop/src/renderer/app/useSessionHistorySync.test.tsx | cd4e2a3c56dfebac63e2e000836b450725c753954a2e6106ac485c649955ddd5 |
| packages/desktop/src/renderer/shell/SessionSearchModal.tsx | 6fa8dedc538efb70a859e9ba00abb85b756e518de3f95f369a6080b80fd4806a |
| packages/desktop/src/main/session-titles-store.ts | 5c7ea7233f145105a79886d570d0735e8d66c1a90ab9495f9ed054d85bc374d7 |
| packages/server/src/session-titles-store.ts | 3cb24ac45af55b69eac3bdb8e369d24ad647a7ae7b35fc89186535d786446ba0 |
| packages/server/src/sessions-service.ts | 8be914ac63c6f235474eb07b5220f18a66d4d645c938beb05574e8eacacb5720 |
| packages/server/src/sessions-service.test.ts | 95a9fbb1b9ec3c8e90847f1c110d198297e3cbc2f0e23a4c07f0a641a72d88c8 |
| packages/desktop/src/renderer/App.tsx | 556e985d3c0898b5915c713a2a0a280f59bf504b4797e89278143bdcdfd265b8 |
| packages/desktop/src/preload/index.ts | b85c80ec01b488890fcfad0e9afed4fb1e02575dcba8e30cce8a06805ed44327 |
| packages/desktop/src/renderer/app/useHostSubscriptions.ts | 86d9d570eb165c07884ccdebcc70aefb8fe7e8b39f2627868528e887ccdb70e8 |
| docs/superpowers/specs/2026-06-01-llm-session-title-design.md | 3a76932b98d95a754e34ca5b8f2577c742d5408447982b8c7e9d4173963203e4 |
| docs/superpowers/plans/2026-06-01-llm-session-title.md | 7188b7bf1cf31cd27cf38d7115ad0019f6801dddbdb85fe7d6fd68ce2507a090 |
| docs/architecture/11-feature-inventory.md | 0ea7108761765306bdcdda84e132f515abdcec1add669e0b5b7e42026ab9903b |
