# Pet 顶层 Agent 设计：用户的私人总管与编排大脑

> 状态：**方向锚点 / 设计稿，非实现承诺**  
> 日期：**2026-07-12**  
> 主题：**Pet = 仓库既已预留的 assistant 主体 = 用户级顶层 agent**  
> 证据规则：本文把仓库可证明的事实标为“现状”，并附 `file_path:line` 或既有文档锚点；无法由当前仓库证明的判断显式标为“推测”；“设计 / 建议”均描述目标态。  
> 分期红线：本期只设计 **tree 内「pet 大脑 ↔ 运行中直属子 session」双向控制面**；不做 sibling mesh，不做显式 Team / 多数字人协作。
> Phase 1 目标形态：**当前单用户本地 / Desktop 即可落地；账号、多用户、per-user worker 与 ownership 是后续 user 改造的演进位，不是 Phase 1 前置。**

## 0. 结论先行

**一句话定位：Pet 是每个 CodeShell 用户唯一拥有的、人格化且可持续对话的顶层 agent；它聚合该用户全部 session 的“正在做什么 / 正在等你什么”，并通过受控路由帮助用户查看、定位和指挥直属运行中 session。**

Pet 不是新造一套 agent runtime。既有 IM gateway 设计已经明确：gateway 只是通道，真正能跨 session 对话和指挥的中枢是未来的 `assistant 主体`，并预留了 `dispatchToAssistant(command, context) → stream/result`（`docs/todo/im-gateway-remote-orchestration.md:86`）。**本文把这个留白正式命名为 Pet，并定义其产品与架构形态。**

推荐采用 **方案 A：host-side `PetStateAggregator` + 一个持久 `pet orchestrator session` + 多端共用的 pet chat contract**。Phase 1 由当前 Desktop/local host 和现有 core worker 承载；后续 user/server 改造时，再把同一聚合器边界放入 `packages/server`，按 `userId` 连接 per-user worker。理由是：

1. Phase 1 不需要 account/login/multi-tenant：默认“当前这台机器的这一个用户”，直接聚合现有 `~/.code-shell` session catalog 与 live worker 状态；当前 canonical session root 是 `${CODE_SHELL_HOME:-~/.code-shell}/sessions`（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:144`）。
2. `core` 已有 multi-session live map、session-tagged `StreamEvent`、pending approval route、agent progress/result/direction envelope 和 idle wake（`packages/core/src/protocol/chat-session-manager.ts:45`、`packages/core/src/protocol/types.ts:411`、`packages/core/src/tool-system/permission.ts:22`、`packages/core/src/tool-system/builtin/agent-notifications.ts:68`、`packages/core/src/protocol/server.ts:295`）；Pet 的主要新增量是**聚合、建立可重建索引和提供受控 assistant command port**，不是重写 run loop。
3. Pet 的对话 transcript 与人格可落在一个正常的 durable session 中；Pet 的“世界状态”则来自 host 投影（Phase 1 local、后续 server），不复制所有 work session transcript，避免双重真相与上下文爆炸。

最小可用 Pet Phase 1 是：

- 列出“我的全部 session”，清楚展示哪些在运行、在跑什么、哪些在等我决定；
- 在 pet chat 中询问全局，例如“现在都有什么在跑？”“哪里卡住了？”；
- 让 Pet 帮我打开某个等待决策的 session；
- 对非当前 session 的新 pending decision 做克制的 badge / peek 提醒；
- **不在 Phase 1 向任意 session 发送模型指令，不替用户审批，不自动打开完整面板。**

上述最小可用 Pet **就在单用户本地形态交付**，无需等待 server roadmap 或账号体系。Phase 1 的“属于我”解释为“属于当前机器上的当前 CodeShell 用户”；未来引入多个产品 `User` 时，再把隐式本地归属升级为显式 `userId + session ownership + per-user worker`，不改变 Pet 的 session/pending projection、chat contract 或 tree 控制边界（详见 §8）。

---

## 1. 一句话定位与边界

### 1.1 Pet 是什么

Pet 同时是三个东西，但只有一个用户心智：

1. **人格化入口**：用户随时打开 `pet chat`，像和一个私人总管对话。
2. **用户级世界状态投影**：知道该用户拥有哪些 session、哪些 live、各自当前阶段、哪些需要人决策。
3. **受控编排主体**：把用户自然语言转换为“查询全局、打开 session、向直属运行中 child 发 direction”等显式命令。

Phase 1 单用户本地默认只有一个 Pet，归属于当前机器上的当前 CodeShell 用户，不需要 authenticated `Principal`、login 或 tenant ownership。`userId`、`Principal.userId`、public `AgentSession.id → owner` 映射仍保留为数据与接口扩展位；等 user/server 改造进入多用户后，再按 server roadmap 的规则启用——browser 不能自报 `userId/ownerId/coreSessionId`，每次操作先解析 ownership（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:332`）。

### 1.2 明确不做什么

本设计坚持 YAGNI：

- **不做 sibling session ↔ sibling session 直接通信**；Pet 可分别观察或指挥直属 child，child 之间没有寻址能力。
- **不做显式 Team / 多数字人 / 成员管理 / lead 选举 / TaskBoard / 共享 todo / Budget 分配。** Phase 0 设计已把这些列为红线（`docs/todo/parent-child-bidirectional-notification-phase0-design.md:558`）。
- 不做跨用户 pet、管理员窥视成员 pet、组织级“超级 pet”。
- 不做第二套 `Engine`、第二套 permission controller、第二套 approval UI 或平行 message bus。
- 不把 Pet 变成所有 session transcript 的镜像库；完整 transcript 仍属于原 session。
- 不让 Pet 因为是“大脑”就获得 `bypassPermissions`、替用户点批准或修改 child 的 permission/sandbox/tool scope。
- Pet Phase 1 不承诺无人值守自主执行、不做长期里程碑推理、不做 IM 主动推送；这些必须在基础观测闭环稳定后再拍板。

### 1.3 “顶层”不等于 mesh

目标树形关系是：

```text
User
└── Pet（唯一顶层 assistant 主体）
    ├── Work Session A（直属 child）
    │   └── A 自己 spawn 的 sub-agent（A 的 child，不是 Pet 的 sibling API）
    ├── Work Session B（直属 child）
    └── Work Session C（直属 child）
```

Pet → A 与 Pet → B 是两条独立的 direct edge；**A 不能发给 B，A 的 sub-agent 也不能发给 Pet 或 B。** 这符合当前 Phase 0 只允许直属父向运行中 child 单播、child 自动上报 progress/result 的方向；当前 router 对非直属父和 sub-agent caller 会返回 `not-direct-parent`（`packages/core/src/tool-system/builtin/agent-registry.ts:257`）。

---

## 2. 概念模型

### 2.1 User / Pet / Session / Worker 关系

Phase 1 单用户本地形态：

```text
Desktop（当前机器的隐式 local-user）
        │
        ▼
Local Pet Host
  ├─ PetStateAggregator ── SessionIndex / PendingDecisionIndex
  ├─ dispatchToAssistant(command, local context)
  └─ Pet orchestrator session（durable chat/personality transcript）
        │
        ▼
current core worker / ChatSessionManager
  ├─ work session A（live Engine 或 disk-only）
  ├─ work session B（live Engine 或 disk-only）
  └─ NotificationQueue / agentNotificationBus / ApprovalRouter
        │
        ▼
existing ~/.code-shell session catalog + current workspaces
```

后续 user/server 演进形态：

```text
Web / Desktop / Mobile / future IM
        │ authenticated Principal + channel context
        ▼
packages/server
  ├─ User 1 ──1 UserPet
  ├─ per-user PetStateAggregator / SessionOwnership / EventHub
  └─ dispatchToAssistant(command, context)
        │ controlled stdio / internal protocol
        ▼
per-user core worker + private data root + authorized workspaces
```

server roadmap 推荐 `packages/server → controlled stdio → per-user core worker`，并把 AuthN/AuthZ、SessionOwnership、EventHub 和 worker supervision 放在 gateway（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:233`）。这是 Pet 的**后续多用户承载方式**，不是本地 Phase 1 前置。两种形态保持同一职责分层：host 聚合状态和通知，core worker 负责 Engine/session/permission；进入多用户后，再由 server 增加 Principal、ownership 和 authorized fan-out。

### 2.2 Pet 的心智模型

Pet 维护的不是“所有聊天全文”，而是四个有界问题：

```text
我是谁？          → Phase 1 隐式 local-user；后续 userId + pet profile
我有哪些工作？    → Phase 1 本地 SessionIndex；后续 owner-scoped projection
它们现在怎样？    → run phase / progress summary / freshness / terminal outcome
什么需要主人？    → PendingDecisionIndex + surfaced/seen/dismissed 状态
```

对每个 work session，Pet 至少能回答：

- `identity`：Phase 1 本地 `sessionId`（投影中兼容记为 `agentSessionId`）、title、workspace display name；多用户后切换为 public `agentSessionId`；
- `runtime`：`dormant | idle | queued | running | terminal | unknown`；
- `phase`：`model | tool | waiting-decision | compacting | finalizing` 等可观测阶段；
- `summary`：一行安全摘要，例如“正在运行 Bash”“等待批准 Write”；
- `attention`：是否有 pending decision、数量、最老等待时长；
- `freshness`：投影来自 live event、snapshot 还是 disk metadata，何时更新；
- `actions`：可打开、可停止、可向 running direct child 发 direction，或因不满足条件而不可用。

**设计约束：Pet 回答全局问题时默认使用上述结构化投影；只有用户明确选择某个 session 且通过 AuthZ 后，才按需读取该 session 的有限历史摘要。** 这与 Phase 0 “progress 只保留一行摘要，完整 transcript 留在 child session/UI”的原则一致（`docs/todo/parent-child-bidirectional-notification-phase0-design.md:501`）。

---

## 3. 能力拆解：逐条对应六个用户诉求

| 用户诉求 | Pet 能力 | 最小交付 |
|---|---|---|
| “我可以有自己的 pet” | Phase 1 隐式 local-user 唯一 Pet；预留 `userId` | Desktop 打开即是自己的 Pet；多用户时再绑定账号 |
| “pet chat” | durable pet orchestrator session + 统一 UI 壳 | 随时问全局、获得带 session 指向的回答 |
| 知道不同 session 有什么在 work | owner-scoped `SessionIndex` + live projection | 列出 running/queued/idle 与一行摘要 |
| 知道什么等我决定 | `PendingDecisionIndex` | 聚合 tool approval / `AskUserQuestion` |
| “什么时候打开” | attention policy + dedupe/throttle | pending 超时后 peek；多 pending 聚合；失败提醒 |
| 统一了解并下达跨 session 指令 | `dispatchToAssistant` + direct-child router | Phase 1 打开目标；后续向 running child 发 direction |

### 3.1 跨 session 状态感知：Pet 如何知道“什么在 work”

#### 3.1.1 现状可复用的数据源

1. **Live session map。** `ChatSessionManager` 以 `Map<string, ChatSession>` 保存 live session，每个 session 一台 Engine；默认上限 16、idle TTL 30 分钟（`packages/core/src/protocol/chat-session-manager.ts:45`、`packages/core/src/protocol/chat-session-manager.ts:56`）。它提供 snapshot-safe `forEachSession()`，idle sweep 不回收 busy 或有 background job 的 session（`packages/core/src/protocol/chat-session-manager.ts:147`、`packages/core/src/protocol/chat-session-manager.ts:244`）。
2. **Session runtime 原语。** `ChatSession` 已有 FIFO turn queue、active `AbortController`、`isBusy()`、`queueDepth()` 和 per-session `pendingApprovals`（`packages/core/src/protocol/chat-session.ts:49`、`packages/core/src/protocol/chat-session.ts:164`、`packages/core/src/protocol/chat-session.ts:178`、`packages/core/src/protocol/chat-session.ts:269`）。
3. **Live sessions query。** manager path 的 `query("sessions")` 当前返回 `sessionId/busy/queueDepth/lastActivityAt`，但只列 live session，不足以表达“正在跑哪个工具/等什么”（`packages/core/src/protocol/server.ts:1751`）。
4. **Session-tagged stream。** 每个事件由协议包装为 `{ sessionId, event }`（`packages/core/src/protocol/types.ts:411`）；`StreamEvent` 已含 `session_started`、model request、tool start/result、turn complete、goal progress、error、usage 等事件，可确定性归约 run phase（`packages/core/src/types.ts:497`）。
5. **运行中 sub-agent 进度。** `asyncAgentRegistry` 保存 parent `sessionId`、child `childSessionId`、status、progress、live control 与 writer lease（`packages/core/src/tool-system/builtin/agent-registry.ts:74`）；heartbeat 每 30 秒把 running agent 的 latest structured progress 写入统一 `NotificationQueue`（`packages/core/src/tool-system/builtin/agent-heartbeat.ts:24`、`packages/core/src/tool-system/builtin/agent-heartbeat.ts:64`）。
6. **Durable catalog。** disk session 才是恢复依据，而 live map 只是进程内 overlay。Phase 1 直接使用现有 `~/.code-shell` session catalog；后续多用户改造时，再按 server roadmap 增加 `AgentSession(ownerUserId, workspaceId, coreSessionId)` ownership/index，transcript 继续 disk-authoritative（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:142`、`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:310`）。

#### 3.1.2 新建 `SessionIndex` 投影

**设计：** Phase 1 的 `PetStateAggregator` 从本地 durable session catalog 得到“全部 session”，再叠加 worker live snapshot 和后续事件；后续 user 改造时，catalog source 替换为 server `AgentSession` ownership view：

```ts
interface PetSessionProjection {
  userId: string;               // Phase 1 固定/隐式 "local-user"；user 改造时才多值
  agentSessionId: string;       // Phase 1 等于本地 sessionId；后续为 public server id
  coreSessionId: string;        // Phase 1 可同 sessionId；后续只在 server/worker 内部
  workerId: string;             // Phase 1 固定当前 worker；后续按绑定解析
  parentPetId: string;          // establishes pet -> direct child edge
  workspaceId?: string;
  title?: string;
  runState: "dormant" | "idle" | "queued" | "running" | "terminal" | "unknown";
  phase?: "model" | "tool" | "waiting-decision" | "compacting" | "finalizing";
  summary?: string;
  queueDepth: number;
  lastActivityAt: number;
  observedAt: number;
  workerGeneration: number;
  terminal?: { status: "completed" | "failed" | "cancelled"; at: number };
  pendingDecisionCount: number;
  teamId?: string;              // reserved only; must be undefined this phase
  correlationId?: string;       // last related command/result chain
}
```

归约规则建议：

- `AgentSession` 有记录、worker 无 live session → `dormant`，不因此 cold-resume Engine；
- live `busy=false` → `idle`；queueDepth > 0 但当前 run 尚未接管 → `queued`；
- `stream_request_start` → `running/model`；`tool_use_start` → `running/tool`；pending created → `running/waiting-decision`；
- `context_compact` → `running/compacting`；`turn_complete` → 根据 queue/pending 归约为 idle/queued/waiting；
- worker crash、generation 变化或 heartbeat 超过 freshness 阈值 → `unknown`，不能伪报“仍在运行”。

Pet 的一行 `summary` 只来自模板化事件，例如“模型处理中”“正在运行 Bash”“等待用户批准 Write”。不复制 tool output、reasoning、secret 或完整命令；Phase 0 progress 设计也明确要求 summary 去换行、限长且不复制 tool result/secret（`docs/todo/parent-child-bidirectional-notification-phase0-design.md:501`）。

#### 3.1.3 缺口判断

**现状结论：** live map 和 `query("sessions")` 足够回答“哪些 live、busy 否”，`StreamEvent` 与 heartbeat 足够增量归约阶段；但 manager query 只列 live session，当前没有一个可断线重建、同时覆盖 disk-only + live session 的全局 projection（`packages/core/src/protocol/server.ts:1751`、`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:147`）。这个本地 `SessionIndex` 是 Pet Phase 1 的主要新建项，不应让 Pet LLM 自己扫磁盘或订阅原始全量 stream；owner scope 是后续 user 改造叠加项（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:149`）。

### 3.2 Pending 决策感知：Pet 如何知道“什么等我决定”

#### 3.2.1 现状与缺口

- 每个 `ChatSession` 已有 `pendingApprovals: Map<requestId, resolver>`（`packages/core/src/protocol/chat-session.ts:64`）。它证明 pending 已按 session 隔离，但 Map value 只有 resolver，不含可供全局查询的 `kind/description/risk/createdAt`。
- tool approval 路由已有 `(connectionId, sessionId, generation)` owner；register 冲突、connection 失联与 generation mismatch 均 fail closed（`packages/core/src/tool-system/permission.ts:22`、`packages/core/src/tool-system/permission.ts:61`、`packages/core/src/tool-system/permission.ts:112`）。
- 协议向 UI 发 `ApprovalRequestNotification`，其中已有 `sessionId/requestId/request`；另有 `ApprovalResolvedNotification`（`packages/core/src/protocol/types.ts:417`、`packages/core/src/protocol/types.ts:429`）。
- `AskUserQuestion` 在 manager path 中也写入该 session 的 `pendingApprovals`，并用 `toolName: "__ask_user__"` 发送同一 approval envelope（`packages/core/src/protocol/server.ts:2505`）。普通 AskUser 不设 wall-clock timeout，Stop/cancel 才会 drain；goal mode 另有 10 分钟 timeout（`packages/core/src/protocol/server.ts:2510`、`packages/core/src/protocol/server.ts:2551`）。
- session cancel 会显式清理 AskUser、browser action 和 tool approvals，避免等待悬挂（`packages/core/src/protocol/server.ts:1210`）。

**现状结论：** 当前具备正确的 per-session 等待与响应路由，但 pending 存储只有 resolver，协议只提供逐事件 request/resolved envelope，没有跨 session pending read model（`packages/core/src/protocol/chat-session.ts:64`、`packages/core/src/protocol/types.ts:417`）。仅遍历 resolver Map 既拿不到卡片内容，也无法在 worker reconnect 后可靠重建。Pet 需要新建跨 session `PendingDecisionIndex`。

#### 3.2.2 `PendingDecisionIndex` 设计

```ts
interface PendingDecisionProjection {
  userId: string;               // Phase 1 固定/隐式 "local-user"；user 改造时才多值
  agentSessionId: string;
  coreSessionId: string;
  workerId: string;
  workerGeneration: number;
  requestId: string;
  routeGeneration?: number;
  kind: "ask_user" | "tool_approval" | "browser_action" | "credential" | "other";
  title: string;                // redacted/template summary
  toolName?: string;
  riskLevel?: "low" | "medium" | "high";
  createdAt: number;
  expiresAt?: number;
  status: "pending" | "resolved" | "expired" | "cancelled" | "owner-lost";
  surfacedAt?: number;
  seenAt?: number;
  teamId?: string;              // reserved; undefined this phase
  correlationId?: string;
}
```

索引生命周期：

1. worker 在把 `ApprovalRequest` 交给 host event reducer 之前产生结构化 `pending.created`；Phase 1 local host 先确认目标在本地 catalog，再加入固定 `local-user` index。多用户后才改为 server 验证 owner。
2. 用户响应、timeout、cancel、session close、approval owner disconnect 都必须产生 terminal transition；重复 terminal event 按 `(workerId, generation, requestId)` 幂等。
3. `toolName === "__ask_user__"` 归类为 `ask_user`；不要让前端从自然语言 description 猜类型。
4. worker reconnect 后提供 read-only `pending snapshot`，host 用 generation 对账：snapshot 不存在的旧 pending 标记为 `cancelled/owner-lost`，绝不把旧卡继续当可审批项；`owner-lost` 在多用户 approval lease 阶段启用。
5. Pet 只负责**展示与导航**。Phase 1 点击 pending 打开原 session，由原 approval route 完成决策；Pet chat 不直接构造 `ApprovalResult`。

为支持 snapshot，建议把 worker 内 pending 从“resolver-only Map”演进为“resolver + metadata 的结构化 entry”，或在 `AgentServer` 边界维护并导出只读 metadata view；不能把 resolver 暴露给 host/UI，后续也不能暴露给 server/browser client。

### 3.3 主动弹出时机：“什么时候打开”

#### 3.3.1 先区分三种 surfacing 强度

```text
L0 Badge   Pet 图标数字/状态变化，不打断用户
L1 Peek    一条可关闭 toast / pet 气泡，点击进入 Pet 或目标 session
L2 Open    自动展开完整 pet panel，可能抢占注意力
```

**Phase 1 默认只使用 L0 + L1，绝不自动 L2 Open。** “主动”首先意味着 Pet 能及时把需要注意的事带到用户眼前，不等于随意抢焦点。完整面板只由用户点击打开；未来若支持 L2，必须是 opt-in 且在用户未输入、未处理 approval、未演示/全屏时才允许。

#### 3.3.2 可复用基础设施

- background work 完成已经归一为 `result` envelope；queue commit 后由同一个 `agentNotificationBus` fan-out（`packages/core/src/tool-system/builtin/agent-notifications.ts:401`）。
- `AgentServer` 订阅 bus，把 legacy event 按目标 session 转发；只有 `result` 会尝试唤醒 idle session（`packages/core/src/protocol/server.ts:295`）。
- idle wake 会先检查 session 存在、idle、非 headless、没有刚被用户 Stop，再 `drainAll()` 聚合结果并注入 synthetic turn；burst 会被合并（`packages/core/src/protocol/server.ts:317`、`packages/core/src/protocol/server.ts:354`）。
- cron/automation 已有 host-agnostic scheduler 和 host-injected runner；job 可选择 `resumeSessionId` 以在定时触发时继续指定 session（`packages/core/src/automation/scheduler.ts:54`、`packages/core/src/automation/index.ts:43`）。

这些机制证明 CodeShell 已有“事件到达 → 聚合 → 唤醒某个 session”的基础原语。**设计上 Pet 不应复用 `maybeWakeIdleSession()` 去自动运行每个提醒**；它应复用 event/bus/dedupe 思路，把事件投影为 user attention，只有用户打开 pet chat 时才需要运行 Pet LLM。

#### 3.3.3 Phase 1 最小触发集

| 触发 | 默认行为 | 抑制 / 聚合 |
|---|---|---|
| 非当前 session 新 pending 持续超过 `N=15s` | L0 + 一次 L1：“Session X 正在等你批准 Write” | 当前 session 已展示同一卡、15s 内已解决则不提示 |
| 同时有 2 个及以上 pending | 合并为一次 L1：“3 个 session 等你决定” | 不为每张卡各弹一次；点击打开 Pet pending 列表 |
| 非当前 session run/background work `failed` | L0 + L1 | 同 session 同 correlation 只发一次 |
| 非当前 session background work `completed` | L0；用户开启“完成时提醒”后才 L1 | burst 在 2s 窗口聚合为一条 |
| 所有 work 从 running 变为 idle 且有新 terminal result | Pet 状态变为“都完成了”，L0 | 不自动打开完整 Pet |

`N=15s` 是**设计默认值**，不是仓库现状；实现前可通过可用性测试调整。Phase 1 不做“LLM 自己判断重要里程碑”，因为这需要额外总结调用、成本控制和误报策略。Phase 2 可从已有 `goal_progress`/structured progress 中加入确定性的长任务里程碑提醒，不从自由文本猜。

### 3.4 Pet chat：可对话入口与 `dispatchToAssistant`

#### 3.4.1 入口形态

推荐 Pet chat 是一个**特殊但 durable 的 Pet session**：Phase 1 属于隐式 `local-user`；后续 user 改造时再映射为 per-user `AgentSession(kind="pet")`。

- 它有独立 transcript、model/context budget 和可选人格配置；
- 它没有默认 workspace 写权限，不把任一 work session 的 cwd 当自己的 cwd；
- 每次 turn 由 local host（后续为 server）注入有界 `PetWorldSnapshot`，并只暴露 host-owned orchestration tools；
- UI 上使用常驻 Pet panel / mobile Pet tab，不沿用 quick-chat 的 ephemeral close/delete/fork 语义。

**UI 北极星：Pet chat 长期应达到 Desktop 主对话的功能与交互体验，而不是停留在 mobile-remote 式精简聊天壳。** Phase 1 MVP 可以先做小，只交付全局状态、pending、chat 与 open-session 闭环；但组件边界、状态模型和 future `packages/web` 都应以 Web/Desktop parity 为演进方向，不把“手机能聊”当最终完成定义。

现有 Quick Chat 已直接复用 `ChatView`，并具备消息、busy/stop、AskUser、approval、permission 和 model 控件（`packages/desktop/src/renderer/panels/QuickChatPanel.tsx:55`、`packages/desktop/src/renderer/panels/QuickChatPanel.tsx:133`）。因此其**对话壳与按 bucket 隔离状态**可以复用；但 Quick Chat 是 side-fork/ephemeral 产品，关闭会删除其 state/transcript，已有设计也明确 inherited history、approval 和 steer 状态彼此隔离（`docs/todo/small-features-2026-07-10/PIPELINE-SUMMARY-QCLIFE.md:12`、`docs/todo/small-features-2026-07-10/PIPELINE-SUMMARY-QUICKCHAT.md:17`），不能把 Pet 实现成一个随面板关闭而销毁的 quick chat。

mobile remote 已有 session list/select/chat.send/approval.respond 的 browser UI 链路（`packages/desktop/src/main/mobile-remote/types.ts:78`），mobile shell 也已有 SessionList、MessageStream、ApprovalCard 和 Composer（`packages/desktop/src/mobile/App.tsx:7`）。**推测：**这些组件可作为未来 mobile pet chat 的 UI 复用起点，但 server roadmap 已要求抽成 `packages/web` 并切断 Electron-specific protocol，不能直接把 mobile dispatcher 当 Pet backend（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:204`）。

#### 3.4.2 `dispatchToAssistant` 作为统一入口

沿用 IM gateway §6 的抽象，建议收敛为：

```ts
type AssistantCommand =
  | { type: "chat"; text: string }
  | { type: "get_global_status" }
  | { type: "list_pending" }
  | { type: "open_session"; agentSessionId: string }
  | {
      type: "send_direction";
      agentSessionId: string;
      prompt: string;
      delivery?: "next-safe-point" | "interrupt-and-redrive";
    };

interface AssistantDispatchContext {
  /** Phase 1 本地省略；user/server 改造后由 server 派生，绝不信 client 自报。 */
  principal?: Principal;
  localOwner?: "local-user";     // Phase 1 固定值；多用户时由 principal 取代
  channel: "web" | "desktop" | "mobile" | "im";
  connectionId: string;
  activeAgentSessionId?: string;
  requestId: string;
  correlationId?: string;
  locale?: string;
}

dispatchToAssistant(
  command: AssistantCommand,
  context: AssistantDispatchContext,
): AsyncIterable<AssistantChunk> | Promise<AssistantResult>;
```

语义：

- `chat` 进入 Pet orchestrator session；模型通过窄工具读取 `SessionIndex/PendingDecisionIndex`，不会拿到 raw storage；多用户阶段也不会拿到其他用户 id。
- `get_global_status/list_pending` 可直接返回 deterministic projection；不必为简单列表花一次 LLM。
- `open_session` 返回 host-validated client action，由当前 UI 切换；多用户阶段再升级为 signed/authorized action。Pet 不伪装成“已处理 pending”。
- `send_direction` 必须经过 §3.5 的 direct-child route；歧义目标或非 running target 一律返回结构化拒绝。
- future IM adapter 只负责把消息和可信 channel context 送入该接口，再把 stream/result 回推；gateway 继续不是大脑。

Phase 1 local host 只接受自身 UI 连接并使用固定 `localOwner`；后续 user/server 改造时才启用 `principal`、ownership 与多 tenant 授权。两者复用同一 command schema，避免届时重写 Pet tools。

`localOwner` 与 `principal` 必须恰有一个有效，不能同时缺失或让 client 自由选择。

#### 3.4.3 自然语言到操作

Pet 的工具集建议只有以下 application commands：

- `PetListSessions(filter)`
- `PetGetSessionStatus(agentSessionId)`
- `PetListPending()`
- `PetOpenSession(agentSessionId)`
- `PetSendDirection(agentSessionId, prompt, delivery)`（后续 Phase）

目标解析顺序：显式 session id > UI 当前选中 session > 唯一 title/workspace match > 最近上下文唯一 match。**若多个 session 同名或 mutation 目标不唯一，Pet 必须询问，不能猜。** 回答“全局怎么样”时采用 snapshot version；若随后动作前 snapshot 已过期，Phase 1 重新做 local binding/live generation 校验，多用户阶段再叠加 ownership。

### 3.5 跨 session 指令下达：Pet → 指定运行中 child

#### 3.5.1 复用现有 Phase 0 控制面

现有 Phase 0 已经实现/定义：

- `NotificationEnvelope` 使用通用 `from/to: { sessionId, agentId?, authority }`，预留 `teamId?`、`correlationId?`、`runtimeGeneration?`（`packages/core/src/tool-system/builtin/agent-notifications.ts:68`）；
- queue 按 `to.sessionId` 分桶，progress latest-only，result 清 stale progress，commit 后只 publish 一次（`packages/core/src/tool-system/builtin/agent-notifications.ts:371`）；
- `AgentSendInput` 对 running target 只走 registry/live runtime route，不能构造第二台 Engine（`packages/core/src/tool-system/builtin/agent.ts:1355`）；
- direct-edge、runtime generation、writer lease 和 intake state 都会校验（`packages/core/src/tool-system/builtin/agent-registry.ts:273`）；
- 当前任何携带 `teamId` 的 envelope 都会被 queue 拒绝，明确表示 Team 尚未启用（`packages/core/src/tool-system/builtin/agent-notifications.ts:343`）。

Pet 不新建 `PetMessageBus`。方向指令继续使用 `direction` envelope、`next-safe-point | interrupt-and-redrive` delivery、`correlationId`、ACK 与 single-writer 语义。

#### 3.5.2 Pet direct-child 路由

**设计：** Phase 1/2 本地形态先在 Pet session binding 中为每个 normal work session 记录 `parentPetId`，把它定义为 Pet 的直属 child；后续 user/server 改造时，这个 binding 进入 server `AgentSession` control metadata。这是一条 tree edge，不是把所有 session 互相连成 mesh。

```text
PetSendDirection
  → localOwner == "local-user"（后续：AuthN Principal + ownership）
  → local session binding（后续：AgentSession owner == principal.userId）
  → session.parentPetId == principal.petId
  → worker binding + generation current
  → target runState == running
  → worker LiveSessionControl routeDirection()
  → existing direction envelope / safe point / ACK
```

**现状：** `LiveChildControl` 位于 `asyncAgentRegistry` entry，路由依赖 `entry.childSessionId/liveControl/writerLease`；普通 `ChatSession` 当前公开的是 turn enqueue、cancel、busy/queue 等 session 生命周期原语（`packages/core/src/tool-system/builtin/agent-registry.ts:74`、`packages/core/src/tool-system/builtin/agent-registry.ts:278`、`packages/core/src/protocol/chat-session.ts:105`）。因此设计上仍需为 normal `ChatSession`/其 Engine 增加窄 `LiveSessionControl` adapter，复用现有 safe-point、AbortController 和 envelope consumer，而不是让 host/router resume 第二台 Engine。该 adapter 仍必须保证：

- 只接受 Pet → 直属 running session；
- target idle/dormant/unknown 时返回 `target-not-running`，本期不偷偷 cold-resume；
- `from.authority` 仍为 `agent`，即便起因是用户在 pet chat 发话，也不等价于 tool approval；
- `interrupt-and-redrive` 是 cooperative abort，不回滚已发生外部副作用；
- ACK 只表示 queued/delivered/interrupted/rejected，不表示任务成功或已授权。

Phase 1 只交付 `PetOpenSession`，让用户进入原 session 决策或继续输入；`PetSendDirection` 放到控制面 adapter 完成后的 Pet Phase 2，避免以“跨 session 指令”为名绕过 single-writer。

---

## 4. 数据模型与状态

### 4.1 Phase 1 本地 metadata 与后续 user 扩展位

Phase 1 不引入账号库或 control DB。建议在现有 `~/.code-shell` 下增加一个小型 Pet metadata 区（例如 `~/.code-shell/pet/`；具体文件名留给 implementation spec），而 Pet chat transcript 继续使用现有 durable session 存储；当前 session canonical root 与 disk-authoritative 事实见 `docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:144`：

| Phase 1 本地实体 | 建议最小字段 | 真相与生命周期 |
|---|---|---|
| `LocalPet` | `id="local-pet"`, `userId="local-user"`, `petSessionId`, `displayName`, `profileVersion` | 当前机器唯一；`userId` 是固定扩展位，不代表已实现账号 |
| `PetPreference` | `userId="local-user"`, `surfaceMode`, `notifyOnCompletion`, `quietHours?`, `locale` | 本地偏好；不需要 login |
| `PetSessionBinding` | `sessionId`, `parentPetId`, `workerGeneration?` | 本地 tree/control edge；不复制 transcript |
| `PetNotificationReceipt` | `userId="local-user"`, `dedupeKey`, `level`, `surfacedAt`, `seenAt?` | 本地节流去重；可设短保留期 |

后续 user/server 改造时，不删除这些概念，而是把固定 `local-user` 升级为真正多值：

| 后续实体 | 演进字段 | 作用 |
|---|---|---|
| `UserPet` | `id`, `userId UNIQUE`, `petAgentSessionId`, `displayName`, `profileVersion` | 多用户阶段的一 user 一 Pet |
| `AgentSession` 增量 | `kind: work|pet`, `ownerUserId`, `parentPetId?`, `workerId`, `workerGeneration` | ownership/control edge |
| `AuditEvent` 增量 | `userId`, `petId`, `correlationId`, `targetAgentSessionId`, `command`, `outcome` | 脱敏审计 |

`UserPet.userId UNIQUE` 是**后续多用户阶段**的数据库不变量，不是 Phase 1 前置。无论本地还是 server 形态，Pet transcript 都继续由 core session disk 持有；未来 control DB 只保存 identity/ownership/index，不复制聊天内容，和 server roadmap 的 disk-authoritative 原则一致（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:534`）。

### 4.2 Runtime projection

以下状态是可重建 cache，不作为 durable 内容真相：

- `SessionIndex: Map<agentSessionId, PetSessionProjection>`
- `PendingDecisionIndex: Map<agentSessionId/requestId, PendingDecisionProjection>`
- `latestWorkerSnapshotVersion`
- per-connection focus/visibility（当前用户正在看哪个 session）

worker 是 live truth；Phase 1 local host 订阅增量事件并维护 materialized view。应用重启后按以下顺序恢复：

1. 从现有本地 session catalog 读全部 durable work session，并载入固定 `local-user` 的 Pet metadata；
2. 未启动 worker 的 session 全部先标 `dormant`，pending 为空；
3. 启动/连接当前 core worker 后拉取 `live session + progress + pending` snapshot；
4. 记录 snapshot version/generation，再接收增量事件；
5. 旧 generation 的迟到事件丢弃并审计，不覆盖新状态。

后续 user/server 改造只替换第 1 步的 catalog source（owner-scoped `AgentSession`）并把 view 按 `userId` 分桶；projection shape 不变。

### 4.3 与 disk-authoritative session 对齐

- disk `state.json/transcript.jsonl` 决定 session 能否 resume 与聊天内容；
- Phase 1 的本地 catalog + `PetSessionBinding` 决定“这个 session 是否属于本地 Pet tree”；后续才由 `AgentSession` ownership 决定“属于哪个 user、在哪个 workspace/worker”；
- `SessionIndex` 决定“此刻观察到什么”；
- `PendingDecisionIndex` 只对 live generation 有效，worker 失联即不可继续审批；多用户阶段再叠加 approval owner 失联语义；
- Pet 不因读取 dormant session 列表而创建 Engine；只有用户打开/resume 或明确运行命令才触发现有生命周期。

这保持了 idle TTL 的意义：live Engine 可被回收，但 durable session 仍出现在 Pet 的“我的工作”中。当前 manager 的 idle close 会从 live map 删除且不删 durable session（`packages/core/src/protocol/chat-session-manager.ts:244`、`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:76`）。

### 4.4 User / 多 worker 演进位

Phase 1 只面对当前本地 worker，不建设 account worker supervisor、分布式 event store 或跨 tenant 聚合。server roadmap 后续推荐先一个 admin worker、再演进到 per-user worker（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:383`）。

为避免未来被锁死，projection 和 event key 保留 `workerId + workerGeneration`：

- 同一个 session 任一时刻只允许一个 active worker binding；多用户后由 `AgentSession` 承载该约束；
- Phase 1 聚合 key 可直接使用本地 `sessionId`；多用户后切换为 server public `agentSessionId`，不能信 browser 裸传 `coreSessionId`；
- worker rebalance/restart 先提升 generation，再接受新 snapshot；旧事件 fail closed；
- 若未来一个 user 因容量使用多个 worker，`PetStateAggregator` 只需合并多个 authorized worker feed，不改变 Pet/UI contract。

最后一项是**扩展位，不是本期多 worker 调度承诺**。

### 4.5 Team 扩展位但不实现

数据结构可保留 `teamId?` 和 `correlationId?`，但本期规则是：

- `teamId` 必须为 `undefined`；传入即 `team-not-supported`；
- `correlationId` 只串联 Pet command → direction ACK → progress/result/audit；
- 不创建 `Team/Member/Role/ACL` 表；
- endpoint 继续用通用 `sessionId/agentId?/authority`，避免未来改 envelope；
- 未来 Team 若落地，另行增加成员目录和 ACL，不把“同 user”偷换成“同 Team 可互发”。

---

## 5. 候选架构与推荐

### 5.1 方案 A（推荐）：host-side 聚合器 + durable pet orchestrator session，后续接 server/user

做法：

- Phase 1 在 Desktop/local host 新建单用户 `PetStateAggregator`、pending/session projection、attention policy 和 `dispatchToAssistant`；
- 当前 core worker 内创建一个 durable pet orchestrator session，本地 catalog 默认都属于隐式 `local-user`；
- 后续 user/server 改造时把聚合器迁入 `packages/server`，增加 `userId` 分桶、ownership、per-user worker 与 authorized EventHub；
- Web/Desktop/Mobile 使用统一 pet chat contract；future IM gateway 也接同一个 dispatch port；tool permission 始终留在 core。

| 优点 | 代价 |
|---|---|
| Phase 1 不依赖账号/server，当前单用户本地即可落地 | local host 仍需设计 worker snapshot 与 projection reconciliation |
| world state 不占 Pet transcript，不需复制所有 session 内容 | 未来迁入 server 时要补 owner migration，但 projection contract 不变 |
| channel-independent，Web/Mobile/IM 共享一个 assistant 主体 | 新增 application command contract 与 UI attention policy |
| 后续可平滑对齐 server roadmap 方案 A、per-user worker 和 ownership | 普通 ChatSession 的 live direction adapter 仍需后续补齐 |

### 5.2 方案 B：在 core 内做特殊 `PetEngine` / 全局 orchestrator

做法：给 `core` 增加特殊 Engine，直接持有所有 `ChatSessionManager`、pending 和 notification 状态。

优点：同进程访问 live map 简单，direction 到 Engine 路径短。

问题：

- `core` 当前 live map key 只有裸 `sessionId`，也没有 product `userId`；Phase 1 虽不需要账号，把 Pet 产品偏好和 UI attention policy 放进 core 仍会污染 UI-agnostic engine，未来多用户时问题更明显（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:128`）。
- 多 worker 时 Pet 无法只靠某个 core process 看全局；最终仍要 server aggregator。
- 特殊 Engine 容易形成另一套 session、permission 和 persistence 语义。

结论：**不推荐。** 可以给 core 增加窄 snapshot/control port，但不让 core 拥有 Pet 产品主体。

### 5.3 方案 C：前端聚合卡片 + 一个普通聊天 session

做法：UI 订阅所有 session stream，在前端拼 running/pending 卡片；普通聊天 session 只接收 UI 拼出的摘要。

优点：最快做出视觉 demo，后端新增少。

问题：

- 多设备、断线和 app/worker restart 后状态不一致；没有 worker snapshot 就无法重建 pending。
- 浏览器必须拿到过多跨 session 原始事件，扩大泄漏与 AuthZ 风险。
- IM/mobile 无法共享前端内存里的“Pet 大脑”；主动提醒只在该页面打开时存在。
- LLM command 与 UI action 缺少可信 host-side target/binding 校验；多用户时还会缺 ownership 校验。

结论：可做 prototype，不作为产品架构。

### 5.4 推荐决策

采用 A，并坚持：

1. **Pet world state 在 host projection，Pet reasoning 在 durable orchestrator session。** Phase 1 host 是 Desktop/local，后续才是 server。
2. **Web/IM contract ≠ core RPC 裸透传。** `dispatchToAssistant` 只暴露 allowlisted application command。
3. **Permission 始终在 core。** Phase 1 先按隐式本地归属校验 direct edge；多用户阶段再叠加 server AuthZ。无论哪种形态，Pet 有权“把 direction 投递给自己的 child”都不代表 child tool 已获准。
4. **Phase 1 先 read + navigate。** live direction 等 `LiveSessionControl` 和竞态测试完成后再开放。

---

## 6. 主动性的安全与克制

### 6.1 Pet 绝不替用户做危险决策

- tool approval、`AskUserQuestion`、browser action、credential use 仍由原 session approval route 处理；
- Pet 可以说“这里等你批准 Write”并打开目标 session，不能调用 resolver 或伪造 `ApprovalResult`；
- 即使用户在 pet chat 说“以后都批准”，也不能绕过目标 session 当前 scope/route；若未来支持 policy edit，必须是独立、显式、可审计的产品操作。

### 6.2 Pet direction 不扩大权限

Phase 0 已规定 `authority` 只表示来源，不授予能力；direction payload 不能携带 `permissionMode/approval/sandbox/toolAllowlist/skillAllowlist`，所有 tool call 仍经过 permission choke point（`docs/todo/parent-child-bidirectional-notification-phase0-design.md:530`）。Pet 继承这条规则：

- Pet direction 使用 `authority: "agent"`；
- Pet 不能把 plan/read-only child 提升为 writable/bypass；
- target session 的 frozen policy、approval router 和 path policy 保持不变；
- `interrupt-and-redrive` 只改变执行时序，不改变权限。

### 6.3 不轰炸用户

- 同一 `(userId, agentSessionId, requestId/correlationId, triggerKind)` 只 surface 一次；Phase 1 的 `userId` 固定为 `local-user`；
- 多 pending、completion burst 聚合；
- 用户已在目标 session 且卡片可见时只 L0，不 L1；
- quiet hours 只抑制非紧急 peek，不隐藏 pending badge；
- Phase 1 用本地 receipt 去重；多端/user 改造后升级为 server receipt，避免 Web/Desktop/Mobile 同时弹三次；
- Phase 1 不自动打开完整 Pet，不用 LLM 判断“这件事很重要”。

### 6.4 数据最小化

- Pet list 默认只见 title、workspace display name、阶段、一行摘要和 pending metadata；
- tool args、prompt、tool output、reasoning、secret 不进入 notification receipt/audit；
- 高风险 approval 的展示摘要由可信模板生成，不把任意命令全文推到锁屏或 future IM；
- future IM 回推必须沿用 gateway 的白名单、鉴权和脱敏边界（`docs/todo/im-gateway-remote-orchestration.md:98`）。

### 6.5 失联与陈旧状态 fail closed

- worker disconnect：running → unknown，pending → stale/cancelled；不继续显示可点的批准按钮。多用户阶段 approval owner 失联再使用 `owner-lost`；
- Phase 1 session close：从 live projection 移除并按 durable catalog 重新归约；多用户阶段 user/session revoke 还必须立即断开 subscription；
- target generation 变化：旧 command/ACK/event 丢弃；
- target 不 running：direction 拒绝，不自动创建/resume Engine；
- Pet LLM 超时或失败：deterministic global status API 和原 session UI 仍可用。

---

## 7. 分期 Roadmap

### Pet Phase 0：contracts 与只读 projection spike

**目标：**证明当前 local host 能可靠重建单用户全局状态，不交付人格化自动动作。

**交付物：**

- `LocalPet`、`PetSessionProjection`、`PendingDecisionProjection` schema/contract；`userId` 固定为 reserved `local-user`；
- worker `pet snapshot`（live sessions + progress + pending metadata）与 generation/reconnect 语义；
- local event reducer：StreamEvent/approval/result → 单用户 projection；
- `dispatchToAssistant(get_global_status | list_pending | open_session)` deterministic contract；
- threat model：跨 session 误路由、stale generation、approval hijack、notification leakage、prompt injection；IDOR 留给后续多用户接入测试。

**复用：** 现有本地 session catalog、`ChatSessionManager.forEachSession`、session-tagged StreamEvent、approval route generation、NotificationQueue/bus。

**新建：** local host projection、pending metadata snapshot、本地 dedupe receipt、pet direct-edge metadata。

**主要风险：** 把 live event 当 durable truth；忽略 reconnect snapshot 后产生幽灵 pending。

**退出条件：** 当前 worker 重启/断线/idle eviction 后，Pet status 能从本地 catalog + snapshot 恢复；不引入 account/login/multi-tenant。

### Pet Phase 1：最小可用 Pet（read + chat + navigate + restrained surface）

**目标：**在当前单用户本地/Desktop 形态交付最小闭环：**“pet 能列出我所有 session 在跑什么 + 等我决定什么；我能和它 chat 问全局、让它帮我切到某个等决策的 session。”**

**交付物：**

1. 当前机器唯一 `LocalPet`，一个 durable pet chat session；
2. Desktop Pet panel：全局 running/pending 列表 + chat；MVP 可小，但长期 Web UI 以 Desktop parity 为北极星；
3. Pet 工具：list sessions、get status、list pending、open session；
4. pending 超过 15s、multi-pending、nonfocused failure 的 L0/L1 surfacing；
5. 点击 pending 进入原 session，由原 UI 审批/回答；
6. snapshot version、worker generation、本地 dedupe/log 可观察。

**复用：** Quick Chat/`ChatView` 对话壳、现有 session/chat/approval components、StreamEvent reducer、approval envelope、background completion bus。

**新建：** Pet profile/session bootstrap、Pet panel、world snapshot prompt/tool adapter、attention policy。

**明确不含：** `PetSendDirection`、自动审批、L2 auto-open、IM push、持久自主任务、Team/mesh。

**主要风险：** Pet 回答使用旧 snapshot；缓解是回答标注 freshness，执行 open 前重新校验本地 session/generation。多用户后再叠加 AuthZ。

### Pet Phase 2：tree 内 Pet ↔ running child 控制面

**目标：**用户可在 pet chat 说“告诉 Session A 先别重构，先复现问题”，安全投递给直属运行中 child。

**交付物：**

- normal `ChatSession` 的 `LiveSessionControl` adapter；
- `PetSendDirection` direct-edge resolver；
- `next-safe-point` 与 `interrupt-and-redrive`；
- correlation/ACK/progress/result 的 UI 反馈；
- single-writer、closing race、stale generation、Stop、pending approval interrupt 的竞态测试矩阵；
- deterministic goal milestone surfacing（可选，只有 event 可证明时启用）。

**复用：** Phase 0 direction envelope、NotificationQueue、agentNotificationBus、runtime generation、safe point、AbortController、permission provenance。

**新建：** host-side Pet route resolver、top-level session direct edge、LiveSessionControl adapter；后续 user 改造时再迁入 server 并叠加 ownership。

**明确不含：** sibling route、broadcast、Team、跨用户、target-not-running 自动 resume。

**主要风险：** 第二个 Engine 写 transcript、interrupt 被误解为回滚、Pet 文本被误当用户 consent。三项都必须 fail closed。

### Pet Phase 3：可选主动性与新渠道

**目标：**在用户拍板后扩展，而不是默认放大自治。

**候选交付物：**

- opt-in L2 auto-open、quiet hours、per-session notification preference；
- future IM gateway 接 `dispatchToAssistant`，支持全局问答与安全 deep link；
- 基于 cron 的 Pet check-in / daily digest；
- 有边界的长期人格/记忆；
- 若用户明确批准，再设计低危 policy automation。

**明确不自动包含：** Team/多数字人。Team 仍是独立后续 Phase，需要成员目录与 ACL。

---

## 8. 与账号体系 / server roadmap 的分期关系

### 8.1 Phase 1 本地前置：不包含账号体系

Pet Phase 1 与 server/account roadmap 解耦，可以在当前 Desktop 单用户本地形态独立交付。它只依赖：

1. 现有本地 durable session catalog，用来列出“我的 session”；
2. 当前 core worker 的 `ChatSessionManager`、session-tagged stream、pending route 和 notification bus，用来叠加 live 状态；
3. 一个固定的隐式身份 `local-user/local-pet` 和本地 `PetSessionBinding`，用来表达唯一 Pet 与 direct-child tree；
4. 本地 durable pet chat session 与少量 preference/receipt metadata。

Phase 1 **不新建** `User/AuthSession`，不要求 login，不做 `Principal.userId` 校验，不做 tenant ownership，也不要求 per-user worker。这里的“我的 Pet”就是“当前机器上当前 CodeShell 用户的唯一 Pet”。

### 8.2 后续 user/server 改造的接入点

当产品开始支持多个 `User` 时，再启用以下扩展位；账号设计保留，但从前置依赖降级为演进方向：

1. **Identity**：固定 `local-user` 迁移为真实 `User.id`，`LocalPet` 迁移为 `UserPet(userId UNIQUE)`。现有 remote passcode/pairing 只能证明设备，不是产品用户账号，因此不能直接当多用户 identity（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:196`）。
2. **Session ownership**：本地 catalog 的隐式全量归属迁移为 `AgentSession(ownerUserId, workspaceId, workerId, coreSessionId)`；所有 Web 操作再先查 ownership（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:151`）。
3. **Per-user worker / private root**：多用户阶段把 runtime、settings、credentials、memory 与 child process 放进用户隔离域；roadmap 推荐一用户一 worker（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:466`）。
4. **Authorized EventHub / approval lease**：多用户 fan-out 按 user + authorized session subscription，不能广播给全部 authenticated users（`docs/nightly-2026-07-12/server-deployment-web-account-roadmap.md:226`）。
5. **Web/Desktop parity**：future `packages/web` 接同一个 Pet contract，并以 Desktop 体验为目标；账号/网络层改变入口，不把 Pet UI 降格成 mobile-remote 精简版。

### 8.3 对齐表

| 产品阶段 | Pet 关系 | 结论 |
|---|---|---|
| 当前 Desktop / 本地单用户 | **直接交付 Pet Phase 1** | 完整满足“自己的 Pet + 全局状态/pending + chat + open session” |
| Server roadmap Phase 0/1 | 若后续推进，可复用 Pet projection/dispatch contract | 不是 Pet Phase 1 blocker，不要求先做 single-admin login |
| Server roadmap Phase 2：多用户 / per-user worker | 给既有 Pet 叠加真实 `userId`、ownership、private root 和 authorized EventHub | 多用户能力是增量，不重新定义 Pet |
| Server roadmap Phase 3：remote/product channels | Pet Phase 3 可接 IM/tunnel/relay | gateway 仍只作 channel |

因此结论是：**本地单用户 Pet 现在就能做；账号体系以后再接。** future IM gateway 的高阶指令仍应调用同一个 `dispatchToAssistant`，不能在 gateway 再造一只 Pet。

---

## 9. 关键流程

### 9.1 用户问“现在都有什么在跑？”

```text
User → pet chat
  → dispatchToAssistant(chat)
  → Pet tool: PetListSessions({ state: running|queued|waiting })
  → local host checks current catalog/generation and returns snapshot v42
  → Pet 生成简短汇总：
      A 正在跑 tests；B 等你批准 Write；C 后台 agent 正在 model 阶段
  → 每项附 authorized open action
```

Pet 不扫 transcript，不轮询每个 Engine。后续多用户时，同一 projection 再加 owner scope，不能读取其他 user 的 EventHub。

### 9.2 某 session 出现 AskUserQuestion

```text
Worker session B
  → pending.created(kind=ask_user, requestId, generation)
  → local PendingDecisionIndex[B/requestId]
  → B 非当前 session，15s 后仍 pending
  → Pet L1 peek：“Session B 在等你选择方案”
  → User click
  → local host re-check session binding + pending generation
  → UI open B；原 approval route 收回答
  → pending.resolved；Pet badge 清除
```

若 worker 在点击前断线，打开动作可保留，但批准动作必须不可用并显示“状态已失联，请刷新/恢复 session”。

### 9.3 Pet 向运行中 session 修正方向（Pet Phase 2）

```text
User: “告诉 A 先复现，不要直接改代码”
  → Pet resolves unique A
  → AuthZ + parentPetId + running + generation checks
  → direction envelope(teamId absent, correlationId set)
  → target LiveSessionControl(next-safe-point)
  → ACK queued/delivered/rejected
  → later progress/result uses same correlationId
```

如果 A 已结束，Pet 回答“它已经停止运行；我可以帮你打开 A”，而不是偷偷 resume 或给 A 的 sibling 发消息。

---

## 10. 风险与缓解

| 风险 | 后果 | 设计缓解 |
|---|---|---|
| projection 陈旧 | Pet 误报“还在跑/还在等” | snapshot version + generation + freshness；动作前重校验 |
| pending 只靠增量事件 | reconnect 后幽灵卡片或漏卡 | worker pending snapshot + terminal transition 幂等 |
| Pet 上下文塞入所有 transcript | token/隐私放大，答案被旧内容污染 | 默认只注入结构化 world snapshot；历史按需、限量读取 |
| Pet route 退化为任意 session send API | 偷渡 sibling mesh；多用户时形成 IDOR | Phase 1 校验 `parentPetId` direct edge + local binding + running + generation；多用户再叠加 owner |
| direction 被当用户批准 | child 越权执行 | authority=agent；permission gate 不变；payload 禁 permission 字段 |
| 自动弹窗轰炸 | 用户关闭 Pet | Phase 1 L0/L1、15s grace、burst aggregate、receipt dedupe、无默认 L2 |
| worker crash 后 Pet 继续行动 | stale writer / approval hijack | unknown/stale fail closed；旧 generation 拒绝；多用户再叠加 owner-lost |
| Pet 自身 model 失败 | 全局入口不可用 | deterministic status/pending APIs 与原 session UI 独立可用 |
| local catalog/projection 不一致；后续 server ownership 与 disk 不一致 | 漏 session、幽灵状态；多用户时可能越权恢复 | Phase 1 snapshot reconcile；多用户时 ownership 先行、内容 disk-authoritative、repair/fail-closed 沿用 server roadmap |

---

## 11. 未决问题清单（需要用户拍板）

按影响从高到低：

1. **Pet 是否有持久人格与长期记忆？** 建议 Phase 1 只有 `displayName + style preference + pet chat transcript`；跨 session 事实记忆后置，避免它与 work session / account memory 形成第三份真相。
2. **Pet 的自治级别？** 建议 Phase 1 仅按需聚合 + 确定性通知；不在后台自主跑 LLM。是否允许 daily digest、主动复盘、无人值守继续工作，放到 Phase 3 单独授权。
3. **主动通知渠道？** 建议 Phase 1 只做 app 内 badge/peek；IM 仅在 gateway 接入 `dispatchToAssistant` 后 opt-in，且默认不发送 prompt/tool args。
4. **Pet 能否代替用户做低危决策？** 建议默认永远不能。若未来需要，只能通过独立 policy（明确工具/风险/范围/期限）表达，不能由 Pet 自行判断“低危”。
5. **完整 panel 是否可自动打开？** 建议默认否；只在 opt-in、无输入/审批/演示状态时允许，并可按设备分别配置。
6. **Pet Phase 2 是否允许对 idle/dormant session 新开 turn？** 建议先否，只向 running direct child 投 direction；以后若需要，设计为明确的“代表用户新建 turn”命令，不复用 direction。
7. **Pet chat 的 model 与成本预算？** 是沿用用户默认模型，还是使用低成本模型处理 status、只在复杂编排时升级？建议 deterministic query 不调用模型，chat 才计费。
8. **Pet personality 与 worker 生命周期如何解耦？** 本地 worker idle 回收或重启后，Pet UI 是否仍由 local deterministic projection 回答“离线/无运行中工作”？建议是，不能为了一个 badge 常驻 LLM Engine；后续 server 形态沿用同一原则。
9. **session title 重名时的交互？** 建议 mutation 必须二次选择；只读汇总可同时列出 workspace/title/public short id。
10. **后续引入账号时，现有 `local-user/local-pet` 如何迁移？** Phase 1 默认当前本地 catalog 全部属于唯一 Pet；user 改造时，建议由机器所有者显式确认迁入首个账号，并为其余账号建立新的 owner scope，不能把同一目录自动广播给所有用户。

---

## 12. 决策与验收不变量

后续 implementation spec 必须持续满足：

1. Pet 就是 `assistant 主体`，所有 channel 经 `dispatchToAssistant` 接入，不在 Web/Mobile/IM 各造一个大脑。
2. Phase 1 是隐式 `local-user → local-pet` 单例，不依赖账号；多用户阶段才启用 `Principal.userId → UserPet` 一对一，且 client 不能指定或切换 `userId/petId`。
3. Phase 1 Pet 只看当前本地 session catalog；多用户阶段切换为 owner-authorized `AgentSession`。无论哪一阶段，disk path、裸 `coreSessionId` 都不进入 browser command。
4. disk transcript 是 session 内容真相；Pet projection 是可重建 runtime view。
5. Phase 1 能列所有 work session 的 running/pending，并能从 Pet 打开目标 session。
6. pending index 覆盖 tool approval 与 `AskUserQuestion`，且 response/timeout/cancel/close/disconnect 都会收束。
7. Phase 1 默认不自动展开完整 Pet、不自动审批、不向 target 发 direction。
8. Phase 2 direction 只允许 Pet → 自己的直属 running child；sibling/跨用户/非直属/带 `teamId` 一律拒绝。
9. direction 复用现有 envelope/queue/bus/safe-point，不创建第二台 Engine 或平行 bus。
10. Pet authority 不等于 user consent；目标 session permission gate 永不绕过。
11. 多 worker 只预留 `workerId/generation`，本期不承诺分布式调度或 Team。
12. 每次主动 surfacing 可去重、可追踪、可关闭；通知内容默认脱敏。

满足以上不变量后，Pet 才是“用户的私人总管/编排大脑”，而不是一个好看的 session 列表，也不是一个越权的全局 agent。
