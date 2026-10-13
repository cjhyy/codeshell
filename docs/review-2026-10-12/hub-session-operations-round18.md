# 第十八轮 Hub/Web 会话管理与恢复

主审正式收录：**R76 / P3 = HS18-1**。下文保留作者原始候选/执行范围；本轮最终便携双基线收据见末尾。独立质量审计新增执行0。

Completed。建议保留 1 个未编号 **P3 候选 HS18-1**：异步答案引发的 Core 续接任务仍在运行，Hub 历史页却把该会话视为空闲，允许归档并隐藏当前历史行。另有实际标题冲突/重复提交/存储错误/会话暂不可用的正常保稿与恢复控制。

只在冻结 latest `a66f4ef291f304ee4df9da8095a90671d9a8f140` 执行；产品、主报告、goal、构建均未改。没有真实 Engine/模型/CLI/worker/Electron/第三方账号实验。**最终 1 便携文件 / 2 Bun 测试 / 37 expect / 0 fail / 0 skipped，Completed。** 源码相同不等于已跑两基线，后者交主审另行复查。

## HS18-1 / 建议 P3：异步回答触发的续接 run 未登记到 Host，仍在运行也能归档

### 正式操作与生产等待边界

1. Hub 会话的一次普通任务调用 AskUserQuestionAsync，然后完成原 run。用户稍后回答原问题。正式回答入口是 `packages/web/app/HubApprovalCard.tsx:54–59` → `useHubController.tsx:599–625` → agent/approve；本轮直接发实际认证 WS agent/approve，**没有点击回答卡**，该 UI 接线只读核对（实际卡片另在 R73 专项验证，不累计本轮）。
2. 实际 Core `server.ts:2367–2385` 等待 async answer admission 后 ACK；实际 `async-user-answer.ts:38–63` 经 workspace 校验、enqueueTurn 启动后续 run，但不等待这个 run 完成才 ACK。这是正常设计，不能为了修 Host 状态把答案 ACK 拖到模型任务结束。
3. Host 的 `packages/server/src/serve/headless-server.ts:238–239` 只从显式 agent/run 请求的 runningSessions 或 automation owner 判断 running。显式 run 在 `1143–1167` 登记，在其 response `468–479` 清登记。后续 agent/approve 并不登记新 run；它的 ACK 也不代表 Core follow-up 已结束。
4. follow-up 的所有实际 Core stream/status/approvalResolved/ACK 均经内存 bridge 原样交给 Host，没有删除帧。Core `server.ts:4249–4253` 发 follow-up stream；onBoundary 仅转 protocol observer（`1571–1572`），没有为它产生新的外部 agent/run request。Host `356–381` 的 stream 分支只 publishStream，不补 runningSessions。
5. 用户进入正式 Hub“历史对话”页。`session-management.ts:181–200` 将上述 Host isRunning 用作 summary.running。实际 HTTP 列表的该行 running=false，而同一实际 Core ChatSession.isBusy() 为 true。
6. 实际 HubSessions 的“归档”按钮只按 busy/entry.running 禁用（`HubSessions.tsx:433–438`）；因收到 false，可以点击。实际 `PATCH /api/v1/sessions/:id {archived:true}` 在 `session-management.ts:333–336` 也复用同一 false，因此成功写 durable archivedAt。页面消费成功回包、重新读取列表后，该行从“当前对话”消失；Core follow-up 此刻仍 busy。

### 实际影响与严格范围

这是正常任务生命周期的运行状态遗漏，导致历史管理页不显示“正在运行”，并违反已有“请等待当前任务完成后再归档或恢复”的合约：仍在执行的对话可以被用户显式归档并隐藏于当前历史列表。没有存储故障或人工在原本同步的位置添加异步 gate。

范围建议 P3：需要“原 run 已结束、答案通过异步 follow-up 执行”的路径，归档是用户显式操作，记录可恢复。**没有证明跨会话发送、自动删除、丢草稿、停止失效、输出损坏或费用失控；没有把 current history 行消失说成所有页面/侧栏无法访问。** 本轮没有完整 Workbench/controller 导航或实际 worker。

同一 running gate 还用于导出（`session-management.ts:279–281`、`HubSessions.tsx:440–450`）。本轮仅实际验证普通显式 run 时 export 返回 409；没有把 follow-up 时导出允许、或有界追加快照本身另报为缺陷，也未测试/声称完整导出发生损坏或不一致。R73 的 configure gate 问题不作本候选的扩展影响。

### 正常反证与恢复

- 同一真实认证 Host + 实际 Core 链的原始显式 agent/run 仍在运行时，archive 和 export HTTP 均 409，archivedAt 未写入。由此排除所有运行任务都缺保护的说法。
- 原 run 完成后再答题，实际 Core enqueue 的第二次 run 持续 busy；approve ACK 和 Host pendingResponseCount=0 均已实际断言。测试还核对 follow-up session_started/clientMessageId=`ask-user-<requestId>` 真正经 Core 发出，未用任意手工“伪运行”来欺骗 Host。
- 归档后 Core 的 busy 仍为 true，state.sessionId 保留；实际 HTTP `{archived:false}` 返回 200 并清 durable marker，然后释放受控 follow-up，Core 正常完成。**恢复动态为真实 API，不是实际点击历史页恢复按钮。** HubSessions 已归档筛选、恢复按钮及恢复后打开的正式 UI 路径在 `:292–297`、`:253–256`、`:433–438`，本轮只静态核对。
- fakeEngine 不执行真实 Engine transcript append/save/final flush。state.sessionId 保留不等于已证明真实后续生成消息的完整历史，也不能写为所有真实 Engine 运行终态一定保留/清理 archive marker。初始 source 只有自有测试消息；没有使用用户数据。

### 根因、去重与修复建议

主位置是 `headless-server.ts:238–239` 与 `:356–381` / `:1143–1167`：Host 将 run 的活跃事实绑定外部 agent/run RPC 的寿命，遗漏由 Core 自己生产的正式续接 turn。应让所有 run producer 共享带 session/generation 身份的权威运行生命周期投影；保留请求回包相关性和 async answer 只等 admission 的正确 ACK 边界。不能简单放开归档安全门禁、用旧 turn_complete 清新任务，或把串行 snapshot 当作“永远无 active run”。

- R73 是 configure admission 检查晚于 lease.submit，未派发回答被错误标 submitted；本轮回答已正常 admission、原问题 resolved，失败对象是**随后真实活跃任务**的 Host running 投影，修复位置不同。
- R39 是 Web 已实际恢复后因页面 busy 多一次导航确认；本轮无恢复打开操作，发生在归档 admission。
- R72 是 Desktop Settings 漏 durable restore writer；本轮真实 HTTP archive/restore 都更新 durable marker，只是决定能否操作时的 running 事实漏投影。
- R55/R60 的 Desktop 导航或删除墓碑未参与。Hub 此页面和 HTTP handler 没有正式 DELETE 能力（未匹配方法返回405）；不把未提供的删除 UI 或 TODO 算缺陷。

## 第二项测试：标题失败恢复与请求身份的正常保护

使用真实 HubSessions 组件、真实 session-management HTTP 服务、真实 SessionManager 和 title store；该控制的认证是自有 Cookie predicate，**不是 HubAuth**（第一项候选才使用 actual HubAuth setup/session）。没有 worker/模型。

1. 页面保留编辑草稿 C；另一请求将同一 canonical session 的 title 从空 customTitle 改为 B。实际 UI 用旧 expectedTitle 提交，服务返回409；草稿 C、错误与冲突状态保留。实际 form handler 同 tick 调用两次，但同步 write.current 守卫只发出一个 PATCH（`HubSessions.tsx:165–167`）；这是正常去重控制，不据此宣称原生双击缺陷。
2. 点击“读取最新标题”走真实 GET，更新 CAS baseline 并显示已审阅标题 B，草稿 C 不变；确认保存成功。`HubSessions.tsx:219–231` 的显式 read 更新 baseline 没有被后台 list refresh 偷偷替代。engine 自动标题保持不变，custom title 独立存储。
3. 将自有 title registry 的文件临时备份，并在原路径放目录，实际 strict title mutation 返回500。编辑器保留完整 D 与可重试保存按钮。恢复合法 registry 文件后，对同一草稿重试成功。**最终这是非普通文件 registry 的500，不是 EACCES 复现。** 容错 listTitles 可能暂时使用 engine title，未将该有意 fallback 报新问题。
4. 将自有 session 目录临时移到 owned backup，实际 title PATCH 404；草稿 E 保留，保存禁用、提供“读取最新标题”。放回相同 session，显式 GET 后同一草稿成功保存。确认服务成功通知只包含四次真正成功的 mutation，错误和重复提交没有多计。

上述4xx/5xx错误使用实际服务回包，未 mock fetch 成功/失败，也没有虚构人工延迟 stale response 作为缺陷。页面 read 使用 AbortController、卸载 abort；编辑草稿/写操作触发 onDirtyChange 与正式 Workbench navigation guard 的接线仅源码（Workbench.tsx:195–198 / HubSessions.tsx:90–95），没有新跑完整离页/确认 dialog；不推翻或重计 R39/R41。

## 证据、隔离、诊断与计数

目录：`validation/original-hub-session-operations-round18/`。

最终源码 `session-followup.test.tsx`、最终原始日志 `session-followup.test.log`。入口只使用 cwd 解析仓库和现有 dist，不需要 0.9.33 新增 API：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/hub-session-operations-round18/session-followup.test.tsx
```

最终：**2 pass / 0 fail / 37 Bun expect / 1 文件 / 0 skipped，Completed Bun shard: 2 tests, 0 skipped; 0 failures.** 第一候选17 expect，第二正常控制20；不将每个按钮、状态或协议帧另算测试。最终日志有12条 React act harness 警告，来自 owned HTTP/组件状态更新的测试调度边界，原样保留；没有计为产品缺陷或隐藏。`first-candidate-pass.log` 为早先单测试1/17成功，不重复累计。

Guard 在任何 Core/Host import 前安装：maintained exact-origin HTTP/fetch，额外 node net/tls outbound deny 和精确 WS origin 约束。只允许自有 loopback；不是 OS sandbox 或全 socket/network API confinement。第一项 WorkerBridgeCore 仅改为进程内桥，Core 所有通知和回包均转发；实际 Core/ChatManager，fakeEngine 控制等待/输出生命周期，不加载 provider、实际 Engine 或子 worker。第二项只运行真实 HTTP 模块和组件，auth predicate 可控。没有真实账号或外网。

finally 释放 owned 两个 run gate、卸载 React、关闭自有 WS、await Host/Core close，HTTP-only server await close/closeAllConnections，再删除 owned 临时数据；没有操作其它进程或用户目录。JS/fetch/WS patch 依赖独立 guarded shard 进程退出，不建议放到共享长驻测试进程混跑。

诊断原样保留，不计正式发现或通过次数：

- `harness-syntax-failed.log`：初稿 object 缺大括号，解析失败。
- `harness-run-model-missing.log` / `harness-run-dispatch-failed.log` / `harness-private-flush-corruption.log`：初稿误调用 Transcript 私有 flush() 而传入 undefined，污染 owned transcript 后被正式 Host 正确拒绝；最终删去该调用，append 本来已同步持久。最早日志名按当时排查猜测保留，不据文件名认定模型配置缺陷。
- `harness-archive-response-not-yet-read.log`：读取 durable marker 后、HTTP成功尚未被组件消费时就断言 onChanged；最终等待成功 callback receipt。
- `harness-editor-act-not-committed.log` / `harness-minidom-text-not-aggregated.log`：MiniDOM commit/textContent 读取方式错误，已分 act/递归读取真实渲染文本修正。
- **`diagnostic-parent-EACCES-lock-timeout.log` 是不同性质的真实服务/Bun观察：** chmod title registry 父目录为0500，实际 lock 创建碰到 EACCES；`file-mutex.ts:50,95–112` 对所有 lockSync 错误同步重试30秒，阻塞本 fixture 同进程，导致15秒用例最终在约30秒超时。它不是普通 act race，未抹掉；但本轮没有 maintained native Node Host 实证、事件循环/完整生产调用专项反证，所以**不列新发现、不声明 Node Hub 已实测阻塞**。最终正常500控制改用实际非文件 registry 错误，有界完成；该诊断不加入最终通过metadata。

只读 `84740d56..a66f4ef2` 核对：HubSessions、session-management、Core server/async-user-answer 根因路径无差异；Headless 的差异仅 Panel projectScope 增补，与候选分支无关。旧行号可能因该增补偏移，本报告全部源码行号为 a66f。**本代理仅 latest 执行，双基线需主审最终 receipts。**

## 主审便携复核与正式收录

正式 **R76 / P3 = HS18-1**。最终同一便携脚本在84740与a66f两个冻结产品快照分别guarded通过，每基线 **1文件2测试37个Bun expect、0fail/skip、Completed**；归档作者/开发/重复运行不累加测试数。产品无改动，独立质量核对新增执行0。

[便携脚本](reproductions/hub-session-operations-round18/session-followup.test.tsx)、[初始基线最终日志](reproductions/hub-session-operations-round18/session-followup.test.tsx.log)、[最新基线最终日志](validation/latest-a66f4ef2/repro__hub-session-operations-round18__session-followup.test.tsx.log)、[独立质量核对](hub-session-operations-quality-round18.md)。原始作者材料在validation/original-hub-session-operations-round18/，保留早期失败诊断。

主审两基线最终日志分别保留12/12条act警告，没有隐藏或计为产品失败。候选实际HubAuth/HTTP/WS+Core ChatManager，Engine/worker为受控替身，所有真实Core帧转发；标题正常控制认证是owned Cookie predicate。实际API恢复清marker正常，未执行恢复按钮或真实Engine完整历史。EACCES/30秒锁等待仅原始Bun诊断，本轮不计新发现；native反证另行审查。

### 真实Engine持久化的只读反证

独立整合审计核对正常final flush不会由该运行partial自动删除archive marker：run-finalize的finalState写入经Engine.persistFinalRunState，finalRunStateFields不含archivedAt；active/detached持久路径都以最新disk state为基底，只合并本轮owned字段并检查runId/CAS；Transcript.flush只追加JSONL。这是源码控制，新增执行0，不能冒充本轮实际Engine已动态保留历史。归档admission在Core仍忙时被误放行已经有实际证据，结论仍仅P3历史管理流程。

[finalize](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/run-finalize.ts:284)、[Engine字段](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/engine.ts:3866)、[run状态持久](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/run-state-persistence.ts:50)、[读最新状态合并](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:1583)、[transcript仅追加](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/transcript.ts:985)。
