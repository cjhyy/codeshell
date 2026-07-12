# Pet Phase 1 分步实现计划

> 状态：**待实施 / 可进入逐步 Codex → review → commit 流水线**  
> 日期：**2026-07-12**  
> 范围：**单用户本地 Desktop，Pet Phase 1（read + chat + navigate + L0/L1）**  
> 上位设计：[`pet-top-level-agent-design.md`](./pet-top-level-agent-design.md)  
> Desktop UI：[`pet-desktop-ui-design.md`](./pet-desktop-ui-design.md)  
> 证据口径：本文的现状锚点已按当前仓库回读；所有尚不存在的文件/API/标识符均标为“预计/建议（推测）”。

## 0. 交付结论与硬边界

Phase 1 最终交付一个当前机器唯一的 Pet：它从可重建投影列出所有本地 work session 的状态与待决策事项，提供 durable `kind="pet"` 对话，并且只把用户导航到原 session 处理 approval / `AskUserQuestion`。Sidebar 入口采用已拍板的三项交互：

1. overview 是 **Sidebar 内嵌展开、可调宽的宽面板**，默认双栏，不覆盖或卸载主 chat；
2. avatar 有独立的低对比 running dot，和 pending 数字 pill 不同色、不同形、不同位置；
3. L1 使用右下角 toast peek；单条直达原 session，多条聚合后打开 overview pending 区。

所有步骤共同遵守以下红线：

- 仅实现隐式 `local-user → local-pet` 单用户本地形态；不加账号、登录、多租户、ownership 数据库或 per-user worker。`userId/owner` 只可作为固定值或可选扩展字段，不能形成产品能力。
- 仅保留 tree 内 Pet 与 work session 的父子概念；不做 sibling mesh、broadcast、Team、成员/角色、多数字人。
- **不实现 `PetSendDirection`**，不向 running child 发 direction，不为 Phase 2 提前放置可操作入口。
- Pet 只展示和导航；不代批、不代答、不构造 `ApprovalResult`，不绕过 target session 的 permission gate。
- 只做 L0/L1；projection、reducer、reconnect 或 pending 事件绝不能自动打开 overview（无 L2）。
- Pet projection 是可重建 runtime cache；disk transcript/state 仍是 session 内容真相，不复制所有 work transcript。
- YAGNI：不引入新的全局状态库、第二套 Engine、第二套 message bus、第二套 approval UI 或分布式事件存储。

## 1. 已核对的实现基线

- `ChatSessionManager` 的 live map、snapshot-safe iterator 与 idle sweep 分别位于 `packages/core/src/protocol/chat-session-manager.ts:45`、`:153`、`:244`；`ChatSession` 已提供 `isBusy()` 与 `queueDepth()`（`packages/core/src/protocol/chat-session.ts:178`、`:269`）。
- 当前 `query("sessions")` 只返回 live `sessionId/busy/queueDepth/lastActivityAt`（`packages/core/src/protocol/server.ts:1751`），不足以覆盖 disk-only、phase、summary、pending 与 freshness。
- session-tagged stream envelope 位于 `packages/core/src/protocol/types.ts:411`；可归约的 `stream_request_start`、`tool_use_start`、`turn_complete`、`context_compact` 位于 `packages/core/src/types.ts:512`、`:521`、`:530`、`:606`。
- 当前 `pendingApprovals` 仍是 resolver-only Map（`packages/core/src/protocol/chat-session.ts:64`）。tool approval 与 AskUser 的注册分别在 `packages/core/src/protocol/server.ts:2465`、`:2520`；response、cancel、close、disconnect/route fail-closed 的现有收束入口分别在 `:1143`、`:1216`、`:1460`、`:2899` / `:2940`。
- Desktop main 的 `AgentBridge` 是 process-global worker broker，并已经有 worker outbound tap、stream snapshot 与 lifecycle 事件（`packages/desktop/src/main/agent-bridge.ts:128`、`:150`、`:241`、`:307`、`:320`、`:834`）。这应成为 host aggregator 的接线点。
- disk catalog 已提供 top-level desktop/automation session 的 `id/cwd/title/updatedAt/origin`（`packages/desktop/src/main/sessions-service.ts:145`、`:167`）；Pet 不应让 renderer 自己拼 disk + raw stream。
- preload 现有 session-tagged stream、approval、lifecycle 与 disk list 接口（`packages/desktop/src/preload/types.d.ts:195`、`:693`、`:724`、`:728`、`:1075`），新增 Pet API 应继续走 `window.codeshell.*` 窄桥；renderer 不 runtime-import core。
- Sidebar 顶部 `<nav>`、固定宽度与 numeric badge primitive 位于 `packages/desktop/src/renderer/Sidebar.tsx:217`、`:218`、`:357`；dog asset 已由 `packages/desktop/src/renderer/App.tsx:7` 引入。
- `App` 当前通过 hidden shell + Settings overlay 保持普通树挂载（`packages/desktop/src/renderer/App.tsx:4419`、`:4425`、`:4852`），不能退回 `settings_page` early-return。现有 session navigation 在 `:1381`，dock badge 数据源仍是 `approvalQueue.length`（`:4141`）。
- durable chat 主路径是 `transcriptsReducer` + `applyStreamEvent`（`packages/desktop/src/renderer/transcriptsReducer.ts:53`、`:131`）；`ChatView` 现有 variant 只有 `main | quickChat`（`packages/desktop/src/renderer/ChatView.tsx:49`）。Quick Chat cleanup/evict 在 `packages/desktop/src/renderer/App.tsx:3478`、`:3622`，Pet 不得进入该生命周期。
- Toast root 的视觉位置是 `bottom-4 right-4`（`packages/desktop/src/renderer/ui/ToastProvider.tsx:44`、`:86`）；现有 toast contract 没有 Pet 所需的 action/dedupe，应做窄扩展或独立 host，而不是把 message 字符串当 action。

## 2. 目标 contract 与拆分原则

### 2.1 投影 contract

建议（推测）由 `packages/core/src/pet/types.ts` 定义并 type-only 共享：

- `PetSessionProjection.runState`：`dormant | idle | queued | running | terminal | unknown`；`waiting-decision` 保持为 `phase`，renderer 按 `pendingDecisionCount > 0 || phase === "waiting-decision"` 映射 display state，避免与上位设计竞争。
- `phase`：`model | tool | waiting-decision | compacting | finalizing`。
- `summary` 只由可信模板生成，例如“模型处理中”“正在运行 Bash”“等待批准 Write”；禁止 raw args、command、tool output、reasoning、prompt 或 secret。
- `freshness` 至少含 `source: disk | live-snapshot | live-event` 与 `observedAt`；worker 断开后 live running 变 `unknown`，不能继续动画。
- `PendingDecisionProjection.kind` Phase 1 只 surface `tool_approval | ask_user`。browser/credential/workspace 等内部 bridge wait 即使继续复用底层 Map，也必须标为 internal/non-surfaceable。

### 2.2 提交粒度

- 每步都应先提交测试，再提交最少实现；一个 step 的最终 commit 必须能单独 review、回滚，并且不依赖未提交的工作树状态。
- “涉及文件”是当前设计下的预计落点；新文件均为推测。实现时若仓库并行变更已提供等价落点，应复用等价文件并在 PR/commit 说明偏差，不能机械再造一份。
- 同一文件出现在多个 step 时，本文明确要求串行；尤其是 core 的 `server.ts/types.ts/index.ts`，以及 desktop 的 `App.tsx/Sidebar.tsx/main/index.ts/preload/*`。

## 3. 分步实现

### Step 01 — Core `SessionIndex` 纯投影与安全 summary（M）

**触碰范围：** `core`

**目标**

交付一个无 UI、可确定性测试的 `SessionIndex`：接受 owner-scoped disk catalog、live `query("sessions")` snapshot、session-tagged `StreamEvent` 与 worker lifecycle，产出覆盖 disk-only + live 的可重建 `PetSessionProjection[]`。Phase 1 owner 固定为 `local-user`，但 API 不把“全部进程状态”写死成未来多租户语义。

**涉及文件**

- `[core]` 预计新建 `packages/core/src/pet/types.ts`
- `[core]` 预计新建 `packages/core/src/pet/session-index.ts`
- `[core]` 预计新建 `packages/core/src/pet/session-index.test.ts`
- `[core]` 预计修改 `packages/core/src/index.ts`（只导出 Pet contract/index）

**依赖**

- 无；这是 core lane 起点。

**TDD 测试点**

1. disk catalog 中无 live overlay 的 work session 归约为 `dormant`，且读取 catalog 不创建/resume Engine。
2. live `busy=false`、`queueDepth>0`、`busy=true` 分别归约为 `idle`、`queued`、`running`；pending 可把 phase 覆盖为 `waiting-decision`。
3. `stream_request_start/tool_use_start/context_compact/turn_complete/error` 按顺序归约 phase、terminal、queue；旧 snapshot/event 不能倒灌覆盖新版本。
4. summary 只保留 tool name/固定模板，去换行、限长；带 command、args、output、token-like secret 的事件不进入 summary。
5. worker disconnect 将 live running 标为 `unknown`，保留 disk metadata/freshness；reclaimed 且无 live 工作与异常 disconnected 可区分。
6. owner filter 只接受调用方提供的 `local-user` catalog；`kind="pet"`、ephemeral、sub-agent 不出现在 work projection。

**验收**

- 给定同一 catalog + snapshot + event 序列，输出完全确定、排序稳定、可从空内存重建。
- 覆盖 `dormant/idle/queued/running/waiting-decision/terminal/unknown` 的 contract 测试通过。
- 没有新增账号/login/Team/direction；没有 raw 敏感数据字段。

**本步边界**

只建只读投影；owner 是固定本地扩展位，不实现 ownership/AuthZ。不得加入 session-to-session route、direction 或 approval action。

---

### Step 02 — 结构化 pending entry 与 `PendingDecisionIndex` 生命周期（M）

**触碰范围：** `core`

**目标**

把 resolver-only `pendingApprovals` 演进为“resolver + 只读 metadata”的结构化 entry，并新增跨 session `PendingDecisionIndex`。所有 user-visible tool approval 与 `AskUserQuestion` 都必须有 created → terminal 的完整、幂等生命周期；resolver 永不进入 snapshot/renderer。

**涉及文件**

- `[core]` 预计新建 `packages/core/src/pet/pending-decision-index.ts`
- `[core]` 预计新建 `packages/core/src/pet/pending-decision-index.test.ts`
- `[core]` 预计修改 `packages/core/src/protocol/chat-session.ts`
- `[core]` 预计修改 `packages/core/src/protocol/server.ts`
- `[core]` 预计修改 `packages/core/src/protocol/types.ts`
- `[core]` 预计新增/修改生命周期测试：`packages/core/src/protocol/server.pet-pending.test.ts`（推测）及现有 cancel/AskUser 测试
- `[core]` 预计修改 `packages/core/src/index.ts`

**依赖**

- Step 01 的共享 projection/types。

**TDD 测试点**

1. tool approval metadata 包含 `kind/title/toolName/riskLevel/createdAt/sessionId/requestId/routeGeneration`；AskUser 明确归类为 `ask_user`，不由 description 猜。
2. `__browser_action__`、`__credential_action__`、`__workspace_action__` 等内部等待不进入 Pet surfaceable index。
3. response、timeout、Stop/cancel、explicit close、server close、approval owner disconnect 分别产生一次 terminal transition；重复 terminal event 幂等。
4. AskUser 无普通 wall-clock timeout的现状保持不变；goal AskUser timeout 会终结 index，不能留幽灵 pending。
5. session A 的 response 不能 resolve session B 同 requestId；stale route generation fail closed。
6. snapshot 序列化不包含 resolver、question options、raw args 或完整 command；AskUser title 可信截断，tool title 使用模板。

**验收**

- 跨 session snapshot 能同时列出 tool approval + AskUser，且每条都有结构化、脱敏 metadata。
- 所有指定 terminal 路径结束后 `status !== "pending"`；worker/owner 失联时不可继续作为可审批项。
- 原 session 的 approve/AskUser route 仍是唯一 resolver 路径，现有 permission gate 行为不变。

**本步边界**

Pet index 只读；不得增加 Pet approve/answer 方法。`owner-lost` 可保留为 contract 扩展值，但 Phase 1 只使用本地 disconnect/cancel 语义，不实现多用户 lease。

---

### Step 03 — Core projection snapshot、ordered delta 与 reconnect 对账协议（M）

**触碰范围：** `core`

**目标**

把 `SessionIndex` / `PendingDecisionIndex` 通过窄 worker 协议暴露为“一次 snapshot + ordered delta”。复用当前 `query("sessions")` live snapshot builder 与同一条 session-tagged stream，不把 raw 全量事件直接交给 Pet renderer；reconnect 后以新 generation snapshot 对账。

**涉及文件**

- `[core]` 预计修改 `packages/core/src/protocol/types.ts`
- `[core]` 预计修改 `packages/core/src/protocol/server.ts`
- `[core]` 预计修改 `packages/core/src/protocol/client.ts`
- `[core]` 预计修改 `packages/core/src/protocol/chat-session-manager.ts`（只增加只读 snapshot/generation accessor；推测）
- `[core]` 预计新建 `packages/core/src/protocol/server.pet-projection.test.ts`
- `[core]` 预计修改 `packages/core/src/index.ts`

**依赖**

- Step 01、Step 02。

**TDD 测试点**

1. `getPetProjectionSnapshot`（建议名，推测）返回 `snapshotVersion/observedAt/sessions/pending`，不返回 resolver/raw stream/tool args。
2. snapshot 与 delta 使用单调 version；先订阅再取 snapshot或 snapshot+cursor 的握手不会漏事件，也不会双应用。
3. worker reconnect/generation 提升后，snapshot 中不存在的旧 pending 被终结；旧 generation 迟到 event 被丢弃。
4. disconnect 时 running → unknown、pending → cancelled/stale；reconnect snapshot 可以恢复真实 live state。
5. 现有 `query("sessions")` 返回兼容；Pet snapshot 复用相同 live builder，不形成第二套 busy/queue 真相。
6. 多 session stream 归约保持 session isolation；一个 session 的 event 不改变另一个 projection。

**验收**

- 一个新 host 仅靠 snapshot + 后续 delta 可恢复与持续维护两个 index。
- worker 重启/断线/idle eviction 测试无幽灵 running、无幽灵 pending。
- 旧 client/query 行为不回归，renderer 仍无需 runtime-import core。

**本步边界**

协议只暴露单用户本地有界投影；不暴露裸 resolver、磁盘路径或任意跨 session mutation。没有 Team、direction、approval response API。

---

### Step 04 — Durable `kind="pet"` session 身份与安全 run profile（M）

**触碰范围：** `core + desktop-main`（两者；desktop 仅做普通 work catalog 排除）

**目标**

让 pet chat 使用正常、durable 的 core session，但持久标记 `kind="pet"`，与 `work`/ephemeral quick chat 生命周期隔离。新增 `pet` run profile 时默认不暴露 workspace mutation、Agent/direction 或 permission-bypass affordance；恢复已有 pet session 时 kind 不可被 client 改写。

**涉及文件**

- `[core]` 预计修改 `packages/core/src/types.ts`（`SessionKind`/`SessionState.kind`，旧数据默认 `work`）
- `[core]` 预计修改 `packages/core/src/session/session-manager.ts`
- `[core]` 预计修改 `packages/core/src/engine/run-types.ts`
- `[core]` 预计修改 `packages/core/src/engine/engine.ts`
- `[core]` 预计修改 `packages/core/src/protocol/types.ts`
- `[core]` 预计修改 `packages/core/src/protocol/server.ts`
- `[core]` 预计新建 `packages/core/src/session/session-manager.pet.test.ts`
- `[core]` 预计新建 `packages/core/src/engine/engine.pet-behavior.test.ts`
- `[desktop-main]` 预计修改 `packages/desktop/src/main/sessions-service.ts` 测试/过滤逻辑（仅确保 pet 不出现在普通 work catalog；如 Step 06 统一过滤则此处不改实现）

**依赖**

- Step 01；为避免 `types.ts/server.ts` 冲突，实际落地必须排在 Step 03 之后。

**TDD 测试点**

1. 新建 pet session 写入 `state.json.kind="pet"`，关闭/重启后能 resume；旧 session 缺 kind 时归为 `work`。
2. 已有 work session 不能通过新 run 参数变成 pet，已有 pet 也不能变成 work。
3. pet session 不被普通 disk work catalog / `SessionIndex` 列为 work session，也不采用 `qchat-*` namespace/claim/cleanup。
4. pet profile 不暴露 Write/Edit/Bash/Agent/permission scope/direction 类能力；仍保留 normal permission choke point，不能设置 bypass。
5. pet session transcript 正常持久化用户与 assistant 消息，Stop/模型错误仍走标准 lifecycle。

**验收**

- pet chat 关闭 UI 后 transcript/session 仍在，应用重启可 hydrate。
- quick chat stale cleanup 不会删除 pet session，普通 Sidebar session 列表不会出现 Pet 自己。
- 没有第二台 Engine 或特殊 permission controller。

**本步边界**

`kind="pet"` 是本地 session 分类，不是账号 ownership。profile 不包含 `PetSendDirection`，也不能通过“Pet”身份获得额外工具权限。

---

### Step 05 — Desktop 纯展示组件与状态语言（M）

**触碰范围：** `desktop-renderer`

**目标**

先完成不接 IPC、不碰 `App.tsx/Sidebar.tsx` 的纯 renderer 组件：overview header、紧凑 session row、pending navigation-only row，以及加载/空/worker reclaimed/disconnected/stale 状态。它们只消费投影 props，便于与 core 后半段并行。

**涉及文件**

- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetOverviewHeader.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/SessionStatusSection.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PendingDecisionSection.tsx`
- `[desktop-renderer]` 预计新建对应 `*.test.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/i18n/ns/pet.ts`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/i18n/dict.ts`

**依赖**

- Step 01 的 type contract；可与 Step 02–04 并行实现，合入时避开 `dict.ts` 的其他并行改动。

**TDD 测试点**

1. display state 映射覆盖 waiting/running/queued/idle/dormant/terminal/unknown，并有文本/`aria-label`，不只靠颜色。
2. running 才有动效，unknown 停止动画；`prefers-reduced-motion` 下无强制 pulse。
3. summary/freshness/workspace/short id 正确截断；不渲染 raw args/output。
4. pending row 只有“打开并处理”，没有 approve/deny/options/input；可复用 `RiskPill`，不可复用完整 `ApprovalCard` / `AskUserMessageView`。
5. 加载 skeleton、无 session、无 pending、reclaimed、disconnected、stale、对账中各有独立文案；Pet chat failure 不遮蔽左侧数据区。

**验收**

- 纯 props 测试可渲染全部设计状态；组件无需 `window.codeshell`、无需 App context。
- 视觉密度是 row/list，不退化成大卡片墙或 mobile card flow。

**本步边界**

纯展示，无导航副作用、无 approval、无 direction、无账号 UI。所有文案遵守数据最小化。

---

### Step 06 — Desktop main `PetStateAggregator`（M）

**触碰范围：** `desktop-main`

**目标**

在 Electron main/host 实例化可重建 Pet 聚合器：disk catalog 作为全量基线，worker projection snapshot/delta 作为 live overlay；由 `AgentBridge` 提供 worker lifecycle/generation，正常未启动/回收与异常断线语义分开。没有 worker 时只读 disk，绝不为了 badge 启动 Pet LLM/worker。

**涉及文件**

- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-state-aggregator.ts`
- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-state-aggregator.test.ts`
- `[desktop-main]` 预计修改 `packages/desktop/src/main/agent-bridge.ts`（只读 request/lifecycle subscription seam）
- `[desktop-main]` 预计修改 `packages/desktop/src/main/index.ts`（process-global aggregator bootstrap）
- `[desktop-main]` 读取并复用 `packages/desktop/src/main/sessions-service.ts`；仅在现有 catalog 缺字段时预计修改

**依赖**

- Step 03、Step 04；Step 05 不阻塞。

**TDD 测试点**

1. 无 worker：分页读取完整 disk catalog，产出 dormant/terminal metadata，不触发 `spawnChild`。
2. worker ready：拉 snapshot 后按 `engineSessionId` 叠加 live；ordered delta 单调应用。
3. worker normal exit/reclaimed 与 crash/gave_up 映射不同；crash 后 running unknown，pending 不可处理。
4. generation 变化先进入 reconciling，再用新 snapshot 替换；旧 generation delta 丢弃。
5. disk 删除/session close 后不留幽灵 projection；pet/ephemeral/sub-agent 不进入 work list。
6. summary/title/cwd 组合时只把 workspace display name交给 renderer，不暴露不必要绝对路径。

**验收**

- main 内存在唯一 source of truth，可向任意 renderer window提供相同 snapshot。
- renderer remount、worker restart、idle eviction 后状态可恢复；没有 renderer-only aggregator。

**本步边界**

固定 `local-user`，不建账号/tenant/跨 worker fan-out。聚合器无 mutation route，不审批、不发 direction。

---

### Step 07 — Main ↔ preload ↔ renderer 窄 Pet bridge（S）

**触碰范围：** `desktop-main + desktop-preload`

**目标**

暴露 `window.codeshell.pet.getSnapshot()` 与 `onProjectionEvent()`（建议名，推测），只传有界 typed projection。IPC handler 与 listener 必须支持多窗口、unsubscribe、renderer remount，不能把 core resolver/raw worker line 暴露出去。

**涉及文件**

- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-ipc.ts`
- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-ipc.test.ts`
- `[desktop-main]` 预计修改 `packages/desktop/src/main/index.ts`
- `[desktop-preload]` 预计修改 `packages/desktop/src/preload/index.ts`
- `[desktop-preload]` 预计修改 `packages/desktop/src/preload/types.d.ts`
- `[desktop-preload]` 预计新增 `packages/desktop/src/preload/pet-contract.test.ts`（推测）

**依赖**

- Step 06。

**TDD 测试点**

1. snapshot schema 只含 version/generation/workerState/sessions/pending/observedAt。
2. ordered delta 透传一次；unsubscribe 后不再触发；重复订阅不会共用错误 listener。
3. 非法 command/channel payload 在 main 边界拒绝；renderer 无法请求 raw transcript/args/resolver。
4. renderer reload 后新 subscriber 先拿 snapshot，再从 cursor 接 delta，无漏/重。

**验收**

- 一个最小 renderer harness 能取 snapshot、订阅更新、正确 unsubscribe。
- preload 类型与实际 expose 对齐，未增加 renderer runtime core import。

**本步边界**

此步只读；不提前暴露 `send_direction`、approve 或任意 `coreSessionId` mutation。

---

### Step 08 — 稳定挂载的 `PetStateProvider` 与 renderer reducer（M）

**触碰范围：** `desktop-renderer`

**目标**

建立 feature-local `useReducer + context`，一次订阅 Pet bridge，持有 snapshot cache、overview open/filter/focus、chat draft 等 renderer state。Provider 挂在普通 App 之外且只在主窗口启用，Settings/Pet overview open-close 不会销毁 subscription 或 durable chat state。

**涉及文件**

- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/petStateReducer.ts`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/petStateReducer.test.ts`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetStateProvider.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetStateProvider.test.tsx`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/main.tsx`

**依赖**

- Step 07；可复用 Step 05 组件但不依赖其视觉完成。

**TDD 测试点**

1. snapshot hydrate + ordered delta reducer；gap/generation mismatch 触发 re-snapshot，不猜状态。
2. StrictMode 下 listener 仍只有一个有效实例，cleanup 完整。
3. overview close 只改可见性；projection、draft、pet transcript holder 不清空。
4. Settings overlay/返回不重建 provider；测试明确防止 `settings_page` early-return 回归。
5. projection event reducer 没有 `openOverview` side effect；只有显式 user action可打开。

**验收**

- Provider 在 overview 未打开、Settings 打开时仍持续接收 pending/running 更新。
- 不引入 Redux/Zustand；无重复 subscription/peek 的生命周期基础问题。

**本步边界**

Provider 只维护本地单用户 view state；绝不根据 event 自动 L2，不含 approval/direction。

---

### Step 09 — Sidebar Pet 入口 + 可调宽内嵌 overview shell（M）

**触碰范围：** `desktop-renderer`

**目标**

交付第一块可见闭环：Sidebar `<nav>` 第一项 Pet，pending numeric pill、独立 running dot、完整 tooltip；点击后在 Sidebar 右侧内嵌展开可调宽宽面板，主 chat/PanelArea 仍 mounted 且并排可见。关闭恢复此前 session/scroll/dock，不停止 Pet。

**涉及文件**

- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetSidebarEntry.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetSidebarEntry.test.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetOverviewPanel.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetOverviewPanel.test.tsx`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/Sidebar.tsx`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/App.tsx`
- `[desktop-renderer]` 复用现有 `packages/desktop/src/renderer/assets/codeshell-dog-icon.png`，不新增品牌 asset

**依赖**

- Step 05、Step 08。

**TDD 测试点**

1. Pet 固定为 `<nav>` 第一项；pending 0 隐藏、1–99 原样、>99 为 `99+`。
2. running dot 与 pending pill 可同时出现，CSS/DOM 位置、shape、颜色 token不同；tooltip 同时朗读 pending/running 数。
3. 点击/Enter 打开，Esc/close 关闭；active 只代表 overview open。
4. resize 有 min/max clamp、持久宽度；默认宽度足以承载双栏，窄窗口才降级单列。
5. panel 是 Sidebar sidecar/expanded region，不注册 `PanelRegistry`，不覆盖主 chat；open/close 不卸载底层 chat/PanelArea。
6. projection update、reconnect、pending burst 不会调用 open。

**验收**

- 用户手势可打开/调整/关闭宽面板；底层 session state 与 dock state前后一致。
- 已拍板三决策中的 overview 形态与 running dot 完整落地。

**本步边界**

入口无 account switcher、Team、direction。overview 只能由 user gesture 打开；不实现 L2。

---

### Step 10 — Overview world pane：session/pending/空态/离线态（M）

**触碰范围：** `desktop-renderer`

**目标**

把 Step 05 纯组件接入 Provider：左栏 pending 固定置顶，session 按 waiting/running/queued/idle-dormant/terminal/unknown 排序；右栏暂留 Pet chat slot。Header 展示确定性计数与 freshness，完整覆盖加载、空、reclaimed、disconnected、stale、reconciling。

**涉及文件**

- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/pet/PetOverviewPanel.tsx`
- `[desktop-renderer]` 预计修改 Step 05 的 header/session/pending components
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/petSelectors.ts`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/petSelectors.test.ts`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/App.tsx`（只传 navigation adapter 的预留 prop；若 Step 11 再接则本步不改）

**依赖**

- Step 09。

**TDD 测试点**

1. pending section 即时列出全部 pending，不受 15s grace 隐藏；Sidebar count 另用 surfaceable selector。
2. waiting session 在 pending 与全量 session 两处均存在；列表排序和同名 session workspace/short id disambiguation稳定。
3. Header 的 running/queued/pending 与同一 snapshot 派生，不调用 LLM、不从 DOM/approvalQueue另算。
4. reclaimed 显示“无 live 工作/worker 已回收”而非红色故障；disconnected 显示 unknown/stale，停止 running animation。
5. 首次 loading 不锁住右侧 chat slot；无 work session 时 Pet chat slot仍可用。

**验收**

- 给任一合法 snapshot，用户能回答“有哪些工作、现在怎样、什么等我决定、状态多新”。
- UI 不显示完整 command、question options、tool output 或 secret。

**本步边界**

world pane 仍是只读；不加 stop/restart/direction/approve 按钮，不自动打开面板。

---

### Step 11 — 安全导航：row/pending → 原 session（S）

**触碰范围：** `desktop-main + desktop-preload + desktop-renderer`

**目标**

为 session row 与 pending CTA 增加结构化导航。main/host 在点击时重新验证 session 仍属于当前本地 catalog、pending request generation仍匹配，再返回 `repoId + uiSessionId` 或 stale 结果；renderer 复用 `handleSelectSession`，关闭 overview并进入原 chat。

**涉及文件**

- `[desktop-main]` 预计修改 `packages/desktop/src/main/pet/pet-ipc.ts`
- `[desktop-main]` 预计修改 `packages/desktop/src/main/pet/pet-state-aggregator.ts`
- `[desktop-preload]` 预计修改 `packages/desktop/src/preload/index.ts`
- `[desktop-preload]` 预计修改 `packages/desktop/src/preload/types.d.ts`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/petNavigation.ts`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/petNavigation.test.ts`
- `[desktop-renderer]` 预计修改 pending/session row components 与 `packages/desktop/src/renderer/App.tsx`

**依赖**

- Step 10。

**TDD 测试点**

1. valid structured `agentSessionId + snapshotVersion/requestId/generation` 解析到正确 repo/session，调用一次 `handleSelectSession`。
2. 点击前已 resolved：仍可打开 session，但提示“该请求已处理”；不恢复旧 pending action。
3. generation 变化/worker disconnect：允许打开 durable session，返回 stale；不提供 approval action。
4. 同名 title 不参与身份判断；不存在/删除/ephemeral/pet target fail closed。
5. renderer 不能通过 Markdown 文本或裸 title 猜 session id。

**验收**

- 从普通 row 与 pending CTA 均能到原 session；后续回答/批准只发生在原 `ApprovalCard` / `AskUserMessageView`。
- Pet 代码中没有 `window.codeshell.approve(...)` 或 `ApprovalResult` 构造。

**本步边界**

只导航，不代批、不代答、不发 direction。Phase 1 本地校验不升级为账号 ownership。

---

### Step 12 — `LocalPet` metadata 与 allowlisted dispatch backend（M）

**触碰范围：** `desktop-main + desktop-preload`

**目标**

在 Desktop main 建立唯一 `LocalPet`（固定 `local-user/local-pet` + durable `petSessionId`）与 `dispatchToAssistant` 后端。Phase 1 allowlist 仅为 `chat | get_global_status | list_pending | open_session`；`chat` 使用固定 pet session、安全 profile 与有界 world snapshot，其他三个走确定性 host action。

**涉及文件**

- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-metadata-store.ts`
- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-metadata-store.test.ts`
- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-dispatch-service.ts`
- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-dispatch-service.test.ts`
- `[desktop-main]` 预计修改 `packages/desktop/src/main/agent-bridge.ts`（host request/await result，不造第二 worker）
- `[desktop-main]` 预计修改 `packages/desktop/src/main/pet/pet-ipc.ts` 与 `packages/desktop/src/main/index.ts`
- `[desktop-preload]` 预计修改 `packages/desktop/src/preload/index.ts`、`packages/desktop/src/preload/types.d.ts`

**依赖**

- Step 04、Step 07、Step 11。

**TDD 测试点**

1. 首次启动原子创建 metadata，后续启动复用同一 `petSessionId`；损坏文件 fail closed 后可重建，不删除 work session。
2. `chat` 只向现有 process-global worker发送一个 `agent/run`，参数固定 `kind="pet"` / pet behavior / host-owned cwd；不使用 quick-chat claim/cleanup。
3. world snapshot 有条数/长度上限与 freshness，只含 title/workspace/state/safe summary/pending metadata；不注入 transcript/raw args/secret。
4. `get_global_status/list_pending` 不调用 LLM；`open_session` 复用 Step 11 revalidation。
5. `send_direction`、broadcast、approve、teamId、任意 session mutation command 均返回结构化 `unsupported-in-phase-1`。
6. Pet model失败不影响 deterministic snapshot/pending/open。

**验收**

- 同一机器始终得到同一 durable pet session；普通 chat 可走现有 Engine/stream/permission lifecycle。
- allowlist 外命令不可达；不存在第二套 Engine、permission controller 或 worker。

**本步边界**

LocalPet metadata 不是账号表；不实现跨用户/Team/direction。Pet chat 文本不等于 user consent，不能改变 target permission。

---

### Step 13 — `PetChatHost` + `ChatView variant="pet"` + 结构化 action（M）

**触碰范围：** `desktop-renderer`

**目标**

在 overview 右栏接入 durable pet chat。Provider 持有固定 pet bucket 的 transcript/draft/model/busy，即使 overview unmount 或 Settings 覆盖仍保留；消息继续走 `transcriptsReducer`。一般自然语言 chat 进入 Step 12；“全局状态/列 pending”可用确定性快捷 action，返回结构化 open chips。

**涉及文件**

- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetChatHost.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetChatHost.test.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetActionChip.tsx`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/ChatView.tsx`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/ChatView.composer-variant.test.tsx`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/pet/PetStateProvider.tsx`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/pet/PetOverviewPanel.tsx`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/App.tsx`（navigation adapter）

**依赖**

- Step 12。

**TDD 测试点**

1. `variant="pet"` 保留 message stream、Markdown、composer、model、stop；隐藏 workspace picker、Goal、普通 permission scope与 direction UI。
2. pet stream 只进固定 pet bucket；work session stream 不串入，反之亦然。
3. overview close/reopen、session navigation、Settings round-trip 后 transcript/draft 不丢；没有 `cleanupQuickChatSession` / `evict`。
4. app 重启从 durable pet transcript hydrate；busy/Stop 走 pet session id。
5. deterministic status/pending action 不需要 LLM；自然语言 chat 回答附 freshness/unknown，不从旧状态猜。
6. action chip 携带 typed `agentSessionId + snapshotVersion`，点击走 Step 11；不解析 Markdown label，不出现 `PetSendDirection`。

**验收**

- 用户可持续和 Pet chat，对话关闭/重开/重启仍在；能问全局、列 pending、点击打开目标 session。
- 左侧 deterministic world pane 在 Pet model失败时仍正常工作。

**本步边界**

Pet chat 不绑定 work cwd，不提供“完全访问”暗示，不允许 direction/approve。确定性 data action 与 durable LLM chat 共用同一 UI，但不伪造 permission consent。

---

### Step 14 — L0/L1 attention：15s grace、receipt dedupe、toast peek（M）

**触碰范围：** `desktop-main + desktop-preload + desktop-renderer`

**目标**

完成通知闭环：`surfaceablePendingCount` 在 pending 持续 15s 后驱动 Sidebar/dock badge；每个 request 最多一次 L1；2s burst 聚合；当前 active target session 抑制 L1。右下角单条 peek 直达 session，多条打开 overview并聚焦 pending。dismiss/seen 只写 receipt，不 resolve pending。

**涉及文件**

- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-attention-policy.ts`
- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-attention-policy.test.ts`
- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-receipt-store.ts`
- `[desktop-main]` 预计修改 `packages/desktop/src/main/pet/pet-ipc.ts`
- `[desktop-preload]` 预计修改 `packages/desktop/src/preload/index.ts`、`packages/desktop/src/preload/types.d.ts`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetPeekHost.tsx`
- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/pet/PetPeekHost.test.tsx`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/ui/toastState.ts`、`ToastProvider.tsx`（增加 typed action/dedupe，或复用视觉 token 的独立 stack；二选一，推测）
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/App.tsx`（active session上报 + dock badge数据源）

**依赖**

- Step 11、Step 13。

**TDD 测试点**

1. fake clock：created 后 14.999s 无 L0/L1；15s仍 pending 才进入 count并 surface；grace 内 resolved 不提示。
2. receipt key 为 `(local-user, agentSessionId, requestId, triggerKind)`；renderer remount/app restart 不重复 peek。
3. 2s 内 2+ pending 只产生一条聚合 peek；单条 action=`open_session`，多条 action=`open_pet_pending`。
4. 当前 active target session 抑制 L1但保留 L0；切走后同一 request 不因 receipt错误重复。
5. dismiss/timeout 只关闭 peek、写 receipt；badge 仅在 pending terminal transition 时下降。
6. dock badge 改用同一 `surfaceablePendingCount`，不再用 `approvalQueue.length`，因后者漏 AskUser。
7. projection/reconnect/pending burst 不打开 overview；只有点击 aggregated peek 才打开并滚到 pending。
8. peek 脱敏、可键盘操作、关闭按钮不触发 action、不抢 composer focus。

**验收**

- L0 与 L1 共享唯一 count/policy truth；tool approval + AskUser 都覆盖。
- 已拍板的右下角、单条直达、多条聚合行为完整；全程无自动 L2、无代批。

**本步边界**

通知只在 app 内，默认无声音、无 IM push、无 L2。receipt 不存 prompt/tool args/secret，也不代表 pending 已解决。

---

### Step 15 — 全链路生命周期、a11y 与边界回归收口（S）

**触碰范围：** `core + desktop`（两者，以测试/必要 wiring 修复为限）

**目标**

用集成测试锁死 Phase 1 不变量，修复仅在联调中暴露的 wiring 问题；不增加新能力。重点覆盖 app/renderer/worker restart、Settings、overview resize、navigation、notifications 与 Pet chat 的组合生命周期。

**涉及文件**

- `[desktop-renderer]` 预计新建 `packages/desktop/src/renderer/AppPet.test.tsx`
- `[desktop-main]` 预计新建 `packages/desktop/src/main/pet/pet-lifecycle.integration.test.ts`
- `[core]` 预计补充 `packages/core/src/protocol/server.pet-projection.test.ts`
- `[desktop-renderer]` 预计修改 `packages/desktop/src/renderer/narrow-layout.smoke.test.tsx`
- `[core/desktop]` 若测试暴露 wiring 缺陷，仅修改 Step 01–14 已列 feature 文件；禁止借机扩 scope

**依赖**

- Step 01–14 全部。

**TDD 测试点**

1. disk-only 启动 → worker live → disconnect → reconnect snapshot 的 session/pending/freshness全链路。
2. Settings 打开/返回、Pet open/close、Sidebar collapse/reopen 后，普通 chat、PanelArea、pet transcript、subscription与 draft均未被卸载/清空。
3. pending 单条/多条/已解决/stale 的 badge、peek、导航结果；任何 event 都不能自动打开 overview。
4. 键盘：Sidebar Enter、overview heading focus、Esc close、row Enter、peek CTA/close；状态有文本与 aria，不只靠颜色。
5. 窄窗口降级仍保留 pending/session/chat完整信息；默认宽窗口保持高密度双栏。
6. 安全断言：无 Pet approve API、无 direction command、无 Team/account UI、无 raw args/output/secret snapshot。

**验收**

- Phase 1 的 7 块范围均有至少一条跨层验收测试。
- 所有 hard boundary 有负向测试；集成修复不引入新产品能力。
- 实施 PR/commit 说明列出已知的非阻塞后续项时，只能指向 Phase 2/3，不得把它们偷带入本提交。

**本步边界**

纯收口，不做 direction、Team、多用户、L2、IM、自动审批或长期记忆。

## 4. 推荐落地顺序与串并行分组

### 4.1 推荐夜间流水线顺序

主线按以下顺序逐个 review/commit：

```text
01 SessionIndex
→ 02 PendingDecisionIndex
→ 03 core snapshot/delta
→ 04 durable pet session kind/profile
→ 06 desktop main aggregator
→ 07 preload bridge
→ 08 renderer provider
→ 09 Sidebar + resizable shell
→ 10 world pane
→ 11 safe navigation
→ 12 LocalPet dispatch backend
→ 13 Pet chat UI
→ 14 L0/L1 attention
→ 15 integration closeout
```

Step 05 在 Step 01 contract 合入后即可单开 lane，并行于 Step 02–04；在 Step 09 之前合回：

```text
01 ─┬─→ 02 → 03 → 04 ──────────────┐
    └─→ 05 pure renderer components ─┴→ 06 → 07 → 08 → 09 ... → 15
```

如果夜间执行器只能严格单线程，则顺序使用 `01 → 02 → 03 → 04 → 05 → 06 ... → 15`，最少产生返工。

### 4.2 必须串行的冲突组

| 串行组 | Steps | 原因/重叠文件 |
|---|---:|---|
| Core protocol | 01 → 02 → 03 → 04 | 多次触碰 `packages/core/src/index.ts`、`protocol/types.ts`、`protocol/server.ts`；02–04 不得并行落同一工作树 |
| Desktop main bridge | 06 → 07 → 11 → 12 → 14 | 重叠 `main/index.ts`、`agent-bridge.ts`、`pet-ipc.ts` |
| Preload contract | 07 → 11 → 12 → 14 | 重叠 `preload/index.ts`、`preload/types.d.ts`；每步都必须同步真实 expose 与类型 |
| Renderer shell | 08 → 09 → 10 → 11 → 13 → 14 → 15 | 从 09 起多次触碰 `App.tsx`；必须逐个 review/commit |
| Sidebar | 09 → 14 | `Sidebar.tsx`/badge语义先建入口，再接最终 attention count；不得并行改同一入口 |
| Pet overview/chat | 09 → 10 → 13 → 15 | 重叠 `PetOverviewPanel.tsx` 与 Provider 生命周期 |

### 4.3 可并行的安全窗口

- Step 05 可与 Step 02–04 并行：它只新增纯 renderer 组件/测试，唯一共享风险是 `i18n/dict.ts`；合并时先 rebase/手工并入 namespace import。
- Step 06 的 main aggregator 测试设计可在 Step 04 后半段提前准备，但正式实现/commit 必须等 Step 03 contract 和 Step 04 session kind稳定。
- Step 14 的纯 attention reducer/receipt-store 测试可与 Step 12–13 前期并行起草，但其 main/preload/App wiring 必须等 Step 11/13 落地后串行提交。
- 除上述窗口外，不建议并行：收益小于 `App.tsx/server.ts/preload` 冲突与 contract 漂移成本。

## 5. Phase 1 范围覆盖矩阵

| 要求 | 主要 Steps | 完成证据 |
|---|---:|---|
| 1. core `SessionIndex` | 01、03、06 | disk-only + live、phase/summary/freshness、disconnect/rebuild |
| 2. core `PendingDecisionIndex` | 02、03、06 | tool + AskUser；response/timeout/cancel/close/disconnect；snapshot reconcile |
| 3. 协议/桥接 | 03、07、08 | snapshot + ordered delta；main↔preload↔renderer 窄 API |
| 4. Sidebar Pet 入口 | 09、14 | 固定顶部、pending pill、独立 running dot、统一 badge count |
| 5. overview 面板 | 05、09、10、11 | 可调宽内嵌双栏、rows/pending、导航、空/加载/离线/stale |
| 6. durable pet chat | 04、12、13 | `kind="pet"`、固定 session、`ChatView` + `transcriptsReducer`、无 quick-chat cleanup |
| 7. L0/L1 通知 | 14、15 | 15s grace、receipt dedupe、active-session suppression、单跳/聚合、无 L2 |

## 6. 实施完成自检

- [ ] 15 个 step 均可单独由一个 Codex 实现、review、commit，且每步都有目标/文件/依赖/TDD/验收/边界。
- [ ] 所有预计新增 API/文件均标明为建议或推测；现状锚点可在当前仓库定位。
- [ ] 覆盖 Phase 1 全部 7 块，没有把 Phase 2 direction、Team/mesh、多用户、IM/L2/代批带入。
- [ ] `SessionIndex` 的 disk truth、live overlay、generation/freshness 与安全 summary 有测试。
- [ ] `PendingDecisionIndex` 的 tool + AskUser、六类收束路径与 reconnect 对账有测试。
- [ ] badge、overview pending 与 dock badge最终共享 `PendingDecisionIndex` 派生数据，不再各算一份。
- [ ] Sidebar running dot 与 pending pill 同时出现时仍不同色/形/位，语义可由 tooltip/aria完整读取。
- [ ] overview 是可调宽 Sidebar 内嵌宽面板；主 chat/PanelArea 保持 mounted。
- [ ] `settings_page` 继续使用 hidden shell + overlay；Provider/chat/panel tree 不因 early-return 卸载。
- [ ] pet chat 是 durable `kind="pet"` session，使用 `transcriptsReducer`，没有 quick-chat claim/cleanup/evict。
- [ ] pending/peek/chat action 只导航到原 session；没有 Pet approve/answer/direction API。
- [ ] 15s grace、receipt dedupe、当前 session 抑制、单条直达、多条聚合与“绝不自动 L2”均有 fake-clock/集成测试。
