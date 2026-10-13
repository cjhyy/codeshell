# Goal bound cold resume 独立质量核对，第 20 轮

Completed。**保留 G20-2，建议 P2。新增测试、原生程序、worker、CLI、模型及网络执行均为 0。** 此次只读最终报告、两快照最终日志/JSON、冻结 fixture 和生产源码；不修改产品、构建、主报告或目标。G20-1 的无 worker Main 分支由另一审计负责，本附录不重复裁定。

审阅对象：[原始报告](/tmp/codeshell-review-20261012-goal-sleep-round20.md)、[冻结 fixture](/tmp/codeshell-review-20261012-goal-sleep-round20/goal-resume.test.tsx)、[latest 最终日志](/tmp/codeshell-review-20261012-goal-sleep-round20/latest-a66f4ef2/goal-resume.final.log)、[initial 最终日志](/tmp/codeshell-review-20261012-goal-sleep-round20/initial-84740d56/goal-resume.final.log)、[latest observations](/tmp/codeshell-review-20261012-goal-sleep-round20/latest-a66f4ef2/observations.json)。最终 source SHA 为 `b9af1cb777b5fb030839600ced33d4ea369306ee7272127c9f57744d59f490b6`；两份正式日志分别为 1 文件、4 tests、72 expects、0 fail/skip、Completed。早期 fourth 的 4/68 是历史版本，不累计。两基线作者执行数也不转换成本审计新增执行数。

## 判定与自然可达性

问题是 **native project-bound Session 的冷 Goal continuation 没有重新取得 Host workspace authority，随后隐藏了正确的安全拒绝**。不应把 Core 的 bound guard 写成缺陷，也不应把 `paused:false` 单独叫做“正在运行”。正式 Resume 的驱动语义有明确实现和正常控制：Core [server.ts:2684](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2684) 将 idle Goal 的 `paused:false` 定义为 drive request，在 2757 排队 synthetic turn。合法 cold Session 无法执行这一恢复操作，而且该次失败没有 error/暂停回滚，足以支持 P2；不是纯偏好或显示摩擦。

这不是只有任意 protocol 调用才能构造的状态：

1. 正常 Desktop native run 携带 Host 的 WorkspaceContext，Engine [engine.ts:1666](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/engine.ts:1666) 将其转为持久 project/root binding；已有会话也会在 [run-session-open.ts:91](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/run-session-open.ts:91) 补绑定。因此被测 bound 形状属于正式项目会话，不是 fixture 私有字段。
2. Desktop worker 是共享的 stdio 服务。启动后的另一会话普通 run 可让 worker 存活，而重新打开 B 只从磁盘读取 Goal，不创建 B 的 ChatSession。生产 [agent-server-stdio.ts:412](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:412) 和 [server.ts:2891](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2891) 明确记录这个加载契约。另有生产 30 分钟 idle TTL/60 秒 sweeper：[agent-server-stdio.ts:350](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:350)、[chat-session-manager.ts:640](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session-manager.ts:640)。它只回收不 busy、无 pending approval、无 running background job 的普通会话，未给持久 Goal 额外常驻例外；不声称所有暂停瞬间都会被回收。
3. 正式加载 hook 在 [useTranscriptBuckets.ts:384](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useTranscriptBuckets.ts:384) 读取 persisted Goal。可见 Resume 按钮 [StatusPopover.tsx:189](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/topbar/StatusPopover.tsx:189) 调 App [1962](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1962)，经 preload [index.ts:629](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:629) 发 `agent/goalUpdate`。按钮没有要求该 Session 已 resident。
4. Main 的 `prepareAgentRunMetadata` 在 [agent-run-metadata.ts:89](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-run-metadata.ts:89) 对非 `agent/run` 原样返回，故不为 GoalUpdate 注入 context；worker 存活时正常转发 [agent-bridge.ts:912](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:912)。外部 CLI 的 prepareResume 不能补救 native：其 handler [external-runtime-goal-rpc.ts:81](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/external-runtime-goal-rpc.ts:81) 明确跳过非 external Session。

上述 UI→Main→真实 worker 整链为源码可达性证明；**bound-cold 动态用例直接进入 actual AgentServer transport，并没有点击完整 App 或启动 Electron/worker**。它不是完整 Desktop E2E。第 1 用例验证的实际按钮/App closures/Main callback/preload 为另一个 no-worker 场景，不能挪作第 3 用例完整 UI 已跑的证明。

## 生产 factory / bridge 反证

不能以“自定义 engineFactory 漏配置”排除：

- Main [agent-bridge.ts:188](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:188) 实际解析 stdio worker 入口。生产 factory [agent-server-stdio.ts:299](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:299) 直接设置 `cwd:sessionCwd, workspaceContext:slice.workspaceContext`，没有自行从 registry 重造 context；[426](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:426) 同样开启 workspaceBridge，436–438 供给 Goal 磁盘回调。
- Cold Goal path [server.ts:2547](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2547) 仅传 `{projectTrusted:false}`。实际 manager [chat-session-manager.ts:388](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session-manager.ts:388) probe 磁盘后在 397–401 只补 cwd，不能从 cwd 推导 Host registry/root authority。
- `wireInteractiveSession` [server.ts:1179](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:1179) 设置 workspace bridge 是工具调用能力，并不在设定时自动发 Host resolve 请求。冷恢复随后直接 enqueue，未调用已有 `resolveHostSessionWorkspace`。真实后台唤醒在 [server.ts:950](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:950) 会显式请求 Host；这条对照也排除了“启用 bridge 就必然已有 context”的解释。
- 本次只读 `git diff --stat 84740d56..a66f4ef2` 核对了上述 server/ChatSession/manager/Engine workspace/stdio factory/Main metadata+workspace resolver/App/load hook/StatusPopover/preload 文件，输出为空。结论覆盖两冻结产品快照，不扩到其他版本或所有 SDK host。

## 真实失败链与“成功”用语

Core [run-workspace.ts:188](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/run-workspace.ts:188) 对 bound Session 缺 authoritative context 正确拒绝。它在 [233](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/run-workspace.ts:233) 返回 `EngineResult`，Engine [engine.ts:1539](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/engine.ts:1539) 在 session setup/model turn/stream start 前直接 return：

```text
ERROR: bound Session requires an authoritative WorkspaceContext
reason=model_error; turnCount=0; usage=0
```

`model_error` 是初始化失败枚举，不证明 provider 失败。fixture 保留了真实 error text、两次 factory slice、无 context、主模型调用 0、Host workspace 请求 0、stream error 0、session_started 0，以及磁盘 lifecycle active/revision2。注册 ProjectStore、SessionCwdIndex 和 actual Main `resolveSessionRunWorkspace` 证明健康 root 的正确 authority 存在，失败不是 target 已删除/非法目录/拒绝未获授权项目。

重要表述边界：公开 RPC 返回的是 `{ok:true,updated:true,paused:false}`，**没有 `queued:true` 字段**。其含义首先是 Goal mutation 成功；不能仅因这个早 ACK 本身认定有 bug。实际缺陷还包括后续 resolved 初始化失败没有被处理：[chat-session.ts:545](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session.ts:545) 把真实 EngineResult 交给 next.resolve，而 resume 专用 resolver [405](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session.ts:405) 忽略结果并 resolve(true)。Server [2769](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2769) 只有 reject 才调用回滚/error 分支。故真正未启动的 continuation 既未暂停回来也未通知失败；App [1929](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1929) 接受返回投影后没有异常可触发 reconcile。

## 正常、恢复与安全范围

最终 fixture 的 cold legacy 与 resident bound 两项控制均在 actual Core/Engine 下运行一次 owned 内存 LLMClientBase，通过 actual `complete_goal` 持久 terminal/completed；说明失败限定 bound+nonresident，不是所有 Goal 或所有 cold Session。`projectTrusted:false` 的 resident bound 对照同样成功，失败不是“未受信任项目本来就不许 Resume”。fixture 的 bypass permission mode 用于消除工具批准交互，workspace guard 在模型/tool 阶段前独立生效，不据此宣称任何真实用户 bypass 权限问题。

失败后，同一 Session 的普通 `agent/run` 携 actual Main resolver 已取得的 context，实际 Engine 成功一轮并完成 Goal。这是**服务级恢复**；报告已标 `actualMainSend:false`，并未实际点击 normal-send/启动完整 worker。Main ordinary-run context 注入和 ensure 接线为源码支持。可以建议用户发送继续消息作为有根据的 workaround，但不能写“完整 Desktop 恢复点击已验证”。没有历史删除、目标丢失、永久不可恢复、错项目执行、权限绕过、真实 provider 请求或费用证据。

现有 fence 仍应保留：Goal ID/revision CAS、严格 TCP 连接归属 [server.ts:2518](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2518)、同 Goal pending resume 合并及 queue-head pause/delete guard [chat-session.ts:386](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session.ts:386)、manager close/migration 生命周期门禁和 workspace binding 匹配。建议修复先经 Host 得到最新合法 authority，在 await 后复核 Session/generation/owner/Goal 身份，再 enqueue；失败须按当前 Goal revision 条件回滚并报告原因。不能通过删除 bound guard、合成 legacy context、相信 renderer cwd 或旧 activeProject 修复。resolved 结果判定也应区分 pre-loop failure、正常已运行终态及 intentional queue skip，避免把所有 false/取消结果一律回滚成新错误。

## 去重与证据限制

与 G20-1 的无 worker fallback 独立：只给 Main 增加 ensureWorker 仍会抵达本项 cold bound 失败；只修 Core Host context 也不会使原来无 worker 的 Main fallback 发请求。两者可在产品叙述中相邻，但有不同失败层、正式触发条件和修复点。本项缺 authority 与吞掉 resolved 初始化失败宜合为一个冷恢复 finding，不拆数量。

与 R44/R45 自动化 timeout/分类不是同条生产链：这里是用户 GoalUpdate synthetic continuation，修复点在 Core Goal scheduler 与 ChatSession result，不涉及 cron helper/gateway completed 投影；与 R73/R76 async-answer admission/busy projection 亦独立。未发现现有 R01–R77 已覆盖这条 bound cold Goal 失败。

fixture 的 transport 若见 Host workspace request 会抛错，因此它不是真实 Main workspace IPC adapter；本场景动态记录请求 0，与源码确实没有调用 resolve 的事实一致，未利用错误 adapter 伪造失败结果。actual runtime 为最小替身、hooks 清空、provider 为 owned 内存类；不称真实 capability/plugin/runtime/LLM 端到端。导入前已设精确 origin guard、net/tls deny、全部 child_process API deny；cleanup await server.close/Engine.dispose 后只移除 owned 目录，最终 network/subprocess 0。此次没有重跑这些控制；所有执行数字来自冻结收据。

**最终建议：保留独立 P2；正式标题/正文应突出“bound 冷 Goal 恢复漏权威上下文且初始化失败未反馈”，避免写成模型错误、所有 Resume 失效或公开返回 queued:true。审计新增执行 0、发现数增量 0，仅支持该已冻结候选。**
