# Automation Run → Sidebar Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make completed automation (cron) runs appear as normal sessions in the desktop sidebar under the project matching their `cwd`, with full transcript viewable, marked as automation-sourced, and deletable together with their on-disk data.

**Architecture:** Disk (`~/.code-shell/runs/<id>/` + `~/.code-shell/sessions/<id>/transcript.jsonl`) is the source of truth; localStorage remains the sidebar's data source. The desktop main process gains a pure JSONL→"fold-items" reader; the renderer folds those through the existing `applyStreamEvent`/`appendUserMessage` reducer into a `MessagesReducerState`, attributes the run to a repo by normalized `cwd`→`path` match (deduping by `engineSessionId`, capped to 50 recent per repo), and writes it into localStorage. Delete is unified across localStorage + session dir + run dir, which also fixes a latent `sessions:delete` directory bug.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), React, Bun test runner, Vitest-style `bun test`. Renderer is a thin client (no `@cjhyy/code-shell-core` import except `type StreamEvent`). Desktop has its OWN `tsc --noEmit` + `vite build` — run them in `packages/desktop`.

---

## File Structure

**Create:**
- `packages/desktop/src/renderer/automation/pathMatch.ts` — normalize + match cwd↔repo.path (pure, renderer).
- `packages/desktop/src/renderer/automation/pathMatch.test.ts`
- `packages/desktop/src/main/transcript-reader.ts` — read `<sessionId>/transcript.jsonl`, parse to ordered fold-items. Pure parse, no reducer.
- `packages/desktop/src/main/transcript-reader.test.ts`
- `packages/desktop/src/renderer/automation/foldTranscript.ts` — fold fold-items → `MessagesReducerState` (renderer, reuses `applyStreamEvent`/`appendUserMessage`).
- `packages/desktop/src/renderer/automation/foldTranscript.test.ts`
- `packages/desktop/src/renderer/automation/importRuns.ts` — attribution + dedup + cap + build `SessionSummary` + write transcript (renderer).
- `packages/desktop/src/renderer/automation/importRuns.test.ts`

**Modify:**
- `packages/desktop/src/main/sessions-service.ts` — fix `deleteSession` to remove the `<sessionId>/` *directory* (latent bug); add `getSessionTranscript(sessionId)`.
- `packages/desktop/src/main/runs-service.ts` — add `deleteRun(runId)`.
- `packages/desktop/src/main/index.ts:698-721` — register `sessions:transcript` + `runs:delete` IPC handlers.
- `packages/desktop/src/preload/index.ts:222-230` — bridge `getSessionTranscript` + `deleteRun`.
- `packages/desktop/src/preload/types.d.ts:243-249` — declare the two new methods + `FoldItem` type.
- `packages/desktop/src/renderer/transcripts.ts:31-49` — add `source?` + `runId?` to `SessionSummary`; add `upsertImportedSession()`.
- `packages/desktop/src/renderer/App.tsx` — backfill effect on mount/repo-create; unified delete in `handleDeleteSession`.
- `packages/desktop/src/renderer/Sidebar.tsx` — render a small marker when `summary.source === "automation"`.

---

## Shared type: FoldItem

Defined once in `packages/desktop/src/preload/types.d.ts` (shared across the main/renderer boundary), imported by both the reader and the folder:

```typescript
import type { StreamEvent } from "@cjhyy/code-shell-core";

/** One step in replaying a persisted transcript into renderer state. */
export type FoldItem =
  | { kind: "stream"; event: StreamEvent }
  | { kind: "user"; text: string };
```

---

## Task 1: Path normalization + repo match (renderer, pure)

**Files:**
- Create: `packages/desktop/src/renderer/automation/pathMatch.ts`
- Test: `packages/desktop/src/renderer/automation/pathMatch.test.ts`

Match a run's `cwd` to a repo by normalized path. Normalize = strip trailing slashes; compare case-insensitively on darwin/win32, case-sensitively elsewhere. The renderer has no `node:path`/`node:os`; detect platform via `navigator.platform` (electron renderer exposes it) with a darwin/win fallback to case-insensitive.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/desktop/src/renderer/automation/pathMatch.test.ts
import { describe, it, expect } from "bun:test";
import { normalizeCwd, matchRepoIdForCwd } from "./pathMatch";

const repos = [
  { id: "r1", name: "alpha", path: "/Users/me/alpha" },
  { id: "r2", name: "beta", path: "/Users/me/beta/" },
];

describe("normalizeCwd", () => {
  it("strips trailing slash", () => {
    expect(normalizeCwd("/a/b/", false)).toBe("/a/b");
    expect(normalizeCwd("/a/b", false)).toBe("/a/b");
  });
  it("lowercases when case-insensitive", () => {
    expect(normalizeCwd("/A/B", true)).toBe("/a/b");
  });
  it("keeps a bare root", () => {
    expect(normalizeCwd("/", false)).toBe("/");
  });
});

describe("matchRepoIdForCwd", () => {
  it("matches exact path", () => {
    expect(matchRepoIdForCwd("/Users/me/alpha", repos, false)).toBe("r1");
  });
  it("matches despite trailing slash on either side", () => {
    expect(matchRepoIdForCwd("/Users/me/beta", repos, false)).toBe("r2");
    expect(matchRepoIdForCwd("/Users/me/alpha/", repos, false)).toBe("r1");
  });
  it("matches case-insensitively when requested", () => {
    expect(matchRepoIdForCwd("/users/me/ALPHA", repos, true)).toBe("r1");
  });
  it("returns null on no match", () => {
    expect(matchRepoIdForCwd("/somewhere/else", repos, false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && bun test src/renderer/automation/pathMatch.test.ts`
Expected: FAIL — `Cannot find module './pathMatch'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/desktop/src/renderer/automation/pathMatch.ts
export interface RepoLike {
  id: string;
  name: string;
  path: string;
}

/** True on platforms whose filesystems are case-insensitive by default. */
export function isCaseInsensitivePlatform(): boolean {
  const p =
    typeof navigator !== "undefined" && typeof navigator.platform === "string"
      ? navigator.platform.toLowerCase()
      : "";
  // darwin ("MacIntel"/"MacARM") + windows ("Win32") → case-insensitive.
  // Linux ("Linux x86_64") → case-sensitive. Unknown → insensitive (safer:
  // we'd rather over-match an existing repo than wrongly auto-create one).
  if (p.includes("mac") || p.includes("win")) return true;
  if (p.includes("linux")) return false;
  return true;
}

/** Strip trailing slashes (keep a lone "/") and optionally lowercase. */
export function normalizeCwd(cwd: string, caseInsensitive: boolean): string {
  let out = cwd.replace(/\/+$/, "");
  if (out === "") out = "/";
  return caseInsensitive ? out.toLowerCase() : out;
}

/** Return the id of the repo whose path equals `cwd` (normalized), or null. */
export function matchRepoIdForCwd(
  cwd: string,
  repos: RepoLike[],
  caseInsensitive: boolean,
): string | null {
  const target = normalizeCwd(cwd, caseInsensitive);
  for (const r of repos) {
    if (normalizeCwd(r.path, caseInsensitive) === target) return r.id;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && bun test src/renderer/automation/pathMatch.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/automation/pathMatch.ts packages/desktop/src/renderer/automation/pathMatch.test.ts
git commit -m "feat(desktop): cwd↔repo path matching helper for automation attribution"
```

---

## Task 2: Transcript reader — JSONL → fold-items (main, pure)

**Files:**
- Create: `packages/desktop/src/main/transcript-reader.ts`
- Test: `packages/desktop/src/main/transcript-reader.test.ts`
- Reference (shape source): `packages/core/src/session/transcript.ts:39-73`, `packages/core/src/types.ts:72-90` (TranscriptEvent), `packages/core/src/types.ts:241-271` (StreamEvent).

Reads `~/.code-shell/sessions/<sessionId>/transcript.jsonl`, parses each line to a `TranscriptEvent`, and maps to an ordered `FoldItem[]`. Mapping (per design):

| TranscriptEvent.type | FoldItem(s) |
|---|---|
| `session_meta` | `{kind:"stream", event:{type:"session_started", sessionId, promptTokens:0}}` |
| `message` role=user | `{kind:"user", text}` |
| `message` role=assistant | `{kind:"stream", stream_request_start}` + `{text_delta(text)}` + `{assistant_message(message)}` |
| `tool_use` | `{kind:"stream", event:{type:"tool_use_start", toolCall:{id,toolName,args}}}` |
| `tool_result` | `{kind:"stream", event:{type:"tool_result", result:{id,toolName,result,error}}}` |
| `turn_boundary` | `{kind:"stream", event:{type:"turn_complete", reason:"completed"}}` |
| `summary` | `{kind:"stream", event:{type:"context_compact", strategy:"summary", before:0, after:0}}` |
| `error` | `{kind:"stream", event:{type:"error", error}}` |

Assistant `message.content` may be a string or `ContentBlock[]`; extract display text by joining `text` blocks. The folder needs the assistant text as a `text_delta` so `applyStreamEvent` builds the assistant message.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/desktop/src/main/transcript-reader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { transcriptToFoldItems, getSessionTranscript } from "./transcript-reader";

function line(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ id: "x", type, timestamp: 1, turnNumber: 0, data });
}

describe("transcriptToFoldItems", () => {
  it("maps a simple user→assistant turn", () => {
    const jsonl = [
      line("session_meta", { sessionId: "sess-1", cwd: "/repo" }),
      line("message", { role: "user", content: "hello" }),
      line("message", { role: "assistant", content: "hi there" }),
      line("turn_boundary", { turnNumber: 1 }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items[0]).toEqual({ kind: "stream", event: { type: "session_started", sessionId: "sess-1", promptTokens: 0 } });
    expect(items[1]).toEqual({ kind: "user", text: "hello" });
    expect(items[2]).toEqual({ kind: "stream", event: { type: "stream_request_start", turnNumber: 0 } });
    expect(items[3]).toEqual({ kind: "stream", event: { type: "text_delta", text: "hi there" } });
    expect(items[4]).toEqual({ kind: "stream", event: { type: "assistant_message", message: { role: "assistant", content: "hi there" } } });
    expect(items[5]).toEqual({ kind: "stream", event: { type: "turn_complete", reason: "completed" } });
  });

  it("maps tool_use + tool_result", () => {
    const jsonl = [
      line("tool_use", { toolName: "Bash", toolCallId: "tc1", args: { command: "ls" } }),
      line("tool_result", { toolCallId: "tc1", toolName: "Bash", result: "a\nb" }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items[0]).toEqual({ kind: "stream", event: { type: "tool_use_start", toolCall: { id: "tc1", toolName: "Bash", args: { command: "ls" } } } });
    expect(items[1]).toEqual({ kind: "stream", event: { type: "tool_result", result: { id: "tc1", toolName: "Bash", result: "a\nb", error: undefined } } });
  });

  it("extracts text from assistant content blocks", () => {
    const jsonl = line("message", {
      role: "assistant",
      content: [{ type: "text", text: "block one" }, { type: "tool_use", id: "t", name: "X", input: {} }],
    });
    const items = transcriptToFoldItems(jsonl);
    const delta = items.find((i) => i.kind === "stream" && i.event.type === "text_delta");
    expect(delta).toEqual({ kind: "stream", event: { type: "text_delta", text: "block one" } });
  });

  it("skips malformed lines without throwing", () => {
    const jsonl = ["not json", line("message", { role: "user", content: "ok" })].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items).toEqual([{ kind: "user", text: "ok" }]);
  });

  it("maps summary and error", () => {
    const jsonl = [line("summary", { summary: "s" }), line("error", { error: "boom" })].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items[0]).toEqual({ kind: "stream", event: { type: "context_compact", strategy: "summary", before: 0, after: 0 } });
    expect(items[1]).toEqual({ kind: "stream", event: { type: "error", error: "boom" } });
  });
});

describe("getSessionTranscript", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-tr-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns [] for a missing session", async () => {
    expect(await getSessionTranscript("nope", dir)).toEqual([]);
  });

  it("reads a session dir transcript.jsonl", async () => {
    const sdir = path.join(dir, "sess-9");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "transcript.jsonl"), line("message", { role: "user", content: "yo" }) + "\n");
    expect(await getSessionTranscript("sess-9", dir)).toEqual([{ kind: "user", text: "yo" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && bun test src/main/transcript-reader.test.ts`
Expected: FAIL — `Cannot find module './transcript-reader'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/desktop/src/main/transcript-reader.ts
/**
 * Read a persisted engine transcript (~/.code-shell/sessions/<id>/transcript.jsonl)
 * and convert it to an ordered list of FoldItems the renderer can replay
 * through its existing message reducer. Pure parse — no reducer here, so the
 * renderer stays the single source of message-folding logic.
 *
 * TranscriptEvent shape: packages/core/src/types.ts:84-90.
 * StreamEvent shapes:     packages/core/src/types.ts:241-271.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { FoldItem } from "../preload/types";

const SESSIONS_DIR = path.join(os.homedir(), ".code-shell", "sessions");

interface TranscriptEvent {
  id: string;
  type: string;
  timestamp: number;
  turnNumber: number;
  data: Record<string, unknown>;
}

interface ContentBlockLike {
  type?: string;
  text?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlockLike[])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

export function transcriptToFoldItems(jsonl: string): FoldItem[] {
  const items: FoldItem[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let ev: TranscriptEvent;
    try {
      ev = JSON.parse(line) as TranscriptEvent;
    } catch {
      continue; // skip malformed lines, mirroring core Transcript.loadFromFile
    }
    const d = ev.data ?? {};
    switch (ev.type) {
      case "session_meta":
        items.push({
          kind: "stream",
          event: { type: "session_started", sessionId: String(d.sessionId ?? ""), promptTokens: 0 },
        });
        break;
      case "message": {
        const role = String(d.role ?? "");
        if (role === "user") {
          items.push({ kind: "user", text: textOf(d.content) });
        } else if (role === "assistant") {
          items.push({ kind: "stream", event: { type: "stream_request_start", turnNumber: 0 } });
          items.push({ kind: "stream", event: { type: "text_delta", text: textOf(d.content) } });
          items.push({
            kind: "stream",
            event: { type: "assistant_message", message: { role: "assistant", content: d.content as never } },
          });
        }
        break;
      }
      case "tool_use":
        items.push({
          kind: "stream",
          event: {
            type: "tool_use_start",
            toolCall: {
              id: String(d.toolCallId ?? ""),
              toolName: String(d.toolName ?? ""),
              args: (d.args as Record<string, unknown>) ?? {},
            },
          },
        });
        break;
      case "tool_result":
        items.push({
          kind: "stream",
          event: {
            type: "tool_result",
            result: {
              id: String(d.toolCallId ?? ""),
              toolName: String(d.toolName ?? ""),
              result: d.result as string | undefined,
              error: d.error as string | undefined,
            },
          },
        });
        break;
      case "turn_boundary":
        items.push({ kind: "stream", event: { type: "turn_complete", reason: "completed" } });
        break;
      case "summary":
        items.push({ kind: "stream", event: { type: "context_compact", strategy: "summary", before: 0, after: 0 } });
        break;
      case "error":
        items.push({ kind: "stream", event: { type: "error", error: String(d.error ?? "error") } });
        break;
      // session lifecycle events with no renderer representation are ignored.
    }
  }
  return items;
}

/**
 * Read + convert the transcript for `sessionId`. `baseDir` overridable for
 * tests; defaults to ~/.code-shell/sessions. Returns [] when absent/empty.
 */
export async function getSessionTranscript(
  sessionId: string,
  baseDir: string = SESSIONS_DIR,
): Promise<FoldItem[]> {
  const clean = sessionId.replace(/[\\/]/g, "");
  const file = path.join(baseDir, clean, "transcript.jsonl");
  try {
    const jsonl = await fs.readFile(file, "utf8");
    return transcriptToFoldItems(jsonl);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && bun test src/main/transcript-reader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/transcript-reader.ts packages/desktop/src/main/transcript-reader.test.ts
git commit -m "feat(desktop): main-process transcript reader (JSONL → fold items)"
```

---

## Task 3: Unified delete (fix session-dir bug) + runs:delete + IPC + preload wiring

**Files:**
- Modify: `packages/desktop/src/main/sessions-service.ts:50-61` (deleteSession)
- Modify: `packages/desktop/src/main/runs-service.ts` (add `deleteRun`)
- Modify: `packages/desktop/src/main/index.ts:61,96,698-721` (imports + 2 new handlers)
- Modify: `packages/desktop/src/preload/index.ts:223,229` (bridge)
- Modify: `packages/desktop/src/preload/types.d.ts` (FoldItem + 2 methods)
- Test: `packages/desktop/src/main/sessions-service.test.ts`, `packages/desktop/src/main/runs-service.test.ts`

The current `deleteSession` only unlinks flat `<id>.jsonl`/`<id>.json` files, but the engine writes a `<sessionId>/` *directory* (`session-manager.ts:93,141`). Fix it to also `rm -rf` the directory. Add `deleteRun` to remove `~/.code-shell/runs/<runId>/`. Also extend `RunSummary` to surface `source` + `cronJobName` from `run.json`'s `metadata` (`runner.ts:97` writes `metadata: { source: "automation", cronJobId, cronJobName }`), so backfill doesn't need an N+1 `getRun` fetch.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/desktop/src/main/sessions-service.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteSessionDir } from "./sessions-service";

describe("deleteSessionDir", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ss-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("removes a session directory", async () => {
    const sdir = path.join(dir, "sess-1");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "transcript.jsonl"), "x");
    await deleteSessionDir("sess-1", dir);
    expect(fs.existsSync(sdir)).toBe(false);
  });

  it("removes a legacy flat file", async () => {
    fs.writeFileSync(path.join(dir, "sess-2.jsonl"), "x");
    await deleteSessionDir("sess-2", dir);
    expect(fs.existsSync(path.join(dir, "sess-2.jsonl"))).toBe(false);
  });

  it("is a no-op (no throw) when nothing exists", async () => {
    await deleteSessionDir("ghost", dir);
    expect(true).toBe(true);
  });

  it("rejects path traversal in id", async () => {
    // cleanId strips slashes, so this collapses to a harmless name
    await deleteSessionDir("../../etc", dir);
    expect(fs.existsSync(path.join(dir, "....etc"))).toBe(false);
  });
});
```

```typescript
// packages/desktop/src/main/runs-service.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteRunDir } from "./runs-service";

describe("deleteRunDir", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rs-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("removes a run directory", async () => {
    const rdir = path.join(dir, "run-1");
    fs.mkdirSync(rdir, { recursive: true });
    fs.writeFileSync(path.join(rdir, "run.json"), "{}");
    await deleteRunDir("run-1", dir);
    expect(fs.existsSync(rdir)).toBe(false);
  });

  it("is a no-op when missing", async () => {
    await deleteRunDir("ghost", dir);
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/desktop && bun test src/main/sessions-service.test.ts src/main/runs-service.test.ts`
Expected: FAIL — `deleteSessionDir` / `deleteRunDir` not exported.

- [ ] **Step 3a: Fix `deleteSession` and export testable `deleteSessionDir`**

Replace `sessions-service.ts:50-61` (the existing `deleteSession`) with:

```typescript
/**
 * Remove a session's on-disk data. Modern sessions are a directory
 * `<sessionsDir>/<id>/` (transcript.jsonl + state.json — see
 * core session-manager.ts:93,141). Pre-directory sessions were flat
 * `<id>.jsonl`/`<id>.json` files; we remove those too for back-compat.
 * `baseDir` is overridable for tests.
 */
export async function deleteSessionDir(
  id: string,
  baseDir: string = SESSIONS_DIR,
): Promise<void> {
  const cleanId = id.replace(/[\\/]/g, "");
  // Directory form (current).
  await fs.rm(path.join(baseDir, cleanId), { recursive: true, force: true });
  // Legacy flat files.
  for (const ext of [".jsonl", ".json"]) {
    try {
      await fs.unlink(path.join(baseDir, `${cleanId}${ext}`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

/** @deprecated kept for the existing IPC handler name; delegates to deleteSessionDir. */
export async function deleteSession(id: string): Promise<void> {
  await deleteSessionDir(id);
}
```

Also add `getSessionTranscript` re-export so the IPC handler imports it from one place. Append to `sessions-service.ts`:

```typescript
export { getSessionTranscript } from "./transcript-reader.js";
```

- [ ] **Step 3b: Add `deleteRunDir` + surface `source`/`cronJobName` in `runs-service.ts`**

Append to `runs-service.ts`:

```typescript
/**
 * Remove a run's on-disk directory (~/.code-shell/runs/<runId>/).
 * `baseDir` overridable for tests; no-op when absent.
 */
export async function deleteRunDir(
  runId: string,
  baseDir: string = RUNS_DIR,
): Promise<void> {
  const clean = runId.replace(/[\\/]/g, "");
  await fs.rm(path.join(baseDir, clean), { recursive: true, force: true });
}
```

Extend `RunSummary` (the interface at lines 23-36) with two optional fields so
`listRuns` carries enough for attribution without a per-run detail fetch:

```typescript
  /** "automation" for cron-triggered runs (from run.json metadata.source). */
  source?: string;
  /** Display name of the originating cron job, when source === "automation". */
  cronJobName?: string;
```

And populate them in `snapshotToSummary` (lines 70-85), reading from
`snap.metadata`:

```typescript
function snapshotToSummary(snap: Record<string, unknown>): RunSummary {
  const meta =
    snap.metadata && typeof snap.metadata === "object" && !Array.isArray(snap.metadata)
      ? (snap.metadata as Record<string, unknown>)
      : {};
  return {
    runId: String(snap.runId ?? ""),
    objective: String(snap.objective ?? ""),
    preset: typeof snap.preset === "string" ? snap.preset : undefined,
    cwd: String(snap.cwd ?? ""),
    status: String(snap.status ?? "unknown"),
    createdAt: Number(snap.createdAt ?? 0),
    updatedAt: Number(snap.updatedAt ?? 0),
    startedAt: (snap.startedAt as number | null) ?? null,
    finishedAt: (snap.finishedAt as number | null) ?? null,
    sessionId: (snap.sessionId as string | null) ?? null,
    error: (snap.error as string | null) ?? null,
    summary: (snap.summary as string | null) ?? null,
    source: typeof meta.source === "string" ? meta.source : undefined,
    cronJobName: typeof meta.cronJobName === "string" ? meta.cronJobName : undefined,
  };
}
```

Mirror the two new fields onto the renderer-side `RunSummary` declaration in
`packages/desktop/src/preload/types.d.ts` (find the `interface RunSummary` /
`RunSummary` type there and add `source?: string;` + `cronJobName?: string;`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/desktop && bun test src/main/sessions-service.test.ts src/main/runs-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire IPC + preload (no separate test; covered by typecheck)**

In `packages/desktop/src/main/index.ts`, update the import at line 61 and 96:

```typescript
import { listSessions, deleteSession, getSessionTranscript } from "./sessions-service.js";
```
```typescript
import { listRuns, getRun, deleteRunDir } from "./runs-service.js";
```

Add two handlers right after the existing `runs:get` handler (after line 721):

```typescript
ipcMain.handle("sessions:transcript", async (_e, sessionId: string) => {
  if (typeof sessionId !== "string") throw new Error("sessionId required");
  return getSessionTranscript(sessionId);
});
ipcMain.handle("runs:delete", async (_e, runId: string) => {
  if (typeof runId !== "string") throw new Error("runId required");
  await deleteRunDir(runId);
});
```

In `packages/desktop/src/preload/index.ts`, add after line 230 (`getRun`):

```typescript
  getSessionTranscript: (sessionId: string) =>
    ipcRenderer.invoke("sessions:transcript", sessionId),
  deleteRun: (runId: string) => ipcRenderer.invoke("runs:delete", runId),
```

In `packages/desktop/src/preload/types.d.ts`, add the `FoldItem` type near the top (after the existing `import type { StreamEvent }` if present; otherwise add the import):

```typescript
import type { StreamEvent } from "@cjhyy/code-shell-core";

export type FoldItem =
  | { kind: "stream"; event: StreamEvent }
  | { kind: "user"; text: string };
```

And add the two methods to the `window.codeshell` interface after line 249 (`getRun`):

```typescript
  getSessionTranscript(sessionId: string): Promise<FoldItem[]>;
  deleteRun(runId: string): Promise<void>;
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/main/sessions-service.ts packages/desktop/src/main/runs-service.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts packages/desktop/src/main/sessions-service.test.ts packages/desktop/src/main/runs-service.test.ts
git commit -m "fix(desktop): delete session DIRECTORY not just flat file; add runs:delete + sessions:transcript IPC"
```

---

## Task 4: foldTranscript — fold-items → MessagesReducerState (renderer)

**Files:**
- Create: `packages/desktop/src/renderer/automation/foldTranscript.ts`
- Test: `packages/desktop/src/renderer/automation/foldTranscript.test.ts`
- Reuses: `applyStreamEvent`, `appendUserMessage`, `INITIAL_STATE` from `../types`.

Folds a `FoldItem[]` into a final `MessagesReducerState` by routing `stream` items through `applyStreamEvent` and `user` items through `appendUserMessage`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/desktop/src/renderer/automation/foldTranscript.test.ts
import { describe, it, expect } from "bun:test";
import { foldTranscript } from "./foldTranscript";
import type { FoldItem } from "../../preload/types";

describe("foldTranscript", () => {
  it("builds user + assistant messages", () => {
    const items: FoldItem[] = [
      { kind: "stream", event: { type: "session_started", sessionId: "s1", promptTokens: 0 } },
      { kind: "user", text: "hello" },
      { kind: "stream", event: { type: "stream_request_start", turnNumber: 0 } },
      { kind: "stream", event: { type: "text_delta", text: "hi there" } },
      { kind: "stream", event: { type: "assistant_message", message: { role: "assistant", content: "hi there" } } },
      { kind: "stream", event: { type: "turn_complete", reason: "completed" } },
    ];
    const state = foldTranscript(items);
    expect(state.sessionId).toBe("s1");
    const kinds = state.messages.map((m) => m.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    const assistant = state.messages.find((m) => m.kind === "assistant");
    expect(assistant && (assistant as { text: string }).text).toBe("hi there");
  });

  it("renders a tool call", () => {
    const items: FoldItem[] = [
      { kind: "stream", event: { type: "tool_use_start", toolCall: { id: "tc1", toolName: "Bash", args: { command: "ls" } } } },
      { kind: "stream", event: { type: "tool_result", result: { id: "tc1", toolName: "Bash", result: "out" } } },
    ];
    const state = foldTranscript(items);
    const tool = state.messages.find((m) => m.kind === "tool");
    expect(tool).toBeDefined();
    expect((tool as { toolName: string }).toolName).toBe("Bash");
  });

  it("returns empty state for empty input", () => {
    expect(foldTranscript([]).messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && bun test src/renderer/automation/foldTranscript.test.ts`
Expected: FAIL — `Cannot find module './foldTranscript'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/desktop/src/renderer/automation/foldTranscript.ts
/**
 * Replay a persisted transcript (as FoldItems from the main-process reader)
 * into a MessagesReducerState by reusing the SAME reducer the live stream
 * uses. This keeps message-folding logic single-sourced in types.ts.
 */
import { applyStreamEvent, appendUserMessage, INITIAL_STATE, type MessagesReducerState } from "../types";
import type { FoldItem } from "../../preload/types";

export function foldTranscript(items: FoldItem[]): MessagesReducerState {
  let state = INITIAL_STATE;
  for (const item of items) {
    state = item.kind === "user"
      ? appendUserMessage(state, item.text)
      : applyStreamEvent(state, item.event);
  }
  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && bun test src/renderer/automation/foldTranscript.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/automation/foldTranscript.ts packages/desktop/src/renderer/automation/foldTranscript.test.ts
git commit -m "feat(desktop): fold persisted transcript into renderer message state"
```

---

## Task 5: SessionSummary fields + importRuns (attribution + dedup + cap)

**Files:**
- Modify: `packages/desktop/src/renderer/transcripts.ts:31-49` (add fields), and add `upsertImportedSession`
- Create: `packages/desktop/src/renderer/automation/importRuns.ts`
- Test: `packages/desktop/src/renderer/automation/importRuns.test.ts`

`importAutomationRuns` takes the run list + repos + a transcript-fetcher + storage callbacks, attributes each automation run to a repo (auto-creating one when no match), dedups by `engineSessionId`, caps at 50 most-recent per repo, folds transcripts, and writes both the `SessionIndex` summary and the transcript. Side effects are injected so the module is unit-testable without localStorage.

- [ ] **Step 1: Add fields + helper to `transcripts.ts`**

In `transcripts.ts`, extend `SessionSummary` (after the `engineSessionId?` field at line 48, before the closing `}`):

```typescript
  /** "automation" when imported from a cron run; absent for manual chats. */
  source?: "automation";
  /** RunStore run id, when source === "automation" — used for unified delete. */
  runId?: string;
```

Add this exported helper (after `bindEngineSession`, ~line 249):

```typescript
/**
 * Insert or update an imported (automation) session summary in a repo's
 * index, keyed by engineSessionId. Returns the new index. Does NOT write
 * the transcript (caller does that via saveTranscript). Idempotent: a second
 * call with the same engineSessionId updates in place instead of duplicating.
 */
export function upsertImportedSession(
  repoId: string | null,
  summary: SessionSummary,
): SessionIndex {
  const idx = loadSessionIndex(repoId);
  const without = idx.sessions.filter(
    (s) => !(summary.engineSessionId && s.engineSessionId === summary.engineSessionId),
  );
  const next: SessionIndex = {
    sessions: [summary, ...without].sort((a, b) => b.updatedAt - a.updatedAt),
    activeSessionId: idx.activeSessionId,
  };
  saveSessionIndex(repoId, next);
  return next;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// packages/desktop/src/renderer/automation/importRuns.test.ts
import { describe, it, expect } from "bun:test";
import { importAutomationRuns, type ImportableRun, type ImportDeps } from "./importRuns";
import type { FoldItem } from "../../preload/types";

const repos = [{ id: "r1", name: "alpha", path: "/repo/alpha" }];

function run(over: Partial<ImportableRun>): ImportableRun {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    cwd: "/repo/alpha",
    objective: "do a thing",
    status: "completed",
    finishedAt: 1000,
    createdAt: 900,
    source: "automation",
    cronJobName: "nightly",
    ...over,
  };
}

function deps(over: Partial<ImportDeps> = {}): { d: ImportDeps; imported: Array<{ repoId: string | null; sessionId: string }> } {
  const imported: Array<{ repoId: string | null; sessionId: string }> = [];
  const d: ImportDeps = {
    caseInsensitive: false,
    existingEngineSessionIds: new Set<string>(),
    fetchTranscript: async (): Promise<FoldItem[]> => [{ kind: "user", text: "hi" }],
    writeImported: (repoId, summary, _state) => { imported.push({ repoId, sessionId: summary.id }); },
    createRepoForCwd: () => "auto-repo",
    cap: 50,
    ...over,
  };
  return { d, imported };
}

describe("importAutomationRuns", () => {
  it("imports a completed automation run into its repo", async () => {
    const { d, imported } = deps();
    await importAutomationRuns([run({})], repos, d);
    expect(imported).toHaveLength(1);
    expect(imported[0].repoId).toBe("r1");
  });

  it("skips runs that are not automation-sourced", async () => {
    const { d, imported } = deps();
    await importAutomationRuns([run({ source: undefined })], repos, d);
    expect(imported).toHaveLength(0);
  });

  it("skips non-terminal or session-less runs", async () => {
    const { d, imported } = deps();
    await importAutomationRuns(
      [run({ status: "running" }), run({ runId: "r2", sessionId: null })],
      repos,
      d,
    );
    expect(imported).toHaveLength(0);
  });

  it("dedups against already-known engineSessionIds", async () => {
    const { d, imported } = deps({ existingEngineSessionIds: new Set(["sess-1"]) });
    await importAutomationRuns([run({})], repos, d);
    expect(imported).toHaveLength(0);
  });

  it("auto-creates a repo when cwd matches none", async () => {
    let createdFor = "";
    const { d, imported } = deps({ createRepoForCwd: (cwd) => { createdFor = cwd; return "new-repo"; } });
    await importAutomationRuns([run({ cwd: "/somewhere/new" })], repos, d);
    expect(createdFor).toBe("/somewhere/new");
    expect(imported[0].repoId).toBe("new-repo");
  });

  it("caps to the N most-recent per repo", async () => {
    const runs: ImportableRun[] = [];
    for (let i = 0; i < 60; i++) runs.push(run({ runId: `run-${i}`, sessionId: `sess-${i}`, finishedAt: i }));
    const { d, imported } = deps({ cap: 50 });
    await importAutomationRuns(runs, repos, d);
    expect(imported).toHaveLength(50);
    // most-recent kept: finishedAt 59 present, finishedAt 0..9 dropped
    const ids = new Set(imported.map((x) => x.sessionId));
    expect(ids.has("sess-59")).toBe(true);
    expect(ids.has("sess-0")).toBe(false);
  });

  it("does not throw when a transcript fetch fails", async () => {
    const { d, imported } = deps({ fetchTranscript: async () => { throw new Error("io"); } });
    await importAutomationRuns([run({})], repos, d);
    // still imports the summary with an empty transcript
    expect(imported).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/desktop && bun test src/renderer/automation/importRuns.test.ts`
Expected: FAIL — `Cannot find module './importRuns'`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// packages/desktop/src/renderer/automation/importRuns.ts
/**
 * Attribute completed automation runs to sidebar projects and import them
 * into localStorage as normal sessions. Pure orchestration with injected
 * side effects (fetchTranscript / writeImported / createRepoForCwd) so it
 * unit-tests without Electron or localStorage.
 */
import type { FoldItem } from "../../preload/types";
import type { MessagesReducerState } from "../types";
import type { SessionSummary } from "../transcripts";
import { foldTranscript } from "./foldTranscript";
import { matchRepoIdForCwd, type RepoLike } from "./pathMatch";

/** A run as needed for import (subset of the main-process RunSummary). */
export interface ImportableRun {
  runId: string;
  sessionId: string | null;
  cwd: string;
  objective: string;
  status: string;
  finishedAt: number | null;
  createdAt: number;
  /** "automation" only — non-automation runs are filtered out. */
  source?: "automation" | string;
  cronJobName?: string;
}

export interface ImportDeps {
  caseInsensitive: boolean;
  /** engineSessionIds already present across all repo indices (dedup key). */
  existingEngineSessionIds: Set<string>;
  fetchTranscript: (sessionId: string) => Promise<FoldItem[]>;
  writeImported: (
    repoId: string | null,
    summary: SessionSummary,
    state: MessagesReducerState,
  ) => void;
  /** Create a repo for an unmatched cwd; returns its id. */
  createRepoForCwd: (cwd: string) => string;
  /** Max runs imported per repo (most-recent first). */
  cap: number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function importAutomationRuns(
  runs: ImportableRun[],
  repos: RepoLike[],
  deps: ImportDeps,
): Promise<void> {
  // 1. Filter: automation-sourced, terminal, has a sessionId, not already known.
  const candidates = runs.filter(
    (r) =>
      r.source === "automation" &&
      TERMINAL.has(r.status) &&
      !!r.sessionId &&
      !deps.existingEngineSessionIds.has(r.sessionId),
  );

  // 2. Group by attributed repoId (auto-creating repos as needed).
  const byRepo = new Map<string | null, ImportableRun[]>();
  for (const r of candidates) {
    let repoId = matchRepoIdForCwd(r.cwd, repos, deps.caseInsensitive);
    if (!repoId) repoId = deps.createRepoForCwd(r.cwd);
    const list = byRepo.get(repoId) ?? [];
    list.push(r);
    byRepo.set(repoId, list);
  }

  // 3. Per repo: most-recent first, cap, fetch+fold+write.
  for (const [repoId, list] of byRepo) {
    list.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const r of list.slice(0, deps.cap)) {
      let state: MessagesReducerState;
      try {
        state = foldTranscript(await deps.fetchTranscript(r.sessionId as string));
      } catch {
        state = foldTranscript([]); // transcript unavailable — import an empty shell
      }
      const summary: SessionSummary = {
        id: r.sessionId as string, // engine sessionId doubles as the UI session id for imports
        title: (r.cronJobName || r.objective || "automation").slice(0, 60),
        createdAt: r.createdAt,
        updatedAt: r.finishedAt ?? r.createdAt,
        engineSessionId: r.sessionId as string,
        source: "automation",
        runId: r.runId,
      };
      deps.writeImported(repoId, summary, state);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/desktop && bun test src/renderer/automation/importRuns.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/transcripts.ts packages/desktop/src/renderer/automation/importRuns.ts packages/desktop/src/renderer/automation/importRuns.test.ts
git commit -m "feat(desktop): attribute+dedup+cap automation runs for sidebar import"
```

---

## Task 6: Wire into App.tsx (backfill on startup) + unified delete + sidebar marker

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx` (imports ~21-48; new backfill effect; `handleDeleteSession` ~442-448)
- Modify: `packages/desktop/src/renderer/Sidebar.tsx` (marker render)

No new unit test (integration wiring); verified by typecheck + renderer build + manual run. Reuses the building blocks from Tasks 1/4/5.

- [ ] **Step 1: Add imports to App.tsx**

In the `./transcripts` import block (lines 21-34), add `upsertImportedSession`, `saveTranscript`, `loadSessionIndex` (saveTranscript/loadSessionIndex already imported — only add the new one):

```typescript
import {
  loadTranscript,
  saveTranscript,
  loadSessionIndex,
  createSession,
  deleteSessionLocal,
  renameSessionLocal,
  archiveSession,
  bindEngineSession,
  upsertImportedSession,
  touchSession,
  setActiveSession,
  NO_REPO_KEY,
  type SessionIndex,
  type SessionSummary,
} from "./transcripts";
```

Add new imports below the repos import (after line 48):

```typescript
import { importAutomationRuns, type ImportableRun } from "./automation/importRuns";
import { isCaseInsensitivePlatform } from "./automation/pathMatch";
```

- [ ] **Step 2: Add the backfill effect**

Add this effect alongside the other mount effects in App.tsx (e.g. right after the stream-subscription `useEffect` that ends near line 618). It runs once on mount: lists runs, collects known engineSessionIds across all current indices, imports, and refreshes `sessionIndices` + repos state.

```typescript
// Backfill automation runs from disk into the sidebar on startup. Disk is
// the source of truth; localStorage is our projection. Runs are deduped by
// engineSessionId and capped to the 50 most-recent per project.
useEffect(() => {
  let cancelled = false;
  void (async () => {
    let runs: ImportableRun[];
    try {
      const raw = await window.codeshell.listRuns();
      // RunSummary now carries source + cronJobName (Task 3), so no per-run
      // detail fetch is needed — importAutomationRuns does the filtering.
      runs = raw.map((r) => ({
        runId: r.runId,
        sessionId: r.sessionId,
        cwd: r.cwd,
        objective: r.objective,
        status: r.status,
        finishedAt: r.finishedAt,
        createdAt: r.createdAt,
        source: r.source,
        cronJobName: r.cronJobName,
      }));
    } catch {
      return; // no runs dir / read error — nothing to backfill
    }
    if (cancelled || runs.length === 0) return;
    const enriched = runs; // naming kept for the import call below

    // Known engineSessionIds across every repo index (manual + already-imported).
    const known = new Set<string>();
    const allRepos = loadRepos();
    for (const r of allRepos) {
      for (const s of loadSessionIndex(r.id).sessions) {
        if (s.engineSessionId) known.add(s.engineSessionId);
      }
    }
    for (const s of loadSessionIndex(null).sessions) {
      if (s.engineSessionId) known.add(s.engineSessionId);
    }

    const touchedRepoIds = new Set<string | null>();
    let reposChanged = false;
    await importAutomationRuns(enriched, allRepos, {
      caseInsensitive: isCaseInsensitivePlatform(),
      existingEngineSessionIds: known,
      cap: 50,
      fetchTranscript: (sid) => window.codeshell.getSessionTranscript(sid),
      createRepoForCwd: (cwd) => {
        const id = makeRepoId();
        const name = cwd.split("/").filter(Boolean).pop() || cwd;
        const next = [...loadRepos(), { id, name, path: cwd }];
        saveRepos(next);
        reposChanged = true;
        return id;
      },
      writeImported: (repoId, summary, state) => {
        saveTranscript(repoId, summary.id, state);
        upsertImportedSession(repoId, summary);
        touchedRepoIds.add(repoId);
      },
    });
    if (cancelled) return;

    if (reposChanged) setRepos(loadRepos());
    if (touchedRepoIds.size > 0) {
      setSessionIndices((prev) => {
        const next = { ...prev };
        for (const rid of touchedRepoIds) next[repoKeyOf(rid)] = loadSessionIndex(rid);
        return next;
      });
    }
  })();
  return () => { cancelled = true; };
}, []);
```

- [ ] **Step 3: Make delete unified in `handleDeleteSession`**

Replace `handleDeleteSession` (lines 442-448) with:

```typescript
const handleDeleteSession = (
  repoId: string | null,
  sessionId: string,
): void => {
  // Find the summary BEFORE we wipe it locally — we need source/runId.
  const summary = sessionIndices[repoKeyOf(repoId)]?.sessions.find((s) => s.id === sessionId);
  const next = deleteSessionLocal(repoId, sessionId);
  setSessionIndices((prev) => ({ ...prev, [repoKeyOf(repoId)]: next }));
  // Imported automation sessions also own on-disk session + run dirs;
  // remove them so "delete" means delete everywhere (disk is together).
  if (summary?.source === "automation") {
    const engineId = summary.engineSessionId ?? sessionId;
    void window.codeshell.deleteSession(engineId).catch((e) =>
      window.codeshell.log("automation.delete.session.failed", { engineId, error: String(e) }),
    );
    if (summary.runId) {
      void window.codeshell.deleteRun(summary.runId).catch((e) =>
        window.codeshell.log("automation.delete.run.failed", { runId: summary.runId, error: String(e) }),
      );
    }
  }
};
```

- [ ] **Step 4: Sidebar marker**

In `Sidebar.tsx`, the session row renders its title at line 522:
`<span className="session-title">{s.title}</span>`. Add a small marker before
that span when `s.source === "automation"`. Change line 522 to:

```typescript
      {s.source === "automation" && (
        <Clock className="session-automation-icon" aria-label="自动化" />
      )}
      <span className="session-title">{s.title}</span>
```

Add `Clock` to the existing `lucide-react` import block (lines 2-14) if it is
not already imported there. Keep styling minimal — `session-automation-icon` is
a tiny inline icon; if no matching CSS class exists, use Tailwind utilities
instead per the desktop CLAUDE.md (`className="h-3 w-3 shrink-0 text-muted-foreground mr-1"`).

- [ ] **Step 5: Typecheck + renderer build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: no type errors; renderer build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/Sidebar.tsx
git commit -m "feat(desktop): backfill automation runs into sidebar + unified delete + marker"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full desktop test suite**

Run: `cd packages/desktop && bun test`
Expected: all pass, including the 4 new test files.

- [ ] **Step 2: Desktop typecheck + build (own pipeline — repo root does not cover it)**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: clean.

- [ ] **Step 3: Repo-wide tests + lint (catch cross-package regressions)**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun test && bun run lint`
Expected: no new failures; lint 0 errors (pre-existing warnings OK).

- [ ] **Step 4: Manual smoke (optional but recommended)**

Per `project_automation_plan` memory: if core exports changed (they didn't here — all changes are in `packages/desktop`), rebuild core. Here only desktop changed, so: launch the desktop app, confirm a completed automation run appears under its project with the marker, click in to see the transcript, then delete it and confirm the run/session dirs are gone from `~/.code-shell/runs` and `~/.code-shell/sessions`.

---

## Self-Review notes

- **Spec coverage:** Component 1 (reader) → Task 2; converter/fold → Task 4; Component 2 (attribution+dedup+cap) → Task 5; backfill wiring → Task 6 Step 2; Component 4 (unified delete + sessions:delete dir fix) → Task 3 + Task 6 Step 3; visual marker → Task 6 Step 4; path normalization → Task 1.
- **Live push (Component 3):** The spec called for live push in addition to backfill. The current App.tsx has no run-completed notification listener (confirmed: only a busy→idle `notify`). Adding a new core→renderer notification channel is a larger surface than the rest and risks scope creep. **Decision: the mount backfill already covers "see what ran" on next focus, and re-running the backfill is cheap + idempotent (deduped by engineSessionId).** Task 6 Step 2's effect can be re-triggered on window focus as a follow-up; for this plan we ship backfill-on-mount and note live-push as a fast-follow. This is a deliberate scope trim, surfaced here rather than silently dropped.
- **Type consistency:** `FoldItem` defined once in `preload/types.d.ts`, imported by reader (main) + folder (renderer) + importRuns. `ImportableRun.source` is `"automation" | string` so the filter is explicit. `summary.id === engineSessionId` for imports (documented) so dedup + delete both key off the same value.
- **Placeholder scan:** no TBD/TODO; every code step has full code. The Sidebar marker step references "find where the row renders" — that is a locate instruction, with the exact JSX to insert provided.
