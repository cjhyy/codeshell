# 第 22 轮 parent Browser Stop：作者原生证据独立只读核证

时间：2026-10-12 07:24–07:31 Asia/Singapore。冻结源码 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，基线 `a66f4ef291f304ee4df9da8095a90671d9a8f140`。已读 CODESHELL.md，复用本代理的 round22-core-gates/loader-gates/tool-discovery-diagnosis 笔记。**本核证执行测试、Electron、worker、CLI、模型和网络均为 0；产品更改 0。** 仅读取父代理已执行并冻结的 fixture/记录，写本 `/tmp` 笔记。

结论：作者第七次完整记录支持窄候选——同一次普通 parent Browser click 正在实际 Puppeteer readiness 等待时，正式 Core Stop 已 abort 并完全结算 turn、清 pending，Main 的旧动作仍在网页稍后变为可操作时提交真实 Input，产生一次 DOM click。Core 正确拒绝迟到回包且未恢复旧 Engine，但这不能撤销已在 Main 产生的副作用。**作者证据已 Completed；我未独立复跑，不给正式 finding 编号或评级；最终采用及双基线独立复跑由 root 决定。**

## 主证据及作者完成状态

主证据目录 `/tmp/codeshell-review-20261012-browser-stop-round22/final-author/`：`native-observations.json`、`browser-stop-native.mjs`、`owned-main-template.mjs`、`source-manifest.json`、`cleanup.json`、`seventh-native.log`。日志明确 `Completed ... 66 Node assertions`；cleanup 为 completed=true/failure=null、66 assertions、closeReceipt `{code:0,signal:null}`、cleanupErrors=[]、isolatedHomeRemoved=true、harnessContextRetries=[]。

最终记录 guard.workerCreated=false、guard.spawned=[]；最终 520 个 workspace 源模块、网络/高层网络/child attempts 各 0、rendererErrors=[]。记录内 modelCalls=7、auxiliaryCalls=8 指 owned 内存 LLM provider 调用，不是真模型调用。productMainLoaded=false、actualWorkerModelCliStarted=false。不要把这组测试描述为完整产品 App/真实 worker/真实模型/用户 Chrome 的端到端运行。

第六次 `sixth-native-failed` 只到 50 assertions，失败为正常新 turn 预期 completed、实际 max_turns；首两个 observation 已形成完整候选和 direct AbortSignal 对照，但不能把第六次当成功。第七次 Engine 的 maxTurns=8（`owned-main-template.mjs:173`），原第六次为 4；给正式发现工具、snapshot、click、completion 足够轮次后，完整正常对照通过，未放宽候选取消门禁。

## 关键顺序：先完全 Stop，再发生尚未提交的旧 click

以下毫秒时间均来自最终作者 JSON；同一程序 logical sequence 另排除同毫秒比较歧义。

| 阶段 | 时间/序号与状态 |
| --- | --- |
| 实际 click 请求及真实 ready 等待 | click at 1791761100113；waitForFunction at 1791761100114/seq1，readiness=true、signal 尚未 abort，busy=true、pending=1、Input=0，owned button disabled=true/hits=0 |
| 正式 Stop | 起始 1791761100141；实际 ChatSession run signal 在 1791761100143 abort；实际 preload/native IPC/Main callback/Core Cancel 返回 `{ok:true}` |
| 实际 Core 已结算 | Engine result reason=aborted_streaming，settledAt 1791761100249/seq2；postStop busy=false、pending=0、Input=0、disabled=true/hits=0；Main click/实际 ready wait 仍 pending，driver signal abortedAt=null |
| 网页稍后可操作 | enable at/domAt 1791761100262/seq3；fixture 明确断言 seq3 > Core settled seq2 |
| 旧动作这时才提交 | CDP Input.dispatchMouseEvent 三条 at 1791761100290–291/seq5–7；DOM click event at 1791761100293、hits=1；同一个 ref、同一个 owned file URL/document，action 回 OK |
| 迟到回包拒绝 | 原 requestId `ddiLRUeLi37_` 的 late approve RPC id900000002 在 1791761100293 被 Core 以 -32602 / `No pending approval for session ... ddiLRUeLi37_` 拒绝；busy=false、pending=0、modelCalls 与 postStop 相同 |

因此证据超出「Stop ACK 后 Promise 晚返回」：`browser-stop-native.mjs:116–129` 等待 busy=false + actual Engine settled + pending0，仍确认 Input0/disabled，再 enable；随后旧动作才发真实 Input/DOM side effect。它也超出「已经提交的点击不可回滚」：在完全结算时，没有任何 Input 命令提交，真实 driver readiness signal 本来可取消。

## 正常对照及反证

direct AbortSignal 对照（observation[1]）：保留实际 Chromium page，额外构造 actual PuppeteerBrowserDriver 并传 AbortController.signal。真实 ready wait at1791761100343；abort listener at1791761100349，调用返回时间1791761100350，wait 在1791761100350以 AbortError 结束，BrowserResult 为 BLOCKED/`browser control lease has ended`。后续 enable + 150ms 后 target hits仍1，Input仍3，没有第二次旧 click。listener 发生比函数返回早1ms符合同步 abort callback 顺序，不是证据矛盾。这是手动连接 signal 的差分驱动对照，不能称为当前正式 Stop 已传 signal。

正常新用户 turn（observation[2]）：actual Engine result completed，正常复用保留页面并使 hits=2/Input=6；随后 idle Stop 不回滚已提交 side effect，Input仍6。这证明「保留 session/target 给新用户继续」是正常设计，不应以 Stop 无条件销毁整个页面作为本证据的必需修复。没有在本记录中把 session target 保留本身认作故障。

## 实际调用范围与替换边界

1. actual Core AgentServer/ChatSessionManager/Engine/provider registry/ToolSearch/browser builtins：Engine 配置 builtinToolHost=desktop，内存 provider 根据正式 requestBoundaryId 区分主请求，先通过正式 ToolSearch 发现 browser_observe/browser_act，再读实际 snapshot ref 并发 click。hooks 在 fixture 清空，LLM 是 owned 内存适配器。
2. actual preload 从冻结源码独立 bundle 到隔离 HOME；control renderer 调实际 `window.codeshell.cancel(sid)`，经过真实 Electron IPC。它是正式普通 unscoped session Cancel 路由；本 fixture 未点击完整 renderer App 的 Stop 按钮，也未测 expectedClientMessageId scoped Stop UI。
3. Main `agent:msg` handler 与 maybeHandleBrowserAction 从冻结 AgentBridge.ts 维护标记范围逐字截取并 TypeScript 转译（`browser-stop-native.mjs:50–57`），除 method 声明改成函数及 deps injection，body 未另写取消逻辑。不是实例化完整 AgentBridge/App。receiver 的 core.sendLine、transport、session/worker目录是 owned in-process 适配器，逻辑 hasChild=true；ensureWorker/child lifetime 若触发即 throw。没有 OS worker/stdin/stdout。
4. Main browser dispatch wrapper 只记录并调用 actual dispatch（template:193–202）；actual DesktopBrowserRuntime/BackgroundBrowserRuntime、Electron ExtensionTransport、puppeteer-core、PuppeteerBrowserDriver、真实 owned BrowserWindow/Chromium DOM。无 builtin/Chrome handoff，普通 parent fallthrough 到 owned background runtime；snapshot identity 的 builtin-panel 是 adapter 元数据，不能据此声称用户浏览器面板被触及。
5. `instrumentDriver`（template:115–130）包装实际 frame.waitForFunction，记录 predicate/options signal，**原参数原样调用 original.call**；没有在 openHost/action 中插入假 callback barrier。disabled button readiness 是 actual production predicate 可达自然等待，后续 enable 是受控网页状态变化。

## 源码门禁对应与窄归因

下列一基行号均指 frozen a66f：

- `packages/core/src/protocol/server-run-controls.ts:108–116` 普通 Stop 调 ChatSession.cancel，drain pending，回 ACK；`chat-session.ts:277` abort run signal；`server.ts:5093–5118` 清 internal pending/timer/route，只结算 Core 侧，不发 ordinary parent Main Browser cancel。
- `packages/desktop/src/main/agent-bridge.ts:1011–1041` 分离 async browser dispatch 后回 approve；`browser-runtime/dispatch.ts:109–127` parent acquire/dispatch/release 没有 turn AbortSignal。child scope close/release 门禁不能自动覆盖普通 parent。
- `packages/desktop/src/main/browser-driver/electron-puppeteer.ts:198–202` 创建实际 driver 传 documentNamespace/captureScreenshot/isActive，未传 ChatSession signal。
- `packages/desktop/src/browser-library/puppeteer-browser-driver.ts:646–649` resolve→ready→checkDocument→action；`:674–690` actual readiness 等待 disabled 消失并监听 driver 自己 abort.signal；`:691–713` 检查活动并等待滚动稳定。正式 Stop 未让 target.active=false，也未 abort 此 driver，待条件满足后自然继续 click。这里既有 driver 取消能力在 direct control 中正常生效。
- `server.ts:2326–2335` exact pending 缺失拒绝 late approve，是本 legacy in-memory AgentServer 记录实际命中的分支。strict route 模式另有 `:2289–2307` fail-closed，未在本 fixture 命中，不应宣称执行了 strict mode。

与 round22-core-gates 早期「静态窄缝尚未证明」状态相比，作者记录现在提供了此前要求的真实可达 readiness 和新副作用顺序。当前代码显示 Core cancellation 与 Main ordinary parent action cancellation 之间缺少传播，而非 Core late-approval 门禁绕过。应围绕「Stop 后仍可能提交未发生的旧 browser action」描述，不扩大到任意动作/任意时长/页面权限绕过，且等待 root 的独立复跑和正式评级。

未发现上述 final 记录内相互矛盾的候选顺序。只读审计证据数量不计新增执行；本文不修改产品或主报告。
