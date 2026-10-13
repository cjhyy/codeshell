# 第二十二轮：原生 parent Stop 与 Browser 输入提交边界

2026-10-12 SG07:27；作者只在 `/tmp` 写夹具/证据，产品冻结树未改。结论为 **R81 / B22-1 / P2，主审两基线独立复跑后收录**：原生 Core Stop 已真正终止旧 turn 并清空其 pending Browser request 后，Main 中已派发、仍在真实 Puppeteer readiness 等待且从未提交输入的 click 未被取消；按钮随后可用时，旧点击仍提交真实 Chromium Input 并触发 DOM handler。这个结论不包含回滚已提交动作，也不把跨 turn 保留 task target 本身当缺陷。

作者最终 maintained native **exit 0 / Completed / 66 Node assertions**。前三种正常边界也在同一次最终运行通过；没有增加 Bun 测试或启动真实 worker、模型服务、CLI、operator Chrome、账号或外站。前六次支架失败单独保留，不算成功、不累计断言。

## 冻结证据与复跑入口

最终作者目录：`/tmp/codeshell-review-20261012-browser-stop-round22/final-author/`，包含：

- `browser-stop-native.mjs`：SHA256 `11bc7a9cf31d53a69c55191b89fe08d621e4857621175841bb13a446d97c320d`。
- `owned-main-template.mjs`：SHA256 `1f9213c591383ae16b4ac41adaabcce8be298fcf143503909eb067cc7dbaf26b`。
- `source-manifest.json`：SHA256 `04d62a7de557f8f01c29d925227ddafddf3b51da34939d483a26ee16c663656e`；含本次 private config、冻结 repo 和十二个关键产品 source 哈希。
- `native-observations.json`：完整三个场景、前后 Core/Host/DOM/真实 Input/模型调用/guard 信息。
- `summary.json`：从完整收据提取主要观测，方便核对；不取代原始 JSON。
- `seventh-native.log`、`owned-native-stdout.log`、`owned-native-stderr.log`、`cleanup.json`。

从待审冻结 repo cwd 运行，先复制两个源入口到新的 owned evidence 目录，避免覆盖作者收据：

```sh
node scripts/run-isolated-node-smoke.mjs /tmp/OWNED-REPRO-DIR/browser-stop-native.mjs
```

源码从 `process.cwd()` 解析；两个入口必须同目录。只在 maintained runner 中运行，脚本主动检查隔离 HOME。所有转译产物写 private HOME；不 install，不执行产品 build/clean，不写产品 dist。作者只在 latest `a66f4ef291f304ee4df9da8095a90671d9a8f140` 运行，初始 `84740d56e55517b004948a0a0e07649ad6fbf998` 现已由主审独立复跑Completed，分账见末表；作者本人未在初始基线执行。

## 触发条件与正常生产门禁

普通 Desktop 原生 Session 在浏览器点击已获合法 ref/当前权限、进入驱动等待按钮 enabled/visible 的自然窗口内按 Stop；页面随后自己将按钮启用。运行期间 target 没有关闭、导航、撤权或被接管。按钮无需敏感名称或特殊权限。测试载体是 owned 本地 HTML，按钮初始 disabled，用户可见实际网页中的动态加载/启用是相同 readiness 条件。

产品链：

1. `packages/desktop/src/renderer/app/useRunController.ts:968` 选择 engineSessionId，`:975` 清 UI busy，`:984` 写 stopped，`:985` 调 `window.codeshell.cancel(engineSessionId)`。本轮只读核这条 React UI 接线；未挂完整 App 或真实 Stop button。
2. actual preload `packages/desktop/src/preload/index.ts:554` / `:563` 将原生 Session Cancel 发为 `agent/cancel`。外部 runtime 的另一分支不在本候选。`:365` 明确 rpc 返回完整 JSON-RPC envelope，最终断言实际 `.result.ok` 并核 envelope/id/error。
3. actual Main `agent:msg` callback 在 `packages/desktop/src/main/agent-bridge.ts:912`–`:915` 转发到 backend；本实验提取并运行**完整未改函数体**，不是另外仿写一个取消 handler。
4. actual Core `packages/core/src/protocol/server-run-controls.ts:108` 调 ChatSession.cancel，`:115` 取消 session approvals，`:116` ACK。`chat-session.ts:277`–`:284` 增 cancellationGeneration/abort 真正的 run signal；不是只让 UI 变 idle。
5. actual Engine main 模型请求使用全内存 LLMClientBase；正式 Desktop Host 值按 `packages/core/src/cli/agent-server-stdio.ts:305` 设置 `builtinToolHost:"desktop"`。general preset Browser schema 原本 deferred；内存 provider 先返回真实 ToolSearch `select:browser_observe,browser_act`，下一实际模型 step 才 snapshot、click。判主/辅助依据正式 `llm/types.ts:9` 的 `requestBoundaryId`（actual model-facade.ts:116/:222）；没有绕过 availability/permission 或手调 handler。maxTurns=8 只为 search/snapshot/click/completion 留正常预算余量。
6. actual Core builtin `browser-tools.ts:461` await bridge.click；`server.ts:4398`/`:4403`/`:4410` 将请求送 session pending channel；actual Main `agent-bridge.ts:1026` await dispatch；actual dispatch `browser-runtime/dispatch.ts:109` acquire/:124 dispatch/:126 release；actual BackgroundRuntime `background-runtime.ts:289`–`:297` 确认有效 owner/control 后使用真实 driver。
7. actual Puppeteer driver `puppeteer-browser-driver.ts:646` resolve ref、`:647` await ready，**`:649` 才执行真正 click**。`:675`–`:687` 的原生 waitForFunction 检查 connected、大小、visibility 和无 disabled，带 driver 自己的 AbortSignal、正式 12 秒上限。夹具没有 fakeHost barrier、不替换 await predicate、不延长 timeout。

使用实际 SessionManager 持久化合法 legacy/unbound Session（origin desktop、kind work、无 project 绑定、private workspaceRoot）；实际 active-guest.registerSessionBucket 注册 no-repo bucket，实际 partitionForSession 解析 profile。没有绕 R79 bound WorkspaceContext 门禁。动态结论限定这条合法 legacy Session；现代 bound Session 共享的 parent Main/driver 路径仅静态同码推断。

## B22-1 的根因与源文件位置

主审可挂到 `packages/desktop/src/main/agent-bridge.ts:1026`（紧邻 async action 的实际 await），并关联 Core 取消端与驱动提交输入端：

- Main 在 `agent-bridge.ts:1011` 启动独立 async IIFE，`:1026` await Browser dispatch，`:1039` 无论旧 Core 是否已取消都会发送迟到 reply。普通 parent cancel 没有请求级 abort/controller 或 run generation 传入这里；child activation/release 在 `:996`–`:1008` 另有显式生命周期，不能混作 parent 已被保护。
- Core `server.ts:5065` / `:5103`–`:5111` 删除 pending/timer/target 并将 internal request resolve 成 cancellation sentinel；它让模型停止等待，但没有通知 Main 中已派发的 parent Browser 操作。`server.ts:2326`–`:2332` 正确拒绝迟到 approve，不能撤销已发生的 DOM 动作。
- `electron-puppeteer.ts:198`–`:202` 创建 target driver 只传 target.isActive，没有把 Core run cancel 绑定到本请求。target仍有效时，真实 driver `:647` 等待 enabled 后继续 `:649` 提交输入。现有 `releaseElectronBrowser` / invalidate 会 dispose driver，直接 AbortSignal 也能中断 readiness；普通 Stop 没触发这些路径。

建议将已派发 Browser action 与请求/run cancellation 身份关联，在原生 host 上取消尚未提交的等待/排队动作，并在输入前重新核本次请求仍有效。保留 task target/profile/已完成输入的正常行为；无需用关闭或清空全部跨 turn 页面来替代请求取消。

## 最终实际观测

Electron 33.4.11、Node v20.18.3、macOS；actual workspace source modules 520。三场景均在 `native-observations.json` 保存完整数据。

| 阶段 | Core | 真实 target / driver / input |
| --- | --- | --- |
| Stop 前 | busy=true，pendingCount=1，browser click 已派发 | disabled=true，hits=0，Input命令0；actual-adapter readiness wait 未settled、signal未abort |
| 实际 preload Cancel 后且 Core 已settled | JSONRPC result={ok:true}；ChatSession signal abort；Engine reason=aborted_streaming，settledSequence=2；busy=false，pendingCount=0 | disabled仍true，hits0，Input0；同一旧Main click/真实driver wait仍alive、abortedAt=null |
| 只在上述settled后启用owned DOM | enable sequence=3，modelCalls仍3 | Input.dispatchMouseEvent seq5/6/7 发生在 enable 后；真实click handler hits=1，旧Browser action返回ok:true |
| Main迟到 success | Core对approve ID900000002报-32602/No pending approval；busyfalse/pending0、旧modelCalls仍3 | 副作用已经发生；不是“只是迟到日志” |

作者这一运行的具体顺序：Core signal abortedAt=1791761100143，Engine settledAt=1791761100249/seq2，enableAt=1791761100262/seq3，Input mouseMoved/Pressed/Released=1791761100290/0291（seq5/6/7），DOM click=1791761100293。顺序另用单调 event sequence 验证，避免同毫秒 timestamp 误判。

实际 normal controls：

- 同一仍存活 real page 上新建 actual PuppeteerBrowserDriver 并传 AbortSignal。在相同 disabled readiness 等待中 abort，真实结果 BLOCKED / browser control lease has ended；随后 enable，Input计数不增加、hits仍1。只是证明提交前等待确能被正常取消，不以optional API本身替代产品Stop合同。
- 由同一实际 Core 的新正式 `agent/run` 经 ToolSearch→fresh snapshot→click→completion 正常结束（reason=completed，turnCount4），hits变2。目标跨 turn 保留与新授权请求正常，不是本 finding。
- 完成输入后再实际 preload Stop，hits仍2且无新Input；不要求回滚已提交动作。

## 既有测试/报告去重与反证

`background-runtime.test.ts:720`–`:753` 明确保证 in-flight action survives **普通lease.release和idle/capacity reclamation**；本实验不把该设计当缺陷。其 owner/control epoch、关闭、takeover门禁亦正常；候选限定真正用户Stop已终结Core且尚无输入提交的窗口。

`puppeteer-browser-driver.test.ts:399`–`:419` 已有真实 Chrome 的 AbortSignal等待/排队取消测试；本轮未执行它、未开Chrome。作者的 owned Electron direct控制在实际同驱动/真实DOM重现该能力。

已读审查 README、flow-coverage、panels-round6、browser-lifecycle-round21和browser-cancel-gates-round21。R80是Chrome idle连接状态反馈，R74是上下文摘要UI无取消入口，R07/R08是外部CLI停止路由；均与本次普通原生parent Browser尚未提交输入的取消传播根因不同。前轮已将该边界列未验证，不重复计算为旧 finding，也不因静态缺AbortSignal就直接立项。

## guard、加载范围与关闭收据

详细完整启动/guard/load方案见 `/tmp/codeshell-review-20261012-browser-stop-round22-native-plan.md`（首段为launch前时间点，后述最终状态以本报告/收据为准）。root和独立web审先审过源码，再执行 prepare-only、核 generated配置/guard/runtime/source-exports，最后才授权 launch。

- Maintained Node isolator→maintained Electron Home/confined fixture/launcher；app ready前设置独立appName/userData/sessionData，Core/Desktop import前检查HOME/TMP、process.chdir(private project)、执行exact-origin bootstrap后额外deny所有业务fetch/http(s)/net/tls/Socket connect和child/utilityProcess。
- actual Core/Desktop 同一jiti source module图，显式exports alias、tryNative=false、tsconfigPaths=false、privatefsCache；最终断言关键模块实际存在、所有workspace modules在当前冻结repo src且无productdist。仅actualpreload用锁定本地esbuild编译到ownedprivateCJS；callbacks按完整actualsource标记提取后只TS转译，不改函数体。
- Chromium default和actualtargetpartition load前装webRequest，只两个exactownedfile URL。CSP禁connect/externalresources；window.open/其他navigation拒绝；两ownedhiddenwindows。final记录仅这两个file请求。没有HTTPendpoint、真实页面/账号或下载。
- Node业务networkAttempts=[]、highLevelNetworkAttempts=[]、childAttempts=[]、rendererErrors=[]。没有另外跑所有deny负向探针，不能说所有guard都动态负测。outerPlaywright本地控制CDP与Chromium必要helpers属原生测试设施，与业务外联分开。
- actual Core/ChatManager/Engine/tool pipeline；实际preload和真实ElectronIPC；Main callbacks为实际源码提取体，内存stdio transport与logical-live bridge receiver替代真实worker。actualruntime/adapter/Puppeteer/ownedChromiumDOM。未运行完整AgentBridge构造、productMain、React App/ChatView/send-run/真正worker/stdin，不称fullApp E2E。ownedBrowserHost工厂用actualbuildWindowOptions，非完整productionopenBrowserHost。权限为已获许可运行的bypassPermissions；实际默认policy/目标owner/ref/输入等待门禁保留。
- author final PID17522，app.close receipt code0/signalnull，cleanupErrors=[]，privateHOMEvOXf4z removed=true；read-only contextretry0。没有强杀、遗留owned HOME或operator进程处理。mainshutdown与app.close独立finally，确认退出后才清私有目录。

## 失败账本（全部不是产品 finding / 最终测试通过）

| 记录 | 结论与修正 | 原始断言/退出/清理 |
| --- | --- | --- |
| prepare-only / before-first-native | 只prepare本地资产；root核后精确移除privateHOME dSiWKH；`prepare-home-cleanup.json` | 0assert、未launchPID；不算native执行 |
| first-native-failed | Main尚未完成启动时evaluate contextdestroy；加firstWindow和stdio/startup诊断 | 0assert，exit1；PID12017close0、HOMESYCoT1removed；shutdown global未就绪属harness |
| second-native-failed | 主请求被“browser_act schema存在”错误当auxiliary，未达到ready；本次尚无完整失败snapshot | 15prefixassert，exit1；PID12690close0、HOMEQA2i31removed、cleanupErrors0 |
| third-native-failed | 同错分，另read-onlyevaluate contextdestroy；保存完整snapshot并加仅该精确错误有界只读重试 | 15prefixassert，exit1；PID13444close0、HOMEaiSgu0removed；完整11stream帧含主turncomplete，不称preflight卡住 |
| fourth-native-failed | 正式desktopHost已补，但Browser仍deferred；tools名诊断确定错分；随后用正式requestBoundaryId区分并走真实ToolSearch | 15prefixassert，exit1；PID15682close0、HOMEytL5KRremoved；retry0 |
| fifth-native-failed | 实际Cancel已成功且Core settle；断言误把preload全JSONRPC当裸result；只修assert封套 | 21prefixassert，exit1；PID16476close0、HOMEI1Sngeremoved；retry0 |
| sixth-native-failed | 主候选和directAbort场景完成；正常第四轮触maxTurns4预算summary，reason=max_turns；正式预算改8留余量，不伪造completion | 50prefixassert，exit1；PID16971close0、HOME4jDC4premoved；精确read-onlyinfo重试3次；mutation不重试 |
| final-author / seventh-native.log | 当前冻结版三个完整场景、全部guard/cleanup检查通过 | **66Nodeassert/exit0/Completed**；PID17522close0、HOMEremoved、retry0 |

每个 failed 目录包含当时两入口源码、source manifest、原始日志/清理和可得snapshot；所有失败保留后才修改下一版。最终source不再变。各次prefixassert不相加，也不并入Bun或root另跑的native账本。

## 主审独立复跑分账（SG07:29 回报）

root 使用作者最终同SHA两入口，分别在 initial84740 与 latesta66f 的 owned validation 副本通过 maintained native 复跑；这是主审独立执行回报，作者没有在原收据上覆盖或再次累计运行：

| 执行者/基线 | 最终结果 | 只读info精确context重试 | owned退出/清理 |
| --- | --- | --- | --- |
| 作者/latesta66f | 66 Nodeassert、exit0、Completed | 0 | Main17522，HOMEvOXf4zremoved，close0、cleanupErrors0 |
| root/initial84740 | 66 Nodeassert、exit0、Completed | 2 | Main18509，HOMEVTslDWremoved，close0、cleanupErrors0 |
| root/latesta66f | 66 Nodeassert、exit0、Completed | 1 | Main18950，HOMEU1YyCVremoved，close0、cleanupErrors0 |

root 回报十二项关键产品 source manifest 与作者latest完全同hash，两个workspace module图也各520。三次独立收据分列；不合并成198断言suite，不把只读transport context重试当产品失败，未重试run/Stop/enable等任何mutation。通用Bun仍81文件243测试。主审收录为R81/P2；本报告的作者原稿另存原始归档。

## 主审持久证据入口

源码挂点：[Main派发](../../packages/desktop/src/main/agent-bridge.ts:1026)、[Core取消pending](../../packages/core/src/protocol/server.ts:5065)、[驱动等待后提交](../../packages/desktop/src/browser-library/puppeteer-browser-driver.ts:647)。十二个关键产品文件在两基线与作者最终manifest完全同SHA。

[分账与PID清理收据](validation/round22-browser-stop-results.json)、[作者完整观察](validation/original-browser-stop-round22/final-author/native-observations.json)、[初始基线主审日志](validation/browser-stop-round22/root-native.log)、[latest主审日志](validation/latest-a66f4ef2/browser-stop-round22/root-native.log)。主审另核三次成功运行的9个已知Main/renderer PID均不存在；不扩大为所有Chromium helper独立进程树检测。

[可复跑源入口](validation/browser-stop-round22/browser-stop-native.mjs)与[Main模板](validation/browser-stop-round22/owned-main-template.mjs)同目录，从目标冻结repo根用 maintained Node isolator运行：

```sh
node scripts/run-isolated-node-smoke.mjs docs/review-2026-10-12/validation/browser-stop-round22/browser-stop-native.mjs
```

合同与反证见[Stop合同](browser-stop-contract-round22.md)、[Core pending/迟到门禁](browser-stop-core-gates-round22.md)、[launch前隔离审计](browser-stop-preflight-round22.md)、[deferred工具诊断](browser-stop-discovery-round22.md)。前置静态审计中的“尚未执行”是当时状态，不覆盖本段最终成功收据。

最终[独立质量复核](browser-stop-quality-round22.md)新增执行0，支持R81窄P2；Core取消/迟到reply正常，尚未提交的Main输入继续发生，不泛称Stop完全无效。

最终[整合语义核验](quality-round22.md)完成，新增执行0；三次native分账、历史版本与便携入口已核对，无未解决实质矛盾。
