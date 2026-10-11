# 第22轮 Desktop Browser Stop 合同独立只读审计

状态：**Completed；新增验证执行0，测试0，正式发现0。** 只读 latest `a66f4ef291f304ee4df9da8095a90671d9a8f140` 的生产源码、CODESHELL.md、主报告R07/R08/R74/R80及既有质量报告。没有运行任何测试、Core/worker、Electron、Chrome、模型、CLI或网络请求；没有修改产品、主报告或构建。工作区已有根代理的未跟踪 review docs，本审计未改动它们。行号均指 latest 产品快照，不冒充两基线执行。

## 裁定

**自然 ready 等待期间尚未发出的输入，属于普通用户 Stop 应协作阻止的后续工作；它与已经发送的输入不能回滚，是不同问题。** 正式 Desktop 聊天 Stop 确实走同一个 native parent `agent/cancel`，不是错误协议或仅关闭 UI。Core 也正确 abort 当前 turn、排空排队 turn 并终结 browser host-loopback 的 pending 请求。当前可疑边界在 Main 已接收的 parent 浏览器动作：这个执行没有请求级取消信号，默认 Electron driver 的活跃性来自 target，而普通 Stop 没有改变 target 的控制状态。

这是一条可信、自然可达的静态候选，**尚不是动态确认发现**。作者原生 fixture 还没有最终 launch/收据；本文没有引用它为通过证据。只有证明“Core cancel 已确认时 Input 尚为0，随后同一等待动作发出 Input”，才能把传播缺口写成用户可观察缺陷。UI先显示 stopped、动作晚于该时间完成，单独不足以证明取消失败。

如果上述动态条件成立，建议独立 **P2**：用户已经撤销本轮继续执行的意图，但该轮尚未发出的浏览器交互继续发生，Stop 的主要控制合同不完整。不需要假设付款、删除、泄密或跨会话执行。若最终仅证明非常窄且轻微的显示/等待摩擦、没有实际后续输入，不能据此保留P2；可降P3或剔除，按收据而定。目前不正式评级。

## 正式点击链与会话身份

所有路径以下列根目录为基准：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/`。

| 层 | 精确生产位置 | 已核对行为与限制 |
| --- | --- | --- |
| 聊天按钮 | `packages/desktop/src/renderer/ChatView.tsx:2170`、`:2176`；`renderer/App.tsx:2505` | busy时显示正式Stop，onClick调用onStop，App接`stop()`。候选是仍在等待工具的普通聊天，不是R74摘要期间没有按钮。 |
| renderer控制器 | `packages/desktop/src/renderer/app/useRunController.ts:930`、`:942`、`:946`、`:955`、`:968`、`:985` | 按当前可见bucket定位会话，优先取summary.engineSessionId，调用`window.codeshell.cancel(engineSessionId)`。不是随全局最后运行会话乱取消。 |
| renderer旧回包保护 | 同文件`:948`、`:975`、`:984` | 先推进launch版本、取消pending launch、清busy并记stopped；旧run RPC回包不能终结继任run。**UI不等待cancel ACK**，故UI stopped不等于Main/Core已经完成取消。 |
| preload | `packages/desktop/src/preload/index.ts:554`、`:560`、`:563` | native发`agent/cancel {sessionId}`；external runtime显式走`externalRuntime:interrupt`。本候选限native parent，不扩成外部CLI问题。`:546`的run注释也把Stop定义为abort路径。 |
| Main转发 | `packages/desktop/src/main/agent-run-metadata.ts:89`；`main/agent-bridge.ts:856`、`:878`、`:912`、`:914` | 非agent/run原行返回，正常存活worker时发送到Core。取消不经过run metadata/browser资源重配。无worker时`:885`允许drop approve/cancel，因此验证必须有真实存活Core接收并回ACK，不能拿no-workerdrop当本候选。 |
| Core协议 | `packages/core/src/protocol/server.ts:2433`；`protocol/server-run-controls.ts:83`、`:108`、`:115`、`:116` | 定位指定ChatSession，执行cancel与cancelSessionApprovals，随后回ok。Desktop没有发送expectedClientMessageId，走普通按session取消分支。 |
| ChatSession | `packages/core/src/protocol/chat-session.ts:269`、`:277`、`:284`、`:286` | 明确协作式AbortSignal合同；推进cancellationGeneration、abort当前controller、拒绝排队turn。没有closeSession/删除会话。 |

这里不是任意协议方法被测试调用就声称完整App E2E：UI→preload→Main→Core的入口与身份是逐层源码核验；本轮没有实际点击完整App。

## Stop终结了哪些“审批/lease”

三个不同生命周期须分别描述，不能统称“lease已经释放所以动作应消失”。

1. **Core本次host-loopback pending请求：已终结。** `packages/core/src/protocol/server.ts:5065`的cancelSessionApprovals先处理internal条目；`:5103`删除pending，`:5104`清timer，`:5105`清pendingApprovalTargets，`:5108`向internal resolver交cancellation sentinel。`requestBrowserActionForSession:4443`解析该值，令Core等待返回取消结果。真实许可审批则返回approved:false，而不是把内部Browser取消误写成用户Deny。
2. **ApprovalRouter会话owner：普通Stop不释放。** `packages/core/src/tool-system/permission.ts:76`注册owner，`:82`同连接重复register直接复用原target；`:120`的release才删除owner并通知ownershipLost。普通cancel分支没有release。显式closeSession才在`protocol/server.ts:2989`release并close ChatSession。保持会话route本身是正常设计，不应为了停止一次动作删除整个会话授权。
3. **Main Browser runtime资源lease：动作settle后才release。** `packages/desktop/src/main/browser-runtime/dispatch.ts:109`acquire，`:124`await dispatch，`:126`finally release。Stop没有本次lease句柄。普通lease.release是资源引用回收，不是用户撤销动作的同义词。既有`main/browser-driver/background-runtime.test.ts:720`明确允许in-flight在普通release后完成；该case没有用户Stop，本轮未执行，不能用它排除Stop传播候选。

`server.ts:1588`的approval transition只调用observers。对相关生产源码检索，实际`onApprovalTransition`实现位于`packages/pet/src/projection-extension.ts:312`，是Pet投影，未将parent browser取消传给Main driver。当前Core取消pending/迟到回包防护正确，不自动等于Main已经取消副作用。

## 未发Input的自然等待为何不是回滚要求

项目的[架构合同01:110](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/architecture/01-engine-and-turn-loop.md:110)写明“Abort is terminal, not retryable”，用户Stop的AbortSignal经ChatSession、Engine、TurnLoop、ToolExecutor至tool handlers。实际`packages/core/src/tool-system/registry.ts:201`传播parent abort、`:210`给ctx.signal，`:240`将executor与abort竞争。这是协作取消，race不会自动终止不观察signal的底层promise。

Browser工具的实际click在`packages/core/src/tool-system/builtin/browser-tools.ts:459`直接`await b.click(ref)`，没有传ctx.signal。`protocol/server.ts:1032`给普通parent安装makeBrowserBridge；`:4398`的bridge方法只有动作参数，`:4427`请求把action注册并发到Main，没有普通parent请求取消通道。Main `packages/desktop/src/main/agent-bridge.ts:993`另启async处理；`:1026`调用dispatch只传sessionId/request/childHost，**不传requestId/turn取消信号**；`:1039`等动作完成后再回approve。

默认合法target是task-owned background in-app tab，见`packages/desktop/src/main/browser-runtime/dispatch.ts:42`。既有用户tab须显式grant，不能从焦点偷偷取得。default owner在`dispatch-owner.ts:1`只含sessionId；没有每turn取消代数。这里的background指浏览器target展示/资源归属，不等于一个被用户明确授权、Stop后继续运行的独立后台job。

真实共享驱动按以下顺序执行：

- `packages/desktop/src/browser-library/dom-observation.ts:99`只筛可见几何/visibility，`:112`nativeControl包含button，没有排除disabled；因此有效ref对应disabled按钮是正常页面状态，无需人工promise gate。
- `puppeteer-browser-driver.ts:638`中resolve(ref)→`:647`ready→`:648`checkDocument→`:649`action。click的action是`:207`的`handle.click()`。
- `ready():674`真实waitForFunction要求connected、visible、非disabled，`:687`默认12秒并接受driver内部abort。`:695`再等两RAF几何稳定，`:710`同样可abort。**输入在这些等待之后才发。** 页面稍后正常启用同一节点，能够自然打开待发窗口；有界timeout不能替代及时Stop。
- `packages/desktop/src/main/browser-driver/electron-puppeteer.ts:198`创建driver只给`isActive:()=>target.active`，没有绑定Core当前turn signal。驱动本身有可选signal和dispose能力，但生产parent接线没有把Stop送到该能力。

因此应要求取消的是“停止后不要再走到尚未执行的handle.click”，而不是“撤销已经发出的mousedown/click、远端请求或DOM副作用”。既有直接driver signal取消测试`puppeteer-browser-driver.test.ts:398`正是disabled等待、取消后不继续队列且不关page；本轮仅读源码，没有执行。它证明机制可做，不证明当前Main/Core已接好。

## 新turn、接管、撤权与迟到结果的保护边界

| 保护 | 已核对位置 | 对本候选的意义 |
| --- | --- | --- |
| 旧RPC结果不结束新turn | `useRunController.ts:948` | 保护UI运行身份，未把取消传给Main动作。不要声称旧动作会串成新模型答案。 |
| 老approve拒绝 | `main/browser-driver/intercept.ts:108`保留connectionId/generation/sessionId/requestId；`core/protocol/server.ts:2326`、`:2332` | Stop已删原pending，旧回包会因no pending拒绝。不存在据此证明“旧reply命中新审批”。 |
| 同会话新turn | `core/protocol/server.ts:1982`；`tool-system/permission.ts:82`；`browser-runtime/dispatch-owner.ts:1` | 同连接register复用route，default owner仍同session。没有发现新turn开始自动使旧parent driver失活。新turn若导航/观察改变document/ref，则另有ref guard；不能宣称一切后续操作都保留旧ref。 |
| 默认target接管 | `main/browser-driver/background-runtime.ts:219`、`:222`；`:607` | show先pauseTarget再等queue，推进controlEpoch并detach/dispose driver；可以中断等待。不是要等旧ready结束才接管。 |
| 默认target操作检查 | `background-runtime.ts:260`、`:287`、`:292`、`:294` | lease/epoch/pause会在ensureTarget/createDriver前后重查。普通Stop没有推进这些控制状态，不能把现有检查本身说成无效。 |
| target失活 | `main/browser-driver/electron-puppeteer.ts:102`、`:111`、`:112` | invalidate使active=false、取消协议等待、dispose driver。失活/接管是实际独立fence；Stop不等价target失活。 |
| 显式built-in grant接管/撤权 | `main/browser-runtime/built-in-handoff.ts:196`、`:205`、`:220` | 控制epoch及exact liveGrant checks；过期/bucket改变撤权。这是正确边界，不应泛化为Chrome或用户tab仍能越权。 |
| 会话删除 | `main/agent-bridge.ts:1754`、`:1759` | forgetSession关闭default runtime并清built-in/Chrome session权限。Core普通cancel不调用forget，Stop保留可继续聊天的会话是正常行为。 |
| child host释放 | `core/protocol/server.ts:1116`、`:1145`；`main/agent-bridge.ts:996`、`:1005` | child输入signal能发private release并让Main关闭child runtime。parent在`:1032`没有child scope，不能拿child路径当parent隐式取消。 |

此外document/refidentity、节点detached、页面关闭、policy敏感ref/高后果操作的门禁仍存在。审计没有证据表明Stop传播候选能绕过它们，也不应引入未经验证的支付、删除、秘密输入、错会话、数据丢失或永久不可恢复影响。

## 合法触发前置与收据条件

有效候选必须同时满足：正常native交互parent Session且当前聊天busy；Core worker实际存活；浏览器工具已有合法task-owned target与当前document的有效ref；该可见普通控件当前disabled或正等正常稳定性；Main真实default dispatch已经进入真实ready但还没有输入；用户正式Stop最终被Core收到并确认；此后同页面在驱动timeout内启用同节点；期间没有接管、关闭、撤权、导航或节点替换等其他fence。

需要的最终证据是：实际Core cancel确认/pending清零，且当时CDP Input/页面事件计数都为0；随后owned页面自然enable，同一旧request发出真实Input/事件。未Stop正常完成、明确driver abort/target失活阻止，以及已经Input后才Stop这三种控制应分层。纯Main dispatch或手动协议cancel可证明服务合同，正式UI接线本轮已静态核对；仍不能称完整App/真实worker/模型E2E。

恢复也须限定：接管/关闭target可阻止还没发送的后续工作，ready timeout最终会失败，但旧动作一旦成功输入，停止/关闭不能撤销网页状态。当前未动态验证完整UI恢复流程，不写“一键撤销”或“永久失控”。

## 去重与修复边界

- **R07** 是Core worker退出误清外部CLI busy导致按钮消失；本候选要求存活native worker和可点击Stop，修runtime busy投影不会补Main Browser请求取消。
- **R08** 是paired Web CLI房间发送原生stop的错误协议；当前Desktop native确实正确发agent/cancel并由Core处理，修CLI协议不会改变parent浏览器动作。
- **R74** 是上下文摘要没有可用取消按钮且RPC timeout不取消后台摘要；当前聊天按钮存在且Core cancel成立，缺口在Browser Main执行的协作传播。
- **R80** 是Chrome闲置断线仍显示使用中的P3投影，动作门禁正确拒绝；当前候选限默认Electron task-owned driver，不能从Chrome断线反馈推导本缺陷。

若动态成立，修复应给Main动作添加session/turn/request身份的可取消执行，确保ready/queued动作观察取消，并在Input提交前重查；旧取消不能杀继任turn的driver。不能简单把任意Stop映射成全会话永久revoke/关闭所有tab，也不能削掉exact target/ref/grant门禁。Core pending cleanup和旧reply拒绝应保留；它们解决不同边界。

最终记录：**Completed；只读源码/合同审计；新增执行0、正式发现0；等待作者最终原生收据再裁定上述条件候选。**
