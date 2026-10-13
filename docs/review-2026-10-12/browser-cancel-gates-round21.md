# 第 21 轮 Browser 生命周期：取消、撤权与 owner 关闭只读预审

审查时间：2026-10-12 06:37–06:40 Asia/Singapore。冻结工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，快照 `a66f4ef291f304ee4df9da8095a90671d9a8f140`。已读取该工作区 `CODESHELL.md`、primary 工作区 `docs/review-2026-10-12/panels-round6.md` 与 `flow-coverage.md`。仅审 Core/Host Browser runtime、dispatch、handoff 与生命周期；未审 renderer BrowserPanel，未执行任何测试、worker、浏览器、真实 CLI、网络或模型，未修改产品。本文件是源码审计笔记，不是动态测试通过记录。

结论：**本专项没有新增已验证正式发现。** child scope、显式 grant 撤权、后台 target owner 关闭的主要迟到门禁已在生产实现与现有测试中找到。parent Stop 对 Main 既已派发 Browser 动作的影响仅保留未验证静态边界，不计 finding。另向父代理确认 Chrome idle disconnect 的 Host 状态与实际 grant 有效性之间存在不一致，是否形成用户流程问题由实际 BrowserPanel 验证决定。

以下源码位置均相对于上述冻结工作区，行号为该快照的一基行号。

## 正式入口与 authority

- Core 普通原生会话在 `packages/core/src/protocol/server.ts:1024` 的 `wireInteractiveSession()` 安装 BrowserBridge；`:4398` 创建 typed bridge；`:4427` 的 `requestBrowserActionForSession()` 通过 session pendingApprovals 发 `__browser_action__`，不是模型任意指定 Main target。
- Main 在 `packages/desktop/src/main/agent-bridge.ts:993` 的 `maybeHandleBrowserAction()` 解析正式 worker 消息，`:1026` 调 `dispatchInteractiveBrowserRuntimeAction()`。child activate/release 在 `:996`、`:1005` 被独立处理。Main 进程内 Agent 的直接 bridge 在 `packages/desktop/src/main/browser-runtime/dispatch.ts:135` 也走同一 dispatch。
- `packages/desktop/src/main/browser-runtime/dispatch.ts:65` 每次先解析 built-in claim，再解析 Chrome claim，最后才 acquire task-owned target。无显式 claim 时默认 runtime 是该 session profile 的独立后台 target；focus 不授予既有用户 tab 控制。
- built-in grant 的正式用户入口是 `packages/desktop/src/main/index.ts:4442` 的 `browser-runtime:grant-built-in`，先 assertRendererSessionAccess、验证活 guest 和 owner window；`built-in-handoff.ts:93` 再核 exact guest bucket 与 sourceWindowId。显式切换 source 在 `index.ts:4466` 释放 Chrome grant、`:4467` 关闭独立 runtime，避免两个目标默默并行。
- 显式 built-in revoke 入口 `index.ts:4472` 也检查 renderer session access。不能用直接构造未知 child binding、任意 guest、跨 bucket 或错误窗口作为正常故障触发。

## child scope 取消和 owner 关闭

`packages/core/src/protocol/server.ts:1036` 的 child bindings factory 要求 parentSessionId 相同、safe child sessionId、当前 parent approval route 仍属于本连接。`:1058` 的 scope.failure() 检查 closed/child signal、parent ChatSession 实例、disconnected 以及 route generation。请求前 guard 和 BrowserBridge 请求前检查引用同一 scope。

child `dispose()` 在 `server.ts:1090`：先置 closed、删 abort listener 和 disposer，再清 child approval/path cache，逐一 settle 该 scope pending、清 timer，最后通过正式 private channel 发 `childHost.release=true`（`:1116`）。child AbortSignal 绑定在 `:1145`；已 aborted 也立即 dispose。不是只有 Promise 返回 cancelled 而完全漏掉 Host 资源释放。

Main `agent-bridge.ts:999` 将每个 parentSessionId/bindingId 注册到 `ChildBrowserWorkerLifetime`；正常 release 删除一个 binding，worker onSpawnError/onExit 在 `:386`、`:398` 关闭该 worker cohort。`child-browser-lifetime.ts:17` 先清 map 后逐一调用 cleanup，重复 release/close、reentrant cleanup、个别 target close 抛错不会阻止其余释放。新 worker 可以注册新 bindings。

`browser-runtime/dispatch.ts:16` 的 activeChildOwners 是正向 owner registry。release 在 `:37` 先把捕获的对象置 released，再删 map、close target；pending 调用仍持有旧对象，所以不会因 tombstone 数量或后来的 child 活动失效。派发在 `:57` 检查未激活/已释放，acquire 以后在 `:82` 和 `:116` 再检查。resumed child 使用新的 bindingId，不能把旧等待请求恢复为可执行。

现有测试源码（本次未执行）：

| 文件及入口行 | 已有覆盖 | 重要边界 |
| --- | --- | --- |
| `packages/core/src/protocol/server.child-host-bindings.test.ts:135` | abort child Browser request，仅清该 child pending，sibling 提问可继续；旧 bridge 后续请求 cancelled，resumed bindingId 不同 | 实际 AgentServer/ChatSession 与内存 transport，非真实浏览器 |
| 同文件 `:181` | parent approval owner 丢失后 queued approvals 不再提示，owner_lost 分类 | 不是独立 Main 浏览器进程实测 |
| `packages/desktop/src/main/browser-runtime/dispatch.test.ts:273` | pending acquire 结束前 release；后续 2050 次其他 release 后旧调用仍 TARGET_CLOSED、navigate 次数 0 | runtime acquire 是测试 seam，证明 dispatch 捕获对象规则 |
| `packages/desktop/src/main/browser-runtime/child-browser-lifetime.integration.test.ts:12` | worker lifetime.close 后 pending child 不能 navigate；parent target、restart 后新 child 仍可用 | lifetime/dispatch 组合，runtime 替身；不称真实 worker exit |
| `packages/desktop/src/main/browser-runtime/child-browser-lifetime.test.ts:18`、`:42`、`:53` | duplicate/reentrant release、close callback 抛错与 fresh cohort | 幂等清理边界 |

parent target 在 child 完成或 worker exit 后可以保留，和 child scope 永久结束不同；不能把“浏览器 session 可以在下一轮继续使用”本身记作资源泄漏。

## built-in grant 撤权、接管及重新授权

`built-in-handoff.ts:130` revoke 删除 live grant、保留 revoked marker、清 expiry timer/destruction listener，并 releaseGuest。guest destroyed listener 在 `:121` 自动 revoke；`liveGrant()` 在 `:220` 检查 TTL 和 bucket。dispatch 无 live grant 但有 marker 时返回 NEEDS_HUMAN（`:175`），不会偷偷退回独立 runtime 或另一 tab。只有显式新 grant、source switch/final cleanup 清 marker。

requestTakeover 在 `:196` 增加 controlEpoch 并 releaseGuest，仍可保留有效 capability grant。普通 dispatch 在 `:205` 捕获 grant 对象与 epoch，给 `handleBrowserAction()` 的 isActive 同时检查二者（`:207`）。Host 每 guest 串行队列在 `browser-driver/automation-host.ts:188`；排队开始、resumeGuest 后和异步 driverForGuest 后分别在 `:215`、`:317`、`:320`、`:328` 重新检查 isActive。因此新 grant 不能授权旧 grant 的请求，新 resume 也不能授权旧 controlEpoch 的排队动作。

现有 `browser-runtime/built-in-handoff.test.ts`：`:35` 接管取消 queued resume/navigation，之后新的 resume 和 navigation 正常；`:97` revoke+立即 regrant 也不会复活旧 queued navigation；`:148` driver creation 等待中 revoke+regrant，旧 navigation 仍 0；`:194` revoke/TTL 释放并能显式新授权；`:217` owner window/bucket；`:236` exact tab、expiry 与 focus 改变。以上是现有源码覆盖，不是本次执行结果。

## task-owned 后台 target 关闭和恢复

`browser-driver/background-runtime.ts:260` 生成 per-lease bridge；checkLease 验证 lease released、entry.disposed 和 map identity。每次入队捕获 controlEpoch，排队开始检查（`:276`）；普通 use 在 ensureTarget 后、createDriver 后分别检查 control（`:289`、`:293`）。pauseTarget（`:607`）立即增 epoch/置 paused，接管不需要等串行 queue 完成，且主动 detach driver 以中断等待。resumeControl 在 `:328` 新建 driver 后复查 epoch，再清 paused，不会用迟到 resume 重新抢控制。

owner close 的正式底层方法 `:244` 清 continuity 并 dispose 当前 entry。enqueue 的 `:679` 在队列开始检查 disposed/map identity；ensureTarget 的 `:621` 在打开前检查、`:639` 在 openHost 完成后检查并关闭迟到 host、`:650` 在 createDriver 后再次检查。disposeEntry 在 `:763` 先删 map/置 disposed，然后 detach/dispose/close。仅从外层 runtime.close() 未带 tombstone 不能推论旧底层 lease 可继续执行。

会话删除正式链在 `main/index.ts:6748`：先清 grant，再 await bridge.closeSession barrier，完成 disk 删除后 `:6771` forgetSession；`agent-bridge.ts:1754` forgetSession 关闭 interactive runtime、清 grants、forget profile bucket。scope/target close 和普通 tool lease release 不是同一种操作。普通 dispatch finally release 为保留同一 browser target/context 服务，未承诺每个工具调用后关窗；现有 `background-runtime.test.ts:720` 明确覆盖已运行 action 能完成、idle/capacity 不抢正在用 target，不能据此推断 owner close 无效。

现有 `background-runtime.test.ts`：`:181` 接管中断 in-flight wait；`:244` 接管期间迟到 resume 不恢复控制；`:648` 显式 owner close 撤销旧 lease，replacement 新 logical tabId，不接受旧 handle；`:667` released lease 不重开 target；`:757` owner 在 target creation 中 close，迟到 host 关闭、不复活 entry。`:579` idle reclaim 保留 closed logical handle，只能显式 navigate 恢复；`:613` capacity reclaim 不把旧 handle 路由给另一任务；`:636` remembered handle 仍绑原 partition。`listTabs` 的 closed handle 是恢复设计，既不是 live target 也不代表错目标控制。

## Chrome grant 的执行门禁与 idle 状态差异

`chrome-extension-runtime.ts:176` revoke 删除 grant、记 endedGrants 并请求 exact tabId/grantId detach；forgetSession 在 `:195` 才移除 continuity marker。dispatch 在 `:207` 队列开始检查 isCurrentGrant 和 epoch；takeover 在 `:204` 立即增 epoch，`:221` 绕过 queue。requestForGrant 在 `:529` 请求前核 grant/connection、`:543` await 后再次核同一 grant/epoch。Chrome 回应 tab identity 在 `:317` 校验，旧 detached event 只能删除同 tabId/grantId（`:260`）。新 hello 在 `:229` 明确终止旧 grants，不能自动沿用旧授权。

现有 `chrome-extension-runtime.test.ts:210` 覆盖 takeover 取消 queued resume 和等待 tab.get 的 click；`:240` revoke/expire/disconnect/reconnect 四种结束后不执行 queued action，后续 snapshot NEEDS_HUMAN；`:281` mismatched tab response/旧 detached event；`:300` oversized native request 发送前拒绝。disconnect 测试已经有 action 正在执行，requestForGrant 的后置检查会清 grant，不能证明 idle status 无误。

向父代理提供的独立源码反证：

- `ChromeNativeBridgeServer` socket close（`chrome-native-server.ts:166`）清 client 和 pending requests，没有 callback 通知 ChromeExtensionBackend revoke。
- Backend `status()`（`chrome-extension-runtime.ts:150`）返回 connected=false 与 liveGrant 提供的 granted；`liveGrant()`（`:550`）只按 TTL 清 grant。与 `isCurrentGrant()`（`:491`）把 !server.connected 定义为 grant ended 不一致。
- `beginPairing()`（`:133`）见旧 liveGrant 直接返回 status，不生成新 code。新 hello、显式 revoke 或 expiry 可以恢复。
- 未找到“断线仍保留可用 grant”的设计依据；新 hello 注释相反。但单独 granted 字段也可能表达历史 permission，**只有结合实际 UI 活跃文案/恢复入口才能形成用户流程 finding**。父代理在审 BrowserPanel，本子任务不独立定级、不另编号；不声称越权，执行门禁仍 fail closed。

## parent Stop 静态边界：未验证，不计发现

Core 正式 `agent/cancel` 在 `server-run-controls.ts:108` 调 ChatSession.cancel()，然后 drain session pendingApprovals；`server.ts:5065` 把 internal Browser/Panel 等请求 settle 为 cancellation sentinel，并清 timer。现有 `server.cancel-approvals.test.ts:63` 与 `server.host-loopback-cancel.test.ts:119` 验证 worker 请求及时结束、失败不伪装用户 denial；后者是 Panel loopback，不能当作 Main Browser cancellation 实测。

Main `agent-bridge.ts:1011` 对 Browser 动作启动 async IIFE，`:1026` dispatch 以后等待结果再 `:1039` reply。此段没有每 request AbortSignal；parent 普通 Browser request 也不像 child dispose 那样额外发送 release。若某个普通 Browser action 仍在可取消的 Host await 前后，则 Core Stop 已结算与 Host 是否继续执行的关系需要端到端验证。

本次**不做动态、不计 finding、不给优先级**。必须证明通过真实正式 agent cancel/Host 路由，Stop 后仍执行用户原本期望停止的实际动作，并排除“动作在 Stop 前已经提交”“普通 task-owned browser 可以保留到下一轮”和人为 fake openHost 等待造成的不可达时序。当前源码本身不足以声称取消后不可逆写入、grant 绕过、数据泄漏、无限后台运行或浏览器资源泄漏。

本次新执行测试数 0；产品更改数 0；仅写本 `/tmp` 审计笔记。现有测试名称和断言只用于覆盖盘点，不并入父审查测试通过计数。
