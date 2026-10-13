# 第22轮 Browser parent Stop：最终独立质量复核

Completed。**本审计新增执行0**：只读冻结产品源码、作者最终源码/JSON/日志、六份失败诊断及root两基线收据；未运行、prepare、转译或launch任何测试、Core、worker、Electron、浏览器、模型或网络请求，未改产品、主报告或fixture。前置静态合同审计与方案预审分别保留在 `/tmp/codeshell-review-20261012-browser-stop-quality-round22.md`、`/tmp/codeshell-review-20261012-browser-stop-preflight-round22.md`。

## 结论与分级

**支持保留一项窄P2（root拟登记R81）：正式Desktop parent Stop已经终结Core运行、清空审批后，仍在实际Puppeteer readiness中等待且尚未提交任何输入的旧browser click，会在按钮随后启用时发出并触发DOM。** 最终原生收据满足先前静态审计所缺的实际输入时序证据，因而不再只是源码候选。

分级依据是重要的用户取消流程仍允许一个尚未提交、可协作中止的浏览器动作继续改变页面；不是仅停止状态显示滞后。支持P2并不依赖支付、删除、账号操作或数据损失推断。本次只观察自有页面计数器，未验证任何危险动作；Core确实停止、旧审批回复也正确拒绝。不能将标题写成“Stop完全无效”“模型继续运行”或“已停止任务跨会话执行”。

P3/剔除的最强反论据是：动作此前已经派发给Main，取消本来是协作式，普通lease释放也明确允许in-flight结束，且Stop不是世界状态回滚。但本收据排除了“输入已提交，仅完成通知晚到”：Stop ACK和实际Engine终结后，Input仍为0；driver尚在可取消的disabled等待，且显式AbortSignal对照阻止同类输入。项目架构将User Stop的AbortSignal传至tool handlers作为不变量。普通lease回收单测未调用Stop，不能证明用户取消有意允许尚未发送的输入继续。综合实际影响与范围，P2合理；不提升P1，也不要求撤销已经发出的输入。

## 最终收据与计数归属

作者最终冻结源码在 [final-author/browser-stop-native.mjs](/tmp/codeshell-review-20261012-browser-stop-round22/final-author/browser-stop-native.mjs) 和 [final-author/owned-main-template.mjs](/tmp/codeshell-review-20261012-browser-stop-round22/final-author/owned-main-template.mjs)：

- launcher SHA256 `11bc7a9cf31d53a69c55191b89fe08d621e4857621175841bb13a446d97c320d`；
- owned Main SHA256 `1f9213c591383ae16b4ac41adaabcce8be298fcf143503909eb067cc7dbaf26b`。

本审计只读计算的SHA与作者 [summary.json](/tmp/codeshell-review-20261012-browser-stop-round22/final-author/summary.json) 一致。最终相对第六次Main仅 `maxTurns:4→8`；provider仍只有正常ToolSearch发现、snapshot、click和completion四个主调用阶段，没有增加动作步骤或替换wait。四轮预算用尽后的`max_turns`属于该fixture正常结束断言的配置错误，不作为产品发现。

| 收据归属 | 完成与清理 | 只读info重试 | 计数解释 |
| --- | --- | --- | --- |
| 作者latest第7次，Main17522，HOME后缀vOXf4z | 66 Node assert；Completed；close code0/signal=null；cleanupErrors空；HOME removed | 0 | 作者单次最终运行，不与root相加 |
| root初始84740，Main18509，HOME后缀VTslDW | 66 Node assert；Completed；close0；cleanupErrors空；HOME removed | 2条 | 独立便携复跑，每次操作只重试精确context-destroy的info读取 |
| root最新a66f，Main18950，HOME后缀U1YyCV | 66 Node assert；Completed；close0；cleanupErrors空；HOME removed | 1条 | 另一基线独立便携复跑，mutation没有重试 |

已只读核对作者 [cleanup](/tmp/codeshell-review-20261012-browser-stop-round22/final-author/cleanup.json)/[Completed日志](/tmp/codeshell-review-20261012-browser-stop-round22/final-author/seventh-native.log)、root [初始cleanup](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/validation/browser-stop-round22/cleanup.json)/[日志](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/validation/browser-stop-round22/root-native.log)，以及root [最新cleanup](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/review-2026-10-12/validation/browser-stop-round22/cleanup.json)/[日志](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/review-2026-10-12/validation/browser-stop-round22/root-native.log)。三次成功均记520个workspace source modules、无dist来源；并非完整产品Main已加载。

**Bun本轮无增量，仍81文件243测试/基线。** 原生作者66和root各基线66分开列，不合并为198条suite测试、三个产品E2E或Bun测试。作者六次前置失败的prefix断言数分别0/15/15/15/21/50，均为未Completed诊断，不累计成功native计数。

## 动态时序：输入确在Core停止之后

作者 [native-observations.json](/tmp/codeshell-review-20261012-browser-stop-round22/final-author/native-observations.json) 的第一个scenario及summary提供：

1. 同一合法parent会话先完成正式browser snapshot，再发click。Main的click已进入实际adapter的disabled readiness；`busy=true`、`pendingCount=1`、DOM `disabled=true/hits=0`，全部Input命令为空。
2. 通过真实preload/native IPC调用`window.codeshell.cancel(sid)`，得到JSON-RPC `{result:{ok:true}}`。实际ChatSession signal aborted；实际Engine返回`aborted_streaming`，终结序号2；`busy=false/pendingCount=0`。此时DOM仍disabled、hits仍0、Input仍0，Main click与driver readiness仍未settled且signal未abort。
3. 自有页面解除disabled为序号3。真实ready条件成功、两RAF稳定后才产生`Input.dispatchMouseEvent`序号5/6/7，DOM hit变1。此顺序同时由统一Main事件序号、Input参数和实际DOM事件支持，不依赖跨进程时钟或同毫秒比较。
4. Main旧成功回复回Core后，实际Core返回`-32602 / No pending approval for session …`；旧run的modelCalls维持3、busy=false、pending=0。证明旧回复没有恢复原Engine，并不能逆转已经发生的DOM输入。

root初始/最新两份native-observations重复观察到同样序号2→3→5/6/7及hit1，都是Stop后的真实输入，而非仅晚回包。脚本的[断言段:107](/tmp/codeshell-review-20261012-browser-stop-round22/final-author/browser-stop-native.mjs:107)先检查实际wait/Input为空，`:116–122`再等实际Core终结，`:123–134`最后启用和观察输入，不对mutation自动重试。

“按钮之后启用”是owned页面受控刺激，生产等待本身来自实际driver的disabled检查及两RAF，未用人工promise/Host gate替代。适用条件应写为：**按钮在实际readiness等待期限内变为可操作**。该等待默认12秒有界；不能称永久后台任务或所有已停止动作必然执行。

## 生产入口与根因衔接

实际UI接线仅静态核对，native没有挂完整App或点击产品按钮：[ChatView:2170](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/ChatView.tsx:2170) busy时提供Stop，[App:2505](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2505)调用stop，[useRunController:930](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useRunController.ts:930)定位所看会话并在`:975–985`清busy、标stopped、调用cancel。[preload:549](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:549)明确取消运行中的turn，native走其正式`:563` agent/cancel路径。

实际Core [server-run-controls:108](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server-run-controls.ts:108) abort并drain审批后ACK，[registry:201](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/registry.ts:201)传播parent signal并在`:240`用race结束工具等待。browser click却只在 [browser-tools:461](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/builtin/browser-tools.ts:461) await桥接，普通parent [BrowserBridge:4398](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:4398)和request不携带每动作取消协议。Main [agent-bridge:1011](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:1011)独立async dispatch，完成后才回approve；[dispatch:109](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-runtime/dispatch.ts:109)只在动作结束finally释放lease，没有Stop接线。

[Electron adapter:198](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-driver/electron-puppeteer.ts:198)仅给driver target级isActive，未给run/request级signal；[driver:674](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/browser-library/puppeteer-browser-driver.ts:674)本来支持signal取消真实ready，`:647–649`才等待后发input。静态[架构不变量:110](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/architecture/01-engine-and-turn-loop.md:110)支持协作取消应流到工具handler；[lease-release单测:720](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/browser-driver/background-runtime.test.ts:720)是引用计数/idle容量回收契约，未调用Stop，本审计也未运行该单测。

建议修复位置是Core↔Main的动作/run取消归属及Main输入前的有效性检查；须保留request/session/generation身份和后续新turn正常使用，不能用取消一个请求时粗暴撤销同profile的全部浏览器权限来代替。

## 正常、恢复及范围反证

- **直接signal对照动态成立，但不是产品恢复入口。** 实际同page的新PuppeteerBrowserDriver显式给AbortSignal，真实ready返回`BLOCKED / browser control lease has ended`；启用按钮后hits仍1、Input数不增，页面活着。它证明等待阶段可中止，不能声称Main已经提供用户可点的“中止旧click”补救。
- **后续新Core turn可用动态成立。** 同一target的新正式agent/run完成，`reason=completed`，hits变2；随后idle Stop不再增加输入，也不回滚既有hits。startRun经owned transport投Core，未点击完整产品发送按钮。这是保留目标后可继续新意图的控制，不是恢复已发生的旧点击。
- **Core停止与回包身份保护正常。** 晚approve拒绝、旧run无新增模型调用；没有证明跨会话归属错误、模型持续请求、数据破坏或永久无法继续。
- **目标关闭/takeover/撤权不等于普通Stop。** 既有target失活、controlEpoch和session生命周期门禁源码仍成立，但本final没有动态点击这些生产恢复UI，不把这些替代路径写成一键撤销。若副作用已发生，重新Stop、关闭或重启不能保证还原网页状态；若按钮一直disabled，正常ready超时可使旧动作失败。
- **去重成立。** 与R80 Chrome闲置connected反馈、R08配对CLI房间Stop路由、R07跨runtime busy清理不同：本项是原生parent Core已正确cancel，Main默认in-app动作没有取消传播。与child lifetime释放、普通lease回收也不同，不将child/Chrome路径一并宣布复现。

## 替身、隔离和失败诊断限制

动态为actual Core/ChatManager/Engine、memory LLMClientBase、实际工具发现与browser工具、真实preload/native IPC、source-extracted Main callbacks、actual Runtime/BackgroundRuntime/Electron adapter/Puppeteer，以及owned Chromium页面。未运行完整产品Main/App/AgentBridge实例/stdio worker/真实模型/Chrome扩展/用户浏览器账号。`startRun`直接owned in-process transport，`canSend/hasChild`模拟逻辑live worker；owned BrowserHost工厂使用实际window options和BrowserWindow，targetPool为owned seam。Session是实际保存的legacy/unbound session；active-guest registry及sessionDiskRoot真实对齐，bound WorkspaceContext只按源码共享链解释，没有完整bound Desktop UI动态覆盖。

provider依主requestBoundaryId区分aux，先正式ToolSearch `select:browser_observe,browser_act`，schema出现后才snapshot/click；没有直接改工具surface或绕visibility guard。`builtinToolHost:'desktop'`对齐production CoreCLI。frame.waitForFunction wrapper调用原predicate/options，只记录观察，不伪造等待；WeakMap避免重复包裹。Apphooks清空、memory provider、bypassPermissions、明确启用Browser工具是受控前提；DEFAULT_POLICY与非敏感owned button不变，不能据此推断敏感动作门禁被绕过。

Main在Core/Desktop模块求值前设独立HOME/userData/sessionData/TMP/CWD，显式拒绝fetch/http(s)/net/tls/child_process/utilityProcess；Chromium请求只允许两个owned file URL。成功收据中这些观测数组及rendererErrors均为空。maintained launcher用自己的loopback inspector控制owned Electron；本审计不把这些guard解释为OS级完整网络隔离、所有Electron原生通道探测或全进程树逐PID退出证明。外层本地esbuild service仅源转译，没有产品build/dist写入。Main close0及HOME删除有收据；没有真实worker/CLI启动。

六份未Completed诊断分别涉及startup/read-only context destroy、host/schema发现前提、错误裸preload envelope期望和fixture maxTurns预算。第五次21prefix是实际envelope断言不匹配；第六次50prefix已观察核心时序但正常新turn返回max_turns，仍不记正式通过或另一个产品问题。最终info最多3次仅精确context-destroy重试，作者0/root旧2/root新1；call/startRun/cancel/enable/abortDirect等mutation均不重放。

最终：**Completed；独立审计执行0；支持单项窄P2；无额外finding或测试计数；未发现阻碍root整合R81的实质证据矛盾。**
