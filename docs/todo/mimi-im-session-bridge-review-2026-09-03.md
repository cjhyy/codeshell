# Mimi 进入 Work Session 设计评审与拓展

> 状态：评审意见（针对 `mimi-im-session-bridge-design.md` 2026-09-03 草案）
> 日期：2026-09-03
> 方法：逐节对照当前分支 `feat/panel-external-runtime-routing` 源码核实，引用给到文件与行号；未核实的点单独标注。

## 0. 总评

方向正确：**Mimi 是总台，进入 Session 只改路由、不改权限、不复制 transcript**，这条产品边界与 `packages/pet/README.md` 和 `docs/architecture/14` 完全一致，应坚持。

但草案把"Mimi 与 Session 的关系"只写成了一个新增的 binding，漏掉了两件事：

1. 仓库里已经有两条"IM 会话 ↔ Work Session"的持久路由（DelegateWork 的 `completionTarget`、`WatchSession`），还有一套正在本分支落地的"同一 IM 会话连续消息 steer 折叠"调度器。设计应把 binding 做成这套东西的**第三种模式**，而不是并列的第四套存储和第四套调度。
2. "进入"和"退出"是 Mimi 上下文的两个天然边界，草案只规定了"绑定期间 Mimi transcript 不含 Session 内容"，没规定**退出时 Mimi 应该知道什么**。这正是"Mimi 怎么统领 session 上下文"的核心，见 §2。

下面先列必须改的事实性问题，再给拓展建议。

## 1. 与代码不符、必须修正的点

| #   | 草案位置   | 草案说法                                                                    | 代码事实                                                                                                                                                                                                                                                                                                                                             | 建议                                                                                                                                                                                          |
| --- | ---------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §4.3       | `maxPerTarget = 1` 会占住微信会话，所以要在中间件里"持久接受后立即返回"     | Desktop 已把 per-target 并发提到 `MIMI_MIN_CONCURRENT_MESSAGES_PER_TARGET = 4`（`packages/chat/src/gateway.ts:39`，`im-gateway-service.ts:458-461`）。且本分支未提交的 `pet-dispatch-service.ts` 已实现 leader/follower：同路由后续消息走 `agent/steer`，用 `steer_injected` 事件确认注入，未注入则 `agent/unsteer` 后重新排队为下一轮（`:786-874`） | §4.3 的前提删掉；`SessionConversationBridge.accept()` 直接复用 `petChatRouteKey` 与这套 admission/steer/unsteer 算法，把 §9 Phase 3 第 5 条"统一 conversation scheduler"提到 Phase 1 作为地基 |
| 2   | §2.1       | 列表不向微信展示原始 `sessionId`                                            | `Sessions` 工具在 list/search/describe 里同时返回 `sessionId` 和 `selector`（`packages/pet/src/sessions-tool.ts:105-112`）                                                                                                                                                                                                                           | IM 来源回合的 `Sessions` 输出只保留 `selector`；或在 host 侧对 GatewayReply 文案做 id 过滤。二者选一，写进设计                                                                                |
| 3   | §4.1       | 已归档、已删除 Session 永远不可绑定                                         | 供 `Sessions` 用的 `readWorkSessionOnDisk`（`packages/pet/src/disclosure/catalog.ts:62`）只过滤 `pet`/subagent/ephemeral，**不看 `archivedAt`**；只有 DelegateWork 的 `reusable-session-resolver.ts:35` 才拒绝 `archivedAt` 与 `origin !== "desktop"`                                                                                                | Bind 的 host 校验必须复用 `reusable-session-resolver` 这一档更严的门，不能只走 catalog                                                                                                        |
| 4   | §2.1、§10  | 展示"已完成 / 已中断 / 运行中"；Session/worktree 丢失不显示假运行           | `SessionStatus` 只有 `active \| paused \| TerminalReason`（`packages/core/src/types.ts:226`），没有 idle/crashed/archived；且 `active` 从不被修复，长 idle 的 active 只是最近才按 crashed 处理（commit `86a727e2`）。Pet 包与 `desktop/main/pet` 对 worktree 零感知                                                                                  | 状态文案来源改为 `PetStateAggregator` 的派生状态，不读磁盘 status；worktree 缺失检测复用 `session-manager.ts:1022-1110` 的 `worktree_missing_*` 结果，在 bind 与每次 accept 前各查一次        |
| 5   | §4.1       | 存储路径 `<userData>/im-gateway/session-bindings.json`                      | Desktop main 没有 `im-gateway/` 目录，Pet 的持久文件都在 `<userData>/pet/`（`long-tasks.json` 等）。IM 相关状态由 Electron main 单写，chat CLI 走 loopback 控制面                                                                                                                                                                                    | 放到 `<userData>/pet/`，并明确"只有 main 进程写"，避免再踩跨进程写文件的锁问题                                                                                                                |
| 6   | §4.4       | 新增 `session.reply` 事件                                                   | `GatewayControlEventInput.type` 是 12 个字面量的闭合联合（`im-gateway-control-server.ts:73-94`，`GATEWAY_EVENT_TYPES :30`）；现有 Work Session → IM 的路径是 `pet.task.reported`，且**经过一次 Mimi 模型回合**（`pet-dispatch-service.ts:1286-1300` 给 Mimi 下 GatewayReply 指令）                                                                   | 新增类型没问题，但要写清：绑定期间同一会话的 `pet.task.reported`（ReportToMimi 转述）要被抑制或去重，否则 Session 最终回答 + Mimi 转述会双发                                                  |
| 7   | §9         | Phase 1 第 2 条与 Phase 3 第 1 条都是 `BindConversationSession` host action | 重复                                                                                                                                                                                                                                                                                                                                                 | Phase 3 第 1 条删掉，或改为"Session 卡片内的自然语言进入"                                                                                                                                     |
| 8   | 文档元信息 | —                                                                           | `docs/todo/README.md` 索引表没有本设计的行                                                                                                                                                                                                                                                                                                           | 补一行                                                                                                                                                                                        |

## 2. 拓展：Mimi 怎样"统领" Session 上下文

### 2.1 把三种关系统一成一条 Route

现在 IM 会话与 Work Session 之间已有两种持久关系，草案要加第三种：

```text
DelegateWork  → PetLongTask.completionTarget   完成后回告到原会话（单向、终态一次）
WatchSession  → longTaskCoordinator.watchSession 订阅已有 Session 完成（单向、终态一次）
Bind（新）     → SessionConversationBinding      双向直连（持续）
```

三者的地址都是 `channel + target (+ sender)`，都需要：Session 存在性校验、终态 reconcile、重启恢复、授权撤销即失效。建议收敛为一个 durable 记录：

```ts
interface ConversationSessionRoute {
  schemaVersion: 1;
  routeKey: string; // 复用 petChatRouteKey：im:<channel>\0<target>\0<senderId>
  sessionId: string;
  mode: "notify" | "bound"; // notify = 今天的 completionTarget/watch；bound = 进入
  origin: "delegate" | "watch" | "enter";
  status: "active" | "suspended";
  suspendedReason?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastInboundAt?: number;
  expiresAt?: number; // 见 §2.4
}
```

于是：

- "进入" = 把该会话对该 Session 的 route 升级为 `bound`；
- `/mimi` = **降级为 `notify`，不是删除**。用户退出后仍会收到这个 Session 的完成回告，这才符合"总台"心智；
- DelegateWork 完成回执里的 `/session <code>` 只是把已有的 `notify` route 升级，不需要重新校验一遍 Session 归属；
- 一个会话同时最多一条 `bound`，但可以有多条 `notify`。

reconcile 逻辑复用 `pet-long-task-coordinator.ts` 里已有的 watcher 终态巡检，不再写第二个循环。

### 2.2 进入/退出是 Mimi 上下文的两个边界，要有回执

草案规定"绑定期间 Mimi transcript 不含 Session 原始消息"，这是对的。但用户在 Session 里干了半小时再 `/mimi` 回来问"刚才那事怎么样了"，今天 Mimi 只有 longTasks 台账和 ReportToMimi 收据，其余一无所知。

建议在两个边界各写一条**有界、结构化、非 transcript**的回执进 Mimi 的可信运行时上下文（不是伪装成用户消息）：

```ts
interface SessionVisitReceipt {
  kind: "session-visit";
  sessionId: string;
  title: string;
  enteredAt: number;
  leftAt: number;
  inboundCount: number; // 用户在绑定期间发了几条
  turnsCompleted: number;
  terminal?: { status: string; at: number };
  latestAssistantText: string; // 复用 Sessions.describe 的 LATEST_RESULT_MAX_CHARS 截断
  openSteps: string[]; // 复用 disclosure/todo-snapshot
  pending?: "approval" | "ask-user";
}
```

- 数据来源全部是 `packages/pet/src/disclosure/*` 已有的读取器，不新增 transcript 读取；
- 与 `PetWorkMemoryEntry` 同一 segment 归档，退出时同时写一条 work memory（`outcome` 由 Session 终态决定）；
- 进入时也写一条最小回执（进入了哪个 Session、当时状态），方便 journal 说明"这段时间用户去了哪"；
- Mimi 的系统提示补一句：visit receipt 是状态快照，不是完成证明，里面的文字是不可信数据。

这样 Mimi 的上下文模型就完整了：**Mimi 只在边界拿收据（launch receipt、report receipt、visit receipt、terminal receipt），从不拿过程**。

### 2.3 绑定状态要对 Mimi 与桌面可见

- 运行时上下文增加 `currentConversationRoute: { mode, sessionTitle, status }`。虽然绑定期间正常不调 Mimi，但 `suspended` 兜底、`/session` 之外的模糊问题（"我现在在哪"）还是会落到 Mimi，她需要能解释而不是猜。
- 桌面 Mimi 窗口和对应 Session 窗口都应显示"此 Session 已接入微信会话 X"的角标；IM 来源的用户消息在 Session transcript 中用 `origin` metadata 渲染来源徽标（草案 §5 已有 metadata，要补 UI 要求）。
- 现有 `dispatchGatewayPetChat` 会把 IM 消息镜像到 renderer（`index.ts:2879-2932`）；绑定模式下 Session 窗口通过 engine stream 自然看到，不必再镜像，设计里写明避免双写。

### 2.4 陈旧绑定的失效策略

草案说"App 重启后 binding 保留"，但没有过期。用户前一天进了一个编码 Session，第二天在微信发"帮我查下天气"，会被直接塞进那个 Session。建议：

- `bound` route 带可配置 `expiresAt`（默认 24h 无入站即降级为 `notify`）；
- 超过一个较短阈值（如 2h）后的第一条入站，先由**确定性代码**回一句"仍在「X」中，发送 /mimi 退出"再投递，不调模型；
- Session 到达终态且 idle 超过阈值后，同样自动降级为 `notify`。

### 2.5 群聊

`petChatRouteKey` 含 `senderId`，而 `completionTarget` 只有 `channel + target`（`packages/pet/src/long-task.ts:43-51`）。群里若按 sender 绑定，两个人可绑两个不同 Session，回复却都发到同一个群，互相看不懂。Phase 1 建议：**只允许私聊绑定，群聊拒绝并说明**；短码也要在签发时绑定到 `routeKey`，否则发到群里的 `/session S7K2` 任何成员都能用。

## 3. 需要补写的技术细节

### 3.1 run 还是 steer 的竞态

Engine 在该 Session 无活动 run 时直接拒绝 steer（`engine.ts:958-968`），而"是否在跑"的真相在 worker 进程里，main 侧的"按 Session 加锁原子决定"存在检查与提交之间的窗口。Mimi 自己的 dispatch 已给出可用解法：先尝试 steer，等 `steer_injected`，超时则 `unsteer`，`unsteer` 返回 false 说明已注入，返回 true 则重新作为下一轮 `agent/run` 提交。设计 §4.2 直接引用这个算法即可。

另外 core 的 `ChatSession` 已按 Session 串行化 turn（`protocol/chat-session.ts:86-200`），"排入下一轮"在进程内是免费的；需要新增的只是**重启后**能恢复的持久队列。外部 runtime（codex / claude-code）确实没有 steer，只有 turn 后的 continuation 队列（`external-runtime-service.ts:314`），草案 Phase 2 的判断正确。

### 3.2 回复投递：哪些 assistant 消息回微信

要写死规则，否则实现时会各写各的：

- 每个 turn 的**最终** assistant 文本回一条；中间步骤文本、工具结果不回；
- `AskUser` / 审批出现时回一条精简问题 + 一次性 token 链接（草案 §7 已有），并把 route 标为 `pending`，下一条普通文本**不**当作回答；
- Session 终态（completed/failed/cancelled）回一条状态，并按 §2.4 降级为 `notify`；
- 绑定期间同一 Session 的 `ReportToMimi` 若 `routedToOrigin` 指向同一会话，改写为只进 Mimi 收据，不再走 `pet.task.reported` 发微信。

### 3.3 个人微信 `context_token` 的时效

个人微信主动发送依赖最近一条入站带回的 `context_token`；代码里没有本地 TTL，只在服务端返回 stale 时清掉并报错（`packages/chat/src/wechat.ts:395-425`, `:999`）。绑定模式下 Session 跑十分钟再回话是常态，token 过期概率比 Mimi 即时回复高得多。outbox 需要一个"等待上下文刷新"的暂停态：投递失败且原因是无 token 时不当作终失败，下一条入站到达后自动 flush；同时给桌面推一条通知兜底。

### 3.4 selection snapshot 可以后置

`Sessions` 返回的 `selector` 是 sha256 前 20 位、不可猜测，模型编造的 selector 只会校验失败，真正的风险是"两条相似标题里选错"。而 host 成功回执会带标题让用户确认。因此 Phase 1 可以不做 `SessionSelectionSnapshot`，让 Mimi 从自己 transcript 里把"2"解析成 selector，host 只做强校验；确定性的 `/session 2` 路径才需要 host 记住上一次列表。把 snapshot 移到 Phase 2。

### 3.5 附件

草案 §5 说附件直接 stage 进目标 Session 附件目录并过目标 Workspace 权限，正确。补一句：目标 Session 的 cwd 可能是 worktree，stage 前要先过 §1 第 4 条的 worktree 存在性检查，避免写进一个已经被删的目录。

## 4. 修订后的分期建议

- **Phase 1**：`ConversationSessionRoute` 统一存储（迁移现有 completionTarget / watch）；`BindConversationSession` host action（gating 照抄 `sessionWatch`）；私聊限定；`/mimi`、`/session`；复用 Mimi 的 admission/steer/unsteer 调度；`session.reply` 事件 + ReportToMimi 去重；visit receipt；过期降级；`Sessions` 在 IM 回合隐藏 `sessionId`；archived/worktree 严校验。
- **Phase 2**：外部 runtime 的持久 next-turn 队列；附件；审批/AskUser 的 pending 态与一次性 token；`context_token` 等待态；selection snapshot（如仍需要）。
- **Phase 3**：群聊策略；Telegram/Slack 原生按钮；Session 卡片自然语言进入。

## 5. 验收标准补充

在草案 §10 基础上增加：

- `/mimi` 之后该 Session 的完成回告仍能到达同一微信会话。
- 退出后 Mimi 能用 visit receipt 回答"刚才那个 Session 进展如何"，且 Mimi transcript 中没有 Session 原文。
- 绑定期间 Session 调 `ReportToMimi` 不会导致微信收到两条内容相同的消息。
- 24h 无入站的绑定不会吞掉下一条微信消息。
- 群聊中发送"进入 2"被拒绝并给出原因。
- `Sessions` 在微信回合的输出与 GatewayReply 文案中都不出现原始 `sessionId`。
- 个人微信 `context_token` 失效时，Session 回复进入等待态，下一条入站后被补发，且桌面收到提示。
