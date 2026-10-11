# 第十七轮 Server / Hub 路由审查

主审正式收录：**R73 / P2 = H17-1**。下文保留作者最初 latest-only 记录；主审双基线结果见末尾，独立审计未新增执行。

Completed。产品、主报告和构建产物均未修改。代理本轮只在冻结的 `a66f4ef291f304ee4df9da8095a90671d9a8f140` 快照执行；初始基线由主审另行复跑，不在本轮结果中预先声称通过。

结论：保留 1 个未编号 P2 候选 H17-1；另验证了正常审批错误重试、tab 关闭后的回包归属，以及 Core 配置重载和取消的正常行为。2 个独立便携 Bun 文件，2 pass / 0 fail / 0 skipped / 35 expect。没有 native、Electron、真实模型或真实账号实验。

## H17-1 / P2：配置热重载期间回答异步问题，会提交一个从未交给 worker 的 lease，配置完成后也不能重试

### 生产入口与操作时序

适用范围为启用 Hub 认证的 Headless Server，使用 `AskUserQuestionAsync` 产生的“可稍后回答”问题。不是 CLI room 审批，也不需要构造未来的异步 owner 校验。

1. 一次正常任务发出异步问题，随后该次 run 完成，问题仍待回答。实际 Core 在 `packages/core/src/protocol/server.ts:4180–4290` 注册 `asynchronous: true` 的 session approval，并立即返回问题已显示的回执。实际 Core 控制已验证 run 返回且 session 不 busy，问题仍在 `pendingApprovals` 中。
2. 用户在另一个已登录 Hub 标签页进入 Skills，点击一个本地 Skill 的启停开关。生产入口为 `packages/web/app/HubSkills.tsx:377–398` → `configuration.ts:120–121` / `94–105` → `PUT /api/v1/configuration/skills`。按钮只受本页操作 busy 和 skill disabledReason 约束，未受另一页的待回答问题约束。
3. Host 的 `withConfigurationMutation`（`packages/server/src/serve/headless-server.ts:542–553`）只阻挡运行、准备或已派发等待回包的任务，没有把未回答的异步问题作为拒绝条件。因此以上 run 完成后，配置保存是合法操作。写入后 `559–573` 真正异步等待独立 worker 的 `agent/configure({reloadModels:true,reloadSettings:true})` ACK；这是真实生产 IPC 等待窗口。fixture 控制该已有边界的 ACK 到达时间，没有在生产本来同步的位置添加 gate。
4. ACK 未到达时，原标签页在实际 HubApprovalCard 文本框输入答案并点击“回答”（`packages/web/app/HubApprovalCard.tsx:40–59`），走实际 `useHubController.decide` 和 ProtocolClient。Host 先在 `headless-server.ts:945` 调用 `leases.submit`，再于 `969–981` 发现 `configurationChanging` 并返回 `-32009 / 配置正在保存，请稍后重新发送任务。`。
5. 此早退既没有发给 worker，也没有建立 `1127–1135` 的 pending response route，更没有撤销刚才的 submitted lease。worker 不会处理该答案。配置随后成功 ACK、HTTP 200，原问题仍不能提交。

### 用户可见影响、期限和恢复

第一次错误会显示在实际 controller 的 error 状态，问题卡仍保留。Host 在 `ApprovalLeases.submit` 中先广播带 30 秒 expiresAt 的 lease 再标 submitted，实际卡会显示“设备正在处理此审批…”并禁用按钮（`useHubController.tsx:719–722`、`HubApprovalCard.tsx:48–64`）。

前端 lease 时钟在 `useHubController.tsx:472–480` 每秒更新。测试将 Date.now 注入前移 31 秒，由实际 1 秒时钟 tick 使回答按钮重新启用；**没有实际等待 31 秒**。此时点击同一卡片，实际服务端仍返回 `approval is no longer pending`，也没有向 worker 派发答案。

这不是普通的 30 秒 reservation 到期：`packages/server/src/hub/approval-lease.ts:47–50` 拒绝 submitted，`100–105` 的 sweep 只释放未 submitted 的条目，`69–78` 的 disconnect/releaseHolder 也不释放 submitted。Host 的 5 秒 reaper 调 sweep（`headless-server.ts:273–276`）不会改变这个状态。没有给这个已 submitted 条目设置其它服务端 TTL。

重新连接会收到 `serve/approvalSnapshot`，但 `approval-lease.ts:41–44` 排除 submitted；实际新 WS 的快照为空，不能借重连恢复该问题。配置成功只广播 configurationChanged（`headless-server.ts:579–583`），controller 仅刷新配置（`useHubController.tsx:363–366`）。

**配置重载本身不会隐藏地重发或清理问题。** 第二个 fixture 动态调用实际 AgentServer 的同一个全局 configure RPC：ACK `{ok:true}`、模型重载和 session runtime 配置刷新均被调用，原问题仍 pending，没有新的 approvalRequest、approvalSnapshot 或 approvalResolved。该测试使用 fake engine/runtime，未运行真实 Engine；真实 `Engine.refreshRuntimeConfig` 在 `packages/core/src/engine/engine.ts:3996–4039` 只更新配置、preset、hooks 和版本，没有审批 replay/resolve 路径。这一真实 Engine 层为源码衔接结论。

**有清理恢复入口，但不会恢复旧答案：**

- 未刷新、仍持有问题卡的页面，`useHubController.tsx:663` 把 approvals 算入 running，生产 Workbench 因而显示 Stop（`Workbench.tsx:816–825`）。fixture 动态调用了这个实际 controller.stop 动作（`useHubController.tsx:628–630`），没有渲染并点击完整 Workbench 的 Stop 按钮；实际 Host 确实派发 `agent/cancel`。该 Host fixture 的 worker resolved/ACK 是受控帧。
- 独立的 actual Core fixture 动态证明相同 session 的 agent.cancel 经 `server-run-controls.ts:83–116` / `server.ts:5065–5118` drain 掉旧问题，发 approvalResolved；随后 fresh run 可以提出不同 requestId 的新问题。Host 收到 resolved 后清 lease（`headless-server.ts:455–457`）；Host + 实际回答卡对新问题的成功派发/ACK 已动态验证。**这是取消旧题后重新提问，绝非交付原答案。**
- worker exit 在 `headless-server.ts:524–537` 清所有 Host leases 并发空 snapshot/workerExit，仅为源码确认；本轮未启动、杀死或重启真实 worker，也未证明旧问题/答案跨 worker restart 恢复。重启是清理旧运行态，不能写为恢复旧问题。

不声称历史消息丢失、文件损坏、跨会话执行或服务永远不可用；失败答案一直未进入 worker，当前卡片文本框在未卸载页面时仍保留答案。影响是一次合法回答被本应可重试的配置 busy 错误污染为已提交，通常重试和重连无法交付该旧问题；用户要取消并要求重新提问。

### 根因与修复位置

核心位置为 `packages/server/src/serve/headless-server.ts:945` 与 `969–981`：在进行通用、可重试的 admission 检查前，就不可逆地提交 approval lease。应在配置 admission 通过后再 submit，或让所有 submit 后、未派发前的早退可靠调用 retry 并广播正确 pending 状态。保留已派发、等待 ACK 时不自动过期的保护，避免引入重复决策。

现有正常的 worker error ACK 路径 `headless-server.ts:486–495` 已正确 retry + snapshot；候选只缺未派发早退的回滚。建议 P2，信心高；真实 IPC 窗口通常较短，但并行标签页保存配置与回答问题是正常生产操作，且失败状态超出短暂 busy 窗口持续存在。

### 去重

- R14 是异步问题在 run 完成后阻挡新的独立任务；本候选在实际 Host 已允许配置保存时，把原问题回答错误地标 submitted。只修 UI 的异步阻挡分类不能修 lease 的提交/回滚顺序。
- R19 是 paired 同步审批尚 pending 的交付失败导致卡片缺失，有效 resync 可恢复；这里是 Hub Host submitted 状态被错误保留，重连快照主动排除它。实际 Hub 卡保留并显示错误也仍无法重试。
- R26 是 Skills 编辑 revision 在 409 后未刷新；本轮配置保存合法成功、Skill 状态实际完成，失败对象为另一页的待回答问题，没有编辑 revision 冲突。

## 正常反证与范围限制

`hub-routing.test.ts` 先验证正常派发后的 error ACK：A 页提交，Host 将浏览器 request id 改成内部唯一 id，并使用服务端保存的 generation；A 关闭后仍保留 pending route，worker error ACK 会 retry 并给 B 页发 pending snapshot，B 用相同本地 request id 可以成功重试并仅收到对应自己的响应。关闭 tab 不会自行重开已派发决策，仍等待 worker ACK，这是正确的避免重复执行保护。

配置保存发生在实际 Host 仍有 run pending 时，真实 HTTP 返回 409 且不调用 configure。这排除了“随便在同步工具审批期间保存配置”这种实际不合法的触发。正式候选使用 completed run 后的 async question。

两份证据组合为：实际认证 Headless HTTP/WS + 实际 React controller/card；以及实际 Core AgentServer/ChatSessionManager + fake engine/runtime。第一份只替换 WorkerBridgeCore 为内存受控桥，configure 等待、approval/resolved/ACK 均是协议 fixture，没有子进程；第二份执行真实 Core async-question 注册、configure 和 cancel，但 model run 由 fake engine 发出可控事件。因此**不是一次完整真实 worker + Engine/model E2E**。配置 API 由 fixture 发合法 HTTP PUT，Skills 开关到该 API 的入口为源码核验；回答使用真实 React handler。浏览器 Cookie/Origin 由本地 WebSocket/fetch 适配器填充，不是实际浏览器。

网络守卫在 Core/Host 导入之前安装：维护的 exact-origin HTTP/fetch guard，仅允许自有 loopback；额外限制 WebSocket origin 并拒绝 node net/tls outbound helpers。没有第三方请求、真实 provider/MCP、账号或模型。该约束不是 OS 网络沙箱或全面底层 socket 隔离。

## 独立脚本、命令与原始日志

目录：`/tmp/codeshell-review-20261012-server-routing-round17/`。两份源码均从 `process.cwd()` 解析仓库，不内置任何 worktree 绝对路径；使用已存在的 dist，不依赖 0.9.33 新增 API。

```sh
node scripts/run-bun-test-shard.mjs --timeout 25000 /tmp/codeshell-review-20261012-server-routing-round17/hub-routing.test.ts
node scripts/run-bun-test-shard.mjs --timeout 20000 /tmp/codeshell-review-20261012-server-routing-round17/core-configure-controls.test.ts
```

| 最终源码 / 原始日志 | 本轮 latest 原始结果 | 动态边界 |
| --- | --- | --- |
| `hub-routing.test.ts` / `hub-routing.test.log` | 1 pass, 0 fail, 20 expect；Completed 1/0 skipped/0 failures | 实际认证 Host、HTTP/WS、controller/card；内存 worker bridge |
| `core-configure-controls.test.ts` / `core-configure-controls.test.log` | 1 pass, 0 fail, 15 expect；Completed 1/0 skipped/0 failures | 实际 Core protocol + ChatSessionManager；fake engine/runtime |

最终合计 2 文件 / 2 测试 / 35 Bun expect，0 fail / 0 skipped。Core fixture 的 finally 已 `await server.close()` 后再删除自有目录并重新单独运行，15 expect 最终日志已更新。Headless fixture 最终日志仍有 3 条 React act 警告，来自受控 WS 事件触发测试状态更新的 harness 边界；未隐藏，不计为产品缺陷，且该日志有完整零失败 JUnit/Completed。`hub-routing.act-warnings.log` 和 `hub-routing.harness-import-failed.log` 为开发诊断，不累计为验证结果；早期 import 失败是 /tmp 裸 React 路径问题，最终文件已改为仓库依赖的绝对解析。

本轮只对 latest 执行。只读 diff 核对表明，以上关键 approval lease、controller/card 和 Core 文件在 `84740d56..a66f4ef2` 没有变化；headless-server 差异仅 Panel project-scope 接线，不在该配置/审批分支。两基线成立须由主审复跑后声明。

## 主审便携复核与正式收录

正式 **R73/P2（H17-1）**。主审在84740与a66f分别guarded运行最终两文件：每基线 **2文件2测试35个Bun expect、0fail/skip、Completed**。Core fixture已await close后清理。初始基线首次Hub脚本只等待hello便读取approvalSnapshot，帧尚未到达导致fixture TypeError；原失败日志保存在validation/original-server-routing-round17/hub-routing.root-reconnect-timing-failed.log。便携fixture增加等待snapshot实际收到后再作原断言，两基线仅重跑修改的Hub文件，各1/20通过；未修改产品、没有通过加等待改变lease行为。

[Hub脚本](reproductions/server-routing-round17/hub-routing.test.ts)、[Core控制](reproductions/server-routing-round17/core-configure-controls.test.ts)、[初始Hub最终日志](reproductions/server-routing-round17/hub-routing.test.ts.log)、[Core最终日志](reproductions/server-routing-round17/core-configure-controls.test.ts.log)、[独立审计](server-routing-quality-round17.md)。原始作者Hub有3条act警告，主审最终日志分别为3/3条；这些都是harness更新边界，原样保留，没有计作产品失败或抹掉。

[R73 submit位置](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:945)，[配置admission早退](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:969)，[lease不重试submitted](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/approval-lease.ts:47)。
