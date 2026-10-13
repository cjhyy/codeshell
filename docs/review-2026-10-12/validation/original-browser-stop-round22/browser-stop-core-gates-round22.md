# 第 22 轮原生 parent Browser Stop：Core 契约与迟到门禁只读审计

时间：2026-10-12 06:46–06:48 Asia/Singapore。冻结工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，基线 `a66f4ef291f304ee4df9da8095a90671d9a8f140`。已读该基线 CODESHELL.md，复用 `/tmp/codeshell-review-20261012-browser-lifecycle-round21-cancel-gates.md`。本次仅源码与既有测试覆盖审计，未执行测试、worker、CLI、Chrome、Electron、网络或模型，未修改产品。下面一基行号均指冻结工作区。

**结论：无新增候选、不给优先级、不计 finding。** Core Stop 不仅结算 worker Promise：它 abort 当前 Engine turn、清未运行队列、推进 cancellationEpoch 并抑制旧后台 wakeup；同时单独 drain Browser internal pending。迟到 Main 回包不能重新结算已取消请求或复活旧 turn。当前普通 parent Browser loopback 未将每请求取消传给 Main；这只是需要进一步验证的边界，尚无证据证明正常用户 Stop 后 Main 仍发起了本应阻止的新副作用。不能依据任意 fakeHost await 将其定为 race。

## 正式 Core 路径

1. `packages/core/src/protocol/server.ts:1358` 的 `Methods.Cancel` 进入 `handleCancel()`（`:2433`），委托 `server-run-controls.ts:45` 的 `handleCancelRequest()`。
2. 未提供 expectedClientMessageId 的普通 session Stop：先 cancelRunStarts（`server-run-controls.ts:92`），再取 managed ChatSession；有效会话在 `:108` 调 `s.cancel()`，`:115` drain pending approvals，`:116` 回 `{ok:true}`。它没有 await ChatSession.settled，也不把此 ACK 定义成 Main 所有动作已终止的 barrier。
3. 提供 expectedClientMessageId 的 scoped Stop 在 `:75` 只取消当前真正匹配 turn；只在 stopped=true 时 drain pending approvals。`:77` 明确迟到 Stop 不得影响 successor/start reservation/queued closure。不能把 stale Stop 的 stopped=false 当取消失效。
4. ChatSession.cancel（`chat-session.ts:277`）增 cancellationGeneration、标 cancelledActive、置 cancelledSinceLastTurn、abort 当前 controller、reject queue。`cancelActiveTurn()`（`:302`）同样推进 epoch/abort，但保留无关 queued turns。
5. Engine.run 的正式 signal 来自 `chat-session.ts:519`；pump 对用户 abort 的异常转换为 aborted_streaming（`:552`），finally 在 `:566` settle，再 `:568` 清 active/controller。**cancel() 本身不会同步清 active；busy 直到实际 pump finally 仍可为 true**（`:311`），不能凭收到 Stop ACK 断言 Engine 已完全 idle。
6. cancelledSinceLastTurn/cancellationEpoch 的定义在 `:254`、`:264`；新真实 turn 在 `:178` 清 sticky flag。会话可由新用户输入继续、browser profile/target 可被后续 turn 复用，并不等于旧 turn 自动续跑。

ToolExecutor 在 `packages/core/src/tool-system/executor.ts:144` 对已 aborted signal 提前拒绝；ToolRegistry 在 `registry.ts:201` 将 parent abort 传给 per-tool controller，`:240` race executor 与 aborted promise，`:242` 丢弃取消后迟到成功。它保证 Core 调用/返回生命周期，不会自动取消 JS executor 里没有主动观察 signal 的外部动作。

## Browser request、pending drain 与 Main 回包

普通交互会话通过 `server.ts:1032` 安装实际 BrowserBridge。`makeBrowserBridge()`（`:4398`）把 navigate/click/type/wait 等转为 `requestBrowserActionForSession()`（`:4427`）。其接口只有 session/action/payload/可选 child scope，没有 per-tool AbortSignal 参数。`packages/core/src/tool-system/browser-bridge.ts:227` 的 BrowserBridge 方法也未携带 signal。实际 builtin browserNavigate（`builtin/browser-tools.ts:565`）调用 `b.navigate(url)`，没有传 ctx.signal；该文件 signal 处理集中在 observation screenshot fallback（`:182`、`:197`），不能据此称所有 Browser actions 都会主动取消 Host。

Browser request 先生成唯一 requestId/approval route（`server.ts:4438`）、注册 kind=internal pending（`:4440`，metadata 定义 `:5029`），再 arm timeout（`:4457`）并发 `Methods.ApprovalRequest`/`__browser_action__`（`:4472`）。普通 parent 不含 childHost；child 才携带 bindingId/scope。

Stop drain 在 `server.ts:5065`：

- internal entries 排在 tool_approval entries 前，逐项删除 pendingApprovals、清 timer、删 pendingApprovalTargets（`:5103`）；
- resolve internalCancellation(failure, reason)，默认 failure=cancelled（`:5109`）；
- `parseHostLoopbackDecision()`（`:434`）将 sentinel 归一为 `{ok:false,failure:"cancelled",detail:"browser action cancelled because the turn was stopped"}`，不是用户 deny，也不是 malformed；
- drain loop 会处理 resolver/observer 同步新注册的 pending entries，避免 clear map 后 strand resolver；
- 此方法没有向 Main 发普通 parent Browser request cancel/release 消息。`observeApprovalTransition()`（`:1588`）调用 protocol observers；生产 `packages/pet/src/projection-extension.ts:312` 只更新 pending projection，不是 Browser cancellation channel。

Main 正式入口是 `packages/desktop/src/main/agent-bridge.ts:993` 的 maybeHandleBrowserAction。普通 request 在 `:1011` 开始 async IIFE，`:1026` 等待 actual dispatch，最后 `:1039` send buildBrowserActionReply。`browser-driver/intercept.ts:108` 的回包是 agent/approve，包含原 connectionId/generation/sessionId/requestId。没有从当前 Core pending 状态反向读取、没有 per-request abort token。

迟到回包会被 Core 拒绝：strict routing 在 `server.ts:2289` 需要仍存在 pendingApprovalTargets 且 route 全匹配，Stop 已删除；非 strict managed path 在 `:2326` 需要仍有 exact requestId entry，缺失则 InvalidParams，不回退到 legacy map。因此 Main 即使后来送结果，不能用它让原已取消 Promise 变回成功，也不能借 successor session resolve 旧请求。该规则不等价于“Main 外部动作已被中断”。

对照：child dispose（`server.ts:1090`）观察 child signal，除结算 worker pending，还在 `:1116` 发显式 childHost.release；Main `agent-bridge.ts:1005` 释放 binding，dispatch 的 held lifetime object 保持 released。不能把 child 的这条生产取消通路套到没有 childHost 的 parent request。

## 正常设计反证：资源保留与动作取消不同

`browser-runtime/dispatch.ts:124` 等待 action 结果后 finally release per-call lease。后台 target 本来就应跨工具调用保留；`background-runtime.ts:229` 的 lease.release 只是释放当前引用，idle/capacity 回收避免抢正在运行的动作。`background-runtime.test.ts:720` 名为 “an in-flight action survives lease release and idle/capacity reclamation”，实际先让 click handler 开始，再 release lease，验证 action 完成后才能 idle 回收。**测试没有调用 agent/cancel 或 ChatSession.cancel，不是 Stop 后允许后续动作继续执行的设计许可证。**

相反 owner close/takeover 已有不同的明确门禁：后台 target 的 checkLease/checkEpoch、ensureTarget 及 createDriver await 后检查见 `background-runtime.ts:260`、`:289`、`:293`、`:639`、`:650`；close/takeover 撤销旧实例或 epoch。这些门禁能证明真正调用 close/pause 后迟到请求被拒，但普通 parent Stop 未在已审路径调用它们。

当前实现与 Browser Runtime architecture 文档未找到“agent/cancel 后，尚未提交的 parent Browser 动作仍可启动”的明确设计。`docs/todo/external-agent-runtime-tool-bridge-design.md:1233` 的未来外部 Runtime abort 设计要求 abort Host Tool、使旧 turn 后续事件失效，同时保留 session；`:1243` 写“已经产生外部副作用”不承诺回滚。该文是 TODO 设计，只有 Phase 0-D 的 internal pending 分类分离在 `:1506` 标注已实施，不能直接把全部未来验收条款当作当前 Native Browser 的实现承诺。它同样不支持把已向 CDP/网页提交的单次 click、导航或表单动作当作可自动回滚。

`builtin/browser-tools.ts:155` 对 mutating TIMEOUT 已提示 outcome unknown、先观察避免重复提交；这是已提交动作结果不确定的处理，不是 Stop 后可以发新动作的授权。

## 既有测试覆盖盘点（本次均未执行）

| 测试及行号 | 覆盖结论 | 不能代表的边界 |
| --- | --- | --- |
| `protocol/chat-session-cancel.test.ts:33`、`:60` | active abort clean result；queued turns reject | Engine 替身，无 Main Browser |
| `protocol/server.run-start-cancel.test.ts:103`、`:128`、`:142` | scoped Stop 不杀 successor；Stop 在 run preparation 前阻止 Engine；新用户 run 正常 | 无 Browser side effect |
| `protocol/chat-session-follow-up.test.ts:91` | epoch 只在有效 scoped Stop 增加，跨新 turn 保留 | 无 Main request cancellation |
| `protocol/server.cancel-approvals.test.ts:63` | Stop 立即 drain askUser pending，避免等 timeout | AskUser engine 替身，不是 Browser Host 动作 |
| `protocol/server.host-loopback-cancel.test.ts:119`、`:197`、`:332`、`:670` | internal 与真实 deny 区分、internal 优先、reentrant drain、close 分类 | 核心 probe 是 Panel；不证明 parent Browser Main 已终止 |
| `protocol/server.child-host-bindings.test.ts:135` | child Browser pending 取消、release 通知、后续旧 child bridge 拒绝、fresh binding 恢复 | child scope，与 parent 不同 |
| `tool-system/executor-abort.test.ts:54` | handler 开始前已 abort 不执行 handler/hooks | 不代表已提交外部动作回滚 |
| `tool-system/registry-result-protocol.test.ts:111` | timeout/parent abort 后迟到 handler success 丢弃 | Promise settlement，不证明 handler 外部执行停止 |
| `builtin/browser-tools.test.ts:151` | fallback screenshot cancel promptly、丢迟到图片 | 只读 fallback，不是普通 navigate/click |
| Desktop `browser-driver/background-runtime.test.ts:720`、`:757` | 普通 lease release 保留已运行 action；owner close 时迟到 target 关闭 | 前者不是 Stop；后者是显式 owner close |

没有在这些测试中发现“正式 parent agent/cancel → Main Browser pending 动作停止且无新副作用”的组合覆盖；也没有发现足以推出该故障的动态反例。本轮不新增测试数、正式问题数或严重等级。

## 后续若独立验证时必须满足的证据标准

需要同一个真实正式 Core agent/cancel 路由与真实 Main Browser dispatcher/后台生命周期服务，并记录动作何时提交：如果 Stop 前已经发送操作，Stop 后只收到结果或网页完成，不足以证明新副作用。若要证明 Stop 后还能执行原本可阻止的后续动作，必须证明生产路径的真实等待阶段可达，不能通过任意 fakeHost callback 无限等待来制造窗口；还须以普通完成、新用户 turn、显式 takeover/close 等正常对照排除错误 session/binding 或本来就允许延续的独立后台任务。

如果最终契约要求阻止 Main 尚未提交的动作，Core Promise drain 本身不会跨进程传递 AbortSignal，需要 Main 可见的 request cancellation、turn generation 或等价机制；**当前没有据此认定必须修改产品，也不建议以 Stop 无条件 close 整个 session/target 来破坏正常页面续用。**

新执行测试 0，产品更改 0；只写本 `/tmp` 笔记。parent Stop 静态边界保持未验证，不并入第 21 轮 idle Chrome 反馈 finding。
