# R27 会话标题静态预审（阶段稿；未升项）

正式计数保持85/250。本稿新增fixture、产品import、网络、Git/worker/模型/provider、构建安装及动态验证均为0，产品和主报告未修改。当前按root优先级转查更明确的Files根映射边界，标题主题完整保留在此，不启动fixture。以下是源码可达的显示差异及合同反证，不是正式发现或执行结果。

## 真实入口与窄候选

普通已持久化Desktop native会话（新建路径UI id==engine id，无旧alias条件）在Sidebar右键“重命名会话”成功持久化新title，然后打开本机历史SessionsView；侧栏显示新title，历史仍读旧Core title或独立title override，按新title搜索不能命中。窗口刷新、正常catalog ACK不会改历史标题来源。只指SessionsView局部标题搜索，不指全局全文搜索、不称历史/原文丢失。

- `Sidebar.tsx:317–331` 普通行菜单调用actual DialogProvider.prompt，要求非空trim后onRenameSession；`App.tsx:2223` 接真实useSessionNavigation handler。
- `app/useSessionNavigation.ts:223–229` 只 `renameSessionLocal(projectId,uiId,title,true)` 后setSessionIndices；`transcripts.ts:1017–1037` 写title/titleManual/updatedAt，:468–475交给当前SessionPersistence.saveIndex。
- `sessionPersistence.ts:62–103/270–275/334–342` 生成字段patch，经sessionCatalog:apply保存；`main/session-catalog-store.ts:121–166/179–207` 实际原子catalog写与onChanged；`session-catalog-ipc.ts:33–35/45–53` actualapply只调用catalog、广播sessionCatalog:changed，不调用titleStore。
- `SessionsView.tsx:51–64` freshmount/刷新只并行读listSessions与listSessionTitles，然后registry覆盖Core durabletitle；:96–102filter匹配engine id或这个titleMap。:313–315实际行呈现也用该map。
- Main `index.ts:6741` 的sessions:list直调server listSessions，`server/src/sessions-service.ts:35–109` 只读会话state/transcript，从state.title/summary得fallback，未消费catalog。Main:6857–6864另有sessions:titles/rename的真实独立registry入口。
- `desktop/main/session-titles-store.ts:1–14`是sharedserverstore adapter，默认desktop/session-titles.json；`server/src/session-titles-store.ts:133–188`list/set只操作该map，无catalog联动。
- 普通新建真实identity说明 `useRunController.ts:234–247` 新UI Session直接作为engine id；legacy不同id不必加入触发。无Engine执行需要，fixture可actualCoreSM.create同真实UIcreate生成ID。

## 反向正常同步、重载和跨窗口反证

- 历史页改名 `SessionsView.tsx:121–155`等待actualrename成功才通知host/改自身title；Main写独立registry。`App.tsx:1343–1359`连接 `useSessionHistorySync.ts:46–64`，按canonicalengine id遍历所有UIaliases，renameSessionLocal(...manualtrue)反写catalog。因此history→sidebar明确存在，不应误称两向都不同步；已有R71专项正常EACCES保稿/同值重试已执行，本轮没有复跑。
- `SessionPersistence.initialize:205`订阅catalogchanged；:278–305只重投影catalog；`useSessionIndices.ts:25–35`更新Sidebarprojection，跨window同步的是catalog title。SessionsView没有订阅catalog/storage/hosttitle事件，且即使重载/点击refresh仍从旧两API读。没有找到隐式catalog→registry提交。
- `useHostSubscriptions.ts:348–364`自动session_title会检查titleManual后拒绝覆盖手改，因此自动标题不是反向修补；它本身也只调renameSessionLocal。Coretitle后台持久值不会因这一manualflag变为用户新title。
- `useAutomationSessionImport.ts:127–165`已知engine/UI id在diskimport中被跳过，保较丰富catalogmetadata，不会把titleStore写回。未知disk导入仅补missingrows，不补registry。
- 同一index允许UIalias是兼容模型，但候选首场景选现代同IDnative，避免把局部alias语义混入普通用户rename。

## 合同争议与去重

- **实质设计反证：** `docs/superpowers/specs/2026-06-01-llm-session-title-design.md:19–25`目标只修LLM自动Sidebartitle，明确非目标“不动desktop/session-titles.json（SessionsView用的另一套，与侧边栏localStorage独立）”。这证明历史双store并非新引入。它是旧自动标题feature范围，没有明文承诺手动rename永久仅为Sidebaralias，也没有明文要求后续合并。
- `transcripts.ts:1–21`仍明确Sidebar shortlabel/本地UIid模型；不能单凭同样叫title就否认可能局部alias设计。另一方面现代SessionsView成功rename回写所有canonicalaliases，使用户可合理预期同会话命名一致，但此为体验推断，尚需主审裁定。
- `docs/todo/codeshell-hub-iteration-design.md:72`与hub-usability-polish:22说共享会话标题/设备同步，背景主要Desktop配对Web与Hub。不能直接套为普通ElectronSidebar两个UI入口的明文合同。
- UI两个入口文案均“会话标题/重命名会话”，history搜索placeholder明确“搜索会话id或标题”，见i18n/core.ts:143–145/automation.ts:285/302/306。这支持改进一致性/解释局部alias的UX建议，不单独证明存储合同违规。
- R46是automation按名称/时间关联漏ID；本题普通native不涉及cron认领。R71是项目rename拒写后假成功；本题catalog真实commit正常，不涉及拒写。R75是跨window模型偏好旧整图覆盖；本题两独立title权威来源且现代catalog字段patch已有保护，不能重复算同一根因。

## 若后续授权的最小可行性（尚无fixture源码）

可复用R17已经源码审查过的actualSidebar/DialogProvider/useSessionNavigation/useSessionIndices挂载方式，但换成强guard（round23/25 SHA6e1f）、maintained runner隔离HOME，禁止网络/child/Git/模型。只owned/tmp写；guard第一import在所有Core/Main/UI import前。

实际SessionManager/Transcript生成合法当前nativeSession，actualrenderer createSession+bindEngineSession建立同id UIrow；actualSessionPersistence→actualSessionCatalogStore/IPC+preload bridge保存，并flush证明catalog新title。actualSidebarprompt触发正常rename，actualSessionsView读取实际server listSessions(ownedroot)+actual titleStore，先观察旧title及新titlefilter0match；正常control在actualSessionsView改名，通过actualMainrenamecallback和actualHistorySync回写catalog，再refresh搜索命中，同id原transcript bytes保留。

可以source-AST提取Main三个小IPCcallback并记录exactsource，避免加载完整ElectronMain；传输和window为controlledseam，不能称完整App/Electron/native跨window。@UIleafalias需按root/作者目录可移植策略明确forward实际exports，MiniDom仅DOM环境。source/dist provenance、ownedpaths/isolatedHOME、phase、attempts/cleanupafterAll早注册，失败全件保留；未经root审完最终源码/guard禁止运行。鉴于两store旧设计争议及当前优先方向，本轮不准备或执行此fixture。

本题当前正式新增0、动态0，待root对设计/体验边界裁定；优先Files根映射主题不改变此稿结论。
