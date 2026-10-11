# 第十七轮上下文打包正常控制：独立只读质量审核

结论：**四项正常控制成立，正式新增 0；本次审核新增执行严格 0。** 未修改产品、主报告、原 fixture，未运行测试/模型/native 进程或创建代理。报告正确区分实际 MessageStream + Core/Engine/SessionManager 与静态 App / Main / preload / IPC / Sidebar 边界。root 已采纳测试显示名与精确取消入口修订，并补同步 exclusive 保护；最终脚本及两快照成功日志已再次只读核对。

已读 CODESHELL.md、`/tmp/codeshell-review-20261012-context-recovery-round17.md`、最终便携 `context-recovery.test.tsx`、tmp 最终/初始成功日志、两快照 docs 下的最终脚本和 `.test.tsx.log`，并静态核对相关生产源码。tmp 最终脚本与两快照便携副本 cmp 一致；相关 MessageStream/App、Core server/chat-session/engine/session-manager 在 `84740d56..a66f4ef2` 无差异。

## 动态结论与不能扩张的范围

| 控制 | 脚本证据 | 审核判断 |
| --- | --- | --- |
| 摘要失败后同选择重试 | 111–125，实际 UI handler、Core error reply、真实 sessions 目录、summary/provenance 与原文事件 | 成立；只是 owned provider 抛错，不是实际第三方超时、OS 崩溃或磁盘拒写 |
| 非法 range / 已存在 target 在模型前拒绝 | 127–133，真实 Core 请求，owned client.calls=0，target 不存在/原文保留 | 成立；范围验证与目标存在性来自生产 Core / SessionManager，没有替换 Engine 拒绝逻辑 |
| 服务级取消释放 exclusive 后重试 | 135–147，真实 agent/cancel、provider signal abort、目标未发布、busy=false、新目标成功 | 成立；不证明 Desktop Stop 出现、按钮接线或 UI 取消摘要完成，也不证明忽略 AbortSignal 的真实提供方一定终止 |
| 切会话后旧成功结果不应激活 | 149–157，第二个真实持久 session；实际 MessageStream 重新 render，target 仍落盘，callback 的 shouldActivate=false，旧选择消失 | 成立；测的是 predicate/回调与 Core target，未执行 App 注册 Sidebar、选择导航或 Main IPC |

fixture 的实际链清楚：真实 new Engine（60–64；禁用 builtin tools 并清 hooks）、真实 ChatSessionManager 和 AgentServer（71–81）、真实 provider 注册（19–48），window.codeshell 是本地 transport 适配器（85–88）。模型实现仅内存固定结果/抛错/等待 signal；recordUsage 是真实本地记账，不是付费模型请求。没有用 fake Engine 代替这四项路径。

第 4 测试最终显示名为 `delivers a delayed real Core target callback`，准确对应 92 行仅将 result 与 `options.shouldActivate()` 推入 created 数组；两快照最终日志也已使用该名。正文继续保留“Sidebar 注册仅静态”，消除了旧 `registers` 显示名被独立引用时的歧义。主体断言未变。

## 生产保护与 double-onClick 排除

[MessageStream.tsx:219](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/MessageStream.tsx:219) 每次 render 更新当前 session ref，222–230 的 session effect 递增世代并关闭/清空旧选择。323–328 在打包开始时捕获 source + operation epoch；346 交付 shouldActivate predicate，348–354 仅对 current operation 关闭/显示错误/恢复 idle。因此旧 operation 正常发布并回调，不表示自动取消；动态仅换 session prop，不是完整 Sidebar 点击或跨 project 生命周期。

真正的 merge 是 Button，690–693 在 selectionStatus 非 idle 时 disabled；没有发现类似 R35 的仍可用 input Enter/替代正式入口。直接在同 tick 人工连调 React props.onClick 两次不会被测试框架的 disabled 语义阻止，但这不足以代表原生 UI 双击，更不能只凭 createContextPackage 没有同步 ref 就列缺陷。

另有后端正常保护：[server.ts:1774](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:1774) 拒绝 busy/queued source，1826 调用真实 runExclusive；[chat-session.ts:231](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session.ts:231) 在首次 await 前同步检查并设置 exclusiveOperation，finally 243–250 释放并启动排队 turn。即便两条 fork 都先通过 server 外层检查，第二个 runExclusive 仍会拒绝已有 exclusive。此为静态反证，本轮未新增双提交实验；不能把“按钮禁用”说成已测试所有原生双事件，也不能说当前无 ref 必然产出两个 summary target。

## App 注册与取消接线

[App.tsx:2453](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2453) 以该 render 的 activeBucket 回调到 handleContextPackageCreated，2018–2031 使用 captured activeProjectId 创建 UI session、先恢复此前 active、绑定 engine target，2045–2056 hydration 失败用空值，2058–2072 更新 index 并最终检查 shouldActivate。ChatView.tsx:1561 原样下传 callback。该静态接线支持报告“原项目注册且最后才决定激活”，没有动态证明当前审查中的 Sidebar 可见、点击可读、hydration 失败恢复、项目切换或全 App 状态正确。

摘要实际服务取消入口为 [server.ts:2433](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2433) → server-run-controls.ts:45 / 108 → chat-session.ts:277 / 284。最终报告已补 2433 cancel 入口、1826 exclusive 入口和 ChatSession 231，并加粗“未验证 Desktop Stop”；不会因服务级正常控制声称 UI 摘要取消已经完成覆盖。第 3 项中的 exclusive 链接目标已为 1826，但其显示文字仍是 `[1804]`，仅为残留行号标签，建议同步改成 1826，不影响证据。

summary 只有成功后发布（server.ts:1808–1821），SessionManager 2144–2184 构造 meta + context_transfer，2304–2325 staging、rename、未发布时清理。fixture 第 1 项在摘要失败后只枚举非隐藏 session 目录，因此动态直接证明没有可见 target；没有单独枚举 `.pending-fork-*`。这次失败发生在 publish 之前，源码也支持没有开始 staging，但不应外推“所有 publish/文件系统失败、断电均无半成品”。现报告的范围限制足够。

## guard、清理和计数

- fixture 7 行先要求 guarded HOME，9–13 行在任何 Core/Host import 前安装 exact `http://127.0.0.1:9` HTTP/fetch guard 与 net/tls deny，再在 19–24 导入 Core。guard 的 redirect=error/custom transport 拒绝来自 scripts/runtime-cost-smoke-isolation.mjs:23–63。没有开监听器或调用该 dummy origin；模型 createMessage 不访问网络。guard 是当前 Bun 进程的测试约束，不能说成 OS sandbox 或穷尽一切网络 API。
- `network` 只计该 fixture 的 net/tls deny 调用，109 行每用例断言累计 0；它不是 HTTP/fetch 全请求审计计数。报告措辞“unexpected direct network=0”准确，不扩成独立抓包证据。
- 102–109 先 unmount、释放 owned wait，然后 await server.close / engine.dispose、移除容器/控制记录/owned temp。server.close 4853 起等待 closeAllAsync（4920–4922），支持实际生命周期清理。provider 注册和 guard monkeypatch 没有显式还原，依赖独立 guarded shard 的进程结束；报告“仅当前 Bun 进程”已限定。没有承诺在同进程任意其它测试之前完全复原全局状态，也未动态验证每种中途 setup 失败的回收。
- 两快照最终日志都明确 **4 pass / 0 fail / 40 expect / 0 skipped / Completed**，四个测试名一致。40 包含 fixture choose/clickMerge 辅助 expect 与 4 次 afterEach network expect，是 Bun 正式计数，不需另外加控制/cleanup 断言。两基线分别执行同一 1 文件 4 测试，不能合成新 8 测试；tmp initial-pass/最终归档也不重复累计。提供的日志没有 test harness 失败；复制命令 FileNotFoundError 不属于产品或测试失败，原报告已区分。

最终证据：[84740 最终日志](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/reproductions/context-recovery-round17/context-recovery.test.tsx.log)、[a66f 最终日志](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/docs/review-2026-10-12/reproductions/context-recovery-round17/context-recovery.test.tsx.log)。审核只读这些既有证据，新增执行 0。四项可计正常控制，不能作为取消 UI / Sidebar native end-to-end 已覆盖的证据；无新缺陷建议。
