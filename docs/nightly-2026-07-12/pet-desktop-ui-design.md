# Pet overall agent 桌面页面 UI 设计稿

> 状态：**方向锚点 / 设计稿，非实现承诺**  
> 日期：**2026-07-12**  
> 范围：**CodeShell Desktop renderer，Phase 1 单用户本地形态**  
> 上位设计：[`pet-top-level-agent-design.md`](./pet-top-level-agent-design.md)，本文只把其产品边界、`SessionIndex` / `PendingDecisionIndex` 与通知策略具体化为桌面 UI，不修改上位数据模型。  
> 证据规则：仓库可证明的事实标为“现状”并附 `file_path:line`；无法由当前仓库证明的判断显式标为“推测”；“设计 / 建议”均为目标态。

## 0. 结论先行：一句话定位与形态锁定

**Pet 是位于左侧栏顶部的常驻 overall agent 入口；用户点击后，在现有 Desktop shell 内打开一个高密度 overview panel，同时查看所有 session 的“在跑什么 / 等你决定什么”，并与 durable pet chat 对话。**

形态锁定为：

- **左侧栏顶部常驻入口 + overview panel**，不是独立窗口，也不是另一套产品导航。
- Phase 1 是当前机器上的**单用户本地唯一 Pet**；没有账号、登录、租户切换或 ownership UI。`userId` 只保留为上位设计中的后续演进位（上位设计 §1.1、§8.1）。
- overview 默认推荐为现有 shell 中的**中央覆盖式 panel**：保留 Sidebar 与 TopBar，覆盖 chat + session-owned dock 所在工作区；关闭后回到原 session，底层 session UI 不因打开 Pet 而销毁。
- Phase 1 只做 read + chat + navigate：可问全局、看 pending、点击打开原 session；**不在 Pet 中批准/回答，不向 running child 发 direction**。
- 通知只做 L0 badge + L1 peek；**任何 projection event 都不得自动打开 overview（L2）**。
- 不呈现 sibling session 互连、Team、多数字人、跨用户 Pet；不复制所有 session transcript；不绕过原 permission gate。
- Pet chat 长期对齐 Desktop 主对话体验；MVP 可以缩小能力面，但不采用手机式精简信息架构。

### 被否决的备选

- **独立顶层页**：会把“随时扫一眼并返回当前工作”的路径变成独立目的地，割裂当前 session 上下文，否决。
- **悬浮气泡**：易遮挡正文与 composer，且承载不了高密度 session/pending/chat，否决。
- **列表状态条**：能提示状态但无法容纳全局 pending 与 durable pet chat，否决。

## 1. 现有 Desktop UI 基线

### 1.1 Sidebar 与主布局

**现状：**

- `App` 的 shell 是 TopBar 在上、下方 Sidebar + 主工作区；Sidebar 由 `App` 注入项目、session index、active session 和 per-session status（`packages/desktop/src/renderer/App.tsx:4419`、`packages/desktop/src/renderer/App.tsx:4456`、`packages/desktop/src/renderer/App.tsx:4459`）。
- Sidebar 是固定 `w-60` 的纵向布局；顶部 `<nav>` 不滚动，项目/session 区单独滚动，底部是 Settings 与 Updater（`packages/desktop/src/renderer/Sidebar.tsx:216`、`packages/desktop/src/renderer/Sidebar.tsx:255`、`packages/desktop/src/renderer/Sidebar.tsx:271`、`packages/desktop/src/renderer/Sidebar.tsx:329`）。因此 Pet 放在顶部 `<nav>` 第一项最自然，且不会随项目列表滚走。
- 当前顶部顺序是“新对话、搜索、扩展、自动化、凭证”（`packages/desktop/src/renderer/Sidebar.tsx:218`、`packages/desktop/src/renderer/Sidebar.tsx:253`）；Pet 应插在“新对话”之前，并用一条弱分隔线把“全局总管”与普通命令分开。
- `SidebarItem` 已支持 numeric badge，`Badge` 会把大于 99 的值显示为 `99+`（`packages/desktop/src/renderer/Sidebar.tsx:357`、`packages/desktop/src/renderer/Sidebar.tsx:380`、`packages/desktop/src/renderer/ui/Badge.tsx:3`）。
- session 目前按 project 分组，每组默认只展示前 5 条；行内已有 running spinner、asking pulse dot、unread dot 和相对时间（`packages/desktop/src/renderer/Sidebar.tsx:419`、`packages/desktop/src/renderer/Sidebar.tsx:482`、`packages/desktop/src/renderer/Sidebar.tsx:628`、`packages/desktop/src/renderer/Sidebar.tsx:665`）。Pet overview 应复用这套密度与状态语言，而不是改成大卡片墙。
- Sidebar collapsed 时当前实现完全不渲染 Sidebar（`packages/desktop/src/renderer/App.tsx:4457`）。Phase 1 不另造 collapsed icon rail；收起时沿用 TopBar 的 Sidebar reopen 行为，系统 dock badge 继续作为窗口外 L0 补位。是否要在后续增加窄 rail 属于独立 shell 改造，不阻塞 Pet。

**现状生命周期注意：**当前 `settings_page` 已不是 early-return；普通 shell 被 CSS 隐藏但仍挂载（`packages/desktop/src/renderer/App.tsx:4425`），Settings 再以 overlay 挂在根部（`packages/desktop/src/renderer/App.tsx:4852`）。Pet 必须延续这个结果：不能为了打开 Pet 或 Settings 改回 early-return，从而卸载 chat/panel/subscription 树。

### 1.2 对话壳、approval 与主 reducer

**现状：**

- `QuickChatPanel` 直接复用 `ChatView`，传入 messages、busy/stop、AskUser、approval、permission、model、draft 与 attachments（`packages/desktop/src/renderer/panels/QuickChatPanel.tsx:55`、`packages/desktop/src/renderer/panels/QuickChatPanel.tsx:133`）。
- `ChatView` 已将 `pendingApproval` / `onApprovalDecide`、`onAskUserAnswer`、composer controls、受控 draft 等作为明确 props（`packages/desktop/src/renderer/ChatView.tsx:49`、`packages/desktop/src/renderer/ChatView.tsx:94`、`packages/desktop/src/renderer/ChatView.tsx:110`、`packages/desktop/src/renderer/ChatView.tsx:129`、`packages/desktop/src/renderer/ChatView.tsx:175`）。
- `QuickChatPanel` 不是 Pet 容器：它带 fork/create/retry/use-blank 状态（`packages/desktop/src/renderer/panels/QuickChatPanel.tsx:108`），而 quick chat tab 消失或 App 卸载时会执行 cleanup 并 evict transcript（`packages/desktop/src/renderer/App.tsx:3617`、`packages/desktop/src/renderer/App.tsx:3638`）。Pet chat 必须绑定上位设计 §3.4 的 durable `petSessionId`，关闭 overview 只隐藏，不删除 transcript/session。
- tool approval 的完整操作卡是 `ApprovalCard`；它直接暴露一次/会话/项目批准与拒绝按钮（`packages/desktop/src/renderer/approvals/ApprovalCard.tsx:63`、`packages/desktop/src/renderer/approvals/ApprovalCard.tsx:143`）。Phase 1 Pet overview **不能直接复用整个 `ApprovalCard`**，否则会形成 Pet 内代批入口；只能复用其 `RiskPill`、排版 token，或抽出无操作的 summary primitive。
- `AskUserMessageView` 的选项与自由输入也会直接提交答案（`packages/desktop/src/renderer/messages/AskUserMessageView.tsx:56`、`packages/desktop/src/renderer/messages/AskUserMessageView.tsx:70`），因此 overview pending row 同样不复用其交互，只提供“打开并处理”。
- Desktop MessageStream 的主状态路径是 `transcriptsReducer`，其 `stream` / `stream_batch` 都调用 `types.ts` 的 `applyStreamEvent`（`packages/desktop/src/renderer/transcriptsReducer.ts:53`、`packages/desktop/src/renderer/transcriptsReducer.ts:130`、`packages/desktop/src/renderer/transcriptsReducer.ts:133`、`packages/desktop/src/renderer/types.ts:550`）。Pet chat transcript 应继续走这条主路径；`renderer/lib/streamReducer.ts` 不是接线目标。

### 1.3 PanelRegistry 适配性结论

**现状：**`PanelRegistry` 的 render context 绑定 `tabId + bucket + cwd + engineSessionId`（`packages/desktop/src/renderer/panels/PanelRegistry.ts:22`、`packages/desktop/src/renderer/panels/PanelRegistry.ts:27`）；`PanelArea` 明确是一 session bucket 一个实例，tabs 由 session 所有并保持 mounted（`packages/desktop/src/renderer/panels/PanelArea.tsx:54`、`packages/desktop/src/renderer/panels/PanelArea.tsx:60`、`packages/desktop/src/renderer/panels/PanelArea.tsx:107`、`packages/desktop/src/renderer/panels/PanelArea.tsx:371`）。

**决策：Pet overview 不走 `PanelRegistry`。** Pet 是跨 session 的全局 surface，若注册为普通 dock tab，会错误继承 active session 的 bucket/cwd、被每个 session 复制、并受 dock close/tab lifecycle 影响。推荐在 Desktop shell 层注册 `PetOverviewPanel`，用独立的 `petOverviewOpen`（命名仅为设计建议）控制中央 overlay；`PanelRegistry` 继续只管 session-owned dock。

## 2. 信息架构

### 2.1 Sidebar 入口

`PetSidebarEntry` 位于顶部 `<nav>` 第一项，结构为：

```text
[dog avatar]  Pet                         [3]
              3 个等你决定（可选副文案）
------------------------------------------------
[message]     新对话
[search]      搜索
...
```

规则：

- 使用仓库已有 CodeShell dog asset 作为识别符；该 asset 已用于主 chat welcome（`packages/desktop/src/renderer/App.tsx:4650`、`packages/desktop/src/renderer/App.tsx:4653`），可保持品牌连续性。
- badge 数字**只表示已越过 15s grace、当前仍有效的 `PendingDecisionIndex.status === "pending"` 数量**，覆盖 tool approval 与 `AskUserQuestion`；不把 running 数混进同一个数字。grace 内的 request 已在 overview pending section 可见，但按本稿默认策略尚不进入 L0 数字。
- `0` 时不显示数字。是否在 `0 pending` 但存在 running session 时给 avatar 增加一个低对比 running dot，留作用户拍板；即使增加，也不能与“等你决定”的数字同色同形。
- `1…99` 原样展示，`>99` 沿用现有 `99+`。
- hover/focus tooltip 写完整语义，如“3 个 session 等你决定；2 个正在运行”，避免只靠颜色。
- active 态只表示 overview 当前打开，不表示 Pet 正在运行。

### 2.2 Overview 区域划分

推荐在 Sidebar 右侧、TopBar 下方覆盖现有工作区。宽屏采用 60/40 左右分栏；左侧是确定性 world projection，右侧是 durable chat。窄桌面窗口可降为上下分区，但仍保留完整信息，不改成 mobile card 流。

```text
┌────────────────────────────── TopBar（保留）────────────────────────────────┐
├──────── Sidebar ────────┬──────────── Pet overview panel ───────────────────┤
│ [🐶 Pet]           [3]  │ Pet                                  刚刚同步  [×]│
│ ─────────────────────── │ 2 正在运行 · 3 等你决定 · 8 其它                 │
│ 新对话                  ├──────────────────────────────┬───────────────────┤
│ 搜索                    │ 等你决定  3                  │ Pet chat           │
│ 扩展                    │ ! Session B · AskUser   18s │ [durable messages] │
│ 自动化                  │   选择实现方案     [打开处理]│                   │
│ 凭证                    │ ! Session C · Write    42s │ Pet：B 等你选方案… │
│                         │   等待批准 Write   [打开处理]│ [打开 B]           │
│ 项目                    ├──────────────────────────────┤                   │
│  repo-a                 │ 所有工作                     │                   │
│   session A       ◌     │ ● A  running                │                   │
│   session B       •     │   正在运行 Bash · 刚刚       │                   │
│  repo-b                 │ ◐ D  queued (2)             │                   │
│                         │   队列中 · 1 分钟前           ├───────────────────┤
│                         │ ○ E  idle                    │ [问 Pet…]     [↑] │
│ Settings                │   最近活动 8 分钟前           │ model / stop       │
└─────────────────────────┴──────────────────────────────┴───────────────────┘
```

信息优先级对应上位设计 §2.2 的四个问题：

1. **我是谁？** 顶部显示唯一 Pet 的 avatar/name；Phase 1 不显示用户头像、账号或登录态。
2. **我有哪些工作？** “所有工作”使用 `SessionIndex` 列出全部非删除 session；archived/dormant 可折叠到“其它”。
3. **它们现在怎样？** 每行展示 state、模板化 summary、queue 与 freshness。
4. **什么需要主人？** pending section 固定置顶，且 badge 与该 section 使用同一 `PendingDecisionIndex` 派生，避免两个计数源。

### 2.3 分组与排序

建议固定顺序：

1. `waiting-decision`：pending section 单独置顶；session status 区仍保留对应行，避免用户误以为该 session 不属于全量列表。
2. `running`：按 `lastActivityAt` 降序。
3. `queued`：先按 queue 进入时间，再按 `queueDepth`；队列数字是该 session 内 turn queue，不是全局优先级。
4. `idle` / `dormant`：按最近活动降序，默认先显示最近 N 条，其余折叠。
5. `terminal`：最近完成/失败/取消；失败可提高到 running 之后，但不伪装成 pending decision。
6. `unknown`：紧邻原分组位置显示“状态未知”，并标陈旧时间；不可继续显示 running 动画。

默认不按 project 分组，因为用户问题是“全局在跑什么”；每行把 workspace display name 作为次要信息。可用 filter chips `全部 / 等我 / 运行中 / 最近完成`，Phase 1 不做复杂自定义排序。

## 3. Overview 面板内容设计

### 3.1 Header / 全局摘要

Header 包含：

- Pet avatar + display name；没有 account switcher。
- `X 正在运行 · Y 队列中 · Z 等你决定` 的确定性计数；不调用 LLM。
- projection freshness：“刚刚同步 / 2 分钟前 / 状态可能已过期”。
- worker 状态只显示可操作含义：“Worker 已回收，当前无运行中工作”或“Worker 连接中断，live 状态未知”；不把正常 idle 回收渲染成红色故障。
- 关闭按钮只关闭 overview，不停止 Pet、不删除 pet chat、不改变原 session。

### 3.2 Session 状态区

采用紧凑 `SessionStatusRow`，不是一 session 一大卡：

```text
[state icon]  Session title          [workspace]           [freshness] [>]
              正在运行 Bash          queue 0
```

字段：

- 主标题：`title`；重名时附 workspace 与 short id，符合上位设计 §11 的歧义处理建议。
- UI display state：`waiting-decision | running | queued | idle | dormant | terminal | unknown`。
- summary：只显示 host 投影给出的模板化安全摘要，如“模型处理中”“正在运行 Bash”“等待批准 Write”；不显示完整 command、tool args、tool output、reasoning 或 secret（上位设计 §3.1.2、§6.4）。
- queued：展示 `queueDepth`，例如“队列中 · 前方 2 个 turn”；不承诺预计完成时间。
- terminal：展示 `completed / failed / cancelled` 与时间；失败摘要仍需脱敏。
- freshness：相对时间 + source tooltip，例如 `live event @ 12:30:04`、`snapshot @ …`、`disk metadata @ …`。
- action：整行可打开 session；键盘 focus/Enter 等价。Phase 1 不提供 stop、direction、restart 或 approval button。

**数据模型对齐：**上位 `PetSessionProjection.runState` 中没有独立的 `waiting-decision`，它是 `phase`。UI 用以下只读映射，不改变 contract：

```text
pendingDecisionCount > 0 或 phase=waiting-decision
  → displayState=waiting-decision
否则按 runState=dormant|idle|queued|running|terminal|unknown 展示
```

颜色/动效约束：

- `running` 才用 spinner 或轻微 pulse；尊重 `prefers-reduced-motion`。
- `waiting-decision` 用高对比静态 attention dot + 文本，不用持续强闪。
- `queued` 用半填充圆，不冒充 running。
- `unknown` 用灰色断连符号，不沿用最后一次 running 的蓝色动画。
- 状态不能只靠颜色表达，必须同时有 label/aria-label。

### 3.3 Pending 决策区

`PendingDecisionSection` 聚合 tool approval 与 `AskUserQuestion`，每条为 navigation-only row：

```text
AskUser · Session B                         已等待 18s
选择实现方案                               [打开并处理]

Write · high risk · Session C               已等待 42s
等待批准 Write                             [打开并处理]
```

规则：

- 行内容只用 `PendingDecisionProjection.title/toolName/riskLevel/createdAt` 的脱敏字段。
- `AskUserQuestion` 显示 question 的可信截断摘要；不在 overview 渲染选择项或输入框。
- tool approval 可复用现有 `RiskPill` 视觉；不复用 `ApprovalCard` 的 action 区。
- CTA 永远是“打开并处理”，点击后 host 重新校验 session binding + request generation，再调用 Desktop 原有 session selection/navigation。
- 当前 `handleSelectSession` 已能选中 repo/session 并切回 chat（`packages/desktop/src/renderer/App.tsx:1381`、`packages/desktop/src/renderer/App.tsx:1405`）；Pet 需要的新增量是从 `agentSessionId` 安全解析到其 `repoId + uiSessionId`，不是复制 approval route。
- 打开后仍由原 session 的 `ApprovalCard` / `AskUserMessageView` 和 `window.codeshell.approve(...)` 完成决策；Pet 不构造 `ApprovalResult`。
- 若点击时 pending 已解决：打开 session 可以继续，但显示轻提示“该请求已处理”；不恢复旧按钮。
- 若 generation 已变或 worker 失联：仍可打开原 session，pending row 显示“状态已失联/已过期”，禁止任何 approval action。
- section 空态：“没有待你决定的事项”。不能用“Pet 已替你处理”。

### 3.4 Pet chat 区

Pet chat 是独立、durable 的 `pet orchestrator session` UI：

- 复用 `ChatView` 的 message stream、Markdown/tool rendering、composer、busy/stop、model controls 与受控 draft。
- 建议新增 `variant="pet"`，而不是套 `variant="quickChat"`：隐藏 workspace picker、Goal、普通 permission scope 等与 Pet host-owned tool contract 不相符的控件；保留 model、stop、附件能力与 Desktop chat 的可达演进位。具体控件集合需 implementation spec 再冻结。
- `PetChatHost` 持有固定 `petSessionId` / pet bucket；overview close、session navigation、Settings 覆盖都不触发 cleanup。
- 简单的 `get_global_status` / `list_pending` 应走 deterministic data action，不必调用模型；自然语言 chat 才进入 `dispatchToAssistant({type:"chat"})`（上位设计 §3.4.2）。
- assistant 回复中的 session action 采用结构化 action chip，例如 `[打开 Session B]`；不能从 Markdown 链接文字猜 session id。
- Phase 1 allowlist 仅含 `PetListSessions`、`PetGetSessionStatus`、`PetListPending`、`PetOpenSession`。UI 不出现 `PetSendDirection`、broadcast 或 “告诉 A …” 快捷按钮。
- Pet chat 不默认绑定任一 work session cwd，也不展示“完全访问”能让用户误解为全局 bypass；所有 host action 继续受窄 command contract 约束。

### 3.5 空态、加载态与失联态

| 场景 | UI 文案与行为 |
|---|---|
| 首次 snapshot 加载 | Header skeleton + 4–6 行 row skeleton；chat transcript 可独立 hydrate，不用一个全屏 spinner 锁住两边 |
| 没有任何 work session | “还没有工作会话。新建对话后，Pet 会在这里汇总。”；pet chat 仍可用 |
| 有 session、无 running/pending | “当前没有运行中的工作，也没有待决策事项”；显示最近 session，不把 worker 唤醒 |
| worker 正常 idle 回收/未启动 | 由 catalog + 确定性 projection 回答“无运行中工作”；不启动 Pet LLM 只为刷新 badge |
| worker 异常断开 | live session 变 `unknown`；pending UI 显示 stale，底层 projection 收束为 `cancelled/owner-lost`；保留 disk metadata 与打开 session action，禁用任何误导性处理动作 |
| projection 陈旧 | 顶部显示“状态可能已过期 · 最近同步 …”；每行保留 source/freshness，不继续动画 |
| Pet model/chat 失败 | chat 内给 retry；左侧确定性 session/pending 仍可用，符合上位设计 §6.5 |
| pending snapshot 对账中 | badge 可显示上次 count + subtle syncing；对账后以新 generation snapshot 为准，旧 pending 不保留为可处理项 |

## 4. 关键交互流

### 4.1 用户点 Pet 入口看全局

```text
User click PetSidebarEntry
  → 只执行 user-initiated openPetOverview()
  → shell 中央 overlay 打开，Sidebar/TopBar 保留
  → PetStateProvider 先显示最近 snapshot，再合并 push delta
  → pending 置顶；running/queued 次之；chat 恢复 durable transcript/draft
  → User close
  → 回到打开前的 session、scroll、dock tab，不销毁底层 UI
```

可用性细节：

- 打开后默认 focus overview heading，不抢到 chat composer；用户按 `/` 或点击输入框才进入 chat。
- 若入口因 aggregated peek 打开，自动滚到 pending section，但不 focus 任一批准控件——因为这里没有批准控件。
- `Esc` 关闭 overview；若 chat composer 有未发送 draft，关闭只隐藏并保留 draft，不弹“删除对话”。

### 4.2 非当前 session 出现 AskUser，15 秒后提醒并跳转

```text
Session B emits ApprovalRequest(toolName="__ask_user__")
  → host PendingDecisionIndex adds B/requestId immediately
  → attention timer starts（设计默认 15s）
  → 若 15s 内 resolved：取消 timer，不 surface
  → 若 B 已是当前 session 且 AskUser card 可见：只保留 L0，不发 L1
  → 否则 15s 后：Pet badge count +1，显示一次 L1 peek
  → User click single-item peek
  → re-check binding + request generation
  → close Pet overlay（若开着）并 handleSelectSession(B)
  → 原 AskUserMessageView 收集答案，原 approval route resolve
  → pending.resolved，badge -1；关闭 peek/row
```

说明：`N=15s` 是上位设计 §3.3 的 Phase 1 默认值，不是仓库现状。若产品希望 L0 即时、L1 延迟，可只调整 attention policy，不改变 pending index；本稿默认按任务指定流程在 grace 结束后同时 surface badge + peek。

### 4.3 Pet chat 问“现在都有什么在跑？”

```text
User → Pet chat: “现在都有什么在跑？”
  → dispatchToAssistant(chat)
  → Pet tool reads bounded SessionIndex/PendingDecisionIndex snapshot v42
  → response:
      “2 个 session 正在运行，1 个排队，3 个等你决定。”
      • Session A — 正在运行 Bash          [打开]
      • Session B — 等你选择实现方案       [打开并处理]
      • Session D — 队列中（2）            [打开]
  → 每个 action 携带结构化 agentSessionId + snapshotVersion
  → click 前重新校验；只导航，不代批
```

回答必须附 freshness，例如“状态更新于刚刚”；projection `unknown` 时明确说未知，不让模型补猜。Pet 不读取所有 transcript 来回答该问题。

### 4.4 多 pending 聚合

```text
B/C/D 在短窗口内先后 pending，且均越过 grace
  → L0 count 归约为 3
  → attention reducer 以 2s burst window 合并（设计默认）
  → 仅一条 L1：“3 个 session 等你决定”
  → click aggregated peek
  → 打开 Pet overview 并聚焦 pending section
```

单条 peek 点击直达原 session；多条 peek 点击 overview。关闭 peek 只写 receipt，不 resolve pending，badge 不变。

## 5. 通知呈现：L0 / L1

### 5.1 L0 badge

- 来源唯一：由 `PendingDecisionIndex` 派生的 `surfaceablePendingCount`（设计名，即 pending 且已越过 15s grace）；不从 DOM、当前 transcript 或 `approvalQueue.length` 另算。overview pending section 本身不受 grace 隐藏。
- 数字变化采用无位移的轻量过渡；不播放声音、不抖 Sidebar。
- `resolved/expired/cancelled/owner-lost` 从 count 移除。
- overview 打开或 pending row 被看见只写 `seenAt`，**不清零 badge**；只有 terminal transition 才减少。
- 系统 dock badge 使用同一 count。现状 dock badge 已由 renderer 调 `setBadgeCount(approvalQueue.length)`（`packages/desktop/src/renderer/App.tsx:4141`），main 再映射到 macOS dock / platform badge（`packages/desktop/src/main/index.ts:3894`）；Phase 1 应把数据源换成完整 PendingDecisionIndex，才能覆盖 AskUser 与 reconnect snapshot。

### 5.2 L1 Pet peek

推荐沿用现有 toast 的视觉位置：右下角、非模态、可关闭；当前 ToastProvider 位于 root，位置为 `bottom-4 right-4`（`packages/desktop/src/renderer/ui/ToastProvider.tsx:44`、`packages/desktop/src/renderer/ui/ToastProvider.tsx:85`）。Pet peek 结构：

```text
[dog] Session B 等你选择方案                  [×]
      AskUser · 已等待 15s
      [打开并处理]
```

但不能直接把现有 `useToast()` 当完整实现：当前 `ToastOptions` 只有 `message/variant/durationMs`，card click 只 dismiss，没有 action target 或 dedupe key（`packages/desktop/src/renderer/ui/toastState.ts:13`、`packages/desktop/src/renderer/ui/ToastProvider.tsx:129`）。建议新增 `PetPeekHost`，复用 Toast 的视觉 token/stack/aria-live，增加：

- `dedupeKey`、`action`、`onDismiss`、`createdAt`、aggregation payload；
- 单项 `open_session` 与多项 `open_pet_pending` 两种结构化 action；
- sticky 8–12s（设计建议）后自动关闭，pending badge 继续存在；
- keyboard focusable CTA，关闭按钮不触发 action；
- 文案脱敏，不展示 command、tool args、完整 question 或 secret。

### 5.3 去重、聚合与抑制

- dedupe key 沿用上位设计 §6.3：`(local-user, agentSessionId, requestId/correlationId, triggerKind)`。
- 每个 unresolved request 最多 surface 一次 L1；renderer remount 后从本地 receipt 恢复，不重复弹。
- 2 秒内多个 pending 合成一条；2 个及以上 pending 不逐条弹。
- 当前目标 session 已打开且原卡可见：L1 抑制，L0 保留。
- Settings、全屏演示、用户正在输入时是否进一步抑制属于 attention policy；Phase 1 至少保证不抢焦点。
- receipt 只记录脱敏 key、level、surfaced/seen/dismissed 时间；不存 prompt/tool args。

### 5.4 “绝不自动 L2”的前端约束

- projection / approval / stream event reducer 中**不存在** `setPetOverviewOpen(true)` 或等价 side effect。
- 只有三类显式用户动作可以打开 overview：点击 `PetSidebarEntry`、点击 aggregated peek、点击 Pet keyboard command（若后续提供）。
- 单 pending peek 默认直达原 session，也不先自动展开 Pet。
- worker reconnect、failure、pending burst、completion 都不能触发 overview open。
- Phase 1 不提供“自动打开完整 Pet”设置。L2 只在后续 opt-in 分期单独设计。

## 6. 组件与复用方案

### 6.1 组件树草图

```text
App / DesktopShell
└─ PetStateProvider                         # 全局、稳定挂载
   ├─ TopBar
   ├─ Sidebar
   │  └─ PetSidebarEntry
   │     ├─ dog asset
   │     └─ Badge
   ├─ WorkspaceRegion (relative)
   │  ├─ ExistingChatAndPanelTree           # overlay 下仍 mounted
   │  └─ PetOverviewPanel                   # global overlay，不属于 bucket
   │     ├─ PetOverviewHeader
   │     ├─ PetWorldPane
   │     │  ├─ PendingDecisionSection
   │     │  │  └─ PendingDecisionRow[]
   │     │  └─ SessionStatusSection
   │     │     └─ SessionStatusRow[]
   │     └─ PetChatPane
   │        └─ PetChatHost
   │           └─ ChatView variant="pet"
   └─ PetPeekHost
      └─ PetPeekToast[]
```

### 6.2 可直接复用

- `ChatView`：消息流、composer、busy/stop、model、Markdown/tool card 的桌面壳；Pet 通过新 `variant="pet"` 收窄控件。
- `transcriptsReducer` + `types.ts/applyStreamEvent`：durable pet session 的 renderer transcript 主路径。
- `Badge`：numeric pending count 与 `99+` 行为。
- dog asset：Pet 品牌识别。
- `RiskPill`：tool approval 风险展示，但只消费 host 给出的结构化 risk。
- `handleSelectSession` 的 navigation 结果：打开目标后切回原 chat。
- Toast 的位置、色彩、stack 与 aria-live 视觉规范；Pet action/dedupe 需新增 contract。

### 6.3 需抽取后复用，而非复制粘贴

- `SidebarItem` 当前是 `Sidebar.tsx` file-local function（`packages/desktop/src/renderer/Sidebar.tsx:357`）；建议抽成可带 avatar/subtitle/badge 的共享 primitive，或让 `PetSidebarEntry` 复用相同 class token。
- `SessionRow` 同样是 file-local，且 props 绑定 `SessionSummary` 与 archive action（`packages/desktop/src/renderer/Sidebar.tsx:559`）。建议抽取 status icon、row spacing、relative-time primitive；Pet row 自己消费 `PetSessionProjection`，不强行伪装成 `SessionSummary`。
- `ApprovalCard.summarizeRequest` 当前为组件内私有 helper，且可能回显 command/path（`packages/desktop/src/renderer/approvals/ApprovalCard.tsx:212`）。Pet 不直接复用；若抽取，必须另有 redacted/template mode，优先信任 PendingDecisionIndex 的 `title`。

### 6.4 必须新建

- `PetSidebarEntry`
- `PetOverviewPanel` / `PetOverviewHeader`
- `SessionStatusRow` / `SessionStatusSection`
- `PendingDecisionRow` / `PendingDecisionSection`
- `PetChatHost`（durable session lifecycle）
- `PetStateProvider` + projection/attention reducer
- `PetPeekHost`

这些是组件边界建议，不要求在 Phase 1 首次实现时引入新的第三方 state library。

## 7. 前端数据接线

### 7.1 现成数据能回答多少

| 数据 | 现状可用性 | Phase 1 UI 可回答 | 明确缺口 |
|---|---|---|---|
| renderer `sessionIndices` | App 从 localStorage project indices 初始化，并在特定空 index 场景从 disk backfill（`packages/desktop/src/renderer/App.tsx:480`、`packages/desktop/src/renderer/App.tsx:1720`） | title、project、UI/engine session binding、部分 recent sessions | 不是完整、跨重启可重建的全局 live projection；按 active repo 的 disk probe 不能当 Pet SessionIndex |
| protocol `query("sessions")` | core manager path 返回 live `sessionId/busy/queueDepth/lastActivityAt`（`packages/core/src/protocol/server.ts:1751`） | 哪些 worker session live、busy、queue depth | 只列 live；没有 title/workspace/phase/summary/pending/freshness source；renderer preload 现状没有窄 `querySessions()` API，不能直接调用 |
| session-tagged stream | core envelope 带 `sessionId + event`（`packages/core/src/protocol/types.ts:411`）；main 将 worker stream 转发为 snapshot/live IPC（`packages/desktop/src/main/agent-bridge.ts:268`、`packages/desktop/src/main/agent-bridge.ts:276`）；preload 再分发给 renderer（`packages/desktop/src/preload/index.ts:225`） | 对已知 session 增量判断 model/tool/turn complete/error | renderer 自己订阅全量 raw stream 会形成前端-only aggregator，断线/restart 后不可可靠重建；需要 host projection snapshot |
| `busyKeys` / sidebar status | `session_started` 置 busy，top-level `turn_complete/error` 清 busy（`packages/desktop/src/renderer/App.tsx:1887`、`packages/desktop/src/renderer/App.tsx:1943`）；App 归约 asking/running/unread（`packages/desktop/src/renderer/App.tsx:738`） | 当前 renderer 生命周期内的 per-bucket running/asking hint | 无 dormant/unknown/generation/source freshness；background child 与 main busy 语义不同；不是 Pet world truth |
| approval events | core request/resolved envelope 带 session/request（`packages/core/src/protocol/types.ts:417`、`packages/core/src/protocol/types.ts:429`）；preload 暴露 request/resolved listeners（`packages/desktop/src/preload/index.ts:600`） | 当前在线期间收 tool approval 与 AskUser | 没有跨 session read model/reconnect snapshot；resolver 不能暴露给 UI |
| renderer `approvalQueue` | tool approval 会入队（`packages/desktop/src/renderer/App.tsx:2274`） | 当前未解决 tool approval 数与卡片 | AskUser 在同一 request handler 中先写 transcript后 return，不进入该 queue（`packages/desktop/src/renderer/App.tsx:2192`、`packages/desktop/src/renderer/App.tsx:2245`），所以 `approvalQueue.length` 不能当 Pet badge |
| disk session APIs | preload 有 `listDiskSessions`，返回 id/engineSessionId/cwd/title/updatedAt/origin（`packages/desktop/src/preload/types.d.ts:1073`）；main handler 走 disk service（`packages/desktop/src/main/index.ts:3806`） | dormant catalog 与 metadata 的 prototype 来源 | 不能单独证明 live/pending；UI 不应自行把 disk + raw stream 拼成最终产品 projection |

补充现状：worker 由 Electron main 的 `AgentBridge` 按需承载，main 负责 child stdio 与 renderer IPC（`packages/desktop/src/main/agent-bridge.ts:1`、`packages/desktop/src/main/agent-bridge.ts:10`）。因此“没有 worker process”可能只是正常回收，不等于故障；UI 需要 host 给出明确 lifecycle/generation，而不是从 IPC 沉默猜测。

### 7.2 推荐 Phase 1 接线

遵循上位设计 §3.1 / §3.2 / §5.1：**host-side snapshot + push delta，renderer 只消费有界 projection。**

```text
disk session catalog ─┐
query("sessions") ────┼─> Local PetStateAggregator (Desktop main/host)
stream envelopes ─────┤      ├─ SessionIndex
approval req/resolved ┤      ├─ PendingDecisionIndex
worker generation ────┘      └─ attention receipts
                               │ snapshot + ordered delta
                               ▼
                         preload narrow API
                               │
                               ▼
                         PetStateProvider
                         ├─ Sidebar badge
                         ├─ Overview rows
                         └─ PetPeekHost
```

**设计建议（均为目标态，非现状 API）：**

- `window.codeshell.pet.getSnapshot()`：overview/provider mount 或 worker reconnect 时拿 `snapshotVersion + workerGeneration + sessions + pending + observedAt`。
- `window.codeshell.pet.onProjectionEvent(cb)`：接收 ordered session/pending/lifecycle delta。
- `window.codeshell.pet.dispatch(command)`：只允许上位设计 `get_global_status | list_pending | open_session | chat`；Phase 1 不暴露 `send_direction`。
- Pet chat 的 stream 仍通过 session-tagged主链路进入 `transcriptsReducer`，但 bucket 是固定 durable pet bucket。

**推测：**具体 API 名、IPC channel 与 aggregator 文件位置尚未在仓库中定义；implementation spec 应以现有 `window.codeshell.*` preload 边界落地，renderer 不能 runtime-import core（仓库指引 `CODESHELL.md:51`）。

### 7.3 订阅、轮询与恢复策略

- 产品路径用“一次 snapshot + push delta”；**不在 renderer 逐 session 轮询**，也不让 Pet LLM 扫 disk/transcript。
- host 可在 worker generation 变化时主动重新 query live snapshot 与 pending snapshot，并用 generation 对账。
- `query("sessions")` 是 live overlay 输入，不是 SessionIndex 全量来源；worker 不在线时由 disk catalog + 最近 terminal projection确定性回答“无运行中工作/状态未知”。
- 15s grace 与 relative freshness timer 只驱动呈现，不驱动数据真相。
- **推测：**若早期 spike 尚无 push channel，可短期在 host 轮询 live sessions；这只能是 Phase 0 验证手段，不能成为 renderer 产品架构。

### 7.4 最小数据 contract（UI 只读视角）

UI 直接消费上位设计字段，不另造竞争模型：

```ts
interface PetOverviewSnapshot {
  snapshotVersion: number;
  workerGeneration: number;
  observedAt: number;
  workerState: "active" | "reclaimed" | "disconnected" | "unknown";
  sessions: PetSessionProjection[];
  pending: PendingDecisionProjection[];
}
```

`workerState` 是 UI envelope 建议，不改变 `PetSessionProjection`；如 host 选择不同命名，应保持 reclaimed 与 disconnected 的语义可区分。

## 8. 状态管理与生命周期

### 8.1 状态归属

建议分三层：

| State | 归属 | 持久性 |
|---|---|---|
| `SessionIndex/PendingDecisionIndex/worker generation` | Desktop main/host `PetStateAggregator` 为 source；renderer provider 只保留 snapshot cache | 可重建，不当内容真相 |
| `petOverviewOpen/filter/scroll/focus` | renderer `PetStateProvider` / shell | open/scroll/focus 仅本次窗口临时；filter 可本地保存，避免重启后恢复 open 形成事实上的自动 L2 |
| pet chat transcript | durable pet core session；renderer 继续用 `transcriptsReducer` 投影 | durable transcript，不因 panel close 删除 |
| chat draft/model preference | provider/App 的受控 state +既有持久策略 | 跨 overview close；不得绑 QuickChat claim |
| notification receipts | host/local Pet metadata | 短期 durable，用于 remount 去重 |

### 8.2 为什么不继续堆在 `App.tsx`

`App` 已集中持有 transcripts、approval queue、busy sets、projects、view、session indices 与 quick chat state（`packages/desktop/src/renderer/App.tsx:407`、`packages/desktop/src/renderer/App.tsx:410`、`packages/desktop/src/renderer/App.tsx:416`、`packages/desktop/src/renderer/App.tsx:430`、`packages/desktop/src/renderer/App.tsx:526`）。Phase 1 可以让 `App` 只持有 `petOverviewOpen` 和 navigation adapter，但 projection/attention reducer 应进入独立 `PetStateProvider`，避免把跨 session world model 再耦合进 active-session state。

不要求 Redux/Zustand；一个 feature-local `useReducer + context` 足够。若事件频率证明 context 导致全 App 重绘，再考虑 `useSyncExternalStore`，不提前引入库。

### 8.3 挂载不变量

- `PetStateProvider` 和 `PetPeekHost` 必须位于 PetOverview 条件渲染之外；overview 关闭时仍需收 pending、更新 badge、跑 grace/dedupe。
- Pet overlay 打开时，现有 chat 与各 bucket `PanelArea` 保持 mounted，只改变可见性；当前 `PanelArea` 已明确依赖 mounted 状态保护 webview/terminal（`packages/desktop/src/renderer/panels/PanelArea.tsx:38`、`packages/desktop/src/renderer/panels/PanelArea.tsx:113`）。
- 进入 `settings_page` 不卸载 provider/subscriptions；沿用当前 hidden + overlay 模式，避免历史 early-return 坑。
- overview 自身可以 unmount，但其 durable chat state、draft、projection 和 receipts 不能由 overview component 局部拥有。
- listener 只注册一次并 cleanup；不能因 open/close 重订阅导致 duplicate peek。

## 9. Phase 1 验收口径与后续分期

### 9.1 Phase 1 UI 最小交付

1. Sidebar 顶部 `PetSidebarEntry`，numeric pending badge 与 active state。
2. 由用户点击打开的 overview panel；绝不 event-driven auto-open。
3. overview 三个核心区：pending、session status、durable pet chat。
4. status row 覆盖 running/queued/idle/dormant/terminal/unknown，`waiting-decision` 由 phase/pending 映射；有模板化 summary 与 freshness。
5. tool approval + AskUser 的聚合 pending list；只有“打开并处理”，无内联 approval/answer。
6. 单项与聚合 L1 peek、15s grace、receipt dedupe、当前 session 抑制。
7. 从 row/chat action/peek 打开原 session，并由原 route 完成处理。
8. host snapshot + push projection；worker reclaimed / disconnected / stale UI 正确。
9. pet chat 可问“现在都有什么在跑？”、列 pending、返回结构化 open action。
10. Settings/Pet open-close 不销毁现有 session chat、dock 或 pet chat transcript。

### 9.2 后续，不进入 Phase 1

- **L2 opt-in**：只有用户明确开启后才研究 auto-open 条件；默认仍关闭。
- **Pet Phase 2 direction UI**：对直属 running child 的 direction、delivery/ACK/progress；不得提前放灰按钮暗示 Phase 1 已支持。
- Desktop/Web parity 深化：让 future web 复用同一 Pet contract，并追平 Desktop 的 full chat/overview，而非降为 mobile remote 壳。
- richer personality/memory、quiet hours、per-session notification preference、completion digest。
- idle/dormant session 新 turn、IM push 等另行设计。

即使进入后续，也不因 Pet UI 自然扩展为 sibling mesh、Team、多数字人或 permission bypass；这些不属于本文路线。

## 10. 风险与 UI 缓解

| 风险 | UI 后果 | 约束 |
|---|---|---|
| projection 陈旧 | 把已结束说成 running，把已解决说成 pending | 显示 snapshotVersion/freshness；unknown 停动画；action 前重校验 |
| 只靠 renderer 增量事件 | remount 后漏卡/幽灵卡 | host snapshot + generation reconcile；renderer cache 非真相 |
| badge 从 `approvalQueue` 派生 | 漏掉 AskUser | badge 只从 PendingDecisionIndex 派生 |
| 直接复用 ApprovalCard | Pet 变成代批入口 | overview navigation-only；原 session 决策 |
| Pet chat 套 QuickChat lifecycle | 关闭 panel 删除 transcript | durable pet session；不 claim/cleanup/evict |
| Pet 注册进 PanelRegistry | 全局状态被 active bucket/cwd 污染 | shell-level global overlay，不注册 session dock |
| event handler 打开 overview | 演变为默认 L2、抢焦点 | reducer 无 open side effect；仅 user gesture |
| summary 泄漏命令/secret | 通知与全局页扩大暴露面 | host template + redaction；UI 不读 raw args/output |
| worker 回收被渲染成故障 | 常态红屏、用户不信任状态 | 区分 reclaimed 与 disconnected；确定性显示无运行中工作 |
| 同名 session | 打开错误目标 | row 显示 workspace/short id；structured action；歧义不猜 |

## 11. 需用户拍板的 UI 决策

按影响排序：

1. **Overview 的空间形态：中央覆盖式 panel，还是 Sidebar 内嵌展开？**  
   推荐中央覆盖式：保留 Sidebar/TopBar、覆盖 chat + dock、底层保持 mounted，能容纳高密度 world pane +完整 chat。Sidebar 内嵌宽度不足，容易退化为手机式单列。无论拍哪一个，都不改“侧栏常驻入口 + overview”总形态。

2. **badge 在 `0 pending` 时是否额外表达 running？**  
   numeric badge 的含义建议锁定为 pending 数；需拍板的是 `0 pending` 且有 running 时，avatar 是否加低对比 running dot。推荐先不加，避免双编码；overview header 再显示 running count。

3. **L1 peek 的位置与点击行为。**  
   推荐复用右下角 toast 位置；单项点击直达原 session，多项点击打开 Pet pending section。备选是贴 Sidebar Pet 入口的左上气泡，但更易挡项目列表，也与现有 toast stack 不一致。

4. **Pet chat 与普通 session chat 的视觉区分程度。**  
   推荐复用同一 `ChatView` 语言，只在 header/avatar、world-action chips、无 workspace/permission affordance 上区分；不要另造聊天视觉体系。需拍板 model control、附件、voice 在 MVP 是否全部露出。

5. **15s grace 内 badge 是否即时出现。**  
   本稿按任务指定流程把 L0 + L1 都放在 15s 后；若用户更重视零漏看，可改为 L0 即时、L1 延迟，数据与组件结构无需变化。

## 12. 自检与不变量

本文交付/后续实现必须同时满足：

- [x] 形态锁定为 Sidebar 顶部常驻入口 + overview panel；未采用独立顶层页、悬浮气泡或列表状态条。
- [x] Phase 1 单用户本地；UI 无登录、账号、租户或 ownership 控件。
- [x] 四问题映射完整：Pet identity、全部工作、runtime/summary/freshness、pending decisions。
- [x] pending 同时覆盖 tool approval 与 `AskUserQuestion`。
- [x] Pet overview/chat 只 read + navigate；没有 direction UI。
- [x] pending row/peek/chat action 只打开原 session；没有代批、代答或 permission bypass。
- [x] 通知仅 L0/L1；没有自动 L2，关闭/seen 不等于 resolved。
- [x] 不呈现 sibling mesh、Team、多数字人或 `teamId`。
- [x] Pet chat durable，不继承 QuickChat close/delete/fork 语义。
- [x] 主 stream reducer 锚定 `transcriptsReducer + types.ts/applyStreamEvent`。
- [x] Pet 是 global shell surface，不错误注册为 session-owned `PanelRegistry` tab。
- [x] worker 回收后可由确定性 projection回答“无运行中工作”；model failure 不拖垮 status/pending。
- [x] summary/peek 数据最小化，不复制 transcript、raw tool output、reasoning 或 secret。
- [x] Settings/Pet surface 不通过 early-return 卸载 subscription/chat/panel 树。
- [x] 所有“现状”锚点均来自本次仓库回读；未定义 API/落点已标为“设计建议”或“推测”。
