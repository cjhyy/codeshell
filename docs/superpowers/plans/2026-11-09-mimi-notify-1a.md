# Mimi 通知闭环 1a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现设计稿 `docs/superpowers/specs/2026-11-09-mimi-dispatch-notify-proactivity-design.md` 的 1a 期：原生会话的提醒规则、`NotifyMe`、提醒路由器、六个推送出口收口。

**Architecture:** 规则存在 desktop main 的 `rules.json`；会话事件流与待决策投影喂给规则观察器，产出 Notice；Notice 统一交给由 `pet-attention-policy.ts` 扩展而来的提醒路由器，路由器用纯函数策略决定桌面 / 微信 / 摘要，并以冻结正文 + 确定性 `client_id` 发送。工作会话里的 `NotifyMe` 通过新增的 core 宿主回环（`__host_action__`，复用现有审批回环通道）同步写规则。

**Tech Stack:** TypeScript、Bun test、Electron main、core JSON-RPC stdio 协议。

**Branch / worktree:** `claude/pet/mimi-notify-1a-20261109` @ `codeshell-worktrees/mimi-notify-1a`（基于设计稿分支）。

---

## 实现期发现（相对设计稿的调整）

- **不需要 core `controlReason`。** `complete_goal` 先发 `goal_progress(met)`（`turn-loop.ts:1905-1912`），`cancel_goal` 先发 `goal_cleared`（`turn-loop.ts:1948-1952`），都在 `turn_complete` 之前；规则观察器按这两个事件区分即可。Task 12 同步改设计稿 §5.1 第 4 条。
- **`NotifyMe` 的请求/响应通道。** 扩展协议观察器没有"向宿主请求并等回复"的能力（`capability-module.ts:54-67` 只有 `notify`）。core 内部已有审批回环（`server.ts:4515-4573` 的 `__workspace_action__`，desktop 在 `agent-bridge.ts` 拦截并以 `agent/approve` 回复）。Task 1 把它泛化为 `__host_action__` 并暴露给扩展。

## 约定

- 测试：`bun test ./packages/<pkg>/src/<path>.test.ts`（必须带 `./`，否则是过滤器会扫全仓）。
- 改 core 后跑下游测试前先 `bun run --cwd packages/core build`（desktop/pet 测试吃 core dist）。
- 不跑 `bun run format`；只对改动文件跑 `npx prettier --write <files>`。
- 提交：逐路径 `git add <files>`，不用 `git add -A`。提交信息结尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- `packages/desktop/src/main/index.ts`、`packages/core/src/protocol/server.ts` 有行数预算：新逻辑放独立模块，入口只做接线；每个任务结束跑 `bun test ./tests/architecture-budgets.test.ts`（若存在）或仓库里的预算测试。
- 跨进程写的 JSON 文件走 CronStore 同一把锁（`acquireLockOnPath`），读不懂的条目隔离不丢弃。

## 文件结构

| 文件                                                                                          | 职责                                                                  | 任务 |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---- |
| `packages/core/src/protocol/host-action.ts`（新）                                             | `__host_action__` 回环：请求构造、回复解析                            | 1    |
| `packages/core/src/protocol/server.ts`                                                        | 用通用回环实现 `requestHostAction`；`__workspace_action__` 改为调用它 | 1    |
| `packages/core/src/tool-system/capability-module.ts`                                          | `ProtocolObserverHost.requestHostAction`                              | 1    |
| `packages/desktop/src/main/browser-driver/intercept.ts`                                       | `parseHostActionLine` / `buildHostActionReply`                        | 1    |
| `packages/desktop/src/main/agent-bridge.ts`                                                   | 拦截 `__host_action__`，按 action 分发给注册的处理器                  | 1    |
| `packages/pet/src/notify-me.ts`（新）                                                         | `NotifyMe` 工具定义、校验、可见性                                     | 2    |
| `packages/pet/src/capability.ts`                                                              | 注册 `NotifyMe`，把 `requestHostAction` 绑定给工具                    | 2    |
| `packages/pet/src/notice-rule.ts`（新）                                                       | 共享类型：`NoticeRule`、`RuleEffect`、`NoticeRuleUpsert`              | 2    |
| `packages/desktop/src/main/pet/pet-rule-store.ts`（新）                                       | `rules.json` 读写、每会话一条活动规则、乐观并发、隔离                 | 3    |
| `packages/desktop/src/main/pet/pet-session-rule-watcher.ts`（新）                             | 会话事件 + 待决策 → Notice（§6.2 判定）                               | 4    |
| `packages/desktop/src/main/pet/pet-notice-policy.ts`（新）                                    | 纯函数 `route()`                                                      | 5    |
| `packages/desktop/src/main/pet/pet-notice-ledger.ts`（新）                                    | `notices.json`：去重、计数、发送认领                                  | 5    |
| `packages/desktop/src/main/pet/pet-notice-router.ts`（由 `pet-attention-policy.ts` 改名扩展） | 接收 Notice、调策略、调出口、摘要、待送队列                           | 6    |
| `packages/desktop/src/main/pet/pet-presence.ts`（新）                                         | 在场判定（`powerMonitor.getSystemIdleTime` + 聚焦窗口）               | 6    |
| `packages/chat/src/wechat.ts`、`packages/desktop/src/main/im-gateway-service.ts`              | 外部 `client_id`；微信目标 `ready/unknown`                            | 7    |
| `packages/desktop/src/main/pet/pet-notice-wiring.ts`（新）                                    | 把 router、watcher、rule store、出口接进 main                         | 8    |
| `packages/desktop/src/main/index.ts`                                                          | 只调用 `wirePetNotices(...)`；删除 `onTaskClosed` 直接 publish        | 8    |
| `packages/desktop/src/main/pet/pet-dispatch-service.ts`                                       | 收尾轮不再直接 GatewayReply；文案进 Notice                            | 9    |
| `packages/desktop/src/main/pet/pet-im-decisions.ts`                                           | 数据源扩到规则会话；发送经路由器                                      | 10   |
| `packages/desktop/src/main/pet/session-bridge-wiring.ts`                                      | 绑定会话 done 去重                                                    | 10   |
| `packages/desktop/src/main/pet/pet-work-delegation-host.ts` + long-task coordinator           | 派活说明 + 自动建规则                                                 | 11   |
| `packages/core/src/settings/schema.ts`、renderer 设置页、会话头部铃铛                         | `pet.notifications` 设置、铃铛                                        | 12   |

---

### Task 1: core 宿主回环 `__host_action__`

**Files:**

- Create: `packages/core/src/protocol/host-action.ts`
- Modify: `packages/core/src/protocol/server.ts:4515-4573`（`requestWorkspaceActionForSession` 泛化）
- Modify: `packages/core/src/tool-system/capability-module.ts:54-67`
- Modify: `packages/desktop/src/main/browser-driver/intercept.ts`（在 `__workspace_action__` 段后新增）
- Modify: `packages/desktop/src/main/agent-bridge.ts`（仿照 `maybeHandleWorkspaceAction` 的拦截点）
- Test: `packages/core/src/protocol/host-action.test.ts`、`packages/desktop/src/main/browser-driver/intercept.test.ts`（追加）

接口：

```ts
// core: capability-module.ts
export interface ProtocolObserverHost {
  // ...existing
  /** Ask the attached host to perform a named action for a live session and wait for its JSON reply. */
  requestHostAction?: (
    sessionId: string,
    action: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

// core: host-action.ts
export const HOST_ACTION_TOOL_NAME = "__host_action__";
export interface HostActionRequestArgs { action: string; args: Record<string, unknown> }

// desktop: intercept.ts
export interface ParsedHostAction { sessionId?: string; requestId: string; action: string; args: Record<string, unknown> }
export function parseHostActionLine(line: string): ParsedHostAction | null;
export function buildHostActionReply(parsed: ParsedHostAction, resultJson: string): string;

// desktop: agent-bridge.ts
setHostActionHandler(action: string, handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown>): () => void;
```

- [ ] **Step 1: 写失败测试（desktop intercept）**：`parseHostActionLine` 只认 `method === Methods.ApprovalRequest` 且 `request.toolName === "__host_action__"` 且 `args.action` 为字符串、`args.args` 为对象；`buildHostActionReply` 产出 `agent/approve`，`decision: { approved: true, answer: resultJson }`，带同一 `sessionId/requestId`。参照同文件 `parseWorkspaceActionLine` 的测试写法。
- [ ] **Step 2: 跑测试确认失败**：`bun test ./packages/desktop/src/main/browser-driver/intercept.test.ts`
- [ ] **Step 3: 实现 intercept 两个函数。**
- [ ] **Step 4: 写失败测试（core）**：在 `server.ts` 现有 workspace action 测试旁（`grep -rn "__workspace_action__" packages/core/src --include='*.test.ts'` 找到）新增：observer 调 `host.requestHostAction("s1", "pet.rule.upsert", {x:1})` → transport 收到 `ApprovalRequest`，`request.toolName === "__host_action__"`、`args === { action: "pet.rule.upsert", args: { x: 1 } }`；客户端以 `agent/approve` 回 `{ ok: true, id: "r1" }` → Promise resolve 为该对象；回 `{ ok: false, error: "boom" }` → reject `boom`；超时 → reject。会话不存在 → reject。
- [ ] **Step 5: 实现**：把 `requestWorkspaceActionForSession` 的主体抽成 `requestHostLoopback(session, sessionId, toolName, args, label)`；`__workspace_action__` 与 `__host_action__` 都调它；在构造 `ProtocolObserverHost` 的地方（`grep -n "registerQuery" packages/core/src/protocol/server.ts` 找到 host 对象）加 `requestHostAction`，内部用 `chatManager` 取 live session，取不到 reject `session not live`。
- [ ] **Step 6: desktop agent-bridge 接线**：在处理 `parseWorkspaceActionLine` 的同一位置加 `maybeHandleHostAction(line)`：按 `action` 查 handler；无 handler 回 `{ ok: false, error: "unknown host action" }`；handler 抛错回 `{ ok: false, error }`。暴露 `setHostActionHandler`。
- [ ] **Step 7: 跑测试**：core 与 desktop 两个测试文件全过；`bun run --cwd packages/core build`。
- [ ] **Step 8: Commit** `feat(core): generic host-action loopback for extension observers`

### Task 2: `NotifyMe` 工具（packages/pet）

**Files:**

- Create: `packages/pet/src/notice-rule.ts`、`packages/pet/src/notify-me.ts`、`packages/pet/src/notify-me.test.ts`
- Modify: `packages/pet/src/capability.ts`（注册，参照 `reportToMimiTool` 的注册与可见性）、`packages/pet/src/index.ts`（导出类型）

```ts
// notice-rule.ts — 与 desktop 共享
export type NoticeEvent = "done" | "failed" | "blocked";
export type NoticeAttention = "always" | "important" | "digest" | "muted";
export type NoticeChannel = "auto" | "wechat";
export interface NoticeRuleUpsert {
  sessionId: string;
  createdBy: "notify-me" | "bell" | "delegation" | "watch-session";
  events: NoticeEvent[];
  scope: "turn" | "goal";
  channel: NoticeChannel;
  attention: "always" | "important";
  note?: string;
}
export interface RuleEffect {
  ruleId: string;
  fires: string;
  channel: "wechat" | "desktop" | "auto";
  wechat: "ready" | "unknown" | "unavailable";
  quietHours?: string;
}
export const PET_RULE_UPSERT_ACTION = "pet.rule.upsert";
```

- [ ] **Step 1: 失败测试**：
  - 参数校验：`when` 只能是三者子集且非空；`scope`、`channel`、`attention` 枚举；`note` ≤ 500；未知字段报错。
  - 可见性：有合法 `ctx.sessionId` 的原生顶层会话可见；子代理可见（规则挂 `ctx.parentSessionId ?? ctx.sessionId`，从现有子代理上下文字段取父会话 id，`grep -n "parentSessionId" packages/core/src/tool-system/context.ts` 确认字段名）；`behaviorProfile === "pet"`（Mimi 自己）不可见。
  - 执行：`requestHostAction` 不可用 → 返回 `Error: the host rule channel is unavailable.`；返回 `{ ok:false, error }` → `Error: ...没有订上...`；返回 `RuleEffect` → 文本包含 `ruleId`、`fires`、`channel`、`wechat`，并含一句"Tell the owner exactly this; do not claim anything was sent."
  - 默认值：有活动 Goal（`ctx.hasGoal`）时 `scope: "goal"`，否则 `"turn"`；`channel` 默认 `"auto"`；`attention` 默认 `"always"`。
- [ ] **Step 2: 确认失败**：`bun test ./packages/pet/src/notify-me.test.ts`
- [ ] **Step 3: 实现**，工具描述写清："Use when the owner asks to be told when this Session is done, fails or gets blocked. If they name WeChat, set channel to wechat. Call once; the host tracks completion — do not call RequestMimiDelivery at the end."
- [ ] **Step 4: capability.ts 注册**：默认权限 `allow`（同 ReportToMimi）；把 observer host 的 `requestHostAction` 通过与 `reportFor(sessionId)` 相同的宿主解析逻辑交给工具。
- [ ] **Step 5: 跑 pet 全部测试**：`bun test ./packages/pet/src`
- [ ] **Step 6: Commit** `feat(pet): NotifyMe tool registers a persisted notice rule`

### Task 3: 规则表 `pet-rule-store.ts`

**Files:** Create `packages/desktop/src/main/pet/pet-rule-store.ts` + `.test.ts`

```ts
export interface NoticeRule {
  id: string;
  version: number;
  origin: "user" | "delegation" | "system";
  createdBy: NoticeRuleUpsert["createdBy"] | "system";
  when:
    | {
        kind: "session";
        sessionId: string;
        runtime: "native";
        events: NoticeEvent[];
        scope: "turn" | "goal";
        armedAtSeq: number;
      }
    | { kind: "all-sessions"; events: NoticeEvent[]; onlyWhenAway: true };
  then: { mode: "notify" };
  attention: NoticeAttention;
  channel: NoticeChannel;
  target: { kind: "route"; route: PetChatRoute } | { kind: "owner" };
  note?: string;
  state: "active" | "paused" | "spent" | "completed" | "cancelled";
  createdAt: number;
  updatedAt: number;
}
export class PetRuleStore {
  constructor(opts: {
    path: string;
    now?: () => number;
    lock: (path: string) => Promise<() => Promise<void>>;
  });
  load(): Promise<void>;
  upsertSessionRule(
    input: NoticeRuleUpsert & { target: NoticeRule["target"]; origin: NoticeRule["origin"] },
  ): Promise<NoticeRule>;
  activeForSession(sessionId: string): NoticeRule[]; // 含 all-sessions 规则
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<NoticeRule, "state" | "channel" | "attention" | "note" | "events">>,
  ): Promise<NoticeRule>;
  systemRule(id: "all-sessions"): NoticeRule; // 不存在时返回默认（state: "paused"，决策 D6）
  list(): NoticeRule[];
}
```

- [ ] **Step 1: 失败测试**：同会话同 target 重复 upsert 只保留一条、`version` 递增、`events/channel/note` 被更新；`update` 版本不符抛 `version_conflict`；文件里有一条不认识的条目 → 加载后它进 `quarantine` 数组并在写回时原样保留；写入走传入的 `lock`；`armedAtSeq` 记录为调用方提供的当前会话事件序号（由 Task 4 提供，测试中直接传）。
- [ ] **Step 2–4**：实现（读写用 `bounded-json-store.ts` 的 `readBoundedJson / writeOwnerJsonAtomic`），测试通过。
- [ ] **Step 5: Commit** `feat(desktop): persisted notice rule store`

### Task 4: 规则观察器 `pet-session-rule-watcher.ts`

**Files:** Create `packages/desktop/src/main/pet/pet-session-rule-watcher.ts` + `.test.ts`

输入：会话顶层事件（与 `observeSessionEvent` 同一来源）、待决策投影事件（`pending-upsert/remove`，同 `pet-long-task-coordinator.ts:752-777`）、`PetRuleStore`、`hasActiveLongTask(sessionId)`、`isSessionBusy(sessionId)`（排队消息或运行中后台任务）。输出：`onNotice(notice: NoticeDraft)`。

```ts
export interface NoticeDraft {
  kind: "session.done" | "session.failed" | "session.blocked";
  priority: "P0" | "P1";
  dedupeKey: string;
  sessionId: string;
  ruleIds: string[];
  requestId?: string;
  expiresAt?: number;
  facts: {
    title?: string;
    summary?: string;
    error?: string;
    question?: string;
    options?: { label: string; recommended?: boolean }[];
  };
}
```

判定（设计稿 §6.2，逐条写成测试用例）：

- 每个会话维护 `turnSeq`（每次 `turn_complete` +1）与 `workSinceArm`（本轮出现过 `NotifyMe/ReportToMimi/AskUserQuestion*` 以外的 `tool_use_start`，或本轮以后台任务完成唤醒）。
- `turn_complete(completed)`、无 `completionKind`、`workSinceArm`、`!isSessionBusy` → `scope:"turn"` 规则发 `session.done`，规则置 `spent`；`dedupeKey = ${sessionId}:turn:${turnSeq}`。
- 只回了"好的"（`workSinceArm === false`）→ 不发，规则保持 active。
- `goal_progress(met)` → `scope:"goal"` 规则发 done，`dedupeKey = ${sessionId}:goal:${goalId}`。
- `goal_cleared` → 规则置 `cancelled`，不发。
- `completionKind: "limit_stop"`、`goal_progress.waitingForUser === true`、`goal_progress(exhausted)` → `session.blocked` P0，`dedupeKey = ${sessionId}:goal-pause:${revision ?? turnSeq}`。
- `background_wait` → 不发。
- `turn_complete` 非 completed 且非 abort、或 `error` 事件 → `session.failed` P1。
- abort（`aborted_streaming/aborted_tools`）→ 不发，规则保持。
- `pending-upsert` → `session.blocked` P0，`dedupeKey = ${sessionId}:${requestId}`，带问题与选项（从 `DesktopPendingDecision` 取，字段名以 `pet-state-aggregator.ts` 为准）。
- 有活动长任务（`hasActiveLongTask`）时 done/failed **不发**（收尾路径负责，Task 9），blocked 照发。
- 规则 `events` 不包含该类则不发；无规则则不发（`all-sessions` 系统规则 active 时视同命中，`onlyWhenAway` 交给路由器判断，facts 带 `requiresAway: true`）。

- [ ] Steps：逐条写失败测试 → 实现 → 通过 → Commit `feat(desktop): session rule watcher turns events into notices`

### Task 5: 策略纯函数与提醒记录

**Files:** Create `pet-notice-policy.ts`、`pet-notice-ledger.ts` + tests

```ts
export interface RouteState {
  now: number;
  present: boolean;
  quietHours: { start: string; end: string } | null;
  timezoneOffsetMin: number;
  sentThisHour: number;
  p0SentThisHour: number;
  maxPerHour: number;
  maxP0PerHour: number;
  seenDedupeKeys: ReadonlySet<string>;
  wechat: "ready" | "unknown" | "unavailable";
}
export interface RouteDecision {
  outlet: "wechat" | "desktop" | "both" | "digest" | "record" | "drop";
  reason: string;
}
export function route(
  n: {
    priority: "P0" | "P1" | "P2";
    dedupeKey: string;
    attention: NoticeAttention;
    channel: NoticeChannel;
    requiresAway?: boolean;
  },
  s: RouteState,
): RouteDecision;
```

规则（设计稿 §8.3，每条一个表驱动用例）：重复 → drop；muted → record；digest → digest；P0：`p0SentThisHour >= maxP0PerHour` → digest，否则进渠道；P1/P2：在免打扰（跨零点）→ digest，`sentThisHour >= maxPerHour` → digest；渠道：`channel === "wechat"` → both；`auto` 且 present → desktop（`requiresAway` 时 present → record）；`auto` 且 !present → wechat（`wechat === "unavailable"` → desktop + 待送，outlet 记 `desktop`，reason `wechat-unavailable-queued`）。

Ledger：`notices.json`（≤ 5000 条 / 8 MB，淘汰最旧的终结项）；`claim(notice) → key`（冻结 `body`、生成 `delivery.key = sha256(dedupeKey).slice(0,24)`、状态 `claimed` 落盘后才返回）；`settle(id, status, error?)`；整点计数按本地时区；`recoverOnStartup(now)`：`claimed` 且 `now - at < 10min` → 返回待重发列表，否则置 `unknown`。

- [ ] Steps：表驱动失败测试 → 实现 → 通过 → Commit `feat(desktop): notice routing policy and ledger`

### Task 6: 提醒路由器（扩展 attention policy）

**Files:** `git mv packages/desktop/src/main/pet/pet-attention-policy.ts packages/desktop/src/main/pet/pet-notice-router.ts`（测试同改名）；Create `pet-presence.ts` + test；更新所有 import（`grep -rn "pet-attention-policy" packages/desktop`）。

- 保留现有 `PetAttentionPolicy` 行为与对外事件（`count`/`peek`），类名改 `PetNoticeRouter`，旧名 `export { PetNoticeRouter as PetAttentionPolicy }` 过渡一版。
- 新增 `submit(draft: NoticeDraft & { body?: string; attention; channel; target })`：调 `route()`；`desktop/both` → 现有 peek 通道 + `DesktopNotifier`；`wechat/both` → `ledger.claim` → `outlets.wechat(target, body, clientId)`；`digest` → 加入摘要缓冲，在下一个可发送时刻（免打扰结束 / 下一整点）合成一条"你不在时：……"走同一流程；失败 → `failed` + 待送队列。
- 待送队列：`replayPending(routeKey)` 在主人入站消息、该轮 Mimi 运行前调用；逐条重查（blocked：`isDecisionStillPending(requestId)`、未过 `expiresAt`；done/failed：`wasSessionViewedSince(sessionId, createdAt)`），有效的返回给调用方注入 `runtimeContext.pendingNotices`。
- `pet-presence.ts`：`isPresent(): boolean = powerMonitor.getSystemIdleTime() < idleSec && BrowserWindow.getFocusedWindow() != null`，依赖注入以便测试。
- 成文：模板用于 blocked（问题 + 选项 + `回答 码 N / 跳过 / 等待`，码由 Task 10 提供）与 failed；done 若 draft 带 `body`（收尾轮文案）用之，否则模板"「{title}」做完了：{summary}"。会话内容一律作为数据插入模板，不经模型。

- [ ] Steps：失败测试（用假 outlets、假 presence、假时钟）覆盖：在场只发桌面、明说微信两边都发、免打扰进摘要并在结束时合成一条、P0 第 13 条进摘要、发送失败入队、入队后审批已解决则补发前撤销、重启恢复 claimed → 10 分钟内重发同一 clientId → 实现 → 通过 → Commit `feat(desktop): grow attention policy into the notice router`

### Task 7: 微信外部 `client_id` 与目标就绪度

**Files:** `packages/chat/src/wechat.ts:375-430`、`packages/chat/src/channel.ts`（发送选项类型）、`packages/desktop/src/main/im-gateway-service.ts:656-688,698-760,1383-1386` + tests

- `send(target, message, { clientId?: string })`：提供时所有分段用 `${clientId}-${index}`，不再 `randomUUID()`；失效重试沿用同一值。
- `sendOwnerMessage(targetId, text, { idempotencyKey?: string })` 透传为 `clientId: "code-shell-notice-" + key`。
- `listOwnerMessageTargets` 不再因缺少存盘 token 隐藏微信目标；返回项加 `proactiveReady: "ready" | "unknown"`（有 token → ready，无 → unknown）。`SendMessage` 工具与"微信主动发送暂不可用"兜底文案按 `unknown` 仍尝试发送。

- [ ] Steps：`wechat.test.ts` 新增"外部 clientId 用于所有分段且失效重试复用"；im-gateway 测试新增"无 token 目标列出为 unknown"、"idempotencyKey → clientId" → 实现 → Commit `feat(chat): caller-supplied WeChat client ids and unknown readiness`

### Task 8: main 接线 `pet-notice-wiring.ts`

**Files:** Create `packages/desktop/src/main/pet/pet-notice-wiring.ts`；Modify `packages/desktop/src/main/index.ts`（PetAttentionPolicy 构造处 `index.ts:2617` 附近、`subscribeOutbound` 处 `:2201`、`onTaskClosed` 处 `:2038-2156`）

- `wirePetNotices({ userDataDir, bridge, projection, longTaskStore, imGateway, desktopNotifier, settings, lock })` 返回 `{ router, ruleStore, watcher, dispose }`。
- 在 bridge 上 `setHostActionHandler(PET_RULE_UPSERT_ACTION, ...)`：校验 `sessionId` 为顶层或子代理会话（子代理挂父会话）；确定 target（会话由 IM 绑定或长任务有 IM 来源 → route，否则 owner）；`ruleStore.upsertSessionRule`；返回 `RuleEffect`（`wechat` 取 `listOwnerMessageTargets` 的就绪度；`quietHours` 取设置）。
- `bridge.subscribeOutbound` 的同一 tap 里，在 `longTaskCoordinator.observeSessionEvent` 之后调 `watcher.observe(sessionId, event)`。
- `onTaskClosed`：删除 `publishGatewayControlEvent(pet.task.*)` 与直接 `DesktopNotifier` 调用，改为 `router.submit({ kind, priority:"P1", dedupeKey: task:${task.id}:${status}, body: closureText, target: task.completionTarget ?? owner, channel: rule?.channel ?? delegatedFromDesktop, attention: "always" })`。
- index.ts 只保留 `const notices = wirePetNotices(...)` 与少量调用；跑预算测试。

- [ ] Steps：wiring 单测（假 bridge/假 store）覆盖 host action 处理与 onTaskClosed 只产生一条 Notice → 实现 → `bun test ./packages/desktop/src/main/pet` → Commit `feat(desktop): wire notice rules and router into main`

### Task 9: 收尾轮不再直接发送

**Files:** `packages/desktop/src/main/pet/pet-dispatch-service.ts:1461-1634`（`reportLongTaskClosure`）+ 其测试

- 收尾轮的 host actions 去掉 `gatewayReply`；改为要求 Mimi 用纯文本最终回复（提示句："Write the owner-facing completion message as your final answer; the host delivers it."）。
- `reportLongTaskClosure` 返回 `{ text, continued }`；`continued === false` 时调用方（Task 8 的 onTaskClosed 路径）把 `text` 作为 Notice `body`。
- 续派路径不变。
- 更新断言"收尾轮必须调用 GatewayReply"的测试为"收尾轮返回文案、不产生网关发送"。

- [ ] Steps：先改测试 → 实现 → `bun test ./packages/desktop/src/main/pet/pet-dispatch-service.test.ts` 与 `bun test ./tests/mimi-chat-replay.test.ts` → Commit `refactor(desktop): closure turns hand their text to the notice router`

### Task 10: 审批码与绑定会话

**Files:** `pet-im-decisions.ts`、`session-bridge-wiring.ts` + tests

- `PetImDecisions` 候选会话：现有"有 IM 来源的长任务" ∪ "有 active 规则且 events 含 blocked 的会话"（经注入的 `ruleStore.activeForSession`）。目标：长任务来源路由优先，否则规则 target；owner 目标解析为 `listOwnerMessageTargets` 的第一个微信目标。
- 生成的提示文本与 12 位码逻辑不变，发送改为 `router.submit({ kind:"session.blocked", priority:"P0", dedupeKey: ${sessionId}:${requestId}, body, ... })`；回码解析与 `canReply` 校验不变。
- 规则观察器的 `pending-upsert` blocked Notice 与此重复 → 观察器对 pending 决策不再自己发（交给 PetImDecisions 产出的带码版本），只在 PetImDecisions 判定不适用（例如无微信目标）时由路由器走桌面。实现：观察器把 pending 事件交给 `imDecisions.considerSession(sessionId)`。
- 绑定会话：`session.reply` 发出时记录 `boundReplyAt[sessionId] = turnSeq`；路由器收到 `session.done` 且其 target 与该绑定路由相同、`turnSeq` 相同 → outlet 改 `desktop`，reason `bound-reply-delivered`。

- [ ] Steps：失败测试（非 IM 来源但有规则的会话审批 → 收到带码消息；绑定会话完成只收到一条）→ 实现 → Commit `feat(desktop): decision codes and bound replies go through the router`

### Task 11: 派活说明与自动建规则

**Files:** `pet-work-delegation-host.ts:114-141`、`pet-long-task-coordinator.ts:348-394` + tests

- 启动 `agent/run` 时 prompt = `buildDelegationBrief({ channel: completionTarget ? "WeChat" : "desktop" }) + "\n\n" + objective`，模板：

```
[Delegated by Mimi]
Mimi started this Session for the owner from {channel}. The owner may be away from the computer.
- When you need a decision, use AskUserQuestionAsync with concrete options, mark one recommended, and set skippable.
- The host reports completion automatically; do not call RequestMimiDelivery at the end.
- Use ReportToMimi only for a milestone the owner would want before completion.
[/Delegated by Mimi]
```

- 续派（continuation 模板）不重复加。
- `startDelegation` 成功后 `ruleStore.upsertSessionRule({ createdBy:"delegation", events:["done","failed","blocked"], scope: verificationMode, channel: completionTarget ? "wechat" : settings.delegatedFromDesktop === "wechat" ? "wechat" : "auto", attention:"always", target })`。

- [ ] Steps：失败测试 → 实现 → Commit `feat(desktop): delegated sessions get a brief and an automatic notice rule`

### Task 12: 设置、铃铛、设计稿同步

**Files:**

- `packages/core/src/settings/schema.ts:123-151`：`pet.notifications`（`delegatedFromDesktop`、`quietHours`、`maxPerHour`、`maxP0PerHour`、`mergeWindowSec`、`presenceIdleSec`，全部可选、带上下界）。
- IPC：`pet:rules:list`、`pet:rules:setSessionBell(sessionId, on)`、`pet:rules:setSystemRule(id, patch)`（`pet-ipc.ts`，参照现有 handler 写法与 ipc-contract 测试）。
- Renderer：工作会话头部铃铛（找到会话头部组件：`grep -rn "SessionHeader\|session-header" packages/desktop/src/renderer -l`），状态取 `pet:rules:list`，点击切换；Mimi 设置页"通知与主动"卡片：免打扰、每小时上限、桌面派活默认渠道、"不在电脑前所有会话都推我"开关。i18n 中英同步。
- 设计稿：§5.1 第 4 条改为"按 `goal_cleared` / `goal_progress(met)` 区分，无需 core 字段"；§13 表 1a 去掉 `controlReason`；§14 core 行去掉 `controlReason`。

- [ ] Steps：settings schema 测试、ipc-contract 测试、铃铛组件测试（迷你 DOM，先 `ensureMiniDom` 再 import）→ 实现 → Commit `feat(desktop): notification settings, session bell and system rule toggle`

### Task 13: 全量验证

- [ ] `bun run typecheck`
- [ ] `bun test ./packages/pet/src ./packages/desktop/src/main/pet ./packages/chat/src`
- [ ] `bun test ./tests/mimi-chat-replay.test.ts`
- [ ] 全仓契约/预算：`bun test ./tests/index.exports.test.ts ./tests/ipc-contract.test.ts ./tests/architecture-budgets.test.ts`（以仓库实际文件名为准，`ls tests | grep -E "export|ipc|budget"`）
- [ ] 改动文件 `npx prettier --check` 与 ESLint
- [ ] Commit 修复项；推分支；开 PR（base 为设计稿分支或 main，视 #315 是否已合并）
