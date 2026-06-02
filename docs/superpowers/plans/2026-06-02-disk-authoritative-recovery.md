# disk 作权威源 + 会话/项目可恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 disk(`~/.code-shell/sessions/<id>/state.json` + `transcript.jsonl`)成为会话/项目/内容的权威源,localStorage 降为缓存 —— 清空/丢失 localStorage 后能从 disk 重建会话列表(分页)、自动重建项目、并以 disk 优先 hydrate 内容(顺带根治底部「已处理 N 条命令」孤儿组)。

**Architecture:** core 给子代理 session 的 state.json 写 `parentSessionId`(用 `getCurrentSid()` 取父 sid);main 新增 `listDiskSessions({limit,cursor})` 扫目录式会话并过滤掉带 `parentSessionId` 的子代理;renderer 在某 repo 列表为空时拉 disk 分页重建(cwd 无匹配项目则自动建),并把内容 hydrate 改为 disk 优先。

**Tech Stack:** TypeScript, bun:test, Electron(core/main/preload/renderer), @cjhyy/code-shell-core。

设计依据:`docs/superpowers/specs/2026-06-02-disk-authoritative-recovery-design.md`。

**全程约定:** 直接在 `main` 分支提交(用户偏好);改 `packages/core` 后 `cd packages/core && bun run build`(desktop 从 dist import);改 desktop 后在 `packages/desktop` 跑 `bunx tsc --noEmit`。

执行顺序:**T1 → T2 → T3 → T4 → T5**。

---

## Task 1: core 给子代理 session 写 parentSessionId

**Files:**
- Modify: `packages/core/src/session/session-manager.ts`(`create()` ~82-120)
- Modify: `packages/core/src/engine/engine.ts`(调 `sessionManager.create` 处 ~1012)
- Test: `packages/core/src/session/session-manager.parent.test.ts`(create)

`SessionState.parentSessionId?` 已存在(types.ts:110)。`create()` 目前不写它。本任务让 `create()` 接收并写入 `parentSessionId`,engine 在子代理(`this.config.isSubAgent`)冷启动时用 `getCurrentSid()`(父 sid,子在父的 runWithSid 作用域内构造)传入。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/src/session/session-manager.parent.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager.create — parentSessionId", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sm-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes parentSessionId into state.json when provided", () => {
    const sm = new SessionManager(dir);
    const b = sm.create("/tmp", "m", "p", "child-1", "parent-9");
    expect(b.state.parentSessionId).toBe("parent-9");
    const onDisk = JSON.parse(readFileSync(join(dir, "child-1", "state.json"), "utf8"));
    expect(onDisk.parentSessionId).toBe("parent-9");
  });

  test("omits parentSessionId for a top-level session", () => {
    const sm = new SessionManager(dir);
    const b = sm.create("/tmp", "m", "p", "top-1");
    expect(b.state.parentSessionId).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(dir, "top-1", "state.json"), "utf8"));
    expect("parentSessionId" in onDisk).toBe(false);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/core && bun test src/session/session-manager.parent.test.ts`
Expected: FAIL — `create` 当前签名只有 4 个参数,第 5 个 `parentSessionId` 不被接收;`b.state.parentSessionId` 为 undefined,磁盘也无该字段。
(若 TS 报参数过多而非断言失败,也算 RED — 功能缺失。)

- [ ] **Step 3: 实现 — create 接收并写 parentSessionId**

`session-manager.ts` 的 `create` 签名加第 5 参,并写入 state:

```typescript
  create(
    cwd: string,
    model: string,
    provider: string,
    explicitSessionId?: string,
    parentSessionId?: string,
  ): SessionBundle {
    if (explicitSessionId !== undefined) assertSafeSessionId(explicitSessionId);
    const sessionId = explicitSessionId ?? nanoid(16);
    const sessionDir = join(this.sessionsDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const state: SessionState = {
      sessionId,
      cwd,
      startedAt: Date.now(),
      model,
      provider,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      turnCount: 0,
      invokedSkills: [],
      status: "active",
      ...(parentSessionId ? { parentSessionId } : {}),
    };

    writeFileSync(join(sessionDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
    const transcript = new Transcript(join(sessionDir, "transcript.jsonl"));
    transcript.append("session_meta", { sessionId, cwd, model, provider, startedAt: state.startedAt });
    return { state, transcript };
  }
```

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/core && bun test src/session/session-manager.parent.test.ts`
Expected: PASS(2 tests)。

- [ ] **Step 5: engine 在子代理冷启动时传父 sid**

`engine.ts` ~1012 的 create 调用,加第 5 参。`getCurrentSid` 已从 `../logging/logger.js` 导入(engine.ts:53 已 import `setCurrentSid, runWithSid`;补 `getCurrentSid`)。

先确认 import 行包含 getCurrentSid:
```typescript
import { logger, setCurrentSid, runWithSid, getCurrentSid } from "../logging/logger.js";
```
然后改 create 调用:
```typescript
      session = this.sessionManager.create(
        cwd,
        this.config.llm.model,
        this.config.llm.provider,
        options?.sessionId,
        this.config.isSubAgent === true ? getCurrentSid() : undefined,
      );
```

- [ ] **Step 6: typecheck + 全 core 测试 + rebuild**

Run: `cd packages/core && bunx tsc --noEmit && bun test src/session/ src/engine/ && bun run build`
Expected: tsc 0;测试无回归;build OK。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/session/session-manager.ts packages/core/src/session/session-manager.parent.test.ts packages/core/src/engine/engine.ts
git commit -m "feat(core): 子代理 session 的 state.json 写 parentSessionId

create() 接收 parentSessionId 并落盘;engine 在 isSubAgent 冷启动时用 getCurrentSid()
(父在 runWithSid 作用域,子构造时 getCurrentSid 即父 sid)传入。供 disk 重建列表过滤子代理。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: main 新增 listDiskSessions(扫目录 + 分页 + 过滤子代理)

**Files:**
- Modify: `packages/desktop/src/main/sessions-service.ts`
- Test: `packages/desktop/src/main/sessions-service.disk.test.ts`(create)

现有 `listSessions`(:23)只扫扁平 `.jsonl`(`if (!e.isFile())` 跳过目录),漏掉全部目录式会话。新增 `listDiskSessions` 扫目录式、读 state.json、按 mtime 降序分页,**只返回带 parentSessionId 字段且为空(顶层)的会话;无该字段的存量旧 session 一律跳过**(用户定:存量不自动重建)。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/desktop/src/main/sessions-service.disk.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { listDiskSessions } from "./sessions-service";

function mkSession(base: string, id: string, state: Record<string, unknown>, mtime: number) {
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ sessionId: id, ...state }));
  fs.writeFileSync(path.join(dir, "transcript.jsonl"), "");
  fs.utimesSync(dir, new Date(mtime), new Date(mtime));
}

describe("listDiskSessions", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns top-level sessions (parentSessionId field present + empty), newest first", () => {
    mkSession(dir, "top-old", { cwd: "/p", summary: "老", parentSessionId: undefined }, 1000);
    mkSession(dir, "top-new", { cwd: "/p", summary: "新", parentSessionId: undefined }, 3000);
    const { sessions } = listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["top-new", "top-old"]);
    expect(sessions[0]).toMatchObject({ id: "top-new", cwd: "/p", title: "新" });
  });

  it("filters OUT sub-agent sessions (parentSessionId set)", () => {
    mkSession(dir, "top-1", { cwd: "/p", parentSessionId: undefined }, 2000);
    mkSession(dir, "sub-1", { cwd: "/p", parentSessionId: "top-1" }, 3000);
    const { sessions } = listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["top-1"]);
  });

  it("skips legacy sessions with NO parentSessionId field (存量 not auto-rebuilt)", () => {
    mkSession(dir, "legacy-1", { cwd: "/p", summary: "旧" }, 2000); // no parentSessionId key at all
    mkSession(dir, "new-top", { cwd: "/p", parentSessionId: undefined }, 1000);
    const { sessions } = listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["new-top"]);
  });

  it("paginates with limit + cursor", () => {
    for (let i = 0; i < 5; i++) mkSession(dir, `s${i}`, { cwd: "/p", parentSessionId: undefined }, 1000 + i * 1000);
    const p1 = listDiskSessions({ limit: 2 }, dir);
    expect(p1.sessions.map((s) => s.id)).toEqual(["s4", "s3"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = listDiskSessions({ limit: 2, cursor: p1.nextCursor! }, dir);
    expect(p2.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("returns [] for a missing sessions dir", () => {
    expect(listDiskSessions({ limit: 10 }, path.join(dir, "nope")).sessions).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/desktop && bun test src/main/sessions-service.disk.test.ts`
Expected: FAIL — `listDiskSessions` 未导出(模块无此 export)。

- [ ] **Step 3: 实现 listDiskSessions**

在 `sessions-service.ts` 追加(保留旧 `listSessions` 不动):

```typescript
export interface DiskSessionMeta {
  id: string;
  /** Engine session id == directory name (used as the UI session id too). */
  engineSessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

export interface ListDiskSessionsResult {
  sessions: DiskSessionMeta[];
  /** Opaque cursor for the next page; null when no more. */
  nextCursor: string | null;
}

/**
 * List top-level (non-sub-agent) sessions from disk, newest first, paginated.
 *
 * "Top-level" = state.json HAS a `parentSessionId` key whose value is empty
 * (a session written by the post-Task-1 core). Sessions whose `parentSessionId`
 * is set are sub-agents (filtered out). Legacy sessions with NO `parentSessionId`
 * key at all are skipped — pre-Task-1 存量 is not auto-rebuilt (user decision).
 *
 * `cursor` is the index into the mtime-sorted directory list to resume from.
 */
export function listDiskSessions(
  opts: { limit: number; cursor?: string },
  baseDir: string = SESSIONS_DIR,
): ListDiskSessionsResult {
  let entries: import("node:fs").Dirent[];
  try {
    entries = require("node:fs").readdirSync(baseDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [], nextCursor: null };
    throw e;
  }
  const fsSync = require("node:fs");
  // dir id + mtime, newest first
  const dirs: Array<{ id: string; mtime: number }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!SAFE_ID.test(e.name)) continue;
    try {
      const st = fsSync.statSync(path.join(baseDir, e.name));
      dirs.push({ id: e.name, mtime: st.mtimeMs });
    } catch { /* skip unreadable */ }
  }
  dirs.sort((a, b) => b.mtime - a.mtime);

  const start = opts.cursor ? Number(opts.cursor) : 0;
  const sessions: DiskSessionMeta[] = [];
  let i = start;
  for (; i < dirs.length && sessions.length < opts.limit; i++) {
    const { id, mtime } = dirs[i]!;
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(fsSync.readFileSync(path.join(baseDir, id, "state.json"), "utf8"));
    } catch { continue; } // missing/corrupt state.json → skip
    // Skip legacy (no parentSessionId key) and sub-agents (key set non-empty).
    if (!("parentSessionId" in state)) continue;
    if (state.parentSessionId) continue;
    sessions.push({
      id,
      engineSessionId: id,
      cwd: typeof state.cwd === "string" ? state.cwd : "",
      title: typeof state.summary === "string" && state.summary ? state.summary : id,
      updatedAt: mtime,
    });
  }
  const nextCursor = i < dirs.length ? String(i) : null;
  return { sessions, nextCursor };
}
```

注:文件顶部已有 `import * as fs from "node:fs/promises"; import * as path from "node:path";`。本函数用同步 fs(分页一次读少量),用 `require("node:fs")` 取同步 API,避免改顶部 import 风格;`SESSIONS_DIR` 和 `SAFE_ID` 已在文件内定义(:19/:21)。

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/desktop && bun test src/main/sessions-service.disk.test.ts`
Expected: PASS(5 tests)。

- [ ] **Step 5: typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: exit 0。(若 lint 不喜欢 `require`,改成顶部加 `import * as fsSync from "node:fs"` 并替换调用。)

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/src/main/sessions-service.ts packages/desktop/src/main/sessions-service.disk.test.ts
git commit -m "feat(desktop): listDiskSessions — 扫目录式会话分页 + 过滤子代理/存量

按 mtime 降序分页(limit/cursor),读 state.json 出 {id,cwd,title,updatedAt}。
只返回带 parentSessionId 字段且为空的顶层会话;无该字段的存量旧 session 跳过(不自动重建)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: IPC + preload 暴露 listDiskSessions

**Files:**
- Modify: `packages/desktop/src/main/index.ts`(IPC handler)
- Modify: `packages/desktop/src/preload/index.ts`(暴露方法)
- Modify: `packages/desktop/src/preload/types.d.ts`(类型)

无独立单测(纯接线);验证 = typecheck + build。

- [ ] **Step 1: main IPC handler**

`index.ts`:import 处补 `listDiskSessions`(来自 `./sessions-service.js`,与现有 `listSessions` 同源):
```typescript
import { listSessions, deleteSession, getSessionTranscript, listDiskSessions } from "./sessions-service.js";
```
在 `sessions:list` handler 附近加:
```typescript
ipcMain.handle("sessions:listDisk", async (_e, opts: { limit?: number; cursor?: string }) => {
  const limit = typeof opts?.limit === "number" && opts.limit > 0 ? Math.min(opts.limit, 200) : 30;
  return listDiskSessions({ limit, cursor: typeof opts?.cursor === "string" ? opts.cursor : undefined });
});
```

- [ ] **Step 2: preload 暴露**

`preload/index.ts` 在 `getSessionTranscript` 附近加:
```typescript
  listDiskSessions: (opts?: { limit?: number; cursor?: string }) =>
    ipcRenderer.invoke("sessions:listDisk", opts ?? {}),
```

- [ ] **Step 3: types.d.ts**

在 `CodeshellApi` 接口里、`getSessionTranscript` 附近加:
```typescript
  listDiskSessions(opts?: { limit?: number; cursor?: string }): Promise<{
    sessions: Array<{ id: string; engineSessionId: string; cwd: string; title: string; updatedAt: number }>;
    nextCursor: string | null;
  }>;
```

- [ ] **Step 4: typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:main && bun run build:preload`
Expected: tsc 0;两 bundle OK。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/index.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts
git commit -m "feat(desktop): 暴露 sessions:listDisk IPC + preload listDiskSessions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: renderer 内容 hydrate 改 disk 优先(根治孤儿组)

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx`(lazy-hydrate effect ~339-372)
- Test: `packages/desktop/src/renderer/automation/hydrateOrder.test.ts`(create — 验证 disk 优先无孤儿尾)

把"只有 automation 才 fold disk、普通会话 base=local"改成:**任何有 engineSessionId 的会话都 disk 优先**(disk fold 为权威基底 + mergeTranscripts 补未 flush 尾巴);disk 空才用 local。

- [ ] **Step 1: 写失败测试(纯函数验证 hydrate 选择逻辑)**

抽一个纯函数 `chooseHydrateBase(disk, local)`,App 复用它;测它在 disk 非空时返回 disk-merged(不把 local 残留追加成孤儿尾)。

```typescript
// packages/desktop/src/renderer/automation/hydrateOrder.test.ts
import { describe, it, expect } from "bun:test";
import { chooseHydrateBase } from "./hydrateOrder";
import { INITIAL_STATE, type Message, type MessagesReducerState } from "../types";

const stateOf = (m: Message[]): MessagesReducerState => ({ ...INITIAL_STATE, messages: m });
const user = (id: string, text: string): Message => ({ kind: "user", id, text });
const tool = (id: string, n: string, a: string): Message => ({ kind: "tool", id, toolName: n, args: a, status: "ok", startedAt: 0 });

describe("chooseHydrateBase", () => {
  it("uses disk (merged) when disk has messages — local-only redundant tools don't tail", () => {
    const disk = stateOf([user("d1", "汇总"), tool("d2", "WebSearch", "{}")]);
    const local = stateOf([user("l1", "汇总"), tool("l2", "WebSearch", "{}")]); // same content
    const out = chooseHydrateBase(disk, local);
    // disk authoritative; no duplicated trailing tool
    expect(out.messages.filter((m) => m.kind === "tool")).toHaveLength(1);
    expect(out.messages.map((m) => m.kind)).toEqual(["user", "tool"]);
  });

  it("falls back to local when disk is empty", () => {
    const local = stateOf([user("l1", "hi")]);
    expect(chooseHydrateBase(INITIAL_STATE, local)).toBe(local);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/desktop && bun test src/renderer/automation/hydrateOrder.test.ts`
Expected: FAIL — Cannot find module './hydrateOrder'。

- [ ] **Step 3: 实现 chooseHydrateBase**

```typescript
// packages/desktop/src/renderer/automation/hydrateOrder.ts
/**
 * Choose the hydrate base for a session, disk-authoritative.
 *
 * disk (folded transcript.jsonl) is the complete authoritative record; local
 * (localStorage) is only a cache that may hold the not-yet-flushed tail. When
 * disk has any messages we merge (mergeTranscripts only appends the genuine
 * post-sync-point tail), so localStorage residue can't form an orphan trailing
 * group. disk empty (brand-new front-end session not yet on disk) → use local.
 */
import type { MessagesReducerState } from "../types";
import { mergeTranscripts } from "./mergeTranscripts";

export function chooseHydrateBase(
  disk: MessagesReducerState,
  local: MessagesReducerState,
): MessagesReducerState {
  return disk.messages.length > 0 ? mergeTranscripts(disk, local) : local;
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/desktop && bun test src/renderer/automation/hydrateOrder.test.ts`
Expected: PASS(2 tests)。

- [ ] **Step 5: App.tsx 用 disk 优先**

把 hydrate effect(~339-372)里 automation-only 的 disk fold 改为对**任何 engineId** 生效。将原来的:
```typescript
      let base = local;
      if (summary?.source === "automation" && engineId) {
        try {
          const disk = foldTranscript(await window.codeshell.getSessionTranscript(engineId));
          if (disk.messages.length > 0) base = mergeTranscripts(disk, local);
        } catch { /* disk read failed — fall back to the localStorage projection. */ }
      }
```
改为:
```typescript
      let base = local;
      if (engineId) {
        try {
          const disk = foldTranscript(await window.codeshell.getSessionTranscript(engineId));
          base = chooseHydrateBase(disk, local);
        } catch { /* disk read failed — fall back to the localStorage projection. */ }
      }
```
并在文件顶部 import 区加:
```typescript
import { chooseHydrateBase } from "./automation/hydrateOrder";
```
(其后 §快照重放兜底 `base.messages.length === 0` 那段保持不变。)

- [ ] **Step 6: typecheck + 全 renderer 测试 + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun test src/renderer/automation/ && bun run build:renderer`
Expected: tsc 0;automation 测试全绿;renderer build OK。

- [ ] **Step 7: 提交**

```bash
git add packages/desktop/src/renderer/automation/hydrateOrder.ts packages/desktop/src/renderer/automation/hydrateOrder.test.ts packages/desktop/src/renderer/App.tsx
git commit -m "fix(desktop): 内容 hydrate 改 disk 优先(任何会话),根治底部孤儿命令组

不再只有 automation 才读 disk:任何有 engineId 的会话都以 disk fold 为权威基底 +
mergeTranscripts 补未 flush 尾巴(chooseHydrateBase)。disk 空才用 localStorage。
localStorage 残留不再被追加成无 user 的孤儿 turn_process_group。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: renderer 列表/项目从 disk 重建(空 repo 才触发)

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx`(会话列表加载处 + 一个 disk 重建 effect)
- Test: `packages/desktop/src/renderer/automation/rebuildFromDisk.test.ts`(create — 纯函数:把 disk 页放进 repo/项目)

某 repo 的 `sessionIndices` 为空(清空/丢失 localStorage)时,拉 `listDiskSessions` 第一页,按 cwd 归项目(无匹配则 `createRepoForCwd` 自动建),`upsertImportedSession` 填入。复用 D1 的 `placeLiveAutomationSession` 同款 cwd→repo 机制。

- [ ] **Step 1: 写失败测试(纯函数:disk 会话 → 放置结果)**

```typescript
// packages/desktop/src/renderer/automation/rebuildFromDisk.test.ts
import { describe, it, expect } from "bun:test";
import { planDiskRebuild } from "./rebuildFromDisk";
import type { Repo } from "../repos";

const repo = (id: string, path: string): Repo => ({ id, name: id, path, addedAt: 0 });

describe("planDiskRebuild", () => {
  it("matches an existing repo by cwd", () => {
    const repos = [repo("r1", "/proj/a")];
    const out = planDiskRebuild(
      [{ id: "s1", engineSessionId: "s1", cwd: "/proj/a", title: "聊天", updatedAt: 100 }],
      repos,
      { caseInsensitive: false, createRepoForCwd: () => "SHOULD_NOT_CALL" },
    );
    expect(out).toEqual([{ repoId: "r1", summary: expect.objectContaining({ id: "s1", engineSessionId: "s1", title: "聊天", source: undefined }) }]);
  });

  it("auto-creates a repo for an unmatched cwd", () => {
    let created = "";
    const out = planDiskRebuild(
      [{ id: "s2", engineSessionId: "s2", cwd: "/proj/new", title: "x", updatedAt: 1 }],
      [],
      { caseInsensitive: false, createRepoForCwd: (cwd) => { created = cwd; return "r-new"; } },
    );
    expect(created).toBe("/proj/new");
    expect(out[0].repoId).toBe("r-new");
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/desktop && bun test src/renderer/automation/rebuildFromDisk.test.ts`
Expected: FAIL — Cannot find module './rebuildFromDisk'。

- [ ] **Step 3: 实现 planDiskRebuild(复用 liveSession 的 cwd→repo)**

```typescript
// packages/desktop/src/renderer/automation/rebuildFromDisk.ts
/**
 * Plan how a page of disk sessions maps into repos + SessionSummary entries,
 * rebuilding the sidebar when localStorage is empty. Pure: callers apply the
 * returned (repoId, summary) pairs via upsertImportedSession and persist repos.
 * Reuses the same cwd→repo matching as live automation placement.
 */
import { matchRepoIdForCwd, type RepoLike } from "./pathMatch";
import type { SessionSummary } from "../transcripts";

export interface DiskSessionMeta {
  id: string;
  engineSessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

export interface RebuildDeps {
  caseInsensitive: boolean;
  createRepoForCwd: (cwd: string) => string;
}

export interface RebuildPlacement {
  repoId: string;
  summary: SessionSummary;
}

export function planDiskRebuild(
  sessions: DiskSessionMeta[],
  repos: RepoLike[],
  deps: RebuildDeps,
): RebuildPlacement[] {
  return sessions.map((s) => {
    const matched = matchRepoIdForCwd(s.cwd, repos, deps.caseInsensitive);
    const repoId = matched ?? deps.createRepoForCwd(s.cwd);
    const summary: SessionSummary = {
      id: s.id,
      engineSessionId: s.engineSessionId,
      title: s.title,
      createdAt: s.updatedAt,
      updatedAt: s.updatedAt,
      source: undefined,
    };
    return { repoId, summary };
  });
}
```

> 校验点:确认 `matchRepoIdForCwd` 的签名(`(cwd, repos, caseInsensitive)` 还是别的顺序)与 `RepoLike`、`SessionSummary` 必填字段;`liveSession.ts` 已用同一 `matchRepoIdForCwd`,以它的调用为准对齐参数与 summary 字段(createdAt/updatedAt/title/id/engineSessionId/source 是否够)。

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/desktop && bun test src/renderer/automation/rebuildFromDisk.test.ts`
Expected: PASS(2 tests)。

- [ ] **Step 5: App.tsx 接入(空 repo 才触发)**

在加载 `sessionIndices` 后加一个 effect:对当前 active repo,若其 `sessionIndices[repoKey]` 为空(或 sessions 长度 0),拉 disk 第一页并应用 `planDiskRebuild`:

```typescript
import { planDiskRebuild } from "./automation/rebuildFromDisk";

// effect:active repo 列表为空时从 disk 重建第一页
useEffect(() => {
  const repoKey = repoKeyOf(activeRepoId);
  const idx = sessionIndices[repoKey];
  if (idx && idx.sessions.length > 0) return; // 有数据,不扫盘
  let cancelled = false;
  void (async () => {
    try {
      const page = await window.codeshell.listDiskSessions({ limit: 30 });
      if (cancelled || page.sessions.length === 0) return;
      const reposNow = loadRepos();
      let reposChanged = false;
      const placements = planDiskRebuild(page.sessions, reposNow, {
        caseInsensitive: isCaseInsensitivePlatform(),
        createRepoForCwd: (cwd) => {
          const id = makeRepoId();
          const name = cwd.split("/").filter(Boolean).pop() || cwd;
          reposNow.push({ id, name, path: cwd, addedAt: Date.now() });
          saveRepos(reposNow);
          reposChanged = true;
          return id;
        },
      });
      const touched = new Set<string>();
      for (const { repoId, summary } of placements) {
        upsertImportedSession(repoId, summary);
        touched.add(repoKeyOf(repoId));
      }
      if (reposChanged) setRepos(reposNow.slice());
      setSessionIndices((prev) => {
        const next = { ...prev };
        for (const k of touched) next[k] = loadSessionIndex(k === GLOBAL_KEY ? null : k);
        return next;
      });
    } catch { /* disk unavailable — leave empty */ }
  })();
  return () => { cancelled = true; };
}, [activeRepoId, sessionIndices]);
```

> 校验点:`upsertImportedSession(repoId, summary)` 是否就地写 localStorage(D1 用过,应是);`loadSessionIndex(repoId)` 参数(null=global)。分页"滚到底加载更多"作为后续增强,本任务先做第一页(够恢复可见;YAGNI)。

- [ ] **Step 6: typecheck + 全 renderer 测试 + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun test src/renderer/ && bun run build:renderer`
Expected: tsc 0;renderer 测试(唯一已知无关 fail = AgentMessageView)外全绿;build OK。

- [ ] **Step 7: 提交**

```bash
git add packages/desktop/src/renderer/automation/rebuildFromDisk.ts packages/desktop/src/renderer/automation/rebuildFromDisk.test.ts packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): 空 repo 时从 disk 重建会话列表 + 自动重建项目

某 repo 列表为空(清空/丢失 localStorage)时拉 listDiskSessions 第一页,按 cwd 归项目
(无匹配 createRepoForCwd 自动建),upsertImportedSession 填入。localStorage 有数据则不扫盘。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖:** §4.A listSessions 分页→T2;§4.B 列表/项目重建→T5;§4.C hydrate disk 优先→T4;
  §4.D localStorage 降缓存→T4(disk 优先即降级);§4.E 子代理过滤(parentSessionId)→T1(写)+T2(过滤);
  存量不重建→T2(无字段跳过);孤儿组根治→T4。IPC 暴露→T3。无遗漏。
- **占位扫描:** 3 处「校验点」(T2 require vs import、T5 matchRepoIdForCwd 签名 / upsertImportedSession),
  均给了对齐依据(以 liveSession.ts 现有调用为准)+ 验证命令,非 TODO。
- **类型一致:** `DiskSessionMeta`{id,engineSessionId,cwd,title,updatedAt} 在 T2/T3/T5 一致;
  `listDiskSessions`/`chooseHydrateBase`/`planDiskRebuild`/`mergeTranscripts` 命名贯穿一致;
  `parentSessionId` 与 T1 写入、T2 过滤一致。
- **TDD:** 纯函数任务(T1/T2/T4/T5)均先写失败测试;T3 纯接线以 typecheck+build 兜底。
- **存量边界:** T2 测试显式覆盖"无 parentSessionId 字段→跳过",落实用户"存量不自动重建"决定。
