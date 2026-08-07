# Mimi 归档边界持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Mimi 时间切片的归档结果持久化为 transcript 事件，使应用重启后模型上下文仍然只包含「归档摘要 + 当前切片」，而不是全量历史消息。

**Architecture:** 新增一种 transcript 事件 `range_archive`（摘要文本 + clientMessageId 锚点），`Transcript.toMessages()` 回放时把锚点区间内的消息**替换**为摘要（现有 `summary` 事件是追加语义，不动它）。`Engine.archiveTurnRange` 归档成功后追加该事件；重启后 `run-session-open.ts` 现有的 `transcript.toMessages()` fallback 自动得到裁剪后的上下文，恢复路径零改动。老会话迁移用 journal 已有的小结拼接出一条迁移摘要，零模型调用。

**Tech Stack:** TypeScript + Bun test。涉及 `packages/core`（transcript / engine / protocol）与 `packages/desktop`（pet 闭环 + 迁移）。

---

## 对原始提案的评估与优化（设计依据）

原提案的三个事实判断全部核实成立：

1. 12 小时闲置开新切片 — `packages/pet/src/topic-segment.ts:75`（`DEFAULT_SEGMENT_IDLE_MS`）。
2. 归档只写进程内 `Map` — `packages/core/src/engine/engine.ts:345`（`compactedMessagesBySession`），`archiveTurnRange` 的终点是 `Map.set`（engine.ts:3642），没有任何落盘。
3. 重启后全量回放 — `packages/core/src/engine/run-session-open.ts:87` 在缓存为空时回落到 `session.transcript.toMessages()`，后者无条件回放每条 message 事件。

对原提案的四点优化（本计划采用）：

- **不新建存储层。** 四层数据里三层已存在：transcript.jsonl＝原始聊天记录，`pet/journal.json`＝事件日志，PetMemoryStore＝长期记忆。缺的只是「归档边界」这一个事实，把它写成 transcript 事件即可，单一事实源。
- **锚点用 clientMessageId，不用消息 index。** index 在重启后会错位（`closureService.backfill` 拒绝 re-archive 正是这个原因，见 pet-segment-closure-service.ts 注释）。closure 链路本来就持有边界 clientMessageId（`PetSegmentClosed.closingBoundaryMessageId` / `nextBoundaryMessageId`），直通到底即可。事件按 `segmentId` 幂等，顺带把只在进程内的 `archivedSegmentIds` 防重升级为持久防重。
- **「连续性摘要」不需要独立存储。** `ContextManager.summarizeRange` 已有 rolling anchored summary（`extractAnchoredSummary` 回喂 merge，manager.ts:718）。持久化的 `range_archive.summary` 就存这条 anchored 消息的完整内容，重启回放后 merge 链路继续生效。
- **迁移零模型调用。** journal 已存全部旧切片小结（`PetJournalStore.list()`），active segment 已存 `boundaryBeforeMessageId`；拼接小结 → 追加一条覆盖 `[开头, active 边界)` 的 `range_archive` 事件即完成迁移。**不要**按 journal 里存的 index range 重放——那些 index 早已失效。
- 「旧切片摘要仅相关时发送」属于检索层，本计划不做（独立迭代）。
- 全局 0.85 压缩（ContextManager 压力阈值）保持不动，作为溢出保险；与切片归档是两套独立机制，符合原提案「两套逻辑分开」的判断。

## File Structure

- Modify: `packages/core/src/types.ts` — `TranscriptEventType` 联合加 `"range_archive"`。
- Modify: `packages/core/src/session/transcript.ts` — `appendRangeArchive()`；`toMessages()` 替换回放；`CONTEXT_EVENT_TYPES` 加新类型。
- Modify: `packages/core/src/session/session-manager.ts` — `FORK_COPY_EVENT_TYPES` 加 `"range_archive"`（fork 保留归档边界）。
- Create: `packages/core/src/session/transcript.range-archive.test.ts`
- Modify: `packages/core/src/engine/engine.ts` — `archiveTurnRange` 加可选 `anchors` 参数并持久化；新增 `appendArchiveMarker()`（迁移用）。
- Modify: `packages/core/src/protocol/server.ts` — `archive_range` query 透传 anchors；新增 `archive_marker` query。
- Modify: `packages/desktop/src/main/index.ts` — `archivePetRange` 传 anchors；启动时一次性迁移。
- Create: `packages/pet/src/migration-summary.ts`（纯函数：journal 小结 → 迁移摘要文本）+ `migration-summary.test.ts`。

---

### Task 1: transcript 层 — `range_archive` 事件与替换回放

**Files:**
- Modify: `packages/core/src/types.ts:167-187`（`TranscriptEventType` 联合）
- Modify: `packages/core/src/session/transcript.ts`（`CONTEXT_EVENT_TYPES` 53-59 行、`appendSummary` 之后加 `appendRangeArchive`、`toMessages` 316-393 行）
- Modify: `packages/core/src/session/session-manager.ts:289`（`FORK_COPY_EVENT_TYPES`）
- Test: `packages/core/src/session/transcript.range-archive.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcript } from "./transcript.js";

describe("Transcript range_archive", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-tr-arch-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(t: Transcript): void {
    t.appendMessage("user", "话题A第一句", { clientMessageId: "m1" });
    t.appendMessage("assistant", "回A1");
    t.appendMessage("user", "话题A第二句", { clientMessageId: "m2" });
    t.appendMessage("assistant", "回A2");
    t.appendMessage("user", "话题B第一句", { clientMessageId: "m3" });
    t.appendMessage("assistant", "回B1");
  }

  it("replaces the [from, to) span with the summary on replay", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendRangeArchive({
      summary: "【归档】话题A的摘要",
      fromClientMessageId: "m1",
      toClientMessageId: "m3",
      segmentId: "seg-1",
    });

    const messages = t.toMessages();
    const texts = messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("【归档】话题A的摘要");
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(false);
    expect(texts.some((x) => x.includes("回A2"))).toBe(false);
    // 区间是半开的：to 边界消息本身保留
    expect(texts.some((x) => x.includes("话题B第一句"))).toBe(true);
    expect(texts.some((x) => x.includes("回B1"))).toBe(true);
    expect(messages).toHaveLength(3); // 摘要 + m3 + 回B1
  });

  it("an undefined fromClientMessageId archives from the beginning", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendRangeArchive({
      summary: "【归档】开头到m3",
      toClientMessageId: "m3",
      segmentId: "seg-open",
    });
    const texts = t.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("【归档】开头到m3");
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(false);
    expect(texts.some((x) => x.includes("话题B第一句"))).toBe(true);
  });

  it("is idempotent on segmentId", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    const first = t.appendRangeArchive({
      summary: "s",
      toClientMessageId: "m3",
      segmentId: "seg-1",
    });
    const second = t.appendRangeArchive({
      summary: "s",
      toClientMessageId: "m3",
      segmentId: "seg-1",
    });
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(t.getEvents("range_archive")).toHaveLength(1);
  });

  it("ignores a marker whose toClientMessageId is missing (fails open to full history)", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendRangeArchive({
      summary: "坏标记",
      fromClientMessageId: "m1",
      toClientMessageId: "no-such-id",
      segmentId: "seg-bad",
    });
    const texts = t.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(true);
    expect(texts.some((x) => x === "坏标记")).toBe(false);
  });

  it("survives reload from disk", () => {
    const file = join(dir, "t.jsonl");
    const t = new Transcript(file);
    seed(t);
    t.appendRangeArchive({
      summary: "【归档】话题A的摘要",
      fromClientMessageId: "m1",
      toClientMessageId: "m3",
      segmentId: "seg-1",
    });
    const reloaded = Transcript.loadFromFile(file);
    const texts = reloaded.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("【归档】话题A的摘要");
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(false);
  });

  it("adjacent spans: to of span A === from of span B", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendMessage("user", "话题C第一句", { clientMessageId: "m4" });
    t.appendRangeArchive({
      summary: "A段摘要",
      fromClientMessageId: "m1",
      toClientMessageId: "m3",
      segmentId: "seg-a",
    });
    t.appendRangeArchive({
      summary: "B段摘要",
      fromClientMessageId: "m3",
      toClientMessageId: "m4",
      segmentId: "seg-b",
    });
    const texts = t.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("A段摘要");
    expect(texts[1]).toBe("B段摘要");
    expect(texts.some((x) => x.includes("话题B第一句"))).toBe(false);
    expect(texts.some((x) => x.includes("话题C第一句"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/session/transcript.range-archive.test.ts`
Expected: FAIL — `appendRangeArchive is not a function`。

- [ ] **Step 3: 实现**

`packages/core/src/types.ts` — 在 `TranscriptEventType` 联合中（`"context_transfer"` 之后）加：

```ts
  // A contiguous message span was archived into a summary. Written by
  // Engine.archiveTurnRange / appendArchiveMarker. Anchored by client message
  // ids (NOT indices — indices shift across restarts). toMessages() REPLACES
  // the [fromClientMessageId, toClientMessageId) span with the summary; this
  // is what makes topic-segment archival survive a process restart.
  // data = { summary, toClientMessageId, fromClientMessageId?, segmentId? }
  | "range_archive"
```

`packages/core/src/session/transcript.ts` — `CONTEXT_EVENT_TYPES`（53 行）加 `"range_archive"`。在 `appendSummary`（292-306 行）之后加：

```ts
  /**
   * Persist a range-archival boundary. Span is [fromClientMessageId,
   * toClientMessageId) over message events; an absent from means "from the
   * beginning". Idempotent on segmentId so a crash-replayed closure cannot
   * double-archive.
   */
  appendRangeArchive(data: {
    summary: string;
    toClientMessageId: string;
    fromClientMessageId?: string;
    segmentId?: string;
  }): TranscriptEvent | undefined {
    if (
      data.segmentId &&
      this.events.some(
        (e) => e.type === "range_archive" && e.data.segmentId === data.segmentId,
      )
    ) {
      return undefined;
    }
    return this.append("range_archive", { ...data });
  }
```

`toMessages()`（316 行）改造：循环前做标记预处理，循环中维护 span 状态。

```ts
  toMessages(): Message[] {
    const messages: Message[] = [];
    const selectedToolResults = preferredToolResults(this.events);

    // Range-archive pre-pass: collect valid markers keyed by their span-opening
    // client message id. A marker whose to-anchor no longer resolves to a
    // message event is ignored (fail open to full history rather than
    // swallowing the tail of the conversation).
    interface ArchiveSpan {
      summary: string;
      toClientMessageId: string;
    }
    const presentClientIds = new Set<string>();
    for (const event of this.events) {
      if (event.type === "message" && typeof event.data.clientMessageId === "string") {
        presentClientIds.add(event.data.clientMessageId);
      }
    }
    const spansByFromId = new Map<string, ArchiveSpan>();
    let openingSpan: ArchiveSpan | undefined;
    for (const event of this.events) {
      if (event.type !== "range_archive") continue;
      const { summary, toClientMessageId, fromClientMessageId } = event.data as {
        summary: string;
        toClientMessageId: string;
        fromClientMessageId?: string;
      };
      if (typeof summary !== "string" || !presentClientIds.has(toClientMessageId)) continue;
      if (fromClientMessageId === undefined) {
        openingSpan ??= { summary, toClientMessageId };
      } else if (presentClientIds.has(fromClientMessageId)) {
        spansByFromId.set(fromClientMessageId, { summary, toClientMessageId });
      }
    }

    let activeSpan: ArchiveSpan | null = null;
    if (openingSpan) {
      activeSpan = openingSpan;
      messages.push({ role: "user", content: openingSpan.summary });
    }

    for (const event of this.events) {
      // Span bookkeeping runs on message events only: exit before entry so
      // adjacent spans (A.to === B.from) hand over on the boundary message.
      if (event.type === "message") {
        const clientMessageId =
          typeof event.data.clientMessageId === "string"
            ? event.data.clientMessageId
            : undefined;
        if (activeSpan && clientMessageId === activeSpan.toClientMessageId) {
          activeSpan = null;
        }
        if (!activeSpan && clientMessageId && spansByFromId.has(clientMessageId)) {
          activeSpan = spansByFromId.get(clientMessageId)!;
          messages.push({ role: "user", content: activeSpan.summary });
        }
      }
      if (activeSpan) continue; // archived span: drop every context event inside

      switch (event.type) {
        // …… 原有 switch 内容保持不变（message / tool_use / tool_result /
        // summary / context_transfer 各 case 原样保留），
        // "range_archive" 不需要 case：它只通过预处理生效，自身位置不产出消息。
      }
    }

    return messages;
  }
```

`packages/core/src/session/session-manager.ts:289` — `FORK_COPY_EVENT_TYPES` 集合加 `"range_archive"`（fork 出的会话应继承归档边界，否则 fork 后上下文重新膨胀）。

注意：transcript.ts 555 行附近还有第二个 switch（选区上下文转移用）。那里给 `range_archive` 加一个与 `summary` case 相同形态的分支即可（作为 system-reminder 注入摘要文本），不做替换——手选区间是用户显式选择，不应静默丢消息。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test src/session/transcript.range-archive.test.ts`
Expected: PASS（6 个用例全绿）。再跑 `bun test src/session/` 确认既有 transcript 测试无回归。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/session/transcript.ts packages/core/src/session/session-manager.ts packages/core/src/session/transcript.range-archive.test.ts
git commit -m "feat(core): range_archive transcript event with replacing replay"
```

---

### Task 2: engine 层 — 归档成功后持久化标记 + 迁移入口

**Files:**
- Modify: `packages/core/src/engine/engine.ts:3618-3646`（`archiveTurnRange`）及其后新增 `appendArchiveMarker`
- Test: `packages/core/src/engine/engine.archive-persist.test.ts`

- [ ] **Step 1: Write the failing test**

测试通过真实 SessionManager 建会话、打桩 summarizeFn 不可行（archiveTurnRange 内部自建 LLM client）。改为直接测 engine 的持久化行为：给 `archiveTurnRange` 注入 anchors 后检查 transcript 事件。为让 summarizeRange 产出摘要，测试用 `appendArchiveMarker`（纯持久化，无模型调用）+ 一个覆盖 `archiveTurnRange` anchors 透传的窄测试（mock `ContextManager` 不现实时，退而验证「summarizeRange 未生效时不写标记」这条分支）：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "./engine.js";

describe("Engine archive persistence", () => {
  let dir: string;
  let engine: Engine;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-eng-arch-"));
    engine = new Engine({
      llm: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test" },
      sessionsDir: join(dir, "sessions"),
    } as ConstructorParameters<typeof Engine>[0]);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedSession(): string {
    const bundle = engine.sessionManager.create({ cwd: dir });
    bundle.transcript.appendMessage("user", "旧话题", { clientMessageId: "m1" });
    bundle.transcript.appendMessage("assistant", "旧回复");
    bundle.transcript.appendMessage("user", "新话题", { clientMessageId: "m2" });
    return bundle.state.sessionId;
  }

  it("appendArchiveMarker persists a replayable marker and drops the cache", async () => {
    const sessionId = seedSession();
    const appended = await engine.appendArchiveMarker(sessionId, {
      summary: "旧话题的摘要",
      toClientMessageId: "m2",
      segmentId: "migration-v1",
    });
    expect(appended).toBe(true);

    const session = engine.sessionManager.resume(sessionId);
    expect(session.transcript.getEvents("range_archive")).toHaveLength(1);
    const texts = session.transcript
      .toMessages()
      .map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((x) => x.includes("旧话题的摘要"))).toBe(true);
    expect(texts.some((x) => x === "旧话题")).toBe(false);
    expect(texts.some((x) => x === "新话题")).toBe(true);
  });

  it("appendArchiveMarker is idempotent on segmentId", async () => {
    const sessionId = seedSession();
    await engine.appendArchiveMarker(sessionId, {
      summary: "s",
      toClientMessageId: "m2",
      segmentId: "migration-v1",
    });
    const second = await engine.appendArchiveMarker(sessionId, {
      summary: "s",
      toClientMessageId: "m2",
      segmentId: "migration-v1",
    });
    expect(second).toBe(false);
  });

  it("archiveTurnRange without a summarizer persists no marker", async () => {
    const sessionId = seedSession();
    // 无有效 LLM key → summarizeRange 原样返回 → 不应写标记
    const result = await engine.archiveTurnRange(
      sessionId,
      { start: 0, end: 2 },
      { toClientMessageId: "m2", fromClientMessageId: "m1", segmentId: "seg-1" },
    );
    expect(result.after).toBe(result.before);
    const session = engine.sessionManager.resume(sessionId);
    expect(session.transcript.getEvents("range_archive")).toHaveLength(0);
  });
});
```

（若 Engine 构造签名与现有 engine 测试不同，抄 `packages/core/src/engine/persist-active-model.test.ts` 的现成构造方式——该文件本次改动中已存在,是最新口径。）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/engine/engine.archive-persist.test.ts`
Expected: FAIL — `appendArchiveMarker is not a function`。

- [ ] **Step 3: 实现**

`archiveTurnRange`（engine.ts:3618）签名与结尾改为：

```ts
  async archiveTurnRange(
    sessionId: string,
    range: { start: number; end: number },
    anchors?: { toClientMessageId: string; fromClientMessageId?: string; segmentId?: string },
  ): Promise<{ before: number; after: number }> {
    // …… 3622-3638 行原样保留 ……

    const archived = await contextManager.summarizeRange(sourceMessages, range);
    const after = estimateTokens(archived);
    // Persist the boundary so a restart replays the trimmed context. Only when
    // summarizeRange actually replaced the span (identity return means empty
    // window / rejected summary) and the caller supplied stable anchors.
    if (anchors && archived !== sourceMessages) {
      const summaryMessage = archived[Math.min(range.start, archived.length - 1)];
      const summaryText =
        typeof summaryMessage?.content === "string" ? summaryMessage.content : undefined;
      if (summaryText) {
        session.transcript.appendRangeArchive({ summary: summaryText, ...anchors });
      }
    }
    this.compactedMessagesBySession.set(effectiveSessionId, archived);
    this.lastSessionId = effectiveSessionId;
    this.lastMessages = archived;
    return { before, after };
  }
```

持久化的 `summary` 是 `buildAnchoredSummaryMessage` 产出的完整消息内容（含 anchored 标记），回放时 `extractAnchoredSummary` 能重新识别它 → 重启后 rolling-merge 链路不断。

新增 `appendArchiveMarker`（放在 `archiveTurnRange` 之后）：

```ts
  /**
   * Persist an archive boundary WITHOUT a summarization call — the caller
   * already has the summary text (e.g. the one-time migration built from
   * pet journal entries). Wraps the plain text in the anchored-summary
   * envelope so replay and rolling-merge treat it like a real archive.
   * Returns false when the segmentId was already recorded (idempotent).
   */
  async appendArchiveMarker(
    sessionId: string,
    marker: {
      summary: string;
      toClientMessageId: string;
      fromClientMessageId?: string;
      segmentId?: string;
    },
  ): Promise<boolean> {
    const session = this.sessionManager.resume(sessionId);
    const wrapped = buildAnchoredSummaryMessage(marker.summary);
    const content = typeof wrapped.content === "string" ? wrapped.content : marker.summary;
    const appended = session.transcript.appendRangeArchive({ ...marker, summary: content });
    if (!appended) return false;
    // The in-memory cache (if any) predates the marker; drop it so the next
    // run rebuilds from the trimmed transcript replay.
    this.compactedMessagesBySession.delete(sessionId);
    return true;
  }
```

`buildAnchoredSummaryMessage` 从 `../context/compaction.js` 导入（engine.ts 头部已有对 context 模块的 import 块，就近添加）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test src/engine/engine.archive-persist.test.ts && bun test src/engine/`
Expected: PASS，engine 既有测试无回归。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/engine.ts packages/core/src/engine/engine.archive-persist.test.ts
git commit -m "feat(core): persist archive boundary from archiveTurnRange + appendArchiveMarker"
```

---

### Task 3: protocol 层 — anchors 透传与 archive_marker query

**Files:**
- Modify: `packages/core/src/protocol/server.ts:2978-3030`（`archive_range` case）+ 其后新增 `archive_marker` case
- Modify: `packages/core/src/protocol/types.ts`（若 query 参数有类型定义，同步补充）
- Test: 复用 `packages/core/src/protocol/` 现有 server query 测试文件的模式，新增用例

- [ ] **Step 1: Write the failing test**

在 protocol 现有的 query 测试文件里（按 `archive_range` 既有用例的桩模式）加两个用例：

```ts
it("archive_range forwards anchors to engine.archiveTurnRange", async () => {
  // 桩 engine.archiveTurnRange, 断言第三参 === {
  //   toClientMessageId: "m2", fromClientMessageId: "m1", segmentId: "seg-1"
  // }
});

it("archive_marker appends a marker via engine.appendArchiveMarker", async () => {
  // params: { type: "archive_marker", sessionId, summary, toClientMessageId, segmentId }
  // 断言响应 { type: "archive_marker", data: { appended: true } }
});
```

（具体桩写法抄同文件 `archive_range` 用例——本仓库 protocol 测试已有 engine 桩基建；记忆提示：新增 Engine 公开方法后，约 14 个手写 fake engine 需要补 `appendArchiveMarker` 空实现，编译期会逐个报出来，按报错补齐即可。）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/protocol/`
Expected: 新用例 FAIL（anchors 未透传 / unknown query type）。

- [ ] **Step 3: 实现**

`archive_range` case（server.ts:3003 附近）：

```ts
        const toClientMessageId =
          typeof params.toClientMessageId === "string" ? params.toClientMessageId : undefined;
        const anchors = toClientMessageId
          ? {
              toClientMessageId,
              ...(typeof params.fromClientMessageId === "string"
                ? { fromClientMessageId: params.fromClientMessageId }
                : {}),
              ...(typeof params.segmentId === "string" ? { segmentId: params.segmentId } : {}),
            }
          : undefined;
        const result = await archiveEngine.archiveTurnRange(
          archiveSessionId,
          { start, end },
          anchors,
        );
```

新增 case（紧跟 `archive_range` 之后，结构对齐）：

```ts
      case "archive_marker": {
        const markerSessionId =
          typeof params.sessionId === "string" && params.sessionId.length > 0
            ? params.sessionId
            : undefined;
        const summary = typeof params.summary === "string" ? params.summary : undefined;
        const toClientMessageId =
          typeof params.toClientMessageId === "string" ? params.toClientMessageId : undefined;
        if (!markerSessionId || !summary || !toClientMessageId) {
          this.transport.send(
            createErrorResponse(
              req.id,
              ErrorCodes.InvalidParams,
              "archive_marker requires sessionId, summary and toClientMessageId",
            ),
          );
          return;
        }
        const markerEngine = await this.resolveEngineForSessionQuery(
          req,
          markerSessionId,
          engine,
          "archive_marker",
        );
        if (!markerEngine) return;
        try {
          const appended = await markerEngine.appendArchiveMarker(markerSessionId, {
            summary,
            toClientMessageId,
            ...(typeof params.fromClientMessageId === "string"
              ? { fromClientMessageId: params.fromClientMessageId }
              : {}),
            ...(typeof params.segmentId === "string" ? { segmentId: params.segmentId } : {}),
          });
          this.transport.send(
            createResponse(req.id, { type: "archive_marker", data: { appended } }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
```

`resolveEngineForSessionQuery` 的第 4 参若是字面量联合类型，把 `"archive_marker"` 加进去（见 server.ts:2756 注释处的类型）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test src/protocol/ && bun run typecheck`
Expected: PASS；typecheck 会揪出所有需要补 `appendArchiveMarker` 的 fake engine，逐个补一行空实现。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/ packages/core/src
git commit -m "feat(protocol): archive_range anchors passthrough + archive_marker query"
```

---

### Task 4: desktop — 闭环传 anchors

**Files:**
- Modify: `packages/desktop/src/main/index.ts:2030-2089`（`archivePetRange` + `onSegmentClosed`）
- Test: desktop 侧对 `archivePetRange` 有测试的话（`grep -rn "archive_range" packages/desktop --include="*.test.ts"`），同步断言 payload 含 anchors

- [ ] **Step 1: 修改 `archivePetRange` 与调用点**

```ts
      const archivePetRange = async (
        sessionId: string,
        range: { start: number; end: number },
        anchors?: {
          toClientMessageId: string;
          fromClientMessageId?: string;
          segmentId?: string;
        },
      ): Promise<{ before: number; after: number }> => {
        const response = await petBridge.requestWorker("agent/query", {
          type: "archive_range",
          sessionId,
          start: range.start,
          end: range.end,
          ...(anchors ?? {}),
        });
        if (!response.ok) throw new Error(response.message);
        const data = (response.result as { data?: { before?: number; after?: number } })?.data;
        return { before: data?.before ?? 0, after: data?.after ?? 0 };
      };
```

`onSegmentClosed`（index.ts:2077）内的调用改为：

```ts
            .then(async (result) => {
              if (result) {
                await archivePetRange(
                  petSessionId,
                  result.range,
                  closed.nextBoundaryMessageId
                    ? {
                        toClientMessageId: closed.nextBoundaryMessageId,
                        ...(closed.closingBoundaryMessageId
                          ? { fromClientMessageId: closed.closingBoundaryMessageId }
                          : {}),
                        segmentId: closed.segmentId,
                      }
                    : undefined,
                );
              }
            })
```

`nextBoundaryMessageId` 缺失时（`PetSegmentClosed` 里它是可选的）退化为今天的行为：只做进程内归档，不落盘——安全降级而非报错。

`PetSegmentController` 的 `archiveRange` 回调类型（pet-segment-controller.ts 构造参数）同步加可选第三参。

- [ ] **Step 2: 验证**

Run: `cd packages/desktop && bun run typecheck && bun test src/main/pet/`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/main
git commit -m "feat(desktop): pass segment boundary anchors through pet range archival"
```

---

### Task 5: 老会话一次性迁移（零模型调用）

**Files:**
- Create: `packages/pet/src/migration-summary.ts`
- Create: `packages/pet/src/migration-summary.test.ts`
- Modify: `packages/desktop/src/main/index.ts`（backfill 调用处，2094 行附近）

- [ ] **Step 1: Write the failing test（纯函数）**

```ts
import { describe, it, expect } from "bun:test";
import { buildMigrationSummary } from "./migration-summary.js";

describe("buildMigrationSummary", () => {
  it("joins journal entries oldest-first with title + summary", () => {
    const text = buildMigrationSummary([
      { title: "配环境", summary: "装好了 Bun 和依赖。" },
      { title: "改样式", summary: "把工作台改成了只读预览。" },
    ]);
    expect(text).toContain("【配环境】装好了 Bun 和依赖。");
    expect(text).toContain("【改样式】把工作台改成了只读预览。");
    expect(text.indexOf("配环境")).toBeLessThan(text.indexOf("改样式"));
  });

  it("returns empty string for no entries", () => {
    expect(buildMigrationSummary([])).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pet && bun test src/migration-summary.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现纯函数**

```ts
/**
 * Build the one-time migration summary for a pre-existing Mimi session from
 * its persisted journal entries (oldest → newest). Pure; no model call — the
 * journal already holds the per-segment distillations.
 */
export function buildMigrationSummary(
  entries: readonly { title: string; summary: string }[],
): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `【${entry.title}】${entry.summary}`);
  return ["以下是此前各段对话的归档小结（旧 → 新）：", ...lines].join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/pet && bun test src/migration-summary.test.ts`
Expected: PASS。

- [ ] **Step 5: 接入启动迁移**

`packages/desktop/src/main/index.ts`，紧跟 `closureService.backfill(...)`（2094-2096 行）之后：

```ts
      // One-time context-boundary migration for pre-existing Mimi sessions:
      // before range_archive existed, closures trimmed context only in-memory,
      // so every restart re-inflated the prompt to the full transcript. Seed a
      // single persisted marker covering everything before the active segment,
      // summarized from the journal entries we already have — no model call.
      // Idempotent: appendRangeArchive dedupes on segmentId, so relaunches and
      // already-migrated sessions no-op.
      void (async () => {
        const activeSegment = petWorkMemory.activeSegment();
        const journalEntries = petJournalStore.list();
        if (!activeSegment?.boundaryBeforeMessageId || journalEntries.length === 0) return;
        const summary = buildMigrationSummary(journalEntries);
        if (!summary) return;
        await petBridge.requestWorker("agent/query", {
          type: "archive_marker",
          sessionId: petSessionId,
          summary,
          toClientMessageId: activeSegment.boundaryBeforeMessageId,
          segmentId: "context-migration-v1",
        });
      })().catch((error) => dlog("main", "pet.context_migration.failed", { error: String(error) }));
```

`buildMigrationSummary` 从 `@cjhyy/code-shell-pet` 导入（对齐 index.ts 既有的 pet 包导入名），并在 `packages/pet/src/index.ts`（若有 barrel）补导出。

`PetJournalEntry.list()` 返回序需要确认 oldest-first：`grep -n "sort\|unshift" packages/desktop/src/main/pet/pet-journal-store.ts`，若是 newest-first 则在调用处 `.slice().reverse()`。

- [ ] **Step 6: 验证 + Commit**

Run: `cd packages/desktop && bun run typecheck && bun run build`
Expected: PASS。

```bash
git add packages/pet/src packages/desktop/src/main/index.ts
git commit -m "feat(pet): one-time archive-boundary migration from journal summaries"
```

---

### Task 6: 端到端回归 — 重启后上下文被裁剪

**Files:**
- Test: `packages/core/src/engine/restart-respects-archive.test.ts`

- [ ] **Step 1: Write the test（这是本计划的验收标准）**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "./engine.js";

describe("restart respects persisted archive boundary", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-restart-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a fresh Engine (simulated restart) replays trimmed context", async () => {
    const config = {
      llm: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "test" },
      sessionsDir: join(dir, "sessions"),
    } as ConstructorParameters<typeof Engine>[0];

    const engineA = new Engine(config);
    const bundle = engineA.sessionManager.create({ cwd: dir });
    const sessionId = bundle.state.sessionId;
    for (let i = 0; i < 20; i += 1) {
      bundle.transcript.appendMessage("user", `旧消息${i}`, { clientMessageId: `old-${i}` });
      bundle.transcript.appendMessage("assistant", `旧回复${i}`);
    }
    bundle.transcript.appendMessage("user", "当前切片", { clientMessageId: "current" });
    await engineA.appendArchiveMarker(sessionId, {
      summary: "20轮旧对话的摘要",
      toClientMessageId: "current",
      segmentId: "seg-old",
    });

    // 模拟重启：全新 Engine 实例，进程内缓存为空
    const engineB = new Engine(config);
    const resumed = engineB.sessionManager.resume(sessionId);
    const messages = resumed.transcript.toMessages();
    const texts = messages.map((m) => (typeof m.content === "string" ? m.content : ""));

    expect(messages.length).toBe(2); // 摘要 + 当前切片
    expect(texts[0]).toContain("20轮旧对话的摘要");
    expect(texts[1]).toBe("当前切片");
    expect(texts.some((x) => x.includes("旧消息3"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run**

Run: `cd packages/core && bun test src/engine/restart-respects-archive.test.ts`
Expected: PASS（Task 1+2 完成后应直接绿；红则说明回放或持久化有洞）。

- [ ] **Step 3: 全量回归 + Commit**

Run: `cd packages/core && bun test && bun run typecheck`，`cd packages/desktop && bun run typecheck && bun test`
Expected: 全绿。

```bash
git add packages/core/src/engine/restart-respects-archive.test.ts
git commit -m "test(core): restart replays trimmed context from persisted archive boundary"
```

---

## 风险与边界（实现时对照检查）

- **injected 合成消息**：span 匹配按 clientMessageId 精确命中，与 index 无关，closure 的「跳过 injected」口径不影响本机制；但 closure 传给 `archiveTurnRange` 的 index range 仍是旧口径，两者并行、互不依赖。
- **归档区间切断 tool_use/tool_result 对**：切片边界永远是 user 消息（clientMessageId 只在 user turn 上），完整的 assistant+tool 轮次要么整体在区间内要么整体在外；resume 路径另有 `patchOrphanedToolUses` 兜底。
- **单写者**：transcript 只由 agent-server 进程的 Engine 追加，`archive_marker`/`archive_range` 都经 worker query 进入同一写者，无跨进程并发写（对照记忆里 CronStore 锁的教训——这里不引入第二个写者）。
- **失败开放**：坏标记（to 锚点找不到）被忽略、回放退化为全量历史——宁可上下文大，不可吞消息。
- **不删数据**：原提案第 5 条的承诺保持——迁移只追加事件，transcript.jsonl 里所有原始消息永久保留，UI 查看历史不受影响（UI 走 transcript-reader，不走 toMessages）。

## Self-Review 记录

- 覆盖检查：原提案 5 条 → 分层(设计依据§1)、当前切片+摘要默认发送(Task 1/2)、旧摘要入 journal(已存在)、两套压缩分开(不动 ContextManager)、老会话自动修复(Task 5)。全覆盖。
- 类型一致性：`appendRangeArchive` 返回 `TranscriptEvent | undefined`，Task 2 以 truthiness 判断；`appendArchiveMarker` 返回 `Promise<boolean>`，Task 3/5 对齐。`anchors` 形状三处一致（engine/protocol/desktop）。
- 已知不确定点（执行时按报错修正，不影响设计）：Engine 构造参数以 `persist-active-model.test.ts` 为准；`PetJournalStore.list()` 排序方向需 grep 确认；protocol fake engine 约 14 处需补空方法（见记忆 fake-engine-test-stubs）。
