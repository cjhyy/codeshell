# Pet 全局态势收尾：外部 Codex / Claude CLI Session 接入（可开关）+ 卡片安全摘要 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把独立 Codex CLI/App 与 Claude Code CLI 会话接入 Pet 实时 projection（host 侧通用 per-CLI adapter，事件驱动、只带元数据），每种 CLI 一个**从源头启停的开关（默认关）**，并在 Session 卡片上渲染待审批决策的安全摘要（风险等级徽章）。

**产品决策（2026-07-20 用户拍板）：**
- 开关**从源头关**：关闭时 adapter 完全不扫描/不 tail 该 CLI 的会话文件，零后台开销，也不读别的工具的会话记录；不是"读了但 UI 藏起来"。
- **默认关闭**：装好后 Pet 只显示 CodeShell 内会话；需要看 Codex/Claude 时在设置里逐个打开。
- **Codex 与 Claude 各一个独立开关**，可单独开。因此 Claude CLI 接入是本计划一等实现，不再是 follow-up。

**Architecture:** 新增 desktop main 侧通用 `ExternalSessionAdapter`，按 `cli`（`"codex"` / `"claude"`）分派发现源与 tail 解析：Codex 走 `discoverRecentCodexSessions` + `parseCodexTranscriptLine` + `~/.codex`，Claude 走 `discoverRecentClaudeSessions` + `parseClaudeTranscriptLine` + `~/.claude`。adapter 周期发现近期会话文件，对活跃文件做 `watchFile` tail（模式对齐 `cc-room/transcript-subscriptions.ts`），把追加行归约成 runState/phase 元数据，作为第三数据源推入 `PetStateAggregator`（现有 disk/live 双源之外）。每个开启的 CLI 一个 adapter 实例；开关关闭时不构造/停止该实例并移除其已推送的卡片。渲染端零新数据通道——外部会话作为带 `external` 标记的普通 projection 卡片流经既有 IPC。安全摘要是纯渲染端改动：卡片按 `pending` 里该会话的最高 `riskLevel` 渲染徽章。

**Tech Stack:** TypeScript、Zod（settings schema）、bun:test、Node fs（watchFile/readSync）、React（renderToStaticMarkup 测试）、Tailwind + i18n dict。

**关键既有锚点（先读再动手）：**
- `packages/coding/src/cc-orchestrator/codex-session-discovery.ts` — rollout 走查/首行 meta/首条用户消息（模块私有 helper：`walkRollouts`/`readSessionMeta`/`readFirstUserMessage`）
- `packages/coding/src/cc-orchestrator/codex-session-history.ts:101` — `parseCodexTranscriptLine(line): SessionTailEvent[]`
- `packages/coding/src/cc-orchestrator/session-history.ts:20` — `SessionTailEvent`（user/assistant/tool/tool_result/turn_end）
- `packages/desktop/src/main/cc-room/transcript-subscriptions.ts` — tail -f 的 drain/carry/rotation 处理范式
- `packages/desktop/src/main/pet/pet-state-aggregator.ts` — `DesktopPetSession`、`getSnapshot()` 多源合并、`emit()`
- `packages/desktop/src/preload/pet-api.ts:51` — 渲染端 `PetSessionProjection`
- `packages/desktop/src/renderer/pet/SessionStatusSection.tsx` — 卡片 UI
- `packages/desktop/src/renderer/i18n/ns/pet.ts` — pet 文案（session.state 约在 115 行）

**明确不做（本计划 Non-goals）：**
- 点击外部会话跳转（外部会话记录没有 CodeShell 内可打开的目标；跳 cc-room 留 follow-up）——外部卡片禁用点击并给提示
- 外部会话的"等待审批"检测（Codex rollout / Claude transcript 都不记录审批等待事件，诚实呈现 running/idle/dormant）
- `PetWorkTree.tsx`（完整 Pet 页工作树）上的风险徽章——本次只做 `SessionStatusSection`（独立窗口控制台 + 复用它的入口）
- 开关的 per-project scope：外部会话可见性是**全局开关**（`SettingsScope = "global"`），不做按项目区分

**假设：**
- Codex App 与 Codex CLI 共用 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 布局；Claude Code 用 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`（两者现有 discovery 已依赖）。
- Claude 的 `encodeCwd` 有损（非字母数字全变 `-`），无法从目录名反解真实路径；真实 cwd 取自会话文件首行 JSON 的 `cwd` 字段（Task 1b 读取）。

---

### Task 1a: coding 包 — 全局近期 Codex 会话发现 `discoverRecentCodexSessions`

现有 `discoverCodexSessionsForCwds` 按 cwd 集过滤，Pet 全局视图需要"近期全部"。新增一个不过滤 cwd、返回文件路径（供 tail 用）、按 sessionId 去重（同一 thread 多次 resume 会产生多个 rollout 文件，保留 mtime 最新的）的版本。

**Files:**
- Modify: `packages/coding/src/cc-orchestrator/codex-session-discovery.ts`
- Test: `packages/coding/src/cc-orchestrator/codex-session-discovery.test.ts`（追加，文件里已有 `writeRollout`/`metaLine`/`userItem` fixture helper）

- [ ] **Step 1: 写失败测试**

在 `codex-session-discovery.test.ts` 末尾追加（复用文件顶部已有的 helper）：

```ts
import { discoverRecentCodexSessions } from "./codex-session-discovery.js";

describe("discoverRecentCodexSessions", () => {
  it("returns recent sessions across all cwds with file path, newest first", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeRollout(home, "2026/07/19", "rollout-a.jsonl", [
      metaLine("thread-a", "/tmp/proj-a", "2026-07-19T10:00:00Z"),
      userItem("fix the login bug"),
    ]);
    writeRollout(home, "2026/07/20", "rollout-b.jsonl", [
      metaLine("thread-b", "/tmp/proj-b", "2026-07-20T10:00:00Z"),
      userItem("write release notes"),
    ]);

    const sessions = discoverRecentCodexSessions({}, home);
    expect(sessions.map((s) => s.sessionId)).toEqual(["thread-b", "thread-a"]);
    expect(sessions[0]!.cwd).toBe("/tmp/proj-b");
    expect(sessions[0]!.file.endsWith("rollout-b.jsonl")).toBe(true);
    expect(sessions[0]!.firstMessage).toBe("write release notes");
    expect(sessions[0]!.lastModified).toBeGreaterThan(0);
  });

  it("dedupes by sessionId keeping the newest rollout, honors sinceMs, skips broken files", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeRollout(home, "2026/07/18", "rollout-old.jsonl", [
      metaLine("thread-a", "/tmp/proj-a", "2026-07-18T10:00:00Z"),
      userItem("first attempt"),
    ]);
    writeRollout(home, "2026/07/20", "rollout-new.jsonl", [
      metaLine("thread-a", "/tmp/proj-a", "2026-07-20T10:00:00Z"),
      userItem("resumed"),
    ]);
    // 首行不是合法 JSON 的坏文件必须被静默跳过
    const brokenDir = join(home, "sessions", "2026", "07", "20");
    writeFileSync(join(brokenDir, "rollout-broken.jsonl"), "not-json\n");
    // 让 old 的 mtime 早于窗口
    const oldFile = join(home, "sessions", "2026", "07", "18", "rollout-old.jsonl");
    const past = Date.now() - 48 * 60 * 60_000;
    utimesSync(oldFile, new Date(past), new Date(past));

    const sessions = discoverRecentCodexSessions({ sinceMs: 24 * 60 * 60_000 }, home);
    expect(sessions.map((s) => s.sessionId)).toEqual(["thread-a"]);
    expect(sessions[0]!.file.endsWith("rollout-new.jsonl")).toBe(true);
  });
});
```

同时把测试文件顶部的 `import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";` 扩为 `import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/coding && bun test src/cc-orchestrator/codex-session-discovery.test.ts`
Expected: FAIL，`discoverRecentCodexSessions` is not exported。

- [ ] **Step 3: 最小实现**

在 `codex-session-discovery.ts` 的 `countCodexSessionsForCwds` 之后追加：

```ts
/** One Codex session discovered globally (no cwd filter), for the Pet
 *  external-session adapter. `file` is the newest rollout for this thread. */
export interface RecentCodexSession {
  sessionId: string;
  cwd: string;
  file: string;
  lastModified: number;
  firstMessage: string;
}

/**
 * Discover ALL recent codex sessions regardless of cwd. Same bounded-read
 * strategy as `discoverCodexSessionsForCwds` (stat pass → recency window →
 * first-line meta), plus per-thread dedup: a resumed thread appends a NEW
 * rollout file with the same session_meta id, so keep only the newest file
 * (windowed list is already mtime-descending — first hit wins).
 */
export function discoverRecentCodexSessions(
  opts: DiscoverOptions = {},
  codexHome = join(homedir(), ".codex"),
): RecentCodexSession[] {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return [];
  const stats: { file: string; mtimeMs: number }[] = [];
  for (const file of walkRollouts(root)) {
    try {
      stats.push({ file, mtimeMs: statSync(file).mtimeMs });
    } catch {
      continue;
    }
  }
  const windowed = selectRecentStats(stats, { sinceMs: opts.sinceMs, now: opts.now });
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const out = new Map<string, RecentCodexSession>();
  for (const s of windowed) {
    if (out.size >= limit) break;
    let meta: { id?: string; cwd?: string } | undefined;
    try {
      meta = readSessionMeta(s.file);
    } catch {
      continue;
    }
    if (!meta?.id || !meta.cwd || out.has(meta.id)) continue;
    out.set(meta.id, {
      sessionId: meta.id,
      cwd: meta.cwd,
      file: s.file,
      lastModified: s.mtimeMs,
      firstMessage: readFirstUserMessage(s.file),
    });
  }
  return [...out.values()];
}
```

（`walkRollouts`/`readSessionMeta`/`readFirstUserMessage`/`selectRecentStats` 均为本文件已有引用，无需新 import。该文件经 `index.ts` 的 `export * from "./codex-session-discovery.js"` 自动进入 `@cjhyy/code-shell-capability-coding/orchestration` 导出面。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/coding && bun test src/cc-orchestrator/codex-session-discovery.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add packages/coding/src/cc-orchestrator/codex-session-discovery.ts packages/coding/src/cc-orchestrator/codex-session-discovery.test.ts
git commit -m "feat(coding): global recent codex session discovery for pet projection"
```

---

### Task 1b: coding 包 — 全局近期 Claude 会话发现 `discoverRecentClaudeSessions`

Claude 存储按 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，不像 Codex 按日期。全局发现遍历所有 project 子目录、取近期文件、从**文件首行 JSON 的 `cwd`** 拿真实路径（目录名的 `encodeCwd` 有损无法反解）。返回与 Codex 同构的 `RecentExternalSession` 形状供 adapter 复用。

**Files:**
- Modify: `packages/coding/src/cc-orchestrator/session-discovery.ts`
- Test: `packages/coding/src/cc-orchestrator/session-discovery.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

先看现有测试文件的 fixture helper 命名（`grep -n "function write\|mkdtempSync" packages/coding/src/cc-orchestrator/session-discovery.test.ts`），沿用其写 `~/.claude/projects/<encoded>/<id>.jsonl` 的方式。若没有则自建：

```ts
import { discoverRecentClaudeSessions } from "./session-discovery.js";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeClaudeSession(
  claudeHome: string,
  cwd: string,
  sessionId: string,
  lines: unknown[],
): string {
  const dir = join(claudeHome, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("discoverRecentClaudeSessions", () => {
  it("walks all project dirs, reads real cwd from the first line, newest first", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-home-"));
    writeClaudeSession(home, "/Users/me/proj-a", "sess-a", [
      { type: "user", cwd: "/Users/me/proj-a", message: { role: "user", content: "fix bug" } },
    ]);
    const fileB = writeClaudeSession(home, "/Users/me/proj-b", "sess-b", [
      { type: "user", cwd: "/Users/me/proj-b", message: { role: "user", content: "write docs" } },
    ]);
    const now = Date.now();
    utimesSync(fileB, new Date(now), new Date(now));

    const sessions = discoverRecentClaudeSessions({}, home);
    const b = sessions.find((s) => s.sessionId === "sess-b");
    expect(b?.cwd).toBe("/Users/me/proj-b");
    expect(b?.file.endsWith("sess-b.jsonl")).toBe(true);
    expect(b?.firstMessage).toBe("write docs");
    expect(sessions.map((s) => s.sessionId)).toContain("sess-a");
  });

  it("honors sinceMs and skips files whose first line lacks cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-home-"));
    const old = writeClaudeSession(home, "/Users/me/proj-a", "sess-old", [
      { type: "user", cwd: "/Users/me/proj-a", message: { role: "user", content: "old" } },
    ]);
    writeClaudeSession(home, "/Users/me/proj-c", "sess-nocwd", [
      { type: "summary", summary: "no cwd here" },
    ]);
    const past = Date.now() - 48 * 60 * 60_000;
    utimesSync(old, new Date(past), new Date(past));

    const sessions = discoverRecentClaudeSessions({ sinceMs: 24 * 60 * 60_000 }, home);
    expect(sessions.some((s) => s.sessionId === "sess-old")).toBe(false);
    expect(sessions.some((s) => s.sessionId === "sess-nocwd")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/coding && bun test src/cc-orchestrator/session-discovery.test.ts`
Expected: FAIL，`discoverRecentClaudeSessions` 未导出。

- [ ] **Step 3: 最小实现**

先把 Task 1a 引入的 `RecentCodexSession` 泛化为共享形状。在 `session-discovery.ts` 顶部（`DiscoveredSession` 之后）新增共享接口，并让 `codex-session-discovery.ts` 复用它（把 Task 1a 里的 `RecentCodexSession` 改为 `export type RecentCodexSession = RecentExternalSession` 或直接改用 `RecentExternalSession`）：

```ts
/** A session discovered globally from an external CLI's own storage, with the
 *  file path so the Pet adapter can tail it. Shared by codex + claude paths. */
export interface RecentExternalSession {
  sessionId: string;
  cwd: string;
  file: string;
  lastModified: number;
  firstMessage: string;
}
```

在 `discoverSessions` 之后新增：

```ts
/** Read just the first line of a file, bounded (no full read of a big transcript). */
function readClaudeFirstLine(file: string, maxBytes = 1 << 16): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.toString("utf-8", 0, n);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    closeSync(fd);
  }
}

/**
 * Discover ALL recent Claude Code sessions across every project dir. Claude
 * encodes cwd into the dir name lossily (encodeCwd), so the real cwd comes from
 * the session file's first-line `cwd` field. Bounded strategy mirrors codex:
 * stat every file, apply the recency window, then read only the first line
 * (cwd) + a bounded prefix (first user message) of the surviving slice.
 */
export function discoverRecentClaudeSessions(
  opts: DiscoverOptions = {},
  claudeHome = join(homedir(), ".claude"),
): RecentExternalSession[] {
  const projects = claudeProjectsDir(claudeHome);
  if (!existsSync(projects)) return [];
  const stats: { file: string; sessionId: string; mtimeMs: number }[] = [];
  for (const projectDir of readdirSync(projects)) {
    const dir = join(projects, projectDir);
    let dirStat;
    try {
      dirStat = statSync(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    for (const entry of listSessionStats(dir)) {
      stats.push({ file: entry.file, sessionId: entry.sessionId, mtimeMs: entry.mtimeMs });
    }
  }
  const windowed = selectRecentStats(stats, { sinceMs: opts.sinceMs, now: opts.now });
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const out: RecentExternalSession[] = [];
  for (const s of windowed) {
    if (out.length >= limit) break;
    let cwd: string | undefined;
    let firstMessage = "";
    try {
      const first = readClaudeFirstLine(s.file).trim();
      const parsed = first ? (JSON.parse(first) as { cwd?: string }) : undefined;
      cwd = typeof parsed?.cwd === "string" ? parsed.cwd : undefined;
      // firstMessage: reuse the bounded reader used by discoverSessions.
      const lines = readClaudeFirstLine(s.file, 1 << 20).split("\n");
      firstMessage = firstUserMessage(lines);
    } catch {
      continue;
    }
    if (!cwd) continue;
    out.push({ sessionId: s.sessionId, cwd, file: s.file, lastModified: s.mtimeMs, firstMessage });
  }
  return out;
}
```

补 import：把文件顶部 `import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";` 扩为
`import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";`。
（`firstUserMessage`/`listSessionStats`/`selectRecentStats`/`claudeProjectsDir` 均为本文件已有。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/coding && bun test src/cc-orchestrator/session-discovery.test.ts src/cc-orchestrator/codex-session-discovery.test.ts`
Expected: PASS（含 Task 1a 用例，因 `RecentCodexSession` 已改为共享类型别名，确认未破坏）

- [ ] **Step 5: Commit**

```bash
git add packages/coding/src/cc-orchestrator/session-discovery.ts packages/coding/src/cc-orchestrator/session-discovery.test.ts packages/coding/src/cc-orchestrator/codex-session-discovery.ts
git commit -m "feat(coding): global recent claude session discovery + shared RecentExternalSession"
```

---

### Task 2: desktop main — 外部会话活动状态纯函数 `external-session-state.ts`

把 tail 事件流归约为 Pet 可用的 runState/phase，独立成无 IO 纯模块，adapter 与测试共用。

**Files:**
- Create: `packages/desktop/src/main/pet/external-session-state.ts`
- Test: `packages/desktop/src/main/pet/external-session-state.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from "bun:test";
import {
  decayExternalActivity,
  reduceExternalTail,
  seedExternalActivity,
} from "./external-session-state";

describe("reduceExternalTail", () => {
  test("tool events set running/tool with toolName; tool_result keeps it", () => {
    let a = reduceExternalTail(undefined, [{ type: "tool", name: "Bash", summary: "ls" }], 1_000);
    expect(a).toEqual({ runState: "running", phase: "tool", toolName: "Bash", lastEventAt: 1_000 });
    a = reduceExternalTail(a, [{ type: "tool_result", result: "ok", isError: false }], 2_000);
    expect(a.phase).toBe("tool");
    expect(a.toolName).toBe("Bash");
    expect(a.lastEventAt).toBe(2_000);
  });

  test("user/assistant → running/model; turn_end → idle without phase", () => {
    let a = reduceExternalTail(undefined, [{ type: "user", text: "hi" }], 1_000);
    expect(a).toEqual({ runState: "running", phase: "model", lastEventAt: 1_000 });
    a = reduceExternalTail(a, [{ type: "assistant", text: "done" }], 2_000);
    expect(a.phase).toBe("model");
    a = reduceExternalTail(a, [{ type: "turn_end", reason: "end_turn" }], 3_000);
    expect(a).toEqual({ runState: "idle", lastEventAt: 3_000 });
  });

  test("empty batch keeps previous state", () => {
    const prev = { runState: "running" as const, phase: "model" as const, lastEventAt: 1_000 };
    expect(reduceExternalTail(prev, [], 9_000)).toBe(prev);
  });
});

describe("seedExternalActivity / decayExternalActivity", () => {
  test("recent mtime seeds running, stale mtime seeds idle", () => {
    expect(seedExternalActivity(9_500, 10_000, 90_000).runState).toBe("running");
    expect(seedExternalActivity(0, 200_000, 90_000).runState).toBe("idle");
  });

  test("running decays to idle after quietMs without events", () => {
    const running = { runState: "running" as const, phase: "tool" as const, toolName: "Bash", lastEventAt: 1_000 };
    expect(decayExternalActivity(running, 50_000, 90_000)).toBe(running);
    const decayed = decayExternalActivity(running, 100_000, 90_000);
    expect(decayed).toEqual({ runState: "idle", lastEventAt: 1_000 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && bun test src/main/pet/external-session-state.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 最小实现**

```ts
import type { SessionTailEvent } from "@cjhyy/code-shell-capability-coding/orchestration";

/**
 * Activity state of one EXTERNAL CLI session (Codex/Claude), derived purely
 * from its transcript tail. No "queued"/"waiting-decision": external storage
 * records neither queueing nor approval waits, so we never claim them.
 */
export interface ExternalSessionActivity {
  runState: "running" | "idle";
  phase?: "model" | "tool";
  /** Most recent tool name while phase === "tool". */
  toolName?: string;
  lastEventAt: number;
}

/** Initial state for a session we have not tailed yet, judged by file mtime. */
export function seedExternalActivity(
  mtimeMs: number,
  now: number,
  quietMs: number,
): ExternalSessionActivity {
  return now - mtimeMs <= quietMs
    ? { runState: "running", lastEventAt: mtimeMs }
    : { runState: "idle", lastEventAt: mtimeMs };
}

export function reduceExternalTail(
  previous: ExternalSessionActivity | undefined,
  events: readonly SessionTailEvent[],
  observedAt: number,
): ExternalSessionActivity {
  let next = previous ?? { runState: "idle" as const, lastEventAt: observedAt };
  for (const event of events) {
    switch (event.type) {
      case "user":
      case "assistant":
        next = { runState: "running", phase: "model", lastEventAt: observedAt };
        break;
      case "tool":
        next = { runState: "running", phase: "tool", toolName: event.name, lastEventAt: observedAt };
        break;
      case "tool_result":
        next = {
          runState: "running",
          phase: "tool",
          ...(next.toolName ? { toolName: next.toolName } : {}),
          lastEventAt: observedAt,
        };
        break;
      case "turn_end":
        next = { runState: "idle", lastEventAt: observedAt };
        break;
    }
  }
  return next;
}

/** A writer killed mid-turn never emits turn_end; fall back to idle after quietMs. */
export function decayExternalActivity(
  activity: ExternalSessionActivity,
  now: number,
  quietMs: number,
): ExternalSessionActivity {
  if (activity.runState !== "running" || now - activity.lastEventAt <= quietMs) return activity;
  return { runState: "idle", lastEventAt: activity.lastEventAt };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && bun test src/main/pet/external-session-state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/pet/external-session-state.ts packages/desktop/src/main/pet/external-session-state.test.ts
git commit -m "feat(desktop): pure activity reducer for external CLI session tails"
```

---

### Task 3: `PetStateAggregator` 增加外部会话数据源

外部会话是与 disk/live 并列的第三源：worker 断连/回收不影响它（它不依赖 worker），`getSnapshot` 的 disconnected 覆盖层不得把外部会话改写成 unknown。

**Files:**
- Modify: `packages/desktop/src/main/pet/pet-state-aggregator.ts`
- Test: `packages/desktop/src/main/pet/pet-state-aggregator.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `pet-state-aggregator.test.ts` 末尾追加（自带最小 stub，不依赖文件里其他 helper 的内部细节）：

```ts
function externalSession(id: string): Parameters<PetStateAggregator["upsertExternalSession"]>[0] {
  return {
    agentSessionId: id,
    title: `Codex ${id}`,
    workspaceDisplayName: "proj-a",
    runState: "running",
    phase: "tool",
    summary: "正在运行 Bash",
    queueDepth: 0,
    lastActivityAt: 5_000,
    pendingDecisionCount: 0,
    external: { cli: "codex", cwd: "/tmp/proj-a" },
    freshness: { source: "external-tail", observedAt: 5_000, workerState: "active" },
  };
}

describe("external session source", () => {
  test("upsert/remove merge into snapshot and emit projection events", async () => {
    const bridge: PetStateBridge = {
      hasLiveWorker: () => false,
      requestPetProjectionSnapshot: async () => null,
      subscribePetProjection: () => () => {},
    };
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: async () => ({ sessions: [], nextCursor: null }),
      catalogRefreshIntervalMs: 0,
    });
    await aggregator.start();
    const events: DesktopPetProjectionEvent[] = [];
    aggregator.subscribe((event) => events.push(event));

    aggregator.upsertExternalSession(externalSession("thread-a"));
    expect(events.at(-1)).toMatchObject({ kind: "session-upsert" });
    const snapshot = aggregator.getSnapshot();
    const found = snapshot.sessions.find((s) => s.agentSessionId === "thread-a");
    expect(found?.external?.cli).toBe("codex");
    expect(found?.runState).toBe("running");

    aggregator.removeExternalSession("thread-a");
    expect(events.at(-1)).toMatchObject({ kind: "session-remove", sessionId: "thread-a" });
    expect(
      aggregator.getSnapshot().sessions.some((s) => s.agentSessionId === "thread-a"),
    ).toBe(false);
    aggregator.stop();
  });

  test("worker disconnect does not overwrite external sessions to unknown", async () => {
    let emitLifecycle: ((event: AgentBridgePetEvent) => void) | undefined;
    const bridge: PetStateBridge = {
      hasLiveWorker: () => false,
      requestPetProjectionSnapshot: async () => null,
      subscribePetProjection: (listener) => {
        emitLifecycle = listener;
        return () => {};
      },
    };
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions: async () => ({ sessions: [], nextCursor: null }),
      catalogRefreshIntervalMs: 0,
    });
    await aggregator.start();
    aggregator.upsertExternalSession(externalSession("thread-a"));
    emitLifecycle!({ kind: "lifecycle", state: "disconnected" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const found = aggregator
      .getSnapshot()
      .sessions.find((s) => s.agentSessionId === "thread-a");
    expect(found?.runState).toBe("running");
    expect(found?.freshness.workerState).toBe("active");
    aggregator.stop();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && bun test src/main/pet/pet-state-aggregator.test.ts`
Expected: FAIL，`upsertExternalSession` 不存在 + `external` 字段类型错误。

- [ ] **Step 3: 实现**

`pet-state-aggregator.ts` 三处改动：

① `DesktopPetSession` 接口（第 17-33 行）追加字段并放宽 freshness source：

```ts
export interface DesktopPetSession {
  agentSessionId: string;
  title?: string;
  workspaceDisplayName?: string;
  runState: PetSessionProjection["runState"];
  phase?: PetSessionProjection["phase"];
  summary?: string;
  queueDepth: number;
  lastActivityAt: number;
  pendingDecisionCount: number;
  terminal?: PetSessionProjection["terminal"];
  /** Present on sessions observed from an external CLI's own storage
   *  (Codex/Claude rollouts), not from our worker. */
  external?: { cli: "codex" | "claude"; cwd?: string };
  freshness: {
    source: PetSessionProjection["freshness"]["source"] | "external-tail";
    observedAt: number;
    workerState: DesktopPetWorkerState;
  };
}
```

② 类内新增源与方法（`private readonly liveSessions` 旁边加一个 map；`subscribe` 方法后加两个公开方法）：

```ts
  private readonly externalSessions = new Map<string, DesktopPetSession>();
```

```ts
  /** External-CLI source (Codex/Claude adapters). Independent of the worker:
   *  lifecycle loss must not clear or overlay these. */
  upsertExternalSession(session: DesktopPetSession): void {
    this.externalSessions.set(session.agentSessionId, session);
    this.observedAt = this.now();
    this.emit({ kind: "session-upsert", session });
  }

  removeExternalSession(agentSessionId: string): void {
    if (!this.externalSessions.delete(agentSessionId)) return;
    this.observedAt = this.now();
    this.emit({ kind: "session-remove", sessionId: agentSessionId });
  }
```

③ `getSnapshot()`：在 disconnected 覆盖层循环**之后**、`return` 之前合入外部源（外部会话 id 是 Codex thread UUID，与本地 engineSessionId 无碰撞）：

```ts
    for (const [sessionId, session] of this.externalSessions) {
      sessions.set(sessionId, session);
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && bun test src/main/pet/pet-state-aggregator.test.ts`
Expected: PASS（全部既有用例 + 新增 2 条）

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/pet/pet-state-aggregator.ts packages/desktop/src/main/pet/pet-state-aggregator.test.ts
git commit -m "feat(desktop): external-CLI session source in PetStateAggregator"
```

---

### Task 4: `ExternalSessionAdapter` — 通用（按 CLI 分派）发现 + tail + 推送

adapter 对 CLI 无关：构造时注入 `cli`、`discover`、`parseLine`。Codex 与 Claude 各实例化一次（Task 5）。下面测试用 Codex 形态验证核心逻辑，Claude 只需换 `cli`/`parseLine`/fixture，逻辑同构，故不重复整套测试，只在 Step 6 加一条 Claude 冒烟。

**Files:**
- Create: `packages/desktop/src/main/pet/external-session-adapter.ts`
- Test: `packages/desktop/src/main/pet/external-session-adapter.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecentExternalSession } from "@cjhyy/code-shell-capability-coding/orchestration";
import { parseCodexTranscriptLine } from "@cjhyy/code-shell-capability-coding/orchestration";
import type { DesktopPetSession } from "./pet-state-aggregator";
import { ExternalSessionAdapter, type ExternalPetSessionSink } from "./external-session-adapter";

function rolloutLine(payload: unknown): string {
  return JSON.stringify({ type: "response_item", payload }) + "\n";
}

function recordingSink(): ExternalPetSessionSink & {
  upserts: DesktopPetSession[];
  removals: string[];
} {
  const upserts: DesktopPetSession[] = [];
  const removals: string[] = [];
  return {
    upserts,
    removals,
    upsertExternalSession: (session) => upserts.push(session),
    removeExternalSession: (id) => removals.push(id),
  };
}

function makeRollout(dir: string, name: string, threadId: string, cwd: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd } }) + "\n",
  );
  return file;
}

describe("ExternalSessionAdapter", () => {
  test("scan publishes discovered sessions; appended tool lines flip phase to tool", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    const file = makeRollout(join(home, "s"), "rollout-a.jsonl", "thread-a", "/tmp/proj-a");
    let now = 10_000;
    const meta: RecentExternalSession = {
      sessionId: "thread-a",
      cwd: "/tmp/proj-a",
      file,
      lastModified: now,
      firstMessage: "fix login",
    };
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "codex",
      parseLine: parseCodexTranscriptLine,
      sink,
      discover: () => [meta],
      scanIntervalMs: 0, // manual scans in tests
      now: () => now,
    });
    await adapter.scanOnce();
    expect(sink.upserts.at(-1)).toMatchObject({
      agentSessionId: "thread-a",
      title: "fix login",
      workspaceDisplayName: "proj-a",
      runState: "running", // mtime within quiet window
      external: { cli: "codex", cwd: "/tmp/proj-a" },
      freshness: { source: "external-tail" },
    });

    appendFileSync(file, rolloutLine({ type: "function_call", name: "shell", arguments: "{}" }));
    now = 11_000;
    adapter.pollOnce();
    expect(sink.upserts.at(-1)).toMatchObject({
      agentSessionId: "thread-a",
      runState: "running",
      phase: "tool",
    });

    // 无变化的 poll 不再重复推送
    const count = sink.upserts.length;
    adapter.pollOnce();
    expect(sink.upserts.length).toBe(count);
    adapter.stop();
  });

  test("turn_end flips to idle; quiet decay flips a stuck running session to idle", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    const file = makeRollout(join(home, "s"), "rollout-b.jsonl", "thread-b", "/tmp/proj-b");
    let now = 10_000;
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "codex",
      parseLine: parseCodexTranscriptLine,
      sink,
      discover: () => [
        { sessionId: "thread-b", cwd: "/tmp/proj-b", file, lastModified: now, firstMessage: "" },
      ],
      scanIntervalMs: 0,
      quietMs: 90_000,
      now: () => now,
    });
    await adapter.scanOnce();
    appendFileSync(file, JSON.stringify({ type: "turn_end", reason: "end" }) + "\n");
    // parseCodexTranscriptLine 不产出 turn_end?——用 task_complete 事件核实：见实现注释。
    appendFileSync(
      file,
      rolloutLine({ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }),
    );
    adapter.pollOnce();
    expect(sink.upserts.at(-1)!.runState).toBe("running");

    now = 200_000; // 超过 quietMs 无新事件
    adapter.pollOnce();
    expect(sink.upserts.at(-1)!.runState).toBe("idle");
    adapter.stop();
  });

  test("sessions leaving the discovery window are removed and unwatched", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-adapter-"));
    const file = makeRollout(join(home, "s"), "rollout-c.jsonl", "thread-c", "/tmp/proj-c");
    const metas: RecentExternalSession[] = [
      { sessionId: "thread-c", cwd: "/tmp/proj-c", file, lastModified: 10_000, firstMessage: "" },
    ];
    const sink = recordingSink();
    const adapter = new ExternalSessionAdapter({
      cli: "codex",
      parseLine: parseCodexTranscriptLine,
      sink,
      discover: () => metas,
      scanIntervalMs: 0,
      now: () => 10_000,
    });
    await adapter.scanOnce();
    metas.length = 0;
    await adapter.scanOnce();
    expect(sink.removals).toEqual(["thread-c"]);
    adapter.stop();
  });
});
```

注意第二个测试里对 `turn_end` 的探索性注释：写实现前先跑一下
`grep -n "turn_end\|task_complete" packages/coding/src/cc-orchestrator/codex-session-history.ts`
确认 `parseCodexTranscriptLine` 用哪种 rollout 事件产出 `turn_end`（Codex 侧一般是 `{type:"event_msg", payload:{type:"task_complete"}}` 或类似）。按实际解析器行为修正该测试的 fixture 行——**以解析器为准，不改解析器**。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && bun test src/main/pet/external-session-adapter.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

```ts
import { closeSync, openSync, readSync, statSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { basename } from "node:path";
import type {
  RecentExternalSession,
  SessionTailEvent,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import {
  decayExternalActivity,
  reduceExternalTail,
  seedExternalActivity,
  type ExternalSessionActivity,
} from "./external-session-state.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";

export type ExternalCli = "codex" | "claude";

export interface ExternalPetSessionSink {
  upsertExternalSession(session: DesktopPetSession): void;
  removeExternalSession(agentSessionId: string): void;
}

export interface ExternalSessionAdapterOptions {
  /** Which external CLI this adapter tracks. Tags the projection card. */
  cli: ExternalCli;
  /** Parse one appended transcript line to tail events (codex/claude parser). */
  parseLine: (line: string) => SessionTailEvent[];
  sink: ExternalPetSessionSink;
  /** Discovery pass; production wires discoverRecent{Codex,Claude}Sessions. */
  discover: () => RecentExternalSession[];
  /** 0 disables the internal timer (tests drive scanOnce/pollOnce manually). */
  scanIntervalMs?: number;
  /** Only sessions this fresh get a live tail watcher. */
  liveWindowMs?: number;
  /** Running with no events for this long decays to idle. */
  quietMs?: number;
  /** watchFile poll interval for live rollouts. */
  tailPollMs?: number;
  now?: () => number;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

interface WatchedSession {
  meta: RecentExternalSession;
  offset: number;
  carry: string;
  activity: ExternalSessionActivity;
  listener?: (curr: Stats, prev: Stats) => void;
  lastPublishedKey?: string;
}

const MAX_TITLE_LENGTH = 160;

function bounded(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

/**
 * Host-side adapter for one EXTERNAL coding CLI (Codex or Claude). Periodically
 * discovers recent sessions, tails live ones (same drain/carry pattern as
 * cc-room/transcript-subscriptions), reduces tail events to metadata-only
 * activity state, and feeds the PetStateAggregator. Carries no transcript
 * content, tool args/outputs, or file contents into the projection. CLI-neutral:
 * the caller injects `discover` + `parseLine`, so one class serves both CLIs.
 */
export class ExternalSessionAdapter {
  private readonly records = new Map<string, WatchedSession>();
  private readonly scanIntervalMs: number;
  private readonly liveWindowMs: number;
  private readonly quietMs: number;
  private readonly tailPollMs: number;
  private readonly now: () => number;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(private readonly options: ExternalSessionAdapterOptions) {
    this.scanIntervalMs = options.scanIntervalMs ?? 15_000;
    this.liveWindowMs = options.liveWindowMs ?? 30 * 60_000;
    this.quietMs = options.quietMs ?? 90_000;
    this.tailPollMs = options.tailPollMs ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    void this.scanOnce().catch((error) => this.options.onBackgroundError?.("scan", error));
    if (this.scanIntervalMs > 0) {
      this.scanTimer = setInterval(() => {
        if (this.scanning) return;
        void this.scanOnce().catch((error) => this.options.onBackgroundError?.("scan", error));
      }, this.scanIntervalMs);
      (this.scanTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    for (const record of this.records.values()) this.unwatch(record);
    this.records.clear();
  }

  /** One discovery pass: reconcile the record set with what is on disk. */
  async scanOnce(): Promise<void> {
    this.scanning = true;
    try {
      const discovered = this.options.discover();
      const now = this.now();
      const seen = new Set<string>();
      for (const meta of discovered) {
        seen.add(meta.sessionId);
        let record = this.records.get(meta.sessionId);
        if (!record) {
          record = {
            meta,
            offset: this.safeSize(meta.file),
            carry: "",
            activity: seedExternalActivity(meta.lastModified, now, this.quietMs),
          };
          this.records.set(meta.sessionId, record);
        } else if (record.meta.file !== meta.file) {
          // Resume opened a NEW rollout file for the same thread: rebase the tail.
          this.unwatch(record);
          record.meta = meta;
          record.offset = this.safeSize(meta.file);
          record.carry = "";
        } else {
          record.meta = meta;
        }
        const live = now - meta.lastModified <= this.liveWindowMs;
        if (live && !record.listener) this.watch(record);
        if (!live && record.listener) this.unwatch(record);
        record.activity = decayExternalActivity(record.activity, now, this.quietMs);
        this.publish(record);
      }
      for (const [sessionId, record] of this.records) {
        if (seen.has(sessionId)) continue;
        this.unwatch(record);
        this.records.delete(sessionId);
        this.options.sink.removeExternalSession(sessionId);
      }
    } finally {
      this.scanning = false;
    }
  }

  /** Drain + decay every record once. Tests call this instead of watchFile timers. */
  pollOnce(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      this.drain(record);
      record.activity = decayExternalActivity(record.activity, now, this.quietMs);
      this.publish(record);
    }
  }

  private watch(record: WatchedSession): void {
    const listener = (curr: Stats): void => {
      if (curr.nlink === 0) {
        this.unwatch(record);
        return;
      }
      this.drain(record);
      this.publish(record);
    };
    record.listener = listener;
    watchFile(record.meta.file, { interval: this.tailPollMs, persistent: false }, listener);
  }

  private unwatch(record: WatchedSession): void {
    if (!record.listener) return;
    unwatchFile(record.meta.file, record.listener);
    record.listener = undefined;
  }

  private safeSize(file: string): number {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }

  private drain(record: WatchedSession): void {
    let size: number;
    try {
      size = statSync(record.meta.file).size;
    } catch {
      return;
    }
    if (size < record.offset) {
      // Rewrite/rotation is a new stream boundary; do not replay.
      record.offset = size;
      record.carry = "";
      return;
    }
    if (size === record.offset) return;
    const buffer = Buffer.alloc(size - record.offset);
    const fd = openSync(record.meta.file, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, record.offset);
    } finally {
      closeSync(fd);
    }
    record.offset = size;
    const data = record.carry + buffer.toString("utf-8");
    const lastNewline = data.lastIndexOf("\n");
    if (lastNewline < 0) {
      record.carry = data;
      return;
    }
    record.carry = data.slice(lastNewline + 1);
    const events = data
      .slice(0, lastNewline)
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => this.options.parseLine(line));
    if (events.length === 0) return;
    record.activity = reduceExternalTail(record.activity, events, this.now());
  }

  private publish(record: WatchedSession): void {
    const session = this.toPetSession(record);
    const key = `${session.runState}|${session.phase ?? ""}|${session.summary ?? ""}|${session.lastActivityAt}`;
    if (record.lastPublishedKey === key) return;
    record.lastPublishedKey = key;
    this.options.sink.upsertExternalSession(session);
  }

  private toPetSession(record: WatchedSession): DesktopPetSession {
    const { meta, activity } = record;
    return {
      agentSessionId: meta.sessionId,
      title: meta.firstMessage ? bounded(meta.firstMessage, MAX_TITLE_LENGTH) : basename(meta.cwd),
      workspaceDisplayName: basename(meta.cwd),
      runState: activity.runState,
      ...(activity.phase ? { phase: activity.phase } : {}),
      ...(activity.phase === "tool" && activity.toolName
        ? { summary: `正在运行 ${activity.toolName}` }
        : {}),
      queueDepth: 0,
      lastActivityAt: Math.max(activity.lastEventAt, meta.lastModified),
      pendingDecisionCount: 0,
      external: { cli: this.options.cli, cwd: meta.cwd },
      freshness: { source: "external-tail", observedAt: this.now(), workerState: "active" },
    };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && bun test src/main/pet/external-session-adapter.test.ts`
Expected: PASS（3 条）

- [ ] **Step 6: 加一条 Claude 分派冒烟**

追加一条测试，只换 `cli: "claude"` + `parseLine: parseClaudeTranscriptLine` + Claude 行 fixture（`{ type: "assistant", message: { content: [{ type: "text", text: "hi" }], stop_reason: null } }`），断言卡片 `external.cli === "claude"` 且工具行使 phase 变 `tool`。import 从 orchestration 加 `parseClaudeTranscriptLine`。

Run: `cd packages/desktop && bun test src/main/pet/external-session-adapter.test.ts`
Expected: PASS（4 条）

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/main/pet/external-session-adapter.ts packages/desktop/src/main/pet/external-session-adapter.test.ts
git commit -m "feat(desktop): CLI-neutral external session adapter (codex + claude) for pet"
```

---

### Task 5: 设置开关 schema（默认关）

两个全局布尔开关，默认 `false`。放进 core settings schema 的合适子树（读 `packages/core/src/settings/schema.ts` 找 top-level 对象；若有 `pet`/`ui` 子树则并入，否则新增 `pet` 子树）。

**Files:**
- Modify: `packages/core/src/settings/schema.ts`
- Test: `packages/core/src/settings/schema.test.ts`（若存在；否则加到 manager 的测试）

- [ ] **Step 1: 写失败测试**

```ts
// 在 settings schema 测试里追加
test("pet external-session toggles default to false and validate booleans", () => {
  const parsed = SettingsSchema.parse({});
  expect(parsed.pet?.showExternalCodexSessions ?? false).toBe(false);
  expect(parsed.pet?.showExternalClaudeSessions ?? false).toBe(false);
  expect(
    SettingsSchema.parse({ pet: { showExternalCodexSessions: true } }).pet
      ?.showExternalCodexSessions,
  ).toBe(true);
});
```

（`SettingsSchema` 名称以文件实际导出为准——先 `grep -n "export const.*Schema = z.object" packages/core/src/settings/schema.ts` 找根 schema。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/settings/schema.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

在根 settings schema 里加（若已有 `pet` 子树则合并这两个键）：

```ts
  pet: z
    .object({
      /** Show external Codex CLI/App sessions in the Pet global view. When off,
       *  the host does not scan or tail Codex session files at all. Default off. */
      showExternalCodexSessions: z.boolean().default(false),
      /** Same, for external Claude Code CLI sessions. Default off. */
      showExternalClaudeSessions: z.boolean().default(false),
    })
    .default({}),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/settings/schema.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settings/schema.ts packages/core/src/settings/schema.test.ts
git commit -m "feat(core): pet external-session visibility toggles (default off)"
```

---

### Task 6: main 进程接线 + 开关启停 + preload 类型贯通

adapter 由开关驱动：开→构造并 start，关→stop 并移除该 CLI 已推送的所有外部卡片。设置热变更时 re-evaluate。

**Files:**
- Modify: `packages/desktop/src/main/index.ts`（aggregator 创建于 ~1065 行、`await aggregator.start()` 于 ~1168 行、settings IPC 于 ~3830 行、清理段于 ~4142 行）
- Modify: `packages/desktop/src/main/pet/pet-state-aggregator.ts`（新增按 cli 批量移除）
- Modify: `packages/desktop/src/preload/pet-api.ts:51`（`PetSessionProjection`）
- Test: `packages/desktop/src/main/pet/pet-state-aggregator.test.ts`（追加 removeExternalSessionsByCli）

- [ ] **Step 0: aggregator 加按 CLI 批量移除**

先写失败测试（追加到 pet-state-aggregator.test.ts）：

```ts
test("removeExternalSessionsByCli drops only that CLI's external sessions", async () => {
  const bridge: PetStateBridge = {
    hasLiveWorker: () => false,
    requestPetProjectionSnapshot: async () => null,
    subscribePetProjection: () => () => {},
  };
  const aggregator = new PetStateAggregator({
    bridge,
    listDiskSessions: async () => ({ sessions: [], nextCursor: null }),
    catalogRefreshIntervalMs: 0,
  });
  await aggregator.start();
  aggregator.upsertExternalSession({ ...externalSession("codex-1"), external: { cli: "codex" } });
  aggregator.upsertExternalSession({ ...externalSession("claude-1"), external: { cli: "claude" } });
  aggregator.removeExternalSessionsByCli("codex");
  const ids = aggregator.getSnapshot().sessions.map((s) => s.agentSessionId);
  expect(ids).not.toContain("codex-1");
  expect(ids).toContain("claude-1");
  aggregator.stop();
});
```

实现（`removeExternalSession` 旁）：

```ts
  removeExternalSessionsByCli(cli: "codex" | "claude"): void {
    for (const [id, session] of this.externalSessions) {
      if (session.external?.cli === cli) this.removeExternalSession(id);
    }
  }
```

Run: `cd packages/desktop && bun test src/main/pet/pet-state-aggregator.test.ts` → PASS。

- [ ] **Step 1: preload 类型扩展**

`pet-api.ts` 的 `PetSessionProjection`：

```ts
export interface PetSessionProjection {
  agentSessionId: string;
  title?: string;
  workspaceDisplayName?: string;
  runState: PetSessionRunState;
  phase?: "model" | "tool" | "waiting-decision" | "compacting" | "finalizing";
  summary?: string;
  queueDepth: number;
  lastActivityAt: number;
  pendingDecisionCount: number;
  terminal?: { status: "completed" | "failed" | "cancelled"; at: number };
  /** Present on sessions observed from an external CLI (Codex/Claude). */
  external?: { cli: "codex" | "claude"; cwd?: string };
  freshness: {
    source: "disk" | "live-snapshot" | "live-event" | "external-tail";
    observedAt: number;
    workerState: PetWorkerState;
  };
}
```

- [ ] **Step 2: main 接线（开关驱动的 adapter 生命周期）**

`index.ts` 顶部 import 区（91 行 `PetStateAggregator` import 附近）：

```ts
import { ExternalSessionAdapter, type ExternalCli } from "./pet/external-session-adapter.js";
import {
  discoverRecentCodexSessions,
  discoverRecentClaudeSessions,
  parseCodexTranscriptLine,
  parseClaudeTranscriptLine,
} from "@cjhyy/code-shell-capability-coding/orchestration";
```

模块级变量（455 行 `let petStateAggregator` 旁）：

```ts
const petExternalAdapters = new Map<ExternalCli, ExternalSessionAdapter>();
```

aggregator 创建之后（~1076 行 `petStateAggregator = aggregator;` 之后）加一个按开关调谐的辅助函数（`getSettings` 名称以实际 settings 读取入口为准——见 Step 3）：

```ts
    const EXTERNAL_CLI_CONFIG: Record<
      ExternalCli,
      { discover: ExternalSessionAdapterOptions["discover"]; parseLine: (line: string) => SessionTailEvent[]; toggle: (s: AppSettings) => boolean }
    > = {
      codex: {
        discover: () => discoverRecentCodexSessions({ sinceMs: 24 * 60 * 60_000, limit: 50 }),
        parseLine: parseCodexTranscriptLine,
        toggle: (s) => s.pet?.showExternalCodexSessions ?? false,
      },
      claude: {
        discover: () => discoverRecentClaudeSessions({ sinceMs: 24 * 60 * 60_000, limit: 50 }),
        parseLine: parseClaudeTranscriptLine,
        toggle: (s) => s.pet?.showExternalClaudeSessions ?? false,
      },
    };

    // Turn each CLI's adapter on/off to match settings. Off = the adapter never
    // runs (no scan, no tail) AND its already-published cards are dropped.
    function reconcileExternalAdapters(settings: AppSettings): void {
      for (const cli of ["codex", "claude"] as const) {
        const want = EXTERNAL_CLI_CONFIG[cli].toggle(settings);
        const running = petExternalAdapters.get(cli);
        if (want && !running) {
          const adapter = new ExternalSessionAdapter({
            cli,
            discover: EXTERNAL_CLI_CONFIG[cli].discover,
            parseLine: EXTERNAL_CLI_CONFIG[cli].parseLine,
            sink: aggregator,
            onBackgroundError: (operation, error) => {
              dlog("main", `pet.external.${cli}.${operation}.failed`, { error: String(error) });
            },
          });
          petExternalAdapters.set(cli, adapter);
          adapter.start();
        } else if (!want && running) {
          running.stop();
          petExternalAdapters.delete(cli);
          aggregator.removeExternalSessionsByCli(cli);
        }
      }
    }
```

`await aggregator.start();`（~1168 行）之后做首次调谐：

```ts
      reconcileExternalAdapters(await getGlobalSettings());
```

- [ ] **Step 3: 设置热变更时重新调谐**

`index.ts` 的 settings 写入路径（`ipcMain.handle("settings:get", ...)` 于 ~3830 行附近，找对应的 `settings:set`/`settings:update` handler）在成功持久化 global scope 后调用 `reconcileExternalAdapters(newSettings)`。若 `reconcileExternalAdapters` 定义在 `startApp` 闭包内而 settings handler 在模块级，改为把该函数存到一个模块级 `let reconcileExternal: ((s: AppSettings) => void) | null` 引用，在闭包里赋值、在 handler 里调用。

核实设置读取入口：`grep -n "getSettings\|readSettings\|SettingsManager\|settings:set\|settings:update" packages/desktop/src/main/index.ts | head`，用其真实签名替换上面的 `getGlobalSettings()` / `AppSettings`。

- [ ] **Step 4: 清理段**

清理段（~4142 行 `petStateAggregator?.stop();` 旁）：

```ts
  for (const adapter of petExternalAdapters.values()) adapter.stop();
  petExternalAdapters.clear();
```

- [ ] **Step 5: 核实 IPC 透传**

Run: `grep -n "sessions" packages/desktop/src/main/pet/pet-ipc.ts | head -20`
预期 pet-ipc 把 `aggregator.getSnapshot()` 的 sessions 原样序列化（无字段白名单）。若存在逐字段映射，把 `external` 一并带上。

- [ ] **Step 6: typecheck + desktop 全量测试**

Run: `cd packages/desktop && bun run typecheck && bun test src/main/pet`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/main/index.ts packages/desktop/src/main/pet/pet-state-aggregator.ts packages/desktop/src/main/pet/pet-state-aggregator.test.ts packages/desktop/src/preload/pet-api.ts
git commit -m "feat(desktop): toggle-driven external session adapters (codex + claude) in pet lifecycle"
```

---

### Task 7: 渲染端 — 外部会话徽章 + 禁用跳转

外部会话没有 CodeShell 内可打开的目标（`resolveNavigation` 的 diskBindings 查不到），点击必须禁用并给出解释，同时加 CLI 徽章。

**Files:**
- Modify: `packages/desktop/src/renderer/pet/SessionStatusSection.tsx`
- Modify: `packages/desktop/src/renderer/i18n/ns/pet.ts`（session 节，~115 行 state 对象旁）
- Test: `packages/desktop/src/renderer/pet/SessionStatusSection.test.tsx`（追加）

- [ ] **Step 1: 写失败测试**

追加到 `SessionStatusSection.test.tsx`（fixture 用组件同款类型；`session()` helper 的返回类型如为 `@cjhyy/code-shell-pet` 的 projection，改从 `"../../preload/types"` import `PetSessionProjection` 或在 override 上直接放 `external` 字段——保持和组件 props 一致即可）：

```ts
test("external codex session renders badge and is not clickable", () => {
  const html = renderToStaticMarkup(
    <SessionStatusSection
      sessions={[
        session({
          agentSessionId: "thread-a",
          external: { cli: "codex", cwd: "/tmp/proj-a" },
          freshness: { source: "external-tail", observedAt: 2_000, workerState: "active" },
        } as Partial<PetSessionProjection>),
      ]}
      now={3_000}
      onOpen={() => {}}
    />,
  );
  expect(html).toContain("codex"); // 徽章
  expect(html).toContain("disabled"); // 外部会话不可点击
  expect(html).toContain("暂不支持在 CodeShell 内打开");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && bun test src/renderer/pet/SessionStatusSection.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`SessionStatusSection.tsx` 的 `SessionRow` 内（`shortId` 定义后）：

```tsx
  const external = session.external;
  const navigable = !external;
```

button 改为：

```tsx
      <button
        type="button"
        disabled={!navigable}
        title={navigable ? undefined : t("pet.session.externalNoNav")}
        className={`flex w-full min-w-0 items-start gap-2 px-2 py-2 text-left ${
          navigable ? "hover:bg-muted/50" : "cursor-default"
        }`}
        onClick={() => navigable && onOpen?.(session)}
      >
```

标题行 flex 容器里、stateLabel 前插入徽章：

```tsx
            {external && (
              <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase text-muted-foreground">
                {external.cli}
              </span>
            )}
```

`i18n/ns/pet.ts` 的 `session` 对象（与 `state`/`empty` 同级）加：

```ts
        externalNoNav: "外部会话（由 Codex/Claude CLI 管理），暂不支持在 CodeShell 内打开",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && bun test src/renderer/pet/SessionStatusSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/pet/SessionStatusSection.tsx packages/desktop/src/renderer/i18n/ns/pet.ts packages/desktop/src/renderer/pet/SessionStatusSection.test.tsx
git commit -m "feat(desktop): external session badge + non-navigable card in pet console"
```

---

### Task 8: 渲染端 — 卡片安全摘要（风险等级徽章）

projection 的 `pending` 已带 `riskLevel`（`preload/pet-api.ts:77`），卡片此前只显示"等待用户决定"计数。让等待中的卡片显示该会话待决策的最高风险 + 工具名。

**Files:**
- Modify: `packages/desktop/src/renderer/pet/SessionStatusSection.tsx`
- Modify: `packages/desktop/src/renderer/pet/PetDesktopWindow.tsx:270`（call site 传 pending）
- Modify: `packages/desktop/src/renderer/i18n/ns/pet.ts`
- Test: `packages/desktop/src/renderer/pet/SessionStatusSection.test.tsx`（追加）

- [ ] **Step 1: 写失败测试**

```ts
import type { PetPendingDecision } from "../../preload/types";

function pendingDecision(overrides: Partial<PetPendingDecision> = {}): PetPendingDecision {
  return {
    agentSessionId: "agent-session-12345678",
    requestId: "req-1",
    workerGeneration: 1,
    kind: "tool_approval",
    title: "等待批准 Bash",
    toolName: "Bash",
    riskLevel: "high",
    createdAt: 1_000,
    status: "pending",
    ...overrides,
  };
}

test("waiting session shows the highest pending risk with tool name", () => {
  const html = renderToStaticMarkup(
    <SessionStatusSection
      sessions={[session({ pendingDecisionCount: 2, phase: "waiting-decision" })]}
      pending={[
        pendingDecision({ requestId: "req-1", riskLevel: "low", toolName: "Read" }),
        pendingDecision({ requestId: "req-2", riskLevel: "high", toolName: "Bash" }),
      ]}
      now={3_000}
    />,
  );
  expect(html).toContain("高风险");
  expect(html).toContain("Bash");
});

test("highestPendingRisk ignores other sessions and non-pending decisions", () => {
  expect(
    highestPendingRisk(
      [
        pendingDecision({ agentSessionId: "other", riskLevel: "high" }),
        pendingDecision({ requestId: "req-3", status: "resolved", riskLevel: "high" }),
        pendingDecision({ requestId: "req-4", riskLevel: "medium", toolName: "Edit" }),
      ],
      "agent-session-12345678",
    ),
  ).toEqual({ level: "medium", toolName: "Edit" });
});
```

（`highestPendingRisk` 一并加进文件顶部的 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && bun test src/renderer/pet/SessionStatusSection.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`SessionStatusSection.tsx`：

```ts
import type { PetPendingDecision, PetSessionProjection } from "../../preload/types";

const RISK_ORDER = { high: 3, medium: 2, low: 1 } as const;

const RISK_TONE: Record<"high" | "medium" | "low", string> = {
  high: "bg-status-err/15 text-status-err",
  medium: "bg-status-warn/15 text-status-warn",
  low: "bg-muted text-muted-foreground",
};

/** Highest-risk pending decision for one session (undefined when none pending). */
export function highestPendingRisk(
  pending: readonly PetPendingDecision[] | undefined,
  agentSessionId: string,
): { level: "high" | "medium" | "low"; toolName?: string } | undefined {
  let best: { level: "high" | "medium" | "low"; toolName?: string } | undefined;
  for (const decision of pending ?? []) {
    if (decision.agentSessionId !== agentSessionId || decision.status !== "pending") continue;
    const level = decision.riskLevel ?? "low";
    if (!best || RISK_ORDER[level] > RISK_ORDER[best.level]) {
      best = { level, ...(decision.toolName ? { toolName: decision.toolName } : {}) };
    }
  }
  return best;
}
```

`SessionRow` 加 prop `risk`，在 summary 段之前渲染（仅 waiting 态出现，`risk` 由父组件算好传入）：

```tsx
function SessionRow({
  session,
  now,
  onOpen,
  risk,
}: {
  session: PetSessionProjection;
  now: number;
  onOpen?: (session: PetSessionProjection) => void;
  risk?: { level: "high" | "medium" | "low"; toolName?: string };
}) {
```

标题行（stateLabel 旁）：

```tsx
            {state === "waiting" && risk && (
              <span className={`shrink-0 rounded px-1 text-[10px] ${RISK_TONE[risk.level]}`}>
                {t(`pet.session.risk.${risk.level}`)}
                {risk.toolName ? ` · ${risk.toolName}` : ""}
              </span>
            )}
```

`SessionStatusSection` props 加 `pending?: readonly PetPendingDecision[]`，map 时：

```tsx
          {sessions.map((session) => (
            <SessionRow
              key={session.agentSessionId}
              session={session}
              now={now}
              onOpen={onOpen}
              risk={highestPendingRisk(pending, session.agentSessionId)}
            />
          ))}
```

`PetDesktopWindow.tsx:270` 的调用点加一行：

```tsx
              <SessionStatusSection
                sessions={globalOverview.sessions}
                pending={globalOverview.pending}
                emptyState={globalOverview.emptyState}
                showHeading={false}
                onOpen={(session) => openSession(session.agentSessionId)}
              />
```

`i18n/ns/pet.ts` 的 `session` 对象加：

```ts
        risk: {
          high: "高风险",
          medium: "中风险",
          low: "低风险",
        },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && bun test src/renderer/pet`
Expected: PASS（含 PetDesktopWindow 既有测试）

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/pet/SessionStatusSection.tsx packages/desktop/src/renderer/pet/PetDesktopWindow.tsx packages/desktop/src/renderer/i18n/ns/pet.ts packages/desktop/src/renderer/pet/SessionStatusSection.test.tsx
git commit -m "feat(desktop): pending-decision risk badge on pet session cards"
```

---

### Task 9: 设置 UI — 两个开关（默认关）

在 Pet 设置区加两个 toggle（Codex / Claude），改动经既有 `settings:set`/`settings:update` 写回 global scope，触发 Task 6 的热调谐。

**Files:**
- Modify: Pet 相关设置区块（`grep -rln "showExternal\|pet\." packages/desktop/src/renderer/settings/ | head`；若无独立 pet 设置区块，加到最贴近的设置分区，如通用/实验区）
- Modify: `packages/desktop/src/renderer/i18n/ns/settings.ts`（或 pet.ts，与开关文案同命名空间）
- Test: 对应设置区块的测试文件（追加 toggle 渲染 + onChange 断言）

- [ ] **Step 1: 定位落点**

Run: `grep -rln "Switch\|settings:set\|useSettings\|scope: \"global\"" packages/desktop/src/renderer/settings/ | head` —— 找一个已有的 global-scope 布尔开关区块作模板（照抄其 Switch + 写回 pattern，遵循 desktop CLAUDE.md：用 `@/components/ui` 的 `Switch`，不手写）。

- [ ] **Step 2: 写失败测试**

参照该区块既有测试，断言渲染出两个 Switch、初始 `checked=false`、点击调用写回 `pet.showExternalCodexSessions` / `pet.showExternalClaudeSessions`。（具体断言以模板区块的测试风格为准。）

- [ ] **Step 3: 实现**

加两个 `Switch` + label + 说明文案：
- Codex：「在 Pet 全局视图显示 Codex CLI/App 会话」，副文案「开启后 CodeShell 会读取本机 `~/.codex` 下的会话记录以显示状态；关闭则完全不读取」
- Claude：「在 Pet 全局视图显示 Claude Code 会话」，副文案同理指向 `~/.claude`

i18n 文案加进对应命名空间。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd packages/desktop && bun test <该区块测试> && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/settings packages/desktop/src/renderer/i18n
git commit -m "feat(desktop): settings toggles for external codex/claude sessions in pet view"
```

---

### Task 10: 全量验证 + TODO.md 收账

- [ ] **Step 1: 全仓验证**

```bash
cd packages/coding && bun test && cd ../desktop && bun run typecheck && bun test && bun run build
cd ../.. && bun run typecheck && bun test
```

Expected: 全绿。desktop 有独立 typecheck/build（根检查不覆盖），两边都必须跑。

- [ ] **Step 2: 真机 smoke（手动）**

启动 desktop app：
1. **默认关**：不做任何设置时，Pet 独立窗口**不**出现任何 Codex/Claude 外部会话卡片；
2. 打开「显示 Codex 会话」开关 → 另开终端在任意项目跑一个 Codex CLI 会话 → 15 秒内 Pet 窗口出现该会话卡片，带 `codex` 徽章；
3. Codex 执行工具时卡片转"运行中"、摘要显示"正在运行 <tool>"；回合结束回"空闲"；
4. 关闭该开关 → 卡片立即消失，且此后不再有 Codex 卡片出现（后台不再扫描）；
5. 打开「显示 Claude 会话」开关 → 跑一个 Claude Code CLI 会话 → 出现带 `claude` 徽章的卡片；
6. 外部会话卡片点击无跳转、hover 有解释文案；
7. 本地 CodeShell 会话触发工具审批时，卡片出现风险徽章。

- [ ] **Step 3: 更新根 TODO.md**

把「Pet 全局 Session 实时态势 + 独立窗口控制台」条目的现状边界改写为：事件驱动 projection / 独立窗口 / 全局卡片 / 自动推送 / 外部 Codex CLI+App 与 Claude Code CLI 的可开关 tail adapter（默认关、从源头启停）/ 卡片安全摘要均已落地；剩余 follow-up 单列：①外部会话卡片点击跳转到 cc-room；②`PetWorkTree`（完整 Pet 页工作树）风险徽章；③外部会话可见性的 per-project scope（当前仅全局开关）。

- [ ] **Step 4: Commit**

```bash
git add TODO.md
git commit -m "docs(todo): pet external session adapters (codex+claude, toggleable) + risk badge landed"
```

---

## Self-Review 记录

- 规格覆盖：TODO 产品结论中"host 代理自动推送（不依赖 ReportToPet）/ 不偷读完整 transcript 进投影 / 只携带身份、任务、工作区、状态、时间戳"→ adapter 只把元数据放进 `DesktopPetSession`（Task 4 `toPetSession`），tail 内容读取限于 host 内归约，不进投影。"断线/重启可恢复"→ 外部源不依赖 worker generation，重启后 `scanOnce` 从磁盘重建（Task 3 断连测试 + Task 4 scan 幂等 publish key）。"幂等去重"→ `lastPublishedKey`。"两个 Pet 界面一致"→ 数据只经 aggregator 单源分发，渲染端仅 `SessionStatusSection` 一处消费新字段。
- 用户决策覆盖：从源头启停（Task 6 `reconcileExternalAdapters`：关=不构造/stop+移除卡片）；默认关（Task 5 schema `.default(false)` + Task 9 UI 初始 false + Task 10 smoke 第 1 步）；Codex/Claude 各一开关（Task 5 两个键、Task 6 两个 adapter 实例、Task 9 两个 Switch）；Claude 一等接入（Task 1b + Task 4 CLI-neutral + Task 4 Step 6 冒烟）。
- 已知妥协（有意为之，见 Non-goals）：外部会话无审批/排队感知、无跳转；等待-决策安全摘要仅覆盖本地会话；开关仅全局无 per-project。
- 类型一致性：`ExternalPetSessionSink` 与 `PetStateAggregator` 新方法（`upsertExternalSession`/`removeExternalSession`/`removeExternalSessionsByCli`）签名一致；`external` 字段在 `DesktopPetSession`（main）与 `PetSessionProjection`（preload）同构；`RecentExternalSession` 在 Task 1b 定义为共享类型（Task 1a 的 `RecentCodexSession` 改为其别名），Task 4/6 引用一致；`ExternalCli` 在 adapter 定义、Task 6 复用。
- 待执行期核实的点已显式写进步骤：① `parseCodexTranscriptLine`/`parseClaudeTranscriptLine` 产出 `turn_end` 的确切事件形态（Task 4 Step 1）；② pet-ipc 是否逐字段映射 sessions（Task 6 Step 5）；③ core settings 根 schema 导出名与 pet 子树落点（Task 5 Step 1/3）；④ desktop settings 读取/写回入口真实签名（Task 6 Step 3）；⑤ 渲染设置区块的模板与写回 pattern（Task 9 Step 1）。
