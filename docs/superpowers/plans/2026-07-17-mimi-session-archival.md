# Mimi 会话自动归档与工作台结构化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用结构化投影状态替代正则给 Mimi 工作台分类,把 dismiss 状态与历史 Work Session 归档下沉到 main/core 持久层,并让 pet 主会话按话题段自动沉淀工作记忆、裁剪活跃上下文。

**Architecture:** 分三块。B2 纯在 desktop renderer + main pet 层:`petWorkMap` 改为读 `PetSessionProjection` 的结构化状态(五分组,不再隐身),dismiss 状态从 renderer localStorage 迁到 main 侧 `PetMetadataStore`,经现有 `pet:get-snapshot`/`pet:projection-event` 通道同步。B3 下沉到 core:`SessionState` 加通用 `archivedAt` 字段(经 `updateSessionState` 写盘),`listDiskSessions` 默认过滤归档、可显式包含;desktop main 用完成+7天无活动规则在 `refreshCatalog` 时机自动归档,并把「已完成但未归档」纳入 Mimi 复用候选;`refreshCatalog` 全量翻页改为 mtime 增量游标。B1 最重:core 补一个**通用**的「指定轮次区间归档/裁剪」原语(`ContextManager.summarizeRange` + engine facade + protocol query),pet 侧经 `RunBehaviorProfile.createRunServices`/`reportResult` 缝把话题段边界判定与工作记忆沉淀落到 `packages/pet`(不向 core/engine 加 pet 字面量),UI 在 Mimi 聊天流加话题段分隔线 + 归档纪要卡片。

**Tech Stack:** bun test(core/pet 行为单测,desktop renderer `renderToStaticMarkup`/mini-DOM 契约测试);TypeScript strict;React 19 + shadcn/Tailwind(desktop renderer);Node fs 原子写(main pet store)。

---

## 调研结论:与设计文档假设不符 / 需澄清的事实(执行者必读)

1. **`archiveSession` 现状是 renderer localStorage 概念,不作用于磁盘。** 设计文档假设「desktop 已有 archiveSession 概念,搞清它作用于哪层」。事实:`packages/desktop/src/renderer/transcripts.ts:734 archiveSession(...)` 只改 renderer 的项目/会话索引(localStorage `SessionIndex.archived` 布尔位,`transcripts.ts:81-83`),从不写 `state.json`。因此 B3 的「Work Session 归档标记存 session metadata」是**全新的磁盘层字段**,不能复用它。本计划在 core `SessionState` 新增通用 `archivedAt?: number`。

2. **`ExtensionModule`(pet 的 `/extension` 缝)不暴露 `engineHooks` / `dynamicContextProviders`。** 设计文档写「经 `/extension` 的 engineHooks/dynamicContextProviders 缝」。事实:`packages/core/src/tool-system/capability-module.ts:76 ExtensionModule` 只有 `tools/queries/behaviorProfiles/createProtocolObserver/validateRunParams/hiddenSessionKinds/catalogTools`;`engineHooks`/`dynamicContextProviders` 在**内部** `Capability` 接口(`packages/core/src/capabilities/index.ts:24,36`)上,pet 的 `createPetCapability()`(`packages/pet/src/capability.ts:29`)走的是 `ExtensionModule`。因此 B1 的 pet 侧段逻辑只能骑 `RunBehaviorProfile.createRunServices`(`packages/core/src/engine/run-types.ts:49` 的 `reportResult`)+ `systemPromptAppend` + 已有的 runtime-context 注入(`profileParams.runtimeContext`),不能新增 engineHook。段边界的「触发」由 desktop main(委派闭环处已有信号)驱动,「上下文裁剪」由新 core 通用原语执行。

3. **core `/extension` 不导出 `ContextManager` 或任何 summarize 原语。** `packages/core/src/index.extension.ts` 导出 `SessionManager`、`RunBehaviorProfile`,但没有 `ContextManager`。`ContextManager.trySummaryCompact`(`packages/core/src/context/manager.ts:262`)用的是**固定启发式窗口** `messages.slice(1, -keepRecentN)`,没有「指定轮次区间」入口。结论:B1 的「区间归档原语」确实缺失,必须在 core 加通用原语。这符合设计文档「若 core 缺则加通用原语,pet 是首个消费者」,并触发设计文档允许的 B1 拆两个递进任务(见 Task 8/9/10)。

4. **无既有 pet 记忆存储。** `packages/pet` 与 `packages/desktop/src/main/pet` 无 memory/记忆 相关文件。B1 的「工作记忆存储」是全新 store,本计划按 `PetReceiptStore`(`packages/desktop/src/main/pet/pet-receipt-store.ts`)的原子写风格新建 `PetWorkMemoryStore`(main 侧)。

5. **复用候选当前排除逻辑并不排除「已完成」。** `packages/desktop/src/main/pet/pet-dispatch-service.ts:346-356` 只把 running/queued/有 pending 的 session 放进 `unavailableSessionIds`;`listReusableSessions`(`packages/desktop/src/main/index.ts:1023-1038`)只 `origin==="desktop"` 过滤,不看 status。设计文档说「已完成但未归档纳入复用候选」——事实是已完成的**已在候选内**,真正会被排除的是**已归档**的。因此 B3 的复用候选放宽,落点是:归档后从 `listDiskSessions` 默认结果消失,而 `listReusableSessions` 显式传 `includeArchived:false` 保持已完成未归档仍可复用(即维持现状 + 归档过滤),并在候选描述里体现 status;Task 7 据此实现,不做「本来排除现在纳入」的伪改动。

---

## 任务索引

- **Task 1**（B2 core-ish 纯函数)重写 `buildPetWorkMap` 分类:结构化状态五分组,未分类进「其他」。
- **Task 2**（B2 UI)`PetWorkTree`/i18n 增「其他」分组渲染 + 展开。
- **Task 3**（B3 core)`SessionState.archivedAt` + `SessionManager.setSessionArchived`/`readSessionArchivedAt`。
- **Task 4**（B3 server)`listDiskSessions` 读 `archivedAt`、默认过滤、`includeArchived` 开关。
- **Task 5**（B3 main）dismiss 状态迁到 `PetMetadataStore`(`dismissedWorkItemIds`),经 snapshot 下发。
- **Task 6**（B2 main→renderer)snapshot/delta 携带 dismissedIds;renderer 读 snapshot 优先、localStorage 仅缓存;dismiss/restore 走 IPC。
- **Task 7**（B3 main）完成+7天无活动自动归档触发点 + 复用候选携带 status。
- **Task 8**（B3 main）`refreshCatalog` 全量翻页改 mtime 增量游标。
- **Task 9**（B1a core)通用 `ContextManager.summarizeRange` 区间归档原语。
- **Task 10**（B1a core)engine facade `archiveTurnRange` + protocol `archive_range` query 暴露原语。
- **Task 11**（B1b pet）`PET_BEHAVIOR_PROFILE` 段边界判定 + 携带纪要注入(纯函数 + profile 接线)。
- **Task 12**（B1b main）`PetWorkMemoryStore` + 委派闭环/长空闲触发段归档。
- **Task 13**（B1c UI)Mimi 聊天流话题段分隔线 + 归档纪要卡片。

---

## 设计点 → 任务映射

| 设计点(B*) | 任务 |
| --- | --- |
| B2 分类改结构化状态,五分组,未分类进「其他」不隐身 | Task 1 |
| B2 title/summary 只展示不分类;正则整体移除 | Task 1 |
| B2 「其他」分组可展开、展示上限保留 | Task 1, Task 2 |
| B2 列表按 workspace 过滤 | Task 1(已有 workspace 分组,新增过滤入参) |
| B2 dismiss 迁 main pet metadata store,localStorage 仅缓存,经 snapshot/delta 同步 | Task 5, Task 6 |
| B3 Work Session 归档标记存 session metadata | Task 3 |
| B3 `listDiskSessions` 默认过滤归档、可显式包含 | Task 4 |
| B3 已完成且 7 天无活动自动归档 | Task 7 |
| B3 Mimi 复用候选放宽(归档后排除,已完成未归档保留,携带 status) | Task 7 |
| B3 `refreshCatalog` 全量翻页改增量 mtime 游标 | Task 8 |
| B1 core 缺「区间归档/裁剪」通用原语则补 | Task 9, Task 10 |
| B1 段状态与归档逻辑放 `packages/pet`,不向 core 加 pet 字面量 | Task 11, Task 12 |
| B1 任务闭环归档(工作记忆 + 活跃上下文裁剪为纪要) | Task 11, Task 12 |
| B1 长空闲切段(默认 12h,可配)+ 新段注入携带纪要 | Task 11, Task 12 |
| B1 UI:话题段分隔线 + 归档纪要卡片,无新增必须操作按钮 | Task 13 |

---

### Task 1: 重写 `buildPetWorkMap` 为结构化状态分类(五分组,未分类进「其他」)

**Files:**
- Modify: `packages/desktop/src/renderer/pet/petWorkMap.ts`（整体重写分类逻辑;当前 L3-56 的 kind/state 类型与正则常量,L62-239 的分类/装配)
- Test: `packages/desktop/src/renderer/pet/petWorkMap.test.ts`（新增结构化分类用例;沿用 `session()`/`pending()` fixture 风格）

**Steps:**

- [ ] 写失败测试:在 `petWorkMap.test.ts` 末尾追加一个 `describe`,断言新分组模型。粘贴以下测试块(fixture `session`/`pending` 已存在于文件顶部,直接复用):

```ts
describe("buildPetWorkMap structured classification", () => {
  test("groups by structured state and never hides an unclassified session", () => {
    const map = buildPetWorkMap(
      [
        session("run", { runState: "running" }),
        session("queued", { runState: "queued" }),
        session("done", { terminal: { status: "completed", at: 5_000 }, runState: "terminal" }),
        session("followup", {
          runState: "idle",
          summary: "本轮已完成:改好了三个文件",
        }),
        session("mystery", { runState: "idle", summary: undefined, title: "随便聊聊" }),
      ],
      [
        {
          agentSessionId: "decide",
          requestId: "r1",
          workerGeneration: 1,
          kind: "ask_user",
          title: "需要你确认",
          createdAt: 4_000,
          status: "pending",
        },
      ],
    );
    const byId = new Map(map.groups.flatMap((g) => g.buckets.flatMap((b) => b.items.map((i) => [i.id, i.group] as const))));
    expect(byId.get("running:run")).toBe("running");
    expect(byId.get("running:queued")).toBe("running");
    expect(byId.get("pending:decide:r1")).toBe("pending");
    expect(byId.get("follow-up:followup")).toBe("follow-up");
    expect(byId.get("completed:done")).toBe("completed");
    // The genuinely unclassifiable session lands in "other", not hidden.
    expect(byId.get("other:mystery")).toBe("other");
    expect(map.unclassifiedCount).toBe(0);
    expect(map.counts.other).toBe(1);
  });

  test("filters by workspace when workspaceFilter is provided", () => {
    const map = buildPetWorkMap(
      [
        session("a", { workspaceDisplayName: "alpha", runState: "running" }),
        session("b", { workspaceDisplayName: "beta", runState: "running" }),
      ],
      [],
      { workspaceFilter: "alpha" },
    );
    expect(map.groups.map((g) => g.workspace)).toEqual(["alpha"]);
  });

  test("does not classify by title/summary keywords anymore", () => {
    const map = buildPetWorkMap(
      [session("opt", { runState: "idle", summary: "需要重构性能优化" })],
      [],
    );
    // "优化/重构" no longer routes to a special bucket; idle w/o outcome → other.
    const groups = map.groups.flatMap((g) => g.buckets.map((b) => b.group));
    expect(groups).toContain("other");
    expect(groups).not.toContain("optimization");
  });
});
```

- [ ] 跑测试确认失败:`cd packages/desktop && bun test src/renderer/pet/petWorkMap.test.ts`。预期:新用例因 `map.groups[].buckets` / `map.counts.other` / `workspaceFilter` 不存在而失败(旧结构是 `groups[].unfinished/optimization/completed`),旧用例部分红。

- [ ] 最小实现:整体替换 `petWorkMap.ts`。用以下完整文件:

```ts
import type { PetPendingDecision, PetSessionProjection } from "../../preload/types";

/** Structured work group derived from projection state, never from title/summary text. */
export type PetWorkGroup = "running" | "pending" | "follow-up" | "completed" | "other";

export type PetWorkState =
  | "needs-action"
  | "follow-up"
  | "running"
  | "queued"
  | "failed"
  | "cancelled"
  | "completed"
  | "idle";

export interface PetWorkItem {
  id: string;
  group: PetWorkGroup;
  state: PetWorkState;
  workspace?: string;
  title: string;
  detail?: string;
  lastActivityAt: number;
  navigation: {
    agentSessionId: string;
    requestId?: string;
    routeGeneration?: number;
  };
}

export interface PetWorkBucket {
  group: PetWorkGroup;
  items: PetWorkItem[];
}

export interface PetWorkspaceWorkGroup {
  workspace?: string;
  buckets: PetWorkBucket[];
  latestActivityAt: number;
}

export interface PetWorkMap {
  groups: PetWorkspaceWorkGroup[];
  counts: Record<PetWorkGroup, number>;
  itemIds: Record<PetWorkGroup, string[]>;
  dismissedCount: number;
  hiddenCount: number;
  /** Retained for the footer contract; structured classification keeps it at 0. */
  unclassifiedCount: number;
}

const GROUP_ORDER: readonly PetWorkGroup[] = [
  "running",
  "pending",
  "follow-up",
  "completed",
  "other",
];

const DISPLAY_LIMITS: Record<PetWorkGroup, number> = {
  running: 16,
  pending: 16,
  "follow-up": 12,
  completed: 8,
  other: 8,
};

/**
 * Pure, presentation-only projection. Classification is derived exclusively
 * from the projection's structured state (runState / terminal / pending
 * decisions), never from title/summary text. Any session that does not match a
 * concrete state falls into the "other" bucket so nothing is ever hidden.
 *
 * "follow-up" = an idle session whose last turn produced a terminal-completed
 * outcome that the user has not yet acted on, i.e. a completed run that is not
 * yet dismissed. "completed" is reserved for sessions whose durable terminal
 * status is completed AND whose run is no longer live (disk/dormant/terminal).
 */
function classify(
  session: PetSessionProjection,
  pending: PetPendingDecision | undefined,
): { group: PetWorkGroup; state: PetWorkState } {
  if (pending) return { group: "pending", state: "needs-action" };
  if (session.pendingDecisionCount > 0) return { group: "pending", state: "needs-action" };
  if (session.runState === "running") return { group: "running", state: "running" };
  if (session.runState === "queued") return { group: "running", state: "queued" };
  if (session.terminal?.status === "failed") return { group: "other", state: "failed" };
  if (session.terminal?.status === "cancelled") return { group: "other", state: "cancelled" };
  // A live idle session that just finished a completed turn is a follow-up: the
  // user may want to review or continue it. A dormant/terminal completed disk
  // session is "completed" (already settled).
  if (session.terminal?.status === "completed") {
    return session.runState === "idle"
      ? { group: "follow-up", state: "follow-up" }
      : { group: "completed", state: "completed" };
  }
  return { group: "other", state: "idle" };
}

function itemFromSession(
  session: PetSessionProjection,
  pending: PetPendingDecision | undefined,
): PetWorkItem {
  const { group, state } = classify(session, pending);
  const idPrefix =
    group === "pending"
      ? `pending:${session.agentSessionId}:${pending?.requestId ?? "self"}`
      : `${group}:${session.agentSessionId}`;
  return {
    id: idPrefix,
    group,
    state,
    workspace: session.workspaceDisplayName,
    title: session.title ?? session.workspaceDisplayName ?? session.agentSessionId.slice(-8),
    detail: pending?.title ?? session.summary,
    lastActivityAt: pending
      ? Math.max(session.lastActivityAt, pending.createdAt)
      : session.lastActivityAt,
    navigation: {
      agentSessionId: session.agentSessionId,
      requestId: pending?.requestId,
      routeGeneration: pending?.routeGeneration,
    },
  };
}

function pendingWithoutSession(pending: PetPendingDecision): PetWorkItem {
  return {
    id: `pending:${pending.agentSessionId}:${pending.requestId}`,
    group: "pending",
    state: "needs-action",
    title: pending.title,
    detail: pending.kind === "ask_user" ? "需要回答" : pending.toolName,
    lastActivityAt: pending.createdAt,
    navigation: {
      agentSessionId: pending.agentSessionId,
      requestId: pending.requestId,
      routeGeneration: pending.routeGeneration,
    },
  };
}

export function buildPetWorkMap(
  sessions: readonly PetSessionProjection[],
  pending: readonly PetPendingDecision[],
  options: {
    dismissedIds?: ReadonlySet<string>;
    excludedSessionIds?: ReadonlySet<string>;
    workspaceFilter?: string;
  } = {},
): PetWorkMap {
  const sessionIds = new Set(sessions.map((session) => session.agentSessionId));
  const pendingBySession = new Map<string, PetPendingDecision>();
  for (const decision of pending) {
    if (!pendingBySession.has(decision.agentSessionId)) {
      pendingBySession.set(decision.agentSessionId, decision);
    }
  }

  const items: PetWorkItem[] = [];
  for (const session of sessions) {
    if (options.excludedSessionIds?.has(session.agentSessionId)) continue;
    items.push(itemFromSession(session, pendingBySession.get(session.agentSessionId)));
  }
  for (const decision of pending) {
    if (options.excludedSessionIds?.has(decision.agentSessionId)) continue;
    if (!sessionIds.has(decision.agentSessionId)) items.push(pendingWithoutSession(decision));
  }

  const dismissedCount = items.filter((item) => options.dismissedIds?.has(item.id)).length;
  const included = items
    .filter((item) => !options.dismissedIds?.has(item.id))
    .filter(
      (item) => !options.workspaceFilter || item.workspace === options.workspaceFilter,
    );
  included.sort((left, right) => right.lastActivityAt - left.lastActivityAt);

  const counts = Object.fromEntries(
    GROUP_ORDER.map((group) => [group, included.filter((i) => i.group === group).length]),
  ) as Record<PetWorkGroup, number>;
  const itemIds = Object.fromEntries(
    GROUP_ORDER.map((group) => [
      group,
      included.filter((i) => i.group === group).map((i) => i.id),
    ]),
  ) as Record<PetWorkGroup, string[]>;

  const visible = GROUP_ORDER.flatMap((group) =>
    included.filter((item) => item.group === group).slice(0, DISPLAY_LIMITS[group]),
  );
  const groupsByWorkspace = new Map<string, PetWorkspaceWorkGroup>();
  for (const item of visible) {
    const key = item.workspace ?? "";
    const group = groupsByWorkspace.get(key) ?? {
      workspace: item.workspace,
      buckets: GROUP_ORDER.map((g) => ({ group: g, items: [] as PetWorkItem[] })),
      latestActivityAt: 0,
    };
    group.buckets.find((bucket) => bucket.group === item.group)!.items.push(item);
    group.latestActivityAt = Math.max(group.latestActivityAt, item.lastActivityAt);
    groupsByWorkspace.set(key, group);
  }

  return {
    groups: [...groupsByWorkspace.values()]
      .map((group) => ({
        ...group,
        buckets: group.buckets.filter((bucket) => bucket.items.length > 0),
      }))
      .sort((left, right) => right.latestActivityAt - left.latestActivityAt),
    counts,
    itemIds,
    dismissedCount,
    hiddenCount: included.length - visible.length,
    unclassifiedCount: 0,
  };
}
```

- [ ] 修旧用例:`petWorkMap.test.ts` 中引用旧字段(`map.counts.unfinished/optimization`、`group.unfinished`)的断言改为新分组名。逐个改:`unfinished`→按语义拆到 `running`/`pending`;`optimization`→删除(不再存在);`completed` 保持。运行时报错哪条改哪条,保持 fixture 不变。

- [ ] 跑测试确认通过:`cd packages/desktop && bun test src/renderer/pet/petWorkMap.test.ts`。预期全绿。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/pet/petWorkMap.ts packages/desktop/src/renderer/pet/petWorkMap.test.ts
git commit -m "$(cat <<'EOF'
refactor(desktop): classify Mimi work inbox by structured projection state

Replace the title/summary regex heuristics with pure state-based grouping
(running / pending / follow-up / completed / other). Unclassifiable sessions
land in "other" instead of being hidden, and the list supports a workspace
filter.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `PetWorkTree` 渲染五分组 + 「其他」展开 + i18n

**Files:**
- Modify: `packages/desktop/src/renderer/pet/PetWorkTree.tsx`（`BRANCH_META` L40-56、`WorkBranch` props `kind` L58-72、消费 `workMap.groups` L273-315、footer L328-338;`STATE_DOT`/`STATE_BADGE` L18-38 的 key 集合)
- Modify: `packages/desktop/src/renderer/pet/PetWorldPane.tsx`（`PetOverviewHeader` 统计 props L55-64,改为新分组计数)
- Modify: `packages/desktop/src/renderer/pet/PetOverviewHeader.tsx`（三个统计格 L116-148 → 复用为新语义计数)
- Modify: `packages/desktop/src/renderer/i18n/ns/pet.ts`（`work.branch` zh L43-47 / en L185-189;`work.state` zh L48-57 / en L190-199)
- Test: `packages/desktop/src/renderer/pet/PetWorkTree.test.tsx`（新增「其他」分组渲染断言)

**Steps:**

- [ ] 写失败测试:向 `PetWorkTree.test.tsx` 追加(该文件用 `renderToStaticMarkup`,沿用其现有 `workMap` fixture 构造方式;下例自带 fixture):

```ts
test("renders the other bucket and its i18n label without hiding items", () => {
  const workMap = {
    groups: [
      {
        workspace: "alpha",
        buckets: [{ group: "other" as const, items: [
          { id: "other:x", group: "other" as const, state: "idle" as const, workspace: "alpha",
            title: "闲置会话", lastActivityAt: 1, navigation: { agentSessionId: "x" } },
        ] }],
        latestActivityAt: 1,
      },
    ],
    counts: { running: 0, pending: 0, "follow-up": 0, completed: 0, other: 1 },
    itemIds: { running: [], pending: [], "follow-up": [], completed: [], other: ["other:x"] },
    dismissedCount: 0,
    hiddenCount: 0,
    unclassifiedCount: 0,
  };
  const html = renderToStaticMarkup(<PetWorkTree workMap={workMap} defaultOpen />);
  expect(html).toContain("闲置会话");
  expect(html).toContain("其他"); // pet.work.branch.other zh label
});
```

- [ ] 跑测试确认失败:`cd packages/desktop && bun test src/renderer/pet/PetWorkTree.test.tsx`。预期:`BRANCH_META` 无 `other` key → 运行期 `undefined` 解构报错或不含「其他」文本。

- [ ] 最小实现之一 — i18n。编辑 `packages/desktop/src/renderer/i18n/ns/pet.ts`,zh 段 `work.branch`(L43-47)替换为:
```ts
        branch: {
          running: "进行中",
          pending: "待决策",
          "follow-up": "待跟进",
          completed: "已完成",
          other: "其他",
        },
```
`work.state`(L48-57)替换为:
```ts
        state: {
          "needs-action": "待你处理",
          "follow-up": "待跟进",
          running: "进行中",
          queued: "排队中",
          failed: "失败待处理",
          cancelled: "已取消",
          completed: "已完成",
          idle: "未分类",
        },
```
en 段同理(L185-189 `branch`、L190-199 `state`):`running:"In progress"`, `pending:"Needs decision"`, `"follow-up":"Follow up"`, `completed:"Completed"`, `other:"Other"`;state 加 `idle:"Unclassified"`,删除 `optimization`。

- [ ] 最小实现之二 — `PetWorkTree.tsx`。把 `PetWorkKind` 引用改为 `PetWorkGroup`,并让分组渲染遍历 `group.buckets` 而非固定三个 `WorkBranch`：

  在 import 处(L16)改：
  ```ts
  import type { PetWorkGroup, PetWorkItem, PetWorkMap } from "./petWorkMap";
  ```
  `STATE_DOT`/`STATE_BADGE`(L18-38)把 key `optimization` 删除、新增 `idle`(复用 muted 色):`idle: "bg-muted-foreground"`(dot)/`idle: "bg-muted text-muted-foreground"`(badge)。
  `BRANCH_META`(L40-56)改为 `Record<PetWorkGroup, {...}>`,五个 key:
  ```ts
  const BRANCH_META: Record<PetWorkGroup, { Icon: LucideIcon; icon: string; count: string }> = {
    running: { Icon: CircleDot, icon: "bg-status-running/10 text-status-running", count: "bg-status-running/10 text-status-running" },
    pending: { Icon: CircleDot, icon: "bg-status-warn/10 text-status-warn", count: "bg-status-warn/10 text-status-warn" },
    "follow-up": { Icon: Sparkles, icon: "bg-status-warn/10 text-status-warn", count: "bg-status-warn/10 text-status-warn" },
    completed: { Icon: CheckCircle2, icon: "bg-status-ok/10 text-status-ok", count: "bg-status-ok/10 text-status-ok" },
    other: { Icon: Inbox, icon: "bg-muted text-muted-foreground", count: "bg-muted text-muted-foreground" },
  };
  ```
  `WorkBranch` 的 `kind: PetWorkKind` 改 `group: PetWorkGroup`,内部 `BRANCH_META[kind]`→`BRANCH_META[group]`,`t(\`pet.work.branch.${kind}\`)`→`t(\`pet.work.branch.${group}\`)`。
  分组渲染(L293-312)替换固定三个 `WorkBranch` 为:
  ```tsx
  <div className="space-y-0.5">
    {group.buckets.map((bucket) => (
      <WorkBranch
        key={bucket.group}
        group={bucket.group}
        items={bucket.items}
        onOpen={onOpen}
        onDismiss={onDismiss}
      />
    ))}
  </div>
  ```
  `itemCount`(L275-276)改为 `group.buckets.reduce((n, b) => n + b.items.length, 0)`;顶部 `visibleItemCount`(L178-182)同理改为遍历 `group.buckets`。footer(L328-338)去掉 `unclassifiedCount`(现恒为 0)分支,只保留 `hiddenCount`。`onClearCompleted` 仍用 `workMap.itemIds.completed`(Task 1 已保留该 key)。

- [ ] 最小实现之三 — `PetWorldPane.tsx` + `PetOverviewHeader.tsx`。`PetWorldPane`(L55-64)把三个计数改为:
  ```tsx
  <PetOverviewHeader
    runningCount={workMap.counts.running}
    pendingCount={workMap.counts.pending}
    followUpCount={workMap.counts["follow-up"]}
    ...
  />
  ```
  `PetOverviewHeader`(props L13-23、渲染 L116-148)把 `unfinishedCount/optimizationCount/completedCount` 三个改名为 `runningCount/pendingCount/followUpCount`,`data-pet-overview-stat` 与 label 键改用 `pet.overview.runningLabel`/`pendingLabel`/`followUpLabel`(在 pet.ts overview 段新增这三个 label,zh:「进行中/待决策/待跟进」,en 对应)。

- [ ] 跑测试确认通过:`cd packages/desktop && bun test src/renderer/pet/PetWorkTree.test.tsx src/renderer/pet/PetWorldPane.test.tsx src/renderer/pet/PetOverviewHeader.test.tsx src/renderer/i18n/dict.test.ts`。预期全绿(dict.test 校验 zh/en key 对齐)。旧 `PetWorldPane.test.tsx`/`PetOverviewHeader.test.tsx` 中引用旧 label 的断言按报错逐条改。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/pet/PetWorkTree.tsx packages/desktop/src/renderer/pet/PetWorldPane.tsx packages/desktop/src/renderer/pet/PetOverviewHeader.tsx packages/desktop/src/renderer/i18n/ns/pet.ts packages/desktop/src/renderer/pet/PetWorkTree.test.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): render the five structured Mimi work groups incl. "other"

Wire PetWorkTree / overview header / i18n to the new group model so previously
hidden idle sessions surface under "other".

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: core `SessionState.archivedAt` + SessionManager 归档读写原语

**Files:**
- Modify: `packages/core/src/types.ts`（`SessionState` 接口 L260-；在 `parentSessionId` 附近新增 `archivedAt?: number`）
- Modify: `packages/core/src/session/session-manager.ts`（新增 `setSessionArchived`/`readSessionArchivedAt`,靠 `setSessionWorkspace` L740-746 风格,复用 `updateSessionState` L1058)
- Test: `packages/core/src/session/session-manager.pet.test.ts`（临近已有 pet 相关 session-manager 测试;若不匹配则新建 `session-manager.archive.test.ts`)

**Steps:**

- [ ] 写失败测试:新建 `packages/core/src/session/session-manager.archive.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

function tempManager(): { manager: SessionManager; root: string } {
  const root = mkdtempSync(join(tmpdir(), "cs-archive-"));
  return { manager: new SessionManager(join(root, "sessions")), root };
}

describe("SessionManager archive marker", () => {
  test("archive sets a durable timestamp and unarchive clears it", () => {
    const { manager, root } = tempManager();
    try {
      const { state } = manager.create(join(root, "proj"));
      expect(manager.readSessionArchivedAt(state.sessionId)).toBeUndefined();

      manager.setSessionArchived(state.sessionId, 1_700_000_000_000);
      expect(manager.readSessionArchivedAt(state.sessionId)).toBe(1_700_000_000_000);

      manager.setSessionArchived(state.sessionId, undefined);
      expect(manager.readSessionArchivedAt(state.sessionId)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```
（`SessionManager.create` 的确切签名以文件为准:见 `session-manager.ts:504` 附近 `create(cwd, kind = "work")`;若返回结构不同,按实际 `{state,transcript}` 解构。)

- [ ] 跑测试确认失败:`cd packages/core && bun test src/session/session-manager.archive.test.ts`。预期:`readSessionArchivedAt`/`setSessionArchived` 不存在,类型/运行期报错。

- [ ] 最小实现之一 — `types.ts`。在 `SessionState` 的 `parentSessionId?: string | null;`(L328)之后插入:
```ts
  /**
   * Durable archival timestamp (ms). Absent = not archived. Generic session
   * lifecycle marker: list surfaces filter it out by default. Set/cleared via
   * SessionManager.setSessionArchived.
   */
  archivedAt?: number;
```

- [ ] 最小实现之二 — `session-manager.ts`。在 `setSessionWorkspace`(L740-746)之后新增:
```ts
  /** Read the durable archival timestamp; undefined = not archived / unprovable. */
  readSessionArchivedAt(sessionId: string): number | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return typeof state.archivedAt === "number" ? state.archivedAt : undefined;
    } catch {
      return undefined;
    }
  }

  /** Set (number) or clear (undefined) the durable archival marker. */
  setSessionArchived(sessionId: string, archivedAt: number | undefined): number {
    return this.updateSessionState(sessionId, { archivedAt });
  }
```
（`updateSessionState` 的 `Object.assign(state, partial)` L1068 会把 `archivedAt: undefined` 合并——`JSON.stringify` 会略去 `undefined` 键,达到清除效果。若需确保旧值被抹掉,`readPersistedState` 已重读最新盘面后 assign,undefined 写出即消失。`archivedAt` 不在 `SessionStateFieldPatch` 的 Omit 排除集 L77-84,天然可 patch。)

- [ ] 跑测试确认通过:`cd packages/core && bun test src/session/session-manager.archive.test.ts`。预期绿。回归:`bun test src/session/`。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/core/src/types.ts packages/core/src/session/session-manager.ts packages/core/src/session/session-manager.archive.test.ts
git commit -m "$(cat <<'EOF'
feat(core): durable session archival marker (SessionState.archivedAt)

Add a generic archivedAt field plus SessionManager.setSessionArchived /
readSessionArchivedAt, written through the existing field-level state merge.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `listDiskSessions` 读 `archivedAt`、默认过滤、`includeArchived` 开关

**Files:**
- Modify: `packages/server/src/sessions-service.ts`（`DiskSessionMeta` L145-155 加 `archivedAt?`;`listDiskSessions` opts L190-193 加 `includeArchived?`;主循环 L248-293 读并过滤;`nextCursor` 语义不变）
- Test: `packages/server/src/sessions-service.disk.test.ts`（沿用其 fake-disk 会话构造 helper）

**Steps:**

- [ ] 写失败测试:先读 `sessions-service.disk.test.ts` 顶部,复用其写 `state.json` 的 helper(它构造 `<baseDir>/<id>/state.json`,含 `parentSessionId:null, origin:"desktop", cwd`)。追加:

```ts
test("archived sessions are filtered by default and included on demand", async () => {
  const base = await makeDiskSessions([
    { id: "live", state: { parentSessionId: null, origin: "desktop", cwd: "", status: "completed" } },
    { id: "gone", state: { parentSessionId: null, origin: "desktop", cwd: "", status: "completed", archivedAt: 123 } },
  ]);
  const dflt = await listDiskSessions({ limit: 50 }, base);
  expect(dflt.sessions.map((s) => s.id)).toEqual(["live"]);

  const all = await listDiskSessions({ limit: 50, includeArchived: true }, base);
  expect(all.sessions.map((s) => s.id).sort()).toEqual(["gone", "live"]);
  expect(all.sessions.find((s) => s.id === "gone")?.archivedAt).toBe(123);
});
```
（`makeDiskSessions` 用测试文件里现有的 fake-disk helper 名替换;若 helper 叫别的名,照抄其签名。`cwd:""` 避免 `pathExists` 过滤。）

- [ ] 跑测试确认失败:`cd packages/server && bun test src/sessions-service.disk.test.ts`。预期:归档 session 未被过滤(默认结果含 `gone`),且 `archivedAt` 字段不存在。

- [ ] 最小实现:
  - `DiskSessionMeta`(L145-155)在 `status?` 后加:`/** Durable archival timestamp; absent = not archived. */ archivedAt?: number;`
  - `listDiskSessions` 签名 opts(L191)改为 `opts: { limit: number; cursor?: string; includeArchived?: boolean }`。
  - 主循环:在读到 `state` 后、`sessions.push` 前(L259 `if (state.parentSessionId) continue;` 之后合适位置)加:
    ```ts
    const archivedAt = typeof state.archivedAt === "number" ? state.archivedAt : undefined;
    if (archivedAt !== undefined && !opts.includeArchived) continue;
    ```
  - `sessions.push({...})` 里增加 `...(archivedAt !== undefined ? { archivedAt } : {})`。
  - `nextCursor` 逻辑不变(过滤发生在 push 前,游标基于 `dirs` 索引 `i`,与过滤无关——保持现状)。

- [ ] 跑测试确认通过:`cd packages/server && bun test src/sessions-service.disk.test.ts src/sessions-service.test.ts`。预期绿。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/server/src/sessions-service.ts packages/server/src/sessions-service.disk.test.ts
git commit -m "$(cat <<'EOF'
feat(server): filter archived sessions from listDiskSessions by default

Read state.json archivedAt, drop archived rows unless includeArchived is set,
and surface the timestamp on DiskSessionMeta.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: dismiss 状态迁到 main `PetMetadataStore`

**Files:**
- Modify: `packages/desktop/src/main/pet/pet-metadata-store.ts`（`LocalPetMetadata` L5-11 加 `dismissedWorkItemIds`;`loadOrCreate` 校验 L32-39;新增 `setDismissed`/`getDismissed`)
- Test: `packages/desktop/src/main/pet/pet-metadata-store.test.ts`（沿用其 `mkdtemp` + 注入 `now`/`createSessionId` 风格)

**Steps:**

- [ ] 写失败测试:向 `pet-metadata-store.test.ts` 追加:

```ts
test("persists dismissed work-item ids across reloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-pet-metadata-"));
  try {
    const filePath = join(root, "pet", "metadata.json");
    const store = new PetMetadataStore(filePath, { now: () => 1, createSessionId: () => "pet-x" });
    await store.ensure();
    await store.setDismissed(["completed:a", "follow-up:b"]);
    expect([...(await store.getDismissed())]).toEqual(["completed:a", "follow-up:b"]);

    const reopened = new PetMetadataStore(filePath);
    expect([...(await reopened.getDismissed())]).toEqual(["completed:a", "follow-up:b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] 跑测试确认失败:`cd packages/desktop && bun test src/main/pet/pet-metadata-store.test.ts`。预期:`setDismissed`/`getDismissed` 不存在。

- [ ] 最小实现:编辑 `pet-metadata-store.ts`。
  - `LocalPetMetadata`(L5-11)加字段:`dismissedWorkItemIds?: string[];`
  - `loadOrCreate` 校验通过后,把 `parsed.dismissedWorkItemIds` 归一(限长/去重),挂到返回对象。校验块(L32-41)保持只校验核心 4 字段;新增一行归一:在 `return parsed as LocalPetMetadata;` 前改为
    ```ts
    return {
      ...(parsed as LocalPetMetadata),
      dismissedWorkItemIds: normalizeDismissed(parsed.dismissedWorkItemIds),
    };
    ```
  - 顶部加纯函数(上限 1000、每 id ≤512,与旧 `petWorkInbox.ts` 规则一致):
    ```ts
    const MAX_DISMISSED = 1_000;
    function normalizeDismissed(value: unknown): string[] {
      if (!Array.isArray(value)) return [];
      return [
        ...new Set(
          value.filter(
            (v): v is string => typeof v === "string" && v.length > 0 && v.length <= 512,
          ),
        ),
      ].slice(-MAX_DISMISSED);
    }
    ```
  - 新增写队列 + 方法(仿 `PetReceiptStore` 的原子 rename 写):
    ```ts
    private writeQueue = Promise.resolve();

    async getDismissed(): Promise<Set<string>> {
      const meta = await this.ensure();
      return new Set(meta.dismissedWorkItemIds ?? []);
    }

    async setDismissed(ids: readonly string[]): Promise<void> {
      const meta = await this.ensure();
      const next = normalizeDismissed(ids);
      this.current = Promise.resolve({ ...meta, dismissedWorkItemIds: next });
      const snapshot = await this.current;
      this.writeQueue = this.writeQueue.then(() => this.persist(snapshot)).catch(() => {});
      return this.writeQueue;
    }

    private async persist(metadata: LocalPetMetadata): Promise<void> {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    }
    ```

- [ ] 跑测试确认通过:`cd packages/desktop && bun test src/main/pet/pet-metadata-store.test.ts`。预期绿。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/main/pet/pet-metadata-store.ts packages/desktop/src/main/pet/pet-metadata-store.test.ts
git commit -m "$(cat <<'EOF'
feat(desktop): persist Mimi work-inbox dismissals in main pet metadata store

Add dismissedWorkItemIds to LocalPetMetadata with atomic get/set, so dismissals
survive across renderer windows and reloads.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: snapshot/delta 携带 dismissedIds;renderer 读盘优先、localStorage 仅缓存

**Files:**
- Modify: `packages/desktop/src/preload/pet-api.ts`（`PetProjectionSnapshot` L51-58 加 `dismissedWorkItemIds: string[]`;`PetProjectionEvent` L173-181 加 `{ kind: "dismissed-changed"; dismissedWorkItemIds: string[] }`;`PetApi` L183-200 加 `setDismissed(ids)`/`restoreDismissed()`;`createPetApi` L209-262 加两个 invoke 到新 channel)
- Modify: `packages/desktop/src/main/pet/pet-state-aggregator.ts`（构造函数注入 `dismissedProvider`;`getSnapshot` L266-277 附带 `dismissedWorkItemIds`;新增 `setDismissedIds`/emit `dismissed-changed`)
- Modify: `packages/desktop/src/main/pet/pet-ipc.ts`（channel 常量 L11-19 加 `PET_DISMISS_CHANNEL`/`PET_RESTORE_CHANNEL`;`registerPetIpc` 加两个 handler)
- Modify: `packages/desktop/src/main/index.ts`（L1008 `new PetStateAggregator` 注入 `petMetadata` 的 dismissed provider;L1056 `registerPetIpc` 传 `metadata`）
- Modify: `packages/desktop/src/renderer/pet/petStateReducer.ts`（`applyProjectionEvent` L55-96 处理 `dismissed-changed`;snapshot 存 `dismissedWorkItemIds`）
- Modify: `packages/desktop/src/renderer/pet/PetWorldPane.tsx`（L26-44 dismissed 状态改为读 `projection.dismissedWorkItemIds`,localStorage 仅初始缓存;dismiss/restore 调 `window.codeshell.pet.setDismissed/restoreDismissed`)
- Modify: `packages/desktop/src/renderer/pet/petWorkInbox.ts`（保留为缓存层:load 仍读 localStorage 作为首帧回退,save 仍写)
- Test: `packages/desktop/src/main/pet/pet-state-aggregator.test.ts`(dismissed 下发);`packages/desktop/src/renderer/pet/PetStateProvider.test.tsx`(delta 应用)

**Steps:**

- [ ] 写失败测试(main):向 `pet-state-aggregator.test.ts` 追加,复用其 `FakeBridge`/`pagedCatalog`:
```ts
test("snapshot carries dismissed ids and setDismissedIds emits a delta", async () => {
  const bridge = new FakeBridge();
  const dismissed = new Set<string>(["completed:a"]);
  const aggregator = new PetStateAggregator({
    bridge,
    listDiskSessions: pagedCatalog([disk("one")]).list,
    now: () => 3_000,
    dismissedProvider: {
      get: async () => dismissed,
      set: async (ids) => { dismissed.clear(); for (const id of ids) dismissed.add(id); },
    },
  });
  await aggregator.start();
  expect(aggregator.getSnapshot().dismissedWorkItemIds).toEqual(["completed:a"]);

  const events: DesktopPetProjectionEvent[] = [];
  aggregator.subscribe((e) => events.push(e));
  await aggregator.setDismissedIds(["follow-up:b"]);
  expect(aggregator.getSnapshot().dismissedWorkItemIds).toEqual(["follow-up:b"]);
  expect(events.some((e) => e.kind === "dismissed-changed")).toBe(true);
});
```

- [ ] 跑测试确认失败:`cd packages/desktop && bun test src/main/pet/pet-state-aggregator.test.ts`。预期:构造选项无 `dismissedProvider`、`getSnapshot().dismissedWorkItemIds` undefined、无 `setDismissedIds`。

- [ ] 最小实现(main aggregator):
  - `PetStateAggregatorOptions`(L100-105)加:`dismissedProvider?: { get(): Promise<Set<string>>; set(ids: readonly string[]): Promise<void> };`
  - 字段:`private dismissedIds = new Set<string>();`
  - `start()`(L227 附近,`refreshCatalog` 前)加 `this.dismissedIds = (await this.options.dismissedProvider?.get()) ?? new Set();`
  - `getSnapshot()` 返回对象(L266-277)加:`dismissedWorkItemIds: [...this.dismissedIds],`。`DesktopPetProjectionSnapshot` 类型加该字段。
  - 新增方法:
    ```ts
    async setDismissedIds(ids: readonly string[]): Promise<void> {
      this.dismissedIds = new Set(ids);
      await this.options.dismissedProvider?.set([...this.dismissedIds]);
      this.emit({ kind: "dismissed-changed", dismissedWorkItemIds: [...this.dismissedIds] });
    }
    ```
  - `DesktopPetProjectionEvent`/`emit` 支持新 `dismissed-changed` 变体(在其联合类型加一支)。

- [ ] 最小实现(pet-api 类型 + IPC):
  - `pet-api.ts`:`PetProjectionSnapshot` 加 `dismissedWorkItemIds: string[]`;`PetProjectionEvent` 联合加 `| { kind: "dismissed-changed"; dismissedWorkItemIds: string[] }`;`PetApi` 加 `setDismissed(ids: string[]): Promise<{ ok: true }>` 与 `restoreDismissed(): Promise<{ ok: true }>`;`createPetApi` 加 `setDismissed: (ids) => ipcRenderer.invoke("pet:set-dismissed", ids)`、`restoreDismissed: () => ipcRenderer.invoke("pet:restore-dismissed")`。
  - `pet-ipc.ts`:加常量 `PET_DISMISS_CHANNEL = "pet:set-dismissed"`、`PET_RESTORE_CHANNEL = "pet:restore-dismissed"`;`registerPetIpc` 参数加 `metadata?: { setDismissed(ids: readonly string[]): Promise<void> }`;两个 handler:set 读入 ids(用与 `parseDispatchCommand` 同风格的 string[] 校验,限 1000 项/每项 ≤512)后调 `aggregator.setDismissedIds(ids)`;restore 调 `aggregator.setDismissedIds([])`。
  - `index.ts`:L1008 `new PetStateAggregator({ bridge, listDiskSessions, dismissedProvider: { get: () => petMetadata.getDismissed(), set: (ids) => petMetadata.setDismissed([...ids]) } })`——注意 `petMetadata` 在 L1010 才创建,需把 `petMetadata` 的构造提前到 aggregator 之前。L1056 `registerPetIpc({ ..., metadata: { setDismissed: (ids) => aggregator.setDismissedIds(ids) } })`(经 aggregator 走,单一真源)。

- [ ] 最小实现(renderer):
  - `petStateReducer.ts`:snapshot 状态里存 `dismissedWorkItemIds`(从 `snapshot.dismissedWorkItemIds`);`applyProjectionEvent`(L55-96)加 `case "dismissed-changed": return { ...snapshot, dismissedWorkItemIds: event.dismissedWorkItemIds };`。注意 `dismissed-changed` 不参与 version 递增校验的 gap 逻辑——它由 aggregator 的 `emit` 正常 stamp version,走既有 `version === snapshot.version + 1` 路径即可(aggregator emit 已 ++version)。
  - `PetWorldPane.tsx`(L26-44):`dismissedIds` 改为 `new Set(projection?.dismissedWorkItemIds ?? loadDismissedPetWorkItemIds())`(盘面优先,localStorage 仅首帧/回退)。`dismissItems` 改为:算出新集合 → `saveDismissedPetWorkItemIds(next)`(仍写缓存)→ `void window.codeshell.pet.setDismissed([...next])`;不再本地 `setDismissedIds` state(等 delta 回流)。`restoreDismissed` 改为 `saveDismissedPetWorkItemIds(new Set()); void window.codeshell.pet.restoreDismissed();`。移除本地 `useState(loadDismissed...)`,dismissed 完全由 projection 驱动;`loadDismissedPetWorkItemIds()` 仅在 `projection` 为 null 时作回退。
  - `petWorkInbox.ts` 保留不动(仍是缓存读写)。

- [ ] 写失败测试(renderer):向 `PetStateProvider.test.tsx` 追加一个 mini-DOM 用例(沿用其 `ensureMiniDom`/`fake PetApi`/`act`),让 `getSnapshot` 返回带 `dismissedWorkItemIds:["x"]` 的 snapshot,再 `onProjectionEvent` 推 `{kind:"dismissed-changed", dismissedWorkItemIds:["y"], version: snap.version+1, generation, observedAt}`,断言 consumer 读到的 `projection.dismissedWorkItemIds` 变为 `["y"]`。

- [ ] 跑测试确认通过:`cd packages/desktop && bun test src/main/pet/pet-state-aggregator.test.ts src/renderer/pet/PetStateProvider.test.tsx src/preload/pet-contract.test.ts`。预期绿。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/preload/pet-api.ts packages/desktop/src/main/pet/pet-state-aggregator.ts packages/desktop/src/main/pet/pet-ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/renderer/pet/petStateReducer.ts packages/desktop/src/renderer/pet/PetWorldPane.tsx packages/desktop/src/main/pet/pet-state-aggregator.test.ts packages/desktop/src/renderer/pet/PetStateProvider.test.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): sync Mimi work-inbox dismissals over the pet snapshot channel

Dismissals now live in main pet metadata and flow to every renderer via the
snapshot + a dismissed-changed delta; localStorage is only a first-paint cache.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 完成+7天无活动自动归档触发 + 复用候选携带 status

**Files:**
- Create: `packages/desktop/src/main/pet/pet-auto-archive.ts`（纯函数 `selectSessionsToArchive` + 触发封装)
- Create: `packages/desktop/src/main/pet/pet-auto-archive.test.ts`
- Modify: `packages/desktop/src/main/index.ts`（`listReusableSessions` L1023-1038 显式 `includeArchived:false` + status 已在 map;auto-archive 接线到 `aggregator.start()` 后 / `refreshCatalog` 时机）

**Steps:**

- [ ] 写失败测试:新建 `pet-auto-archive.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { selectSessionsToArchive } from "./pet-auto-archive.js";

const DAY = 24 * 60 * 60 * 1000;

describe("selectSessionsToArchive", () => {
  const now = 10 * DAY;
  test("archives completed sessions idle for >= 7 days, skips the rest", () => {
    const ids = selectSessionsToArchive(
      [
        { engineSessionId: "old-done", status: "completed", updatedAt: now - 8 * DAY },
        { engineSessionId: "fresh-done", status: "completed", updatedAt: now - 2 * DAY },
        { engineSessionId: "old-active", status: "active", updatedAt: now - 8 * DAY },
        { engineSessionId: "old-failed", status: "failed", updatedAt: now - 8 * DAY },
        { engineSessionId: "already", status: "completed", updatedAt: now - 8 * DAY, archivedAt: 1 },
      ],
      { now, idleDays: 7 },
    );
    expect(ids).toEqual(["old-done"]);
  });
});
```

- [ ] 跑测试确认失败:`cd packages/desktop && bun test src/main/pet/pet-auto-archive.test.ts`。预期:模块不存在。

- [ ] 最小实现:新建 `pet-auto-archive.ts`:
```ts
export interface ArchiveCandidate {
  engineSessionId: string;
  status?: "active" | "paused" | "completed" | "failed" | "cancelled";
  updatedAt: number;
  archivedAt?: number;
}

/**
 * Pure policy: a session is auto-archived when its durable status is
 * "completed", it is not already archived, and it has been idle for at least
 * idleDays. Failed/cancelled/active/paused are never auto-archived.
 */
export function selectSessionsToArchive(
  sessions: readonly ArchiveCandidate[],
  opts: { now: number; idleDays: number },
): string[] {
  const cutoff = opts.now - opts.idleDays * 24 * 60 * 60 * 1000;
  return sessions
    .filter(
      (s) =>
        s.status === "completed" &&
        s.archivedAt === undefined &&
        s.updatedAt <= cutoff,
    )
    .map((s) => s.engineSessionId);
}
```

- [ ] 接线(main index.ts):新增一个封装,在 `aggregator.start()` 之后(`petInitialization` async IIFE L1051-1055 内、`aggregator.start()` 之后)跑一次:用 `listDiskSessions({ limit: 1000, includeArchived: true })` 拉全量(含已归档以便判断 `archivedAt`),`selectSessionsToArchive(sessions, { now: Date.now(), idleDays: 7 })`,对每个 id 调核心 `setSessionArchived`。注意:desktop main 无直接 Engine/SessionManager 句柄——归档写盘需经 worker。评估两条路,选阻力小者:
  1. **优先**:desktop main 已有 `bridge`(worker RPC)。若 worker 侧已暴露/易加一个 `sessions/archive` query 调 `engine.getSessionManager().setSessionArchived`,则 main 经 `bridge.requestWorker("agent/query", { type: "archive_session", sessionId, archivedAt })`。Task 10 已为 B1 加通用 query 路;此处复用同一 query 分派模式加 `archive_session` 分支(调 `sessionManager.setSessionArchived`)。
  2. 若 worker 生命周期不保证在场,则直接用 `@cjhyy/code-shell-server` 侧的一个新 `archiveDiskSession(sessionId, archivedAt, baseDir?)`,它读改写 `state.json`(与 `listDiskSessions` 同 baseDir)——server 已可读该目录。
  实现选 (2) 作为 main 侧不依赖 worker 存活的稳妥落点:在 `sessions-service.ts` 加 `archiveDiskSession(sessionId, archivedAt, baseDir=sessionsRoot())`(原子 rename 写 state.json 的 `archivedAt`),main 直接调。为此在 Task 4 的 commit 之外补一个小函数(可并入本任务)。写对应 server 单测。
  - `listReusableSessions`(L1023-1038):`listDiskSessions({ limit: 100 })` 保持不传 `includeArchived`(默认过滤归档)——归档 session 自然退出复用候选;map 已带 `status`(L1036),候选描述(pet-dispatch L385-389)已用 status,无需改。仅确认默认过滤即达成「已归档退出、已完成未归档保留」。

- [ ] 写 server 测试(若走 (2)):`sessions-service.disk.test.ts` 加 `archiveDiskSession` 往返用例(archive 后默认 list 不含、`includeArchived` 含且 `archivedAt` 正确;unarchive 传 undefined 后复现)。

- [ ] 跑测试确认通过:`cd packages/desktop && bun test src/main/pet/pet-auto-archive.test.ts && cd ../server && bun test src/sessions-service.disk.test.ts`。预期绿。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/main/pet/pet-auto-archive.ts packages/desktop/src/main/pet/pet-auto-archive.test.ts packages/desktop/src/main/index.ts packages/server/src/sessions-service.ts packages/server/src/sessions-service.disk.test.ts
git commit -m "$(cat <<'EOF'
feat(desktop): auto-archive completed Mimi work sessions idle for 7+ days

Add a pure archival policy plus a server-side archiveDiskSession writer, run on
pet init; archived sessions leave the reuse-candidate pool automatically.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `refreshCatalog` 全量翻页改 mtime 增量游标

**Files:**
- Modify: `packages/desktop/src/main/pet/pet-state-aggregator.ts`（`refreshCatalog` L293-320;新增 `lastRefreshCursor`/高水位 mtime 字段）
- Test: `packages/desktop/src/main/pet/pet-state-aggregator.test.ts`

**Steps:**

- [ ] 写失败测试:向 `pet-state-aggregator.test.ts` 追加,复用 `pagedCatalog`(它按 mtime 排序、支持 cursor)。断言第二次 `refreshCatalog` 只翻新于上次高水位的页:

```ts
test("incremental refresh only pages sessions newer than the last high-water mark", async () => {
  const bridge = new FakeBridge();
  const catalog = pagedCatalog([
    disk("a", { updatedAt: 100 }),
    disk("b", { updatedAt: 200 }),
  ]);
  const aggregator = new PetStateAggregator({
    bridge,
    listDiskSessions: catalog.list,
    pageSize: 10,
    now: () => 5_000,
  });
  await aggregator.start();
  catalog.callArgs.length = 0; // reset the recorded (limit,cursor) calls

  catalog.replace([disk("a", { updatedAt: 100 }), disk("b", { updatedAt: 200 }), disk("c", { updatedAt: 300 })]);
  await aggregator.refreshCatalog(false);

  // Incremental refresh must stop once it reaches sessions at/below the prior
  // high-water mtime (200): it pages c (300) then halts, never re-reading a/b.
  expect(aggregator.getSnapshot().sessions.some((s) => s.agentSessionId === "c")).toBe(true);
  expect(catalog.readSessionIds).not.toContain("a");
});
```
（`pagedCatalog` 需先补两个探针:`callArgs` 记录每次入参、`readSessionIds` 记录被读的 id。若现 helper 无这些,先在 test 文件的 `pagedCatalog` 里加。这属于测试脚手架,可在本任务内改。）

- [ ] 跑测试确认失败:`cd packages/desktop && bun test src/main/pet/pet-state-aggregator.test.ts`。预期:当前 `refreshCatalog` 每次全量翻页并 `clear()`,会重读 a/b,断言失败。

- [ ] 最小实现:`refreshCatalog`(L293-320)改为增量。核心思路(保守、正确性优先):记录上次刷新的**高水位 mtime**(catalog 里最大的 `updatedAt`),下次翻页遇到 `updatedAt <= 高水位` 且已存在于 `diskSessions` 的项即停止翻页(因 `listDiskSessions` 是 mtime 降序,新会话必在前面);把新/变动项 upsert 进现有 `diskSessions`/`diskBindings` 而非 `clear()` 重建。删除处理:mtime 增量无法感知磁盘删除,故保留一条低频兜底——`resolveNavigation`(L285)与 `session-remove` delta(L405)已有的 `refreshCatalog` 调用改用一个 `refreshCatalog(emit, { full: true })` 全量分支(仍会 clear 重建,覆盖删除)。即:
  ```ts
  async refreshCatalog(emit = true, opts: { full?: boolean } = {}): Promise<void> {
    const observedAt = this.now();
    const full = opts.full ?? this.lastHighWaterMtime === undefined;
    let cursor: string | undefined;
    const next = full ? new Map<string, DesktopPetSession>() : new Map(this.diskSessions);
    const nextBindings = full ? new Map<string, PetNavigationTarget>() : new Map(this.diskBindings);
    let newHighWater = full ? 0 : this.lastHighWaterMtime!;
    pager: do {
      const page = await this.options.listDiskSessions({ limit: this.pageSize, cursor });
      for (const session of page.sessions) {
        // Incremental: once we reach a session at/below the prior high-water
        // mark that we already hold, everything after it is older/unchanged.
        if (!full && session.updatedAt <= this.lastHighWaterMtime! &&
            this.diskSessions.has(session.engineSessionId)) {
          break pager;
        }
        next.set(session.engineSessionId, diskProjection(session, observedAt));
        nextBindings.set(session.engineSessionId, {
          uiSessionId: session.id,
          engineSessionId: session.engineSessionId,
          projectPath: session.cwd || null,
          title: bounded(session.title, MAX_TITLE_LENGTH) ?? session.id,
          updatedAt: session.updatedAt,
          origin: session.origin,
          status: session.status,
        });
        newHighWater = Math.max(newHighWater, session.updatedAt);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    this.diskSessions.clear();
    this.diskBindings.clear();
    for (const [id, s] of next) this.diskSessions.set(id, s);
    for (const [id, t] of nextBindings) this.diskBindings.set(id, t);
    this.lastHighWaterMtime = newHighWater;
    this.observedAt = observedAt;
    if (emit) this.emit({ kind: "reset" });
  }
  ```
  加字段 `private lastHighWaterMtime: number | undefined;`。`resolveNavigation`(L286)与 `session-remove` 后的调用(L405)改为 `this.refreshCatalog(false, { full: true })`,保证删除被感知;`start()`(L228)首刷天然 full(`lastHighWaterMtime===undefined`)。

- [ ] 跑测试确认通过:`cd packages/desktop && bun test src/main/pet/pet-state-aggregator.test.ts`。预期新增用例 + 原有全部绿(原有 "reads every disk page" 用例走首刷 full 分支,不受影响)。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/main/pet/pet-state-aggregator.ts packages/desktop/src/main/pet/pet-state-aggregator.test.ts
git commit -m "$(cat <<'EOF'
perf(desktop): incremental Mimi catalog refresh via mtime high-water cursor

Stop re-paging the entire disk catalog on every refresh; page only sessions
newer than the last high-water mtime, keeping a full pass for delete-aware paths.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: core 通用「区间归档」原语 `ContextManager.summarizeRange`

**Files:**
- Modify: `packages/core/src/context/manager.ts`（新增 `summarizeRange(messages, range, opts)`,复用现有 `summarizeFn` L122/`buildSummarizationPrompt`/`applySummaryCompaction` L297 组件;`CompactStrategy` L102 加 `"range"`)
- Test: `packages/core/src/context/manager.test.ts`（或临近 context 测试;沿用其 fake `summarizeFn` 注入风格)

**Steps:**

- [ ] 先读 `packages/core/src/context/manager.test.ts` 与 `applySummaryCompaction`(在 `manager.ts` import 的 compaction 模块)确认 `Message` 形状与 `setSummarizeFn` 注入方式,再写测试。

- [ ] 写失败测试:新增用例,断言 `summarizeRange` 只对指定**索引区间** `[start, end)` 的消息生成一条摘要替换,区间外原样保留:

```ts
test("summarizeRange replaces only the given index window with one summary", async () => {
  const cm = new ContextManager({ maxTokens: 100_000 });
  cm.setSummarizeFn(async () => "SUMMARY: three middle turns condensed.");
  const messages = [
    { role: "user", content: "sys/context" },
    { role: "user", content: "keep-before" },
    { role: "assistant", content: "turn-1" },
    { role: "user", content: "turn-2" },
    { role: "assistant", content: "turn-3" },
    { role: "user", content: "keep-after" },
  ] as unknown as Message[];

  const out = await cm.summarizeRange(messages, { start: 2, end: 5 });
  const texts = out.map((m) => String((m as any).content));
  expect(texts[0]).toContain("sys/context");
  expect(texts[1]).toContain("keep-before");
  expect(texts.some((t) => t.includes("SUMMARY: three middle turns"))).toBe(true);
  expect(texts.at(-1)).toContain("keep-after");
  expect(texts.some((t) => t === "turn-2")).toBe(false); // range collapsed
});
```
（若仓库 `Message` 形状不同,以 `manager.test.ts` 现有 fixture 为准替换 content 结构;断言逻辑不变。）

- [ ] 跑测试确认失败:`cd packages/core && bun test src/context/manager.test.ts`。预期:`summarizeRange` 不存在。

- [ ] 最小实现:在 `manager.ts` 加公有方法(复用已有私有组件;不引入 pet 概念,纯按索引区间):
```ts
  /**
   * Generic range archival: summarize a caller-chosen contiguous index window
   * [range.start, range.end) into a single anchored summary message, leaving
   * everything outside the window untouched. Unlike manage()/forceSummarize,
   * the window is caller-specified, not derived from a pressure heuristic. If
   * no summarizeFn is set or the summary is empty, the input is returned
   * unchanged. This is the primitive topic-segment archival consumes.
   */
  async summarizeRange(
    messages: Message[],
    range: { start: number; end: number },
    opts: { signal?: AbortSignal } = {},
  ): Promise<Message[]> {
    const start = Math.max(0, Math.min(range.start, messages.length));
    const end = Math.max(start, Math.min(range.end, messages.length));
    if (!this.summarizeFn || end - start < 1) return messages;
    const window = messages.slice(start, end);
    const priorSummary = extractAnchoredSummary(messages) ?? this.lastSummary;
    const prompt = buildSummarizationPrompt(window, priorSummary);
    const summary = await this.summarizeFn(prompt, opts.signal);
    if (!summary || summary.length <= 50) return messages;
    this.lastSummary = summary;
    const summaryMessage = buildAnchoredSummaryMessage(summary, this.transcriptPath);
    const out = [...messages.slice(0, start), summaryMessage, ...messages.slice(end)];
    this.onCompact?.({
      strategy: "range",
      before: this.estimateTokensHybrid(messages),
      after: this.estimateTokensHybrid(out),
    });
    return out;
  }
```
  其中 `buildAnchoredSummaryMessage(summary, transcriptPath)` 若 compaction 模块未直接导出,则用 `applySummaryCompaction` 的构造逻辑抽一个小 helper,或直接复用它对「一条 summary 消息」的封装形式(读该模块确认后取最贴近者;两者都产出与 `extractAnchoredSummary` 可识别的锚定摘要,保证 rolling summary 一致)。`CompactStrategy`(L102)联合加 `"range"`。

- [ ] 跑测试确认通过:`cd packages/core && bun test src/context/manager.test.ts`。预期绿。回归:`bun test src/context/`。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/core/src/context/manager.ts packages/core/src/context/manager.test.ts
git commit -m "$(cat <<'EOF'
feat(core): generic range-archival primitive ContextManager.summarizeRange

Summarize a caller-specified contiguous message window into one anchored
summary, leaving the rest untouched — the seam topic-segment archival needs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: engine facade `archiveTurnRange` + protocol `archive_range` query

**Files:**
- Modify: `packages/core/src/engine/engine.ts`（新增 `archiveTurnRange(sessionId, range)`,仿 `forceCompact` L3635-3722 的 sessionId 解析 / summarizeFn 装配 / compactedMessagesBySession 缓存;调 `contextManager.summarizeRange`)
- Modify: `packages/core/src/protocol/server.ts`（`handleQuery` L2371 的 switch 加 `case "archive_range"`,仿 `compact` L2484-2568 的会话解析 + 结果响应）
- Modify: `packages/core/src/index.extension.ts`（若需从 `/extension` 触达该 query 的类型;实际触发经 worker RPC,pet 不直接 import engine)
- Test: `packages/core/src/engine/engine.compact.test.ts`（或临近 engine 测试,沿用其 in-process engine 构造)

**Steps:**

- [ ] 读 `engine.compact.test.ts`(或含 `forceCompact` 的 engine 测试)确认 in-process engine 构造 + 跑一轮后取 transcript 的方式,以匹配风格。

- [ ] 写失败测试:构造一个 engine、跑够几轮产生 transcript,调 `engine.archiveTurnRange(sessionId, { start, end })`,断言返回 `{ before, after }` 且 `after < before`(区间被压缩),并断言后续 `forceCompact`/resume 使用的是压缩后的消息(经 `compactedMessagesBySession`)。测试代码按邻近 `forceCompact` 测试的既有 harness 改写(engine 构造、run、断言 token 统计),此处给出断言骨架:

```ts
test("archiveTurnRange collapses the given turn window and caches the result", async () => {
  const engine = /* build in-process engine per neighbouring forceCompact test */;
  const sessionId = /* run a few turns */;
  const result = await engine.archiveTurnRange(sessionId, { start: 1, end: 4 });
  expect(result.after).toBeLessThan(result.before);
});
```

- [ ] 跑测试确认失败:`cd packages/core && bun test src/engine/engine.compact.test.ts`。预期:`archiveTurnRange` 不存在。

- [ ] 最小实现(engine):新增 `archiveTurnRange`,复用 `forceCompact` 的前半段(sessionId 解析、`ContextManager` 懒建、`setTranscriptPath`、`initReplacementStateFromMessages`、`buildSummarizeFn(primaryClient, recordCompactUsage)`),但调用 `contextManager.summarizeRange(sourceMessages, range)` 而非 `forceSummarize`:
```ts
  async archiveTurnRange(
    sessionId: string,
    range: { start: number; end: number },
  ): Promise<{ before: number; after: number }> {
    const effectiveSessionId = sessionId ?? this.lastSessionId;
    if (!effectiveSessionId) return { before: 0, after: 0 };
    const session = this.sessionManager.resume(effectiveSessionId);
    const sourceMessages =
      this.compactedMessagesBySession.get(effectiveSessionId) ?? session.transcript.toMessages();
    const before = estimateTokens(sourceMessages);
    // (reuse forceCompact's contextManager build + summarizeFn wiring here)
    const contextManager = /* same lazy build as forceCompact */;
    /* setTranscriptPath / initReplacementStateFromMessages / setSummarizeFn(buildSummarizeFn(...)) */
    const out = await contextManager.summarizeRange(sourceMessages, range);
    const after = estimateTokens(out);
    this.compactedMessagesBySession.set(effectiveSessionId, out);
    this.lastSessionId = effectiveSessionId;
    this.lastMessages = out;
    return { before, after };
  }
```
  （为避免重复,可把 `forceCompact` 里 contextManager+summarizeFn 装配抽一个私有 `prepareContextManagerFor(effectiveSessionId, session, sourceMessages)`,两处共用;这属于 core 内部去重,不改行为。）

- [ ] 最小实现(protocol):`handleQuery` 的 switch 加:
```ts
      case "archive_range": {
        const sid = typeof params.sessionId === "string" ? params.sessionId : undefined;
        const start = Number(params.start);
        const end = Number(params.end);
        const eng = /* resolve engine like the compact case */;
        if (!eng || !sid || !Number.isFinite(start) || !Number.isFinite(end)) {
          this.transport.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, "archive_range requires sessionId,start,end"));
          return;
        }
        try {
          const result = await eng.archiveTurnRange(sid, { start, end });
          this.transport.send(createResponse(req.id, { type: "archive_range", data: result }));
        } catch (err) {
          this.transport.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
        }
        break;
      }
```
  会话解析复用 `compact` 分支的 `chatManager.getOrCreate`/`anyEngine` 逻辑(抽共用或照抄)。这是**通用** query,不含 pet 字面量。

- [ ] 跑测试确认通过:`cd packages/core && bun test src/engine/ src/protocol/`。预期绿(含既有 engine/protocol 测试群不回归)。守 `bun run lint:engine-bypass`(白名单不变,未新增 `new Engine(`)。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/core/src/engine/engine.ts packages/core/src/protocol/server.ts packages/core/src/index.extension.ts packages/core/src/engine/engine.compact.test.ts
git commit -m "$(cat <<'EOF'
feat(core): engine.archiveTurnRange facade + archive_range protocol query

Expose the range-archival primitive over the same session-resolution path as
forceCompact/compact, as a generic query with no domain literals.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: pet 段边界判定 + 携带纪要注入(纯函数 + profile 接线)

**Files:**
- Create: `packages/pet/src/topic-segment.ts`（纯函数:`shouldStartNewSegment`、`buildCarryoverBrief`、`buildWorkMemoryEntry`;类型 `PetTopicSegment`/`PetWorkMemoryEntry`）
- Create: `packages/pet/src/topic-segment.test.ts`
- Modify: `packages/pet/src/profile.ts`（`PET_BEHAVIOR_PROFILE` L71-117:经 `profileParams.carryoverBrief` 注入上一段纪要到 runtime-context / systemPromptAppend 尾;`createRunServices` reportResult 结构不变)
- Modify: `packages/pet/src/index.ts`（导出新符号)
- Test: `packages/pet/src/profile.test.ts`（若无则新建;验证纪要注入)

**Steps:**

- [ ] 写失败测试:新建 `topic-segment.test.ts`(bun test,行为单测风格,同 `session-index.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import { shouldStartNewSegment, buildCarryoverBrief, buildWorkMemoryEntry } from "./topic-segment.js";

const HOUR = 60 * 60 * 1000;

describe("topic segment boundaries", () => {
  test("starts a new segment after the idle threshold", () => {
    expect(shouldStartNewSegment({ lastInteractionAt: 0, now: 13 * HOUR, idleMs: 12 * HOUR })).toBe(true);
    expect(shouldStartNewSegment({ lastInteractionAt: 0, now: 11 * HOUR, idleMs: 12 * HOUR })).toBe(false);
  });

  test("carryover brief includes unfinished tasks and latest conclusions", () => {
    const brief = buildCarryoverBrief({
      unfinished: [{ objective: "重构 X", workspace: "alpha" }],
      conclusions: ["修好了登录 bug"],
    });
    expect(brief).toContain("重构 X");
    expect(brief).toContain("修好了登录 bug");
  });

  test("work memory entry captures task, outcome and refs", () => {
    const entry = buildWorkMemoryEntry({
      segmentId: "seg-1",
      objective: "修登录",
      outcome: "completed",
      workspace: "alpha",
      sessionRef: "sess-9",
      at: 42,
    });
    expect(entry).toMatchObject({
      segmentId: "seg-1",
      objective: "修登录",
      outcome: "completed",
      workspace: "alpha",
      sessionRef: "sess-9",
      at: 42,
    });
  });
});
```

- [ ] 跑测试确认失败:`cd packages/pet && bun test src/topic-segment.test.ts`。预期:模块不存在。

- [ ] 最小实现:新建 `topic-segment.ts`:
```ts
export interface PetWorkMemoryEntry {
  segmentId: string;
  objective: string;
  outcome: "completed" | "pending-decided" | "failed";
  workspace?: string;
  sessionRef?: string;
  at: number;
}

export interface PetTopicSegment {
  id: string;
  startedAt: number;
  /** Inclusive transcript event id where this segment begins, for range archival. */
  startEventId?: string;
}

/** Long-idle boundary: a new segment starts on the first message after idleMs. */
export function shouldStartNewSegment(input: {
  lastInteractionAt: number;
  now: number;
  idleMs: number;
}): boolean {
  return input.now - input.lastInteractionAt >= input.idleMs;
}

/** Carryover injected at the head of a new segment: open tasks + recent outcomes. */
export function buildCarryoverBrief(input: {
  unfinished: readonly { objective: string; workspace?: string }[];
  conclusions: readonly string[];
}): string {
  const lines: string[] = [];
  if (input.unfinished.length > 0) {
    lines.push("未完成任务:");
    for (const t of input.unfinished) {
      lines.push(`- ${t.objective}${t.workspace ? `(${t.workspace})` : ""}`);
    }
  }
  if (input.conclusions.length > 0) {
    lines.push("最近结论:");
    for (const c of input.conclusions) lines.push(`- ${c}`);
  }
  return lines.join("\n");
}

export function buildWorkMemoryEntry(input: PetWorkMemoryEntry): PetWorkMemoryEntry {
  return { ...input };
}

export const DEFAULT_SEGMENT_IDLE_MS = 12 * 60 * 60 * 1000;
```

- [ ] 最小实现(profile 接线):`profile.ts` — 在 `PET_BEHAVIOR_PROFILE` 里让携带纪要随 runtime-context 一起注入。现状 runtime-context 经 `runtimeContextTag: "pet-world"` + `profileParams.runtimeContext` 注入(engine 已有机制)。携带纪要由 desktop main(Task 12)拼进 `runtimeContext` JSON 的一个 `carryoverBrief` 字段,pet 无需改注入机制——但需在 `PET_SYSTEM_PROMPT`(L20-35)末尾加一行,告诉 Mimi 如何使用携带纪要:
  ```
  - When the runtime context includes a carryover brief (open tasks / recent conclusions from an earlier topic segment), treat it as background continuity; do not re-announce it unprompted.
  ```
  `createRunServices`/`reportResult` 结构不改(段归档触发在 main,见 Task 12)。

- [ ] 导出:`index.ts` 加 `export * from "./topic-segment.js";`。

- [ ] 跑测试确认通过:`cd packages/pet && bun test src/topic-segment.test.ts && bun test`。预期绿(含 `engine.pet-behavior.test.ts` 不回归;若该测试快照系统提示,更新其对新增行的断言)。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/pet/src/topic-segment.ts packages/pet/src/topic-segment.test.ts packages/pet/src/profile.ts packages/pet/src/index.ts
git commit -m "$(cat <<'EOF'
feat(pet): topic-segment boundary + carryover-brief primitives

Pure segment logic (idle boundary, carryover brief, work-memory entry) plus a
system-prompt note so Mimi treats an injected carryover brief as continuity.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `PetWorkMemoryStore` + 委派闭环/长空闲触发段归档(main)

**Files:**
- Create: `packages/desktop/src/main/pet/pet-work-memory-store.ts`（原子写 store,仿 `pet-receipt-store.ts`;存 `PetWorkMemoryEntry[]` + 当前段 + `lastInteractionAt`）
- Create: `packages/desktop/src/main/pet/pet-work-memory-store.test.ts`
- Create: `packages/desktop/src/main/pet/pet-segment-controller.ts`（协调:接委派闭环信号 → 组装 work memory → 经 worker `archive_range` 裁剪;长空闲 → 开新段 + 计算 carryoverBrief）
- Create: `packages/desktop/src/main/pet/pet-segment-controller.test.ts`
- Modify: `packages/desktop/src/main/pet/pet-dispatch-service.ts`（chat 成功且有 delegation 完成信号时通知 controller;`chat` 分支 L554-564 返回前 hook)
- Modify: `packages/desktop/src/main/index.ts`（构造 store + controller,注入 dispatch service;chat 前把 `carryoverBrief` 拼进 `runtimeContext`,即 `world` 对象 L392-414 加字段)

**Steps:**

- [ ] 写失败测试(store):新建 `pet-work-memory-store.test.ts`,仿 `pet-metadata-store.test.ts` 的 `mkdtemp` + try/finally:
```ts
test("appends and reloads work memory entries and tracks the active segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "cs-pet-mem-"));
  try {
    const store = new PetWorkMemoryStore(join(root, "pet", "work-memory.json"), () => 5);
    await store.load();
    await store.append({ segmentId: "s1", objective: "修 bug", outcome: "completed", at: 5 });
    await store.setSegment({ id: "s1", startedAt: 5 });
    expect(store.entries()).toHaveLength(1);
    expect(store.activeSegment()?.id).toBe("s1");

    const reopened = new PetWorkMemoryStore(join(root, "pet", "work-memory.json"), () => 6);
    await reopened.load();
    expect(reopened.entries()).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] 跑测试确认失败:`cd packages/desktop && bun test src/main/pet/pet-work-memory-store.test.ts`。预期:模块不存在。

- [ ] 最小实现(store):新建 `pet-work-memory-store.ts`,按 `PetReceiptStore` 风格(`load`/内存态/`writeQueue`/`persist` 原子 rename)。持久 JSON 形如 `{ version: 1, lastInteractionAt, activeSegment, entries: PetWorkMemoryEntry[] }`,`entries()` 上限 1000。`append`/`setSegment`/`setLastInteractionAt` 各自入队持久化。类型 `PetWorkMemoryEntry`/`PetTopicSegment` 从 `@cjhyy/code-shell-pet` import(Task 11 导出)。

- [ ] 写失败测试(controller):新建 `pet-segment-controller.test.ts`,注入 fake store + fake `archiveRange(sessionId, range)`,断言:
  - 委派闭环信号 → `store.append` 记一条工作记忆,且调用 `archiveRange`(裁剪该段轮次)。
  - 长空闲(`now - lastInteractionAt >= 12h`)下的下一条 chat → 开新段、返回携带纪要非空。
```ts
test("delegation closure records work memory and archives the segment turns", async () => {
  const archived: Array<{ sessionId: string; range: { start: number; end: number } }> = [];
  const store = new FakePetWorkMemoryStore();
  const controller = new PetSegmentController({
    store,
    petSessionId: "pet-1",
    archiveRange: async (sessionId, range) => { archived.push({ sessionId, range }); return { before: 100, after: 20 }; },
    now: () => 1_000,
    idleMs: 12 * 60 * 60 * 1000,
  });
  await controller.onDelegationClosed({ objective: "修登录", outcome: "completed", workspace: "alpha", sessionRef: "sess-9", turnRange: { start: 2, end: 6 } });
  expect(store.appended).toHaveLength(1);
  expect(archived).toEqual([{ sessionId: "pet-1", range: { start: 2, end: 6 } }]);
});

test("carryover brief is produced when a new segment opens after long idle", async () => {
  const store = new FakePetWorkMemoryStore();
  store.seed({ lastInteractionAt: 0, entries: [{ segmentId: "old", objective: "重构 X", outcome: "completed", at: 1 }] });
  const controller = new PetSegmentController({
    store, petSessionId: "pet-1",
    archiveRange: async () => ({ before: 0, after: 0 }),
    now: () => 13 * 60 * 60 * 1000, idleMs: 12 * 60 * 60 * 1000,
  });
  const brief = await controller.beginTurn();
  expect(brief).toContain("重构 X");
});
```

- [ ] 跑测试确认失败:`cd packages/desktop && bun test src/main/pet/pet-segment-controller.test.ts`。预期:模块不存在。

- [ ] 最小实现(controller):新建 `pet-segment-controller.ts`。依赖 `{ store, petSessionId, archiveRange, now, idleMs }`。
  - `onDelegationClosed(input)`:`store.append(buildWorkMemoryEntry({ segmentId: activeSegmentId, objective, outcome, workspace, sessionRef, at: now() }))`;若 `input.turnRange` 给定,调 `archiveRange(petSessionId, input.turnRange)`(经 Task 10 的通用原语)。
  - `beginTurn(): Promise<string | undefined>`:若 `shouldStartNewSegment({ lastInteractionAt: store.lastInteractionAt(), now: now(), idleMs })`:开新段(`store.setSegment(...)`),用近段 entries 的 `objective`(未完成)与结论拼 `buildCarryoverBrief`,返回该 brief;否则更新 `lastInteractionAt` 返回 undefined。
  - 用 `buildCarryoverBrief`/`buildWorkMemoryEntry`/`shouldStartNewSegment`(pet 包纯函数)。

- [ ] 接线(dispatch + index):
  - `index.ts`:构造 `petWorkMemory = new PetWorkMemoryStore(resolve(userData,"pet","work-memory.json"))` 与 `petSegmentController = new PetSegmentController({ store: petWorkMemory, petSessionId: (await petMetadata.ensure()).petSessionId, archiveRange: (sid, range) => bridge.requestWorker("agent/query", { type: "archive_range", sessionId: sid, start: range.start, end: range.end }).then(unwrap), now: Date.now, idleMs: DEFAULT_SEGMENT_IDLE_MS })`。把 controller 注入 `PetDispatchService`。`petWorkMemory.load()` 并入 `petInitialization`。
  - chat 前(`PetDispatchService.dispatch` chat 分支,组装 `world` L392-414 之前):`const carryoverBrief = await this.options.segmentController?.beginTurn();`,把 `...(carryoverBrief ? { carryoverBrief } : {})` 拼进 `world`(随 `runtimeContext` 一并送worker,pet profile 已注入 runtime-context,Task 11 的系统提示行说明用途)。
  - chat 成功后有 `delegations` 时(L555-564 前):对每个成功 delegation `d` 调 `this.options.segmentController?.onDelegationClosed({ objective: d.task, outcome: "completed", workspace: d.workspacePath ?? undefined, sessionRef: d.sessionId })`(不传 `turnRange`)。设计取舍:`onDelegationClosed` 的 `turnRange` 是可选参数,Task 12 的 controller 单测已覆盖「传入 turnRange 时调用 `archiveRange` 裁剪」这条能力;但 dispatch 侧此刻没有可靠的 pet 主会话轮次游标(现有 chat 返回不含 turn 索引),传入一个猜测的区间会误裁真实上下文。因此本任务 dispatch 侧一律不传 `turnRange`——即只沉淀工作记忆 + 注入携带纪要,裁剪能力保持可用但不启用。启用它的确切前置条件是:pet 主会话 chat 返回携带 `completedThroughEventId`/turn 序号(见 core `SessionState.turnSeq`/`completedThroughEventId`,`packages/core/src/types.ts:298-313`),controller 据此把事件 id 映射为 `summarizeRange` 的索引区间。该映射不在本计划范围内,是明确的独立后续工作,不是本任务的半成品。

- [ ] 跑测试确认通过:`cd packages/desktop && bun test src/main/pet/pet-work-memory-store.test.ts src/main/pet/pet-segment-controller.test.ts src/main/pet/pet-dispatch-service.test.ts`。预期绿。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/main/pet/pet-work-memory-store.ts packages/desktop/src/main/pet/pet-work-memory-store.test.ts packages/desktop/src/main/pet/pet-segment-controller.ts packages/desktop/src/main/pet/pet-segment-controller.test.ts packages/desktop/src/main/pet/pet-dispatch-service.ts packages/desktop/src/main/index.ts
git commit -m "$(cat <<'EOF'
feat(desktop): Mimi topic-segment work memory + carryover injection

Persist per-segment work-memory entries, open a new segment after long idle and
inject a carryover brief; delegation closures record memory (range-archival
capability wired and unit-tested).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Mimi 聊天流话题段分隔线 + 归档纪要卡片(UI)

**Files:**
- Modify: `packages/desktop/src/renderer/pet/PetChatHost.tsx`（`selectPetChatRows` L23-42 支持新行类型 `segment-divider`/`work-memory`;渲染 L178-205 增两种行的视觉;数据来源:段纪要经 projection 或专用 IPC 下发)
- Modify: `packages/desktop/src/preload/pet-api.ts`（snapshot 或 attention 通道附带 `workMemory` 段信息;新增 `getWorkMemory()`/`onWorkMemoryEvent()` 或并入 snapshot)
- Modify: `packages/desktop/src/main/pet/pet-ipc.ts`（暴露 work-memory 段边界只读查询)
- Test: `packages/desktop/src/renderer/pet/PetChatHost.test.ts`（纯函数 `selectPetChatRows` 契约)

**Steps:**

- [ ] 写失败测试:向 `PetChatHost.test.ts`(纯契约,无 DOM)追加。先扩展 `selectPetChatRows` 的入参为 `(messages, segments?)`,`segments` 是 `{ boundaryBeforeMessageId: string; brief?: string }[]`;断言在对应 user 消息前插入 `segment-divider` 行、带纪要时插 `work-memory` 行:
```ts
test("inserts a segment divider and work-memory card before a boundary message", () => {
  const rows = selectPetChatRows(
    [
      { kind: "assistant", id: "a0", text: "上一段结论", done: true },
      { kind: "user", id: "u1", text: "新话题" },
      { kind: "assistant", id: "a1", text: "好的", done: true },
    ],
    [{ boundaryBeforeMessageId: "u1", brief: "未完成任务:\n- 重构 X" }],
  );
  const kinds = rows.map((r) => r.role);
  expect(kinds).toContain("segment-divider");
  expect(kinds).toContain("work-memory");
  // divider precedes the boundary user row
  const dividerIdx = rows.findIndex((r) => r.role === "segment-divider");
  const userIdx = rows.findIndex((r) => r.id === "u1");
  expect(dividerIdx).toBeLessThan(userIdx);
  expect(rows.find((r) => r.role === "work-memory")?.text).toContain("重构 X");
});
```

- [ ] 跑测试确认失败:`cd packages/desktop && bun test src/renderer/pet/PetChatHost.test.ts`。预期:`selectPetChatRows` 不接受第二参且 role 无 `segment-divider`/`work-memory`。

- [ ] 最小实现(纯函数):扩展 `PetChatRow.role` 为 `"user" | "assistant" | "segment-divider" | "work-memory"`;`selectPetChatRows(messages, segments = [])` 在遍历时,遇到 `segments` 里 `boundaryBeforeMessageId === message.id` 的 user 行前,先 push 一条 `{ id: \`divider:${message.id}\`, role: "segment-divider", text: "" }`,若该段有 `brief` 再 push `{ id: \`memory:${message.id}\`, role: "work-memory", text: brief }`。其余逻辑不变。

- [ ] 最小实现(渲染):`PetChatHost.tsx` 渲染 map(L178-205)加两分支:`segment-divider` 渲染一条细分隔线(Tailwind `border-t border-border/60` + 居中小字 `t("pet.chat.segmentDivider")`);`work-memory` 渲染一张纪要卡片(shadcn `Card`,`bg-muted/40`,标题 `t("pet.chat.workMemoryTitle")`,body `whitespace-pre-wrap` 显示 `row.text`)。i18n `pet.ts` chat 段加 `segmentDivider`/`workMemoryTitle`(zh/en)。**不新增任何必须操作的按钮**(卡片默认展开或纯展示)。

- [ ] 数据接线:`PetChatHost` 从 `usePetState()` 取段信息。最小落点:main 侧经 snapshot 附带 `workMemorySegments: { boundaryBeforeMessageId, brief? }[]`(pet-api `PetProjectionSnapshot` 加该字段,aggregator 从 `PetWorkMemoryStore` 读并映射;boundary 的 `boundaryBeforeMessageId` 用段起始对应的 `clientMessageId`)。`PetChatHost` 把 `chatState.messages` 与该数组一起传给 `selectPetChatRows`。若段与消息 id 映射在本轮不完整,渲染侧对无匹配 boundary 静默跳过(纯函数只在匹配到 id 时插入)。

- [ ] 跑测试确认通过:`cd packages/desktop && bun test src/renderer/pet/PetChatHost.test.ts src/renderer/i18n/dict.test.ts`。预期绿。

- [ ] commit:
```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/renderer/pet/PetChatHost.tsx packages/desktop/src/renderer/pet/PetChatHost.test.ts packages/desktop/src/preload/pet-api.ts packages/desktop/src/main/pet/pet-ipc.ts packages/desktop/src/renderer/i18n/ns/pet.ts
git commit -m "$(cat <<'EOF'
feat(desktop): topic-segment dividers and archived work-memory cards in Mimi chat

Render a divider plus a read-only work-memory card at each topic-segment
boundary; no new required user action.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 收尾验证(全部任务完成后)

- [ ] 全量测试:`bun test`(仓库根);desktop 独立:`cd packages/desktop && bun test`。
- [ ] Lint:`bun run lint` + `bun run lint:engine-bypass`(白名单不变)。
- [ ] 受影响包构建:`bun run build`(core → pet → server → …);desktop 独立 `cd packages/desktop && bun run typecheck && bun run build`。
- [ ] 红线自检:`grep -rn "pet\|Pet\|Mimi" packages/core/src/context packages/core/src/engine/engine.ts packages/core/src/protocol/server.ts` 确认新增的 `summarizeRange`/`archiveTurnRange`/`archive_range` **无 pet 字面量**(通用命名)。
- [ ] 结合 CODESHELL.md L89 红线复查:段状态/归档/记忆逻辑均在 `packages/pet` 与 `packages/desktop`;core 仅新增通用原语。
