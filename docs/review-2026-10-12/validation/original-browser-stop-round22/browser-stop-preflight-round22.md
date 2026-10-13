# Browser Stop round22 native 方案：独立只读预审

Completed；**新增执行0**。没有转译、prepare、launch、调用Core/worker、运行测试、打开浏览器、访问网络或模型。只读两份草案及maintained harness/相关产品源码，并核对文件SHA；未改产品、主报告或fixture。本预审不构成执行授权，也不把计划中的断言记为通过。最终freeze/launch由root决定。

审查对象：

- [browser-stop-native.mjs](/tmp/codeshell-review-20261012-browser-stop-round22/browser-stop-native.mjs)
- [owned-main-template.mjs](/tmp/codeshell-review-20261012-browser-stop-round22/owned-main-template.mjs)

native前预审定版与root及作者提供的SHA一致：launcher `4ef5e9d78f48adc82b6b27e81f697f5988adec013f62e959b60906b48491159e`；owned Main `e57ae6c2d1ded39484bd2f6adf9a1a956a09fffccaacf8d909fb64b12796b424`，已归档至 `before-first-native/`。此前已核 `4c47caf…/7d92918…` 的显式deny修订；该定版又采用actual active-guest registry与一致sessionDiskRoot。下面原预审正文的SHA/行号以此定版解释，新增失败诊断和修订见末节，不把旧稿称作后续最新版。

本次追加0执行核验读取的修稿先为launcher `bdca43c4b6334862352174f94da6fa49449cb8ca04d51142e9847a47defd9095` / Main `17a4e8cc5b245049ba954188741c04b2914d1a376d4f9e79c74f301e03a13258`；随后按root指示核Main `b98589874b1f933d6f2efcd0eb6391b32747c6283530634c0a5dd3fdb2b021ad` 的真实ToolSearch发现增量；最后读到launcher `11bc7a9cf31d53a69c55191b89fe08d621e4857621175841bb13a446d97c320d` 的preload回包断言增量。尚不把这些正在调试的版本或任何未审收据称作成功freeze；后续动态质量审计另计。

作者已经执行一次prepare-only；本审计读取其receipt，**没有执行该准备**。receipt为 `prepareOnly:true/completed:false/failure:null/assertions:0`，HOME为 `/private/var/folders/1d/6__4f4y51g90nblfptt8s9v80000gn/T/codeshell-browser-stop-round22-dSiWKH`，当时有意保留，后续 `prepare-home-cleanup.json` 记录removed=true/nativePidCreated=false。它是生成物准备收据，不是native运行或Core断言通过收据；真正run另建HOME。root负责运行决定，本审计没有launch授权或执行行为。

## 总体判断

方案的证据链方向正确：实际Core/Engine+内存provider产生正式browser工具请求，抽取的实际Main browser handler路由到实际runtime/adapter/Puppeteer，再由owned Chromium DOM记录输入；Stop经过实际preload、native IPC及抽取的Main IPC callback回到实际Core。真实driver的disabled readiness等待提供窗口，没有人为挂起Host promise。

这仍不是完整产品App、完整AgentBridge实例、真实stdio worker、Chrome扩展或真实模型E2E。正式Renderer Stop按钮/App接线来自前一份静态审计；这里动态调用 `window.codeshell.cancel`，不点击完整产品UI。`startRun`直接投递owned Core transport，未经过preload.run/Main run metadata/真实worker。最终报告必须逐层保留这些限制。

截至上述SHA，root列出的隔离/接线改项已补入；此前HTTP dummyorigin开放建议也已落实显式deny。以下保留证据层次收窄。本文件不预测测试一定成功、不评级产品候选。

## 守卫顺序与范围

1. 外层脚本要求maintained `run-isolated-node-smoke.mjs` 的HOME标识；再用maintained `makeIsolatedElectronHome/prepareConfinedElectronFixture` 创建独立Electron HOME、应用数据与guard receipt。真实HOME隔离依据仍应由启动环境及最后收据验证，而非仅靠字符串标识。
2. owned Main先设置专用app name、userData、sessionData，导入 `guarded-runtime.mjs`，再补net.connect/createConnection、Socket.prototype.connect、tls.connect、fetch、http(s).request/get、child_process、utilityProcess guard、`syncBuiltinESMExports`，再进入jiti Core/Desktop源码evaluation。顺序上没有Core/Host import早于这些补丁。上述SHA还检查HOME/TMPDIR/TMP/TEMP并在产品导入前 `process.chdir(cfg.project)`。
3. defaultSession在Core导入前安装Chromium `onBeforeRequest`；target的自有partition在 `loadURL`前安装同一精确file URL允许表，control使用已保护defaultSession。仅允许两份owned HTML、拒window.open及其它导航；CSP不允许connect或外部资源。不是先加载网页后补guard。
4. child_process/utilityProcess补丁阻止owned Main里的真实CLI/CodeShell worker/native utility启动；esbuild的本地安装服务发生在外层准备阶段，是明确的工具链例外，不能称整个脚本从未产生任何子进程。
5. 这些是应用级守卫，不是OS全面网络/进程sandbox。不能据它们宣称所有Node原生接口、所有Chromium内部后台流量、独立worker_threads或任意已捕获transport都被完全隔离。当前受控图没有这些主动路径的证据，但不能把没有观测扩展成全面覆盖。

**此前网络开放建议已关闭（源码核实，非执行通过）：** maintained bootstrap仍以 `http://127.0.0.1:9`生成receipt，但[owned Main:26](/tmp/codeshell-review-20261012-browser-stop-round22/owned-main-template.mjs:26)已覆盖 `globalThis.fetch`，`:27–29`覆盖http(s).request/get：先记录 `highLevelNetworkAttempts`，随后直接throw，没有转调dummyorigin允许表或任何原request。`:23–25`另deny net别名、Socket.prototype.connect及tls。Core/Desktop imports在`:71–77`，位于这些补丁之后。因此这些显式入口对本实验不再允许dummy HTTP；最终断言高层/低层数组为空可记录被监控入口没有尝试（仅在实际运行通过后）。仍不能把这称为OS全面隔离：Electron `net`、其它原生接口及Chromium内部流量不由这两个Node数组完整覆盖，需保留本节第5点和真实receipt范围。

## 已修与仍需注意的fixture接线

| 项目 | 最后核读状态/边界 |
| --- | --- |
| source与dist图混用 | Desktop不再使用原整图bundle作为Core依赖；jiti aliases指向冻结Core/internal/extension/server-worker/CDP/link源码，实际Core factory与provider共享同一jiti图。preload仍单独由实际source bundle到owned temp，这不等于复用已发布完整Desktop包。 |
| 空模块图收据 | 已新增关键Core server/Engine、Desktop runtime/background/adapter/driver必须出现在jiti cache的断言，再检查无dist/无operator checkout，避免原 `.every([])`空通过。它仍只是jiti所记录的workspace模块，不是所有native/预加载bundle依赖的完整证明。 |
| IPC handler的this | `bindIpcHandler(deps)`返回实际listener注册函数，随后`.call(receiver)`执行，抽取闭包里的this指向receiver；不是只创建函数未安装IPC。 |
| logical Core backend | 新稿`canSend:true/hasChild:true`一致，注释说明logical live backend由in-process transport代替stdio；没有真实OS worker。不能把hasChild:true写作真实worker存在。 |
| Session authority | 新稿断言 `legacyUnbound:true`；实际SessionManager.create持久session本来有合法SessionWorkspace `{root,kind}`但没有project binding。这是合法legacy/unbound scope，不是完整绑定项目的WorkspaceContext。不要称已动态覆盖bound Desktop Session；相关路径无binding分歧仅可静态延伸。 |
| private TMP/CWD | 新稿独立temp目录传TMPDIR/TMP/TEMP，owned Main检查并chdir owned project；外层转译读取冻结repo、只写owned输出，未产品build/clean。 |
| 准备失败清理 | 已将owned HOME创建后的prepare/转译包在外层try中，preparationComplete前失败清理；prepare-only成功有意保留供root检查，不是完成运行后的cleanup。 |
| 运行清理 | shutdown有界；即使失败也独立尝试app.close；等close receipt，必要时只对owned Main进程SIGTERM/SIGKILL，强制close不能算Completed。app.close自身的等待仍依赖Playwright/上层有界运行；记录Main退出不能额外声称已独立检查整个原生进程树全部退出。 |

`prepareConfinedElectronFixture.assertWorker(requireWorker:false)`在此owned Main下主要验证Main guard receipt。maintained helper的worker记录补丁位于它生成的guarded-main，当前启动的owned-main没有那段spawn记账；空spawned-workers文件得到的`workerCreated:false`不能单独作为主动探测所有worker的证明。本方案“不启动CodeShell worker”的实质依据是owned Main无真实AgentBridge worker构造、child/utility deny、ensureWorker抛错、显式in-process transport。收据与这些源码依据应一起描述。

## 真实依赖与替身层次

- 实际：AgentServer、ChatSessionManager、Engine、SessionManager、工具registry/browser tools、真实preload RPC与Electron contextBridge/native IPC、实际Main browser action和IPC listener源码闭包、DesktopBrowserRuntime/BackgroundBrowserRuntime、Electron Puppeteer adapter/shared driver、owned BrowserWindow/Chromium DOM。
- 受控替代：LLM内存provider；Engine hooks显式清空；固定bypassPermissions模式；stdio由owned in-process Core transport替代；AgentBridge receiver只提供当前分支所需对象；root/start请求直接deliverCore；默认BrowserHost `openHost`由fixture创建BrowserWindow、调用实际 `buildWindowOptions`及精确URL防护替代，而非完整production `openBrowserHost`。
- 原预审定版SHA已移除原fixture `profile === sid`→partition resolver。[归档owned Main:107](/tmp/codeshell-review-20261012-browser-stop-round22/before-first-native/owned-main-template.mjs:107)调用实际 `registerSessionBucket(sid, "__no_repo__::" + sid)`，`:158`只给DesktopBrowserRuntime提供owned targetPool；[InAppBrowserBackend:47](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-runtime/in-app-browser-backend.ts:47)因此走actual `partitionForSession`。实际[active-guest.registerSessionBucket:107](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-driver/active-guest.ts:107)验证partition并绑定workspace registry。这是实际profile lookup，不是完整App建立workspace/guest授权；注册本身仍是fixture准备，不创建用户guest或登录数据。
- [归档owned Main:197](/tmp/codeshell-review-20261012-browser-stop-round22/before-first-native/owned-main-template.mjs:197)给AgentServer的 `sessionDiskRoot`显式设置为实际SessionManager storageDir，与Engine`:166`一致。增强磁盘权威一致性；不扩大legacy/unbound fixture为bound完整Desktop Session动态验证。后续只读diff没有移除这两项接线。
- DEFAULT_POLICY是现有合法默认（allowedDomains空表），不伪造安全批准；owned按钮标签不敏感，页面只递增内存hits。不能将其扩展为真实支付、删除、认证或高风险权限绕过。
- 已有task-owned runtime通过seedLease载入owned file，后续正式dispatch按同一session/owner取得target。seed是可控准备；不能称真实App UI完成建会话、授权、导航。Main dispatch仍检查显式handoff/Chrome分支；本场景不建立那些grants，结论限默认parent target。

## 输入尚未发出的证据设计

方案先等实际browser request处于未settled、真实driver `waitForFunction` readiness未settled、Core pending=1；再同时取DOM disabled/hits=0及debugger所有Input命令数组为空。Stop调用返回后等实际Engine run settle、abort结果、busy=false、pending=0，并再次断言DOM未点击、Input命令仍0。然后才由owned页面解除disabled。

新稿用owned Main统一eventSequence记录Engine settle、enable、Input提交，避免 `enabledAt > settledAt` 的毫秒同tick假失败；DOM事件时间用于补充顺序。最终若通过，将证明动作输入在实际Core Stop结束之后才发出，区别于“Input已发出、只是结果晚到”。严格时序仍需真实日志才能判定，当前为预审。

observational wrapper原样调用真实 `frame.waitForFunction(predicate, options, ...args)`，追加receipt与then，不返回手工deferred promise、不替换predicate、不延长驱动12秒timeout，故不会制造disabled等待。原稿direct control重复包装同一个frame会重复记录wait，已改WeakMap单次包装、动态label；本候选主case在direct control之前，决定性观测不受后续control复用影响。标签仍是观测上下文，不能将wait数组长度计为动作数量；normal恢复case应以独立request/DOM/Input收据判断，不凭标签计数。

direct AbortSignal control建立另一driver但复用同一真实page，证明共享库在显式signal下会停止尚未提交的click且页面存活；不是生产Main自动接到了Core signal。后续新user turn、已提交input后Stop的对照分别验证目标可继续显式使用及Stop不回滚旧副作用。三者不可合成“Stop保证事务回滚”。

迟到approve应在Core原pending已清后被拒绝、模型调用不再增加；这保护旧回包不成为新任务答案，不能因旧Host动作继续而称跨会话执行或继任意图污染。每项还只是计划断言，未通过前不写入正式影响。

## 预审冻结边界

原预审定版固定为开头已归档的两个SHA，追加核验另列修订版本与范围。已把未覆盖注意点实时发root，不代作者修改文件。HTTP建议已解决，profile resolver亦已改actual registry，不再列开放阻碍；targetPool/openHost与in-process stdio等明确seam仍保留。后续成功运行的cleanup、native assertion数及所有receipt仍须另审；prepare-only不能代替run，“原生实验成功”与“契约/分级成立”仍是两次判断。

现阶段结论：**方案可用于验证自然ready期间取消传播；已审的失败运行未进入该前提，尚无成功Stop结论，不新增正式发现或评级。** 与上一份Stop静态审计一致，普通lease.release允许inflight完成不能替代用户Stop语义；可选driver AbortSignal支持也不能直接替代生产接线和影响证据。

## native支架失败与后续只读修订核验

本节是root授权的新增只读审计，执行仍0。只读取作者保留的失败source/log/cleanup/diagnostic；不把它们作为产品Stop缺陷证据或通过测试计数。

| 作者归档 | 原始结果 | 能支持的结论 |
| --- | --- | --- |
| `first-native-failed/` | 0 assert；startup evaluate发生精确Execution context destroyed；cleanup close code0、HOME removed=true，shutdown因global未ready报错另记 | 支架尚未取得全局观测对象，未进入Stop实验；没有成功证明产品失败。 |
| `second-native-failed/` | 15个prefix assert；actual readiness wait未达到；close code0、无cleanup error、HOME removed=true | target/基础隔离prefix成立，browser click前提没有成立。 |
| `third-native-failed/` | 15个prefix assert；只读info evaluate精确context destroyed；close code0、HOME removed=true；诊断snapshot有browserRequests/waits/Input空、modelCalls0/auxiliaryCalls2、owned auxiliary完成 | 不存在被本次收据证明的pending click，更不能将context诊断写成Stop失败。 |
| `fourth-native-failed/` | 15个prefix assert；readiness前提未达到；harnessContextRetries为空、close code0、HOME removed=true；providerRequests主声明含ToolSearch等常驻工具、没有browser_act，另一aux声明为空 | 真实延迟工具发现未由原memory provider执行；尚未测试候选动作。不是产品browser工具永久不可用。 |

**Host配置修订：** Main `builtinToolHost:"desktop"`与生产[agent-server-stdio.ts:190](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:190)、[同文件:305](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:305)一致，是实际Desktop worker配置对齐，不是把availability改为恒真。原fixture已有固定enabledBuiltinTools/bypassPermissions模式；本修订没有删除ToolExecutor、Main browser policy或grant检查。单独host对齐并不能消除deferred schema，第四receipt已保留这个反证。

**只读重试修订（launcher bdca43…及11bc7…）：** 只把 `info()`读取包在初次调用+最多3次重试中；仅匹配精确 `Execution context was destroyed, most likely because of a navigation.`且owned进程未退出才重试，每次写harnessContextRetries。其它错误仍抛。`call(method,arg)`和native preload cancel均未重试；startRun、enable、abortDirect、resumeControl、shutdown等mutation没有被自动重放。新增firstWindow等待、stdout/stderr/startup-error/failure-snapshot只用于支架诊断，没有替换真实ready/predicate/timeout或注入Host异步gate。info读取仍只是已注册全局对象的状态观测。

**真实发现修订（Main b985898…）：** memory provider依据[CreateMessageOptions.requestBoundaryId:9](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/llm/types.ts:9)区分main facade与aux；[ModelFacade:116](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/model-facade.ts:116)和`:222`确实给主调用标记。若主schema还无browser_act，provider先要求当前schema有ToolSearch，再产出正式ToolSearch `select:browser_observe,browser_act`；只有后续schema出现browser_act才消费原snapshot/click计划。实际[ToolSearch:93](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/builtin/tool-search.ts:93)经runToolSurface.select装载当前eligible工具，`:136–143`仍保留visibility/browser guard；fixture未直接调用select私有对象、手工注册browser schema或在没有声明时伪造click执行。这是内存provider替代模型作出合法工具选择，不是绕生产发现门禁。

**preload回包断言修订（launcher 11bc7…）：** 读取期间新增diff仅将两处Stop期望从裸 `{ok:true}`改为实际preload完整JSON-RPC envelope的`.result`，首处还检查jsonrpc/id/error。此更正不改变RPC、取消时序或mutation执行，不把之前错误期望造成的失败当成产品结论。该增量只读已告root；未在本节审查后续成功收据或给严重度。

以上修订对自然wait的实现、DEFAULT_POLICY、显式Node deny、owned target、actual registry、sessionDiskRoot、Core取消逻辑均没有改动；原生运行仍由作者/root负责。后续最终freeze与成功receipt应另做动态影响/分级审计，不把此前不同版本或失败prefix断言累加为正式suite。

Completed，审计执行0，产品/主报告修改0。
