# 第十七轮 Server / Hub 配置与审批路由：独立只读质量审计

Completed。审计执行计数 **0**：没有执行或重新执行测试，没有启动 worker、CLI、模型、原生进程或外部服务，没有修改产品、主报告、构建产物或 goal，也没有创建子代理。只读检查冻结 `a66f4ef291f304ee4df9da8095a90671d9a8f140` 源码、最终报告和两份 fixture / 最终原始日志。

**结论：建议保留 H17-1 为独立 P2，范围严格限定为 authenticated Headless Hub 中，已完成 run 留下的异步问题，在合法配置保存的 admission / configure ACK 窗口内被回答。** 不是“存在人工 gate 所以存在缺陷”：生产代码本来就先提交 lease，再检查正在保存的配置；fixture 仅控制实际 `bridge.request("agent/configure", …)` 这个异步边界的 ACK 到达。测试没有捕获真实 worker 下自然竞争的发生频率，不能把短窗口描述为每次配置必现。

## 根因和真实可达性

- `packages/core/src/protocol/server.ts:4205–4217,4273–4289` 注册异步问题后立即返回交付回执；问题可以在 requesting run 已完成、session 不 busy 时继续 pending。这是正式契约，不是伪造尚在运行的同步审批。
- 正式 Skills 开关 `packages/web/app/HubSkills.tsx:377–398` 只受本页 busy / disabledReason 限制，调用 `configuration.ts:120–121` 的 PUT。另一个正常登录标签页可以保存本地配置。fixture 的配置保存动态层是合法 authenticated HTTP PUT；未渲染或点击 Skills 开关，其 UI 接线由源码确认。
- `packages/server/src/serve/headless-server.ts:542–553` 拒绝仍 running、preparing 或已派发 pending response 的配置修改，但没有拒绝上述空闲异步问题；`:559–573` 在保存后异步等待 worker configure ACK。fixture 的 active-run 409 / 不调用 configure 是有效反证，排除了把正常同步审批期间的被拒绝配置误作候选。
- 同文件 `:945` 先 `leases.submit`，`:969–981` 随后因 configurationChanging 返回错误；派发路由直到 `:1127–1135` 才建立，真正发送直到 `:1178`。因此候选错误发生时没有 worker 请求、没有等候 ACK 的 route，也就没有日后 worker-error ACK 能撤销这个提交。

实际 controller / HubApprovalCard 的答题 handler 与 Host 网络路由已联合验证，首次提示配置正在保存、按钮短期 busy；不是仅直接调用 lease helper 或跳过正式 UI 门禁。正确的 Hub UI 在 `useHubController.tsx:599–625` 等待 RPC 成功才清卡，错误时保留卡和文本。这项保护存在，但 Host 已把该题改为不可再次提交，所以 UI 保卡不能恢复交付。

## 配置完成、TTL、重连的反证

1. Host 成功 configure 后只发送 `serve/configurationChanged`（`headless-server.ts:579–583`），controller `useHubController.tsx:363–366` 只刷新配置。不存在该通知重新发布旧题或清 submitted 的旁路。
2. 第二份 fixture 动态使用**实际 AgentServer / ChatSessionManager + fake engine / runtime**，处理同一全局 `{reloadModels:true,reloadSettings:true}` RPC；成功 ACK 后原问题仍在 Core pending，且未发 approvalRequest / approvalSnapshot / approvalResolved。它不是真实 Engine / LLM / worker E2E。真实 `Engine.refreshRuntimeConfig` 的 `engine.ts:3996–4039` 只合并 config、preset、hooks 和版本，没有审批 replay / resolve；这一层仅静态衔接。
3. `ApprovalLeases` 的 `approval-lease.ts:41–50,61–78,100–105` 明确：snapshot 排除 submitted，claim 拒绝 submitted，disconnect / releaseHolder 不释放 submitted，sweep 也只释放未 submitted 的 reservation。30 秒只使前端 lease 文案及禁用状态过期，不使已 submitted 的服务端决策可重试。fixture 的 31 秒为 Date.now 注入加实际 UI interval tick，未真实等待 31 秒。
4. 实际新认证 WS 的空 snapshot 与真实按钮重试得到 `approval is no longer pending`，符合上述状态。`packages/web/app/approvals.ts:19–25` 用 snapshot 替换卡状态，所以刷新 / 重连不会找回旧题。Core 问题没有这里的自动过期计时器；`chat-session-manager.ts:650–651` 还正确保留带 pending approvals 的空闲 session，不能期待 idle TTL 修复。

## 恢复与保护边界

未刷新且仍持卡的页面有正式 Stop 入口：`useHubController.tsx:663` 将 approvals 算 running，`Workbench.tsx:816–825` 因而显示 Stop，`:238` 接实际 controller.stop。**动态仅调用实际 controller callback，未渲染或点击完整 Workbench Stop；该 UI 接线与可见条件为源码证据。** Host fixture 动态证明 cancel 被派发，worker resolved / ACK 是受控协议帧；独立 Core fixture 动态证明实际 cancel handler drain 原 pending，并允许 fresh run 提出新 requestId。新问题经真实回答卡成功派发 / ACK 的恢复对照成立。

这是取消旧题再重新提问，不是交付旧答案。刷新后旧题已不在 snapshot，不能再声称同一 Stop 按钮必然仍可见。旧页面未卸载时文本保留，未证明历史聊天或磁盘文件丢失。

`headless-server.ts:501–505,524–537` 的 worker unavailable / exit 会清 Host leases 并发送空 snapshot / workerExit，是正确清理；本次只读审计和作者 fixture 均没有真实启动、退出或重启 worker。这些路径不恢复旧题或旧答案，不应包装为无损恢复。

正常派发后 `headless-server.ts:486–495` 的 worker error ACK 已 `leases.retry` + snapshot；作者正常对照还证明 originating tab 关闭不会丢该 route、另一 tab 可重试，浏览器伪造 generation 被服务端保存值替换。候选是**尚未派发便早退**的独立漏洞。submitted 不自动过期本身是防重复决定的正确保护，修复不应放宽它。

## 分级、去重与修复建议

P2 合理：触发窗口虽窄且自然发生频率未测，错误却超出配置 busy 窗口持续存在；正常重试、30 秒等待和重连均不能交付旧题，用户需放弃旧题并重问。不要扩大为所有审批 / 所有配置保存必现、永久无法使用会话、跨会话执行或数据损坏。

- R14 的问题是 UI 将异步问题视为新独立任务的 busy 门禁；修复其 async 分类不会改变 Host 的 submit / admission 顺序。
- R19 是 paired Web 普通同步审批在仍 pending 的交付失败后丢卡，下一次有效 resync 可恢复；本候选是 Hub Host 持有 submitted 且主动从 snapshot 排除，即使实际 Hub UI 正确保卡仍失败。
- R26 的 Skills revision / 409 恢复与此不同；本候选配置已成功，失败对象是另一个标签页的问题答案。

应在可重试的配置 admission 通过后再 submit，或在**明确尚未派发**的 submit 后早退路径回滚并广播 pending。保留 session / generation / holder 权威验证，以及派发后等待 worker ACK 时 one-shot 不自动过期的保护；不能一概在断线或计时后重开，避免重复执行。

## 证据与隔离核对

最终作者日志为 `hub-routing.test.log` **1 pass / 20 expect** 与 `core-configure-controls.test.log` **1 pass / 15 expect**，各有 `Completed Bun shard: 1 tests, 0 skipped; 0 failures.`；合计 **2 文件 / 2 测试 / 35 Bun expect**。本审计新增执行仍为 **0**，不重复累计这些结果。作者只在 latest 执行；主审双基线复跑尚不能由这份审计预先宣称通过。

Hub 最终日志仍有 3 条 React act harness 警告，报告已披露。正常 / 错误 / 重试状态使用实际 handler 和 until / act 等待断言，警告不构成产品缺陷，也没有被隐藏；仍应保留没有完整浏览器渲染及时序捕获的限制。早期 import 失败及独立 act-warnings 诊断日志不累计。

两份脚本从 `process.cwd()` 解析仓库，要求 guarded HOME marker，并在 Host / Core 动态导入前安装 exact-origin guard。Hub 只允许自有 loopback，WebSocket 适配器核对精确 origin，额外拒绝 net / tls outbound helpers；Core 控制仅使用不可连接的 loopback guard。不是 OS 网络沙箱或底层 socket 全覆盖，不应夸称绝对网络隔离。Memory WorkerBridge 不启动子进程；Core 用 fake engine / runtime，不加载实际提供方运行。

finally 核对：Hub 恢复 Date.now、卸载 root、关闭自有 sockets、await server.close 后删自有临时目录；Core 最终文件 await server.close 后删目录。修改的浏览器 / fetch / WebSocket 全局适配器由独立 guarded Bun shard 的进程退出隔离；fixture 未把它们恢复到同一进程，不能据此建议在共享长驻测试进程中直接混跑。

本审计只写此文件。Completed。
