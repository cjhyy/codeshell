# 驱动外部 Claude Code 编排 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 codeshell 作为外部 `claude` CLI 的编排器——探测 CLI、headless 驱动(spawn/resume)、列项目 session、aux 裁判续/新/停、定时/循环调度、后台多任务,并提供最小 desktop CC 房间 UI。

**Architecture:** core 新增 `cc-orchestrator` 模块(5 单元 + 2 工具),CC 侧无时间概念(只跑一轮),所有延时/定时/循环/续新裁决在 codeshell 编排层。定时复用现有 `CronScheduler`+`CronStore`(独立 store 文件 + 注入自有 executor,不碰 automation 的 RunManager/权限世界观)。后台多 CC 复用现有 `backgroundJobRegistry`。desktop 是薄消费者:IPC 桥 + CC 房间 UI(session 列表为主)。

**Tech Stack:** TypeScript / Node child_process / bun test(core)/ Electron IPC + React + shadcn/ui(desktop)。

**实地已验证(实现时当事实用):**
- `claude` v2.1.186 在 `/opt/homebrew/bin`。
- headless 必须:`claude -p <prompt> --output-format stream-json --verbose`(**缺 `--verbose` 报错**)。
- spawn 必须 **关 stdin**(`stdio[0]='ignore'`),否则白等 3s "no stdin data"。
- stream-json 每行 JSON:`type` ∈ `system`(init/hook)、`assistant`、`result`(subtype=success)、`rate_limit_event`。每行带 `session_id`(snake_case)。
- `result` 行:`{ result: <最终文本>, session_id, is_error, stop_reason, usage, total_cost_usd, permission_denials }`。
- `--resume <id>` 续上下文成功,session_id 不变。
- session 存 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`;encodeCwd = 路径里**每个非字母数字字符 → 一个 `-`**(含前导 `/`)。例:`/Users/admin/Documents/个人学习/代码学习/codeshell` → `-Users-admin-Documents-----------codeshell`。文件名即 sessionId。每行 jsonl 有 `sessionId` 字段;user 消息 `type:"user"`,首条可能是 local-command-caveat 噪声需跳过。

---

## 文件结构

**core 新模块 `packages/core/src/cc-orchestrator/`:**
- `cc-capability.ts` — 探测 claude CLI 可用性 + PATH 修正。
- `agent-adapter.ts` — `AgentAdapter` 接口 + `claudeAdapter`(buildArgs/parseResult);codex 留空壳。
- `external-agent-driver.ts` — `ExternalAgentDriver`:spawn 一轮 headless claude,收集到退出,返回结果。
- `session-discovery.ts` — `encodeCwd` + `discoverSessions`(读 jsonl)。
- `relevance-judge.ts` — `judgeContinuation`(aux LLM 裁决续/新/停)。
- `cc-task-store.ts` — CC 任务元数据 side-store(continuation/goal/sessionId,与 CronStore 配对)。
- `cc-scheduler-binding.ts` — 把 CronScheduler 的 executor 绑到 driver + 裁判。
- `index.ts` — 模块导出。
- 工具:`packages/core/src/tool-system/builtin/drive-claude-code.ts`、`schedule-room-task.ts`。

**desktop:**
- `packages/desktop/src/main/cc-room/cc-room-ipc.ts` — IPC handlers(探测/列session/驱动/任务CRUD)。
- `packages/desktop/src/preload/index.ts` — 暴露 `window.codeshell.ccRoom.*`(修改)。
- `packages/desktop/src/renderer/cc-room/CCRoomView.tsx` — CC 房间 UI(session 列表 + 选/新开 + 定时)。

---

## Task 1: encodeCwd + session 发现

**Files:**
- Create: `packages/core/src/cc-orchestrator/session-discovery.ts`
- Test: `packages/core/src/cc-orchestrator/session-discovery.test.ts`

- [ ] **Step 1: 写失败测试(encodeCwd)**

```ts
// session-discovery.test.ts
import { describe, it, expect } from "bun:test";
import { encodeCwd } from "./session-discovery.js";

describe("encodeCwd", () => {
  it("replaces each non-alphanumeric char with a dash (incl. leading slash)", () => {
    expect(encodeCwd("/Users/admin/proj")).toBe("-Users-admin-proj");
  });
  it("turns CJK chars into one dash each", () => {
    // 个人学习 = 4 chars, 代码学习 = 4 chars; slashes + dirs per real claude layout
    expect(encodeCwd("/Users/admin/Documents/个人学习/代码学习/codeshell")).toBe(
      "-Users-admin-Documents-----------codeshell",
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/cc-orchestrator/session-discovery.test.ts`
Expected: FAIL（模块/函数不存在）

- [ ] **Step 3: 实现 encodeCwd**

```ts
// session-discovery.ts
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Encode a cwd to claude's project dir name: every non-[A-Za-z0-9] char → '-'.
 *  Mirrors `~/.claude/projects/<encoded>` (verified against real layout). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/cc-orchestrator/session-discovery.test.ts`
Expected: PASS

- [ ] **Step 5: 写 discoverSessions 失败测试(用临时 fixture 目录)**

```ts
// 追加到 session-discovery.test.ts
import { discoverSessions } from "./session-discovery.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("discoverSessions", () => {
  it("lists sessions for a cwd from <claudeHome>/projects/<encoded>/*.jsonl", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
    const cwd = "/tmp/myproj";
    const dir = join(claudeHome, "projects", encodeCwd(cwd));
    mkdirSync(dir, { recursive: true });
    // session with a real user message after a caveat noise line
    const sid = "aaaa1111-2222-3333-4444-555566667777";
    const lines = [
      JSON.stringify({ type: "mode", sessionId: sid }),
      JSON.stringify({ type: "user", sessionId: sid, message: { role: "user", content: "<local-command-caveat>noise" } }),
      JSON.stringify({ type: "user", sessionId: sid, message: { role: "user", content: "Fix the login bug" } }),
      JSON.stringify({ type: "assistant", sessionId: sid, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    ];
    writeFileSync(join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
    const got = discoverSessions(cwd, claudeHome);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe(sid);
    expect(got[0].firstMessage).toBe("Fix the login bug");
    expect(got[0].messageCount).toBe(2); // two user messages (incl. caveat)? -> see impl note
  });

  it("returns [] when the project dir is absent", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
    expect(discoverSessions("/tmp/nope", claudeHome)).toEqual([]);
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd packages/core && bun test src/cc-orchestrator/session-discovery.test.ts`
Expected: FAIL（discoverSessions 未定义）

- [ ] **Step 7: 实现 discoverSessions**

```ts
// session-discovery.ts 追加
export interface DiscoveredSession {
  sessionId: string;
  firstMessage: string;
  lastModified: number;
  messageCount: number;
}

function claudeProjectsDir(claudeHome: string): string {
  return join(claudeHome, "projects");
}

/** Extract first *real* user message text, skipping caveat/command noise. */
function firstUserMessage(lines: string[]): string {
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "user") continue;
    const c = d.message?.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
        : "";
    const t = text.trim();
    if (!t) continue;
    if (t.startsWith("<local-command-caveat>") || t.startsWith("<command-name>")) continue;
    return t.slice(0, 200);
  }
  return "";
}

function countUserMessages(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { if (JSON.parse(line).type === "user") n++; } catch { /* skip */ }
  }
  return n;
}

/** List claude sessions for `cwd`. `claudeHome` defaults to ~/.claude (override
 *  for tests). Read-only, on-demand scan; no index. */
export function discoverSessions(cwd: string, claudeHome = join(homedir(), ".claude")): DiscoveredSession[] {
  const dir = join(claudeProjectsDir(claudeHome), encodeCwd(cwd));
  if (!existsSync(dir)) return [];
  const out: DiscoveredSession[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    let st;
    try { st = statSync(file); } catch { continue; }
    let lines: string[];
    try { lines = readFileSync(file, "utf-8").split("\n"); } catch { continue; }
    out.push({
      sessionId: name.replace(/\.jsonl$/, ""),
      firstMessage: firstUserMessage(lines),
      lastModified: st.mtimeMs,
      messageCount: countUserMessages(lines),
    });
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}
```

> 实现注:`messageCount` 数 `type:"user"` 行（含 caveat 噪声行），fixture 里两条 user 行 → 2。`firstMessage` 跳过噪声取第一条真实消息。

- [ ] **Step 8: 跑测试确认通过**

Run: `cd packages/core && bun test src/cc-orchestrator/session-discovery.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/cc-orchestrator/session-discovery.ts packages/core/src/cc-orchestrator/session-discovery.test.ts
git commit -m "feat(cc-orchestrator): encodeCwd + discoverSessions（读 claude 磁盘 session）"
```

---

## Task 2: AgentAdapter 接口 + claudeAdapter

**Files:**
- Create: `packages/core/src/cc-orchestrator/agent-adapter.ts`
- Test: `packages/core/src/cc-orchestrator/agent-adapter.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// agent-adapter.test.ts
import { describe, it, expect } from "bun:test";
import { claudeAdapter } from "./agent-adapter.js";

describe("claudeAdapter.buildArgs", () => {
  it("always includes -p, stream-json, --verbose; closes nothing here", () => {
    const args = claudeAdapter.buildArgs({ prompt: "hi", permissionMode: "default", cwd: "/x" });
    expect(args).toEqual(["-p", "hi", "--output-format", "stream-json", "--verbose", "--permission-mode", "default"]);
  });
  it("adds --resume <id> when resumeSessionId present", () => {
    const args = claudeAdapter.buildArgs({ prompt: "go", resumeSessionId: "S1", permissionMode: "bypassPermissions", cwd: "/x" });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("S1");
    expect(args).toContain("--verbose");
  });
});

describe("claudeAdapter.parseResult", () => {
  it("extracts sessionId + finalText from the result line", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "S9" }),
      JSON.stringify({ type: "assistant", session_id: "S9", message: { content: [{ type: "text", text: "PONG" }] } }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "S9", result: "PONG", is_error: false }),
    ];
    const r = claudeAdapter.parseResult(lines);
    expect(r.sessionId).toBe("S9");
    expect(r.finalText).toBe("PONG");
    expect(r.isError).toBe(false);
  });
  it("falls back to init session_id when no result line", () => {
    const r = claudeAdapter.parseResult([JSON.stringify({ type: "system", subtype: "init", session_id: "S2" })]);
    expect(r.sessionId).toBe("S2");
    expect(r.finalText).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/cc-orchestrator/agent-adapter.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// agent-adapter.ts
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface BuildArgsOpts {
  prompt: string;
  resumeSessionId?: string;
  permissionMode: PermissionMode;
  cwd: string;
}

export interface ParsedResult {
  sessionId: string;
  finalText: string;
  isError: boolean;
}

export interface AgentAdapter {
  /** Display name, e.g. "claude" / "codex". */
  kind: string;
  /** Build the CLI argv (command itself excluded). */
  buildArgs(opts: BuildArgsOpts): string[];
  /** Reduce collected stream-json output lines to {sessionId, finalText, isError}. */
  parseResult(lines: string[]): ParsedResult;
}

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  buildArgs(opts) {
    // -p (print/headless) + stream-json REQUIRES --verbose (verified).
    const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    args.push("--permission-mode", opts.permissionMode);
    return args;
  },
  parseResult(lines) {
    let sessionId = "";
    let finalText = "";
    let isError = false;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let d: any;
      try { d = JSON.parse(t); } catch { continue; }
      if (typeof d.session_id === "string" && !sessionId) sessionId = d.session_id;
      if (d.type === "result") {
        if (typeof d.session_id === "string") sessionId = d.session_id;
        if (typeof d.result === "string") finalText = d.result;
        isError = Boolean(d.is_error);
      }
    }
    return { sessionId, finalText, isError };
  },
};

/** codex adapter placeholder — interface口子,本版不实现 buildArgs/parseResult. */
// export const codexAdapter: AgentAdapter = { ... }  // 留待后续
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/cc-orchestrator/agent-adapter.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cc-orchestrator/agent-adapter.ts packages/core/src/cc-orchestrator/agent-adapter.test.ts
git commit -m "feat(cc-orchestrator): AgentAdapter 接口 + claudeAdapter（buildArgs/parseResult）"
```

---

## Task 3: CCCapability 探测

**Files:**
- Create: `packages/core/src/cc-orchestrator/cc-capability.ts`
- Test: `packages/core/src/cc-orchestrator/cc-capability.test.ts`

- [ ] **Step 1: 写失败测试（注入式 spawn，避免真跑 claude）**

```ts
// cc-capability.test.ts
import { describe, it, expect } from "bun:test";
import { probeCli } from "./cc-capability.js";

describe("probeCli", () => {
  it("reports available + version when the probe runner resolves a version", async () => {
    const r = await probeCli("claude", async () => ({ ok: true, stdout: "2.1.186 (Claude Code)\n" }));
    expect(r.available).toBe(true);
    expect(r.version).toBe("2.1.186 (Claude Code)");
  });
  it("reports not-found when the runner throws ENOENT", async () => {
    const r = await probeCli("claude", async () => { const e: any = new Error("nope"); e.code = "ENOENT"; throw e; });
    expect(r.available).toBe(false);
    expect(r.reason).toBe("not-found");
  });
  it("reports not-executable on non-ENOENT failure", async () => {
    const r = await probeCli("claude", async () => ({ ok: false, stdout: "" }));
    expect(r.available).toBe(false);
    expect(r.reason).toBe("not-executable");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/cc-orchestrator/cc-capability.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（PATH 修正逻辑从 resident-agent 复用，独立小函数）**

```ts
// cc-capability.ts
import { spawn } from "node:child_process";
import { delimiter } from "node:path";

export interface CCAvailability {
  available: boolean;
  command: string;
  version?: string;
  reason?: "not-found" | "not-executable";
}

/** macOS GUI-launched Electron has a minimal PATH (no Homebrew). Prepend common
 *  CLI dirs so `claude` resolves. Mirrors resident-agent.ts's fix. */
export function pathWithCommonBins(env: NodeJS.ProcessEnv = process.env): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const current = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const merged: string[] = [];
  for (const dir of [...extra, ...current]) if (!merged.includes(dir)) merged.push(dir);
  return merged.join(delimiter);
}

export type ProbeRunner = (command: string) => Promise<{ ok: boolean; stdout: string }>;

/** Default runner: `<command> --version` with PATH fix. */
const defaultRunner: ProbeRunner = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, ["--version"], {
      env: { ...process.env, PATH: pathWithCommonBins() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (c) => (stdout += String(c)));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ ok: code === 0, stdout }));
  });

/** Probe a CLI's availability. Injectable runner for tests. */
export async function probeCli(command: string, runner: ProbeRunner = defaultRunner): Promise<CCAvailability> {
  try {
    const { ok, stdout } = await runner(command);
    if (!ok) return { available: false, command, reason: "not-executable" };
    return { available: true, command, version: stdout.trim() || undefined };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { available: false, command, reason: code === "ENOENT" ? "not-found" : "not-executable" };
  }
}

let cached: CCAvailability | undefined;
/** Cached probe; pass force=true to re-detect (user installed CLI mid-session). */
export async function probeClaudeCli(force = false): Promise<CCAvailability> {
  if (cached && !force) return cached;
  cached = await probeCli("claude");
  return cached;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/cc-orchestrator/cc-capability.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cc-orchestrator/cc-capability.ts packages/core/src/cc-orchestrator/cc-capability.test.ts
git commit -m "feat(cc-orchestrator): probeClaudeCli 探测 + PATH 修正 + 缓存/重测"
```

---

## Task 4: ExternalAgentDriver（headless 跑一轮）

**Files:**
- Create: `packages/core/src/cc-orchestrator/external-agent-driver.ts`
- Test: `packages/core/src/cc-orchestrator/external-agent-driver.test.ts`

- [ ] **Step 1: 写失败测试（用 stub spawn，喂录制的 stream-json 行）**

```ts
// external-agent-driver.test.ts
import { describe, it, expect } from "bun:test";
import { runWithLines } from "./external-agent-driver.js";
import { claudeAdapter } from "./agent-adapter.js";

describe("runWithLines（纯解析路径，无子进程）", () => {
  it("returns sessionId + finalText from collected lines", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "S1" }),
      JSON.stringify({ type: "assistant", session_id: "S1", message: { content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "S1", result: "done", is_error: false }),
    ];
    const r = runWithLines(claudeAdapter, lines, 0);
    expect(r.sessionId).toBe("S1");
    expect(r.finalText).toBe("done");
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/cc-orchestrator/external-agent-driver.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（拆出纯函数 runWithLines + spawn 包装 run）**

```ts
// external-agent-driver.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAdapter, BuildArgsOpts, PermissionMode } from "./agent-adapter.js";
import { pathWithCommonBins } from "./cc-capability.js";

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  isError: boolean;
  exitCode: number | null;
  lines: string[];
}

/** Pure: reduce collected output lines + exit code to a result. Unit-testable. */
export function runWithLines(adapter: AgentAdapter, lines: string[], exitCode: number | null): AgentRunResult {
  const parsed = adapter.parseResult(lines);
  return { ...parsed, exitCode, lines };
}

export interface DriverRunOpts extends Omit<BuildArgsOpts, "permissionMode"> {
  permissionMode?: PermissionMode;
}

/** Spawn ONE headless agent run, collect stream-json to exit, return result.
 *  No time concept — a single turn. Honors AbortSignal (kills the child). */
export function runAgentOnce(
  adapter: AgentAdapter,
  opts: DriverRunOpts & { command: string },
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const args = adapter.buildArgs({
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      permissionMode: opts.permissionMode ?? "default",
      cwd: opts.cwd,
    });
    const child = spawn(opts.command, args, {
      cwd: opts.cwd,
      env: { ...process.env, PATH: pathWithCommonBins() },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"], // close stdin (verified: avoids 3s wait)
    });
    const lines: string[] = [];
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => lines.push(line));
    }
    const onAbort = () => {
      if (child.pid && child.pid > 1) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(runWithLines(adapter, lines, code));
    });
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/cc-orchestrator/external-agent-driver.test.ts`
Expected: PASS

- [ ] **Step 5: 写集成测试（真跑 claude，带跳过守卫，避免 CI 无 CLI 时失败）**

```ts
// 追加到 external-agent-driver.test.ts
import { runAgentOnce } from "./external-agent-driver.js";
import { claudeAdapter as adp } from "./agent-adapter.js";
import { probeCli } from "./cc-capability.js";

describe("runAgentOnce（真机集成,无 CLI 自动跳过）", () => {
  it("spawns claude and returns a sessionId + final text", async () => {
    const avail = await probeCli("claude");
    if (!avail.available) { console.log("claude 未安装,跳过集成测试"); return; }
    const r = await runAgentOnce(adp, { command: "claude", prompt: "Reply with exactly: PONG", permissionMode: "bypassPermissions", cwd: process.cwd() });
    expect(r.sessionId.length).toBeGreaterThan(0);
    expect(r.finalText.toUpperCase()).toContain("PONG");
  }, 90_000);
});
```

- [ ] **Step 6: 跑测试确认通过（或本机有 CLI 时真跑）**

Run: `cd packages/core && bun test src/cc-orchestrator/external-agent-driver.test.ts`
Expected: PASS（纯测试 + 集成测试本机真跑 PONG）

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/cc-orchestrator/external-agent-driver.ts packages/core/src/cc-orchestrator/external-agent-driver.test.ts
git commit -m "feat(cc-orchestrator): ExternalAgentDriver headless 跑一轮（spawn/resume/abort）"
```

---

## Task 5: RelevanceJudge（续/新/停裁决）

**Files:**
- Create: `packages/core/src/cc-orchestrator/relevance-judge.ts`
- Test: `packages/core/src/cc-orchestrator/relevance-judge.test.ts`

- [ ] **Step 1: 写失败测试（注入式 LLM 调用，测 prompt 构造 + 解析）**

```ts
// relevance-judge.test.ts
import { describe, it, expect } from "bun:test";
import { judgeContinuation, parseJudgeResponse } from "./relevance-judge.js";

describe("parseJudgeResponse", () => {
  it("parses a stop decision", () => {
    const d = parseJudgeResponse('{"action":"stop","reason":"goal met"}');
    expect(d.action).toBe("stop");
  });
  it("parses continue-fresh with handoff summary", () => {
    const d = parseJudgeResponse('{"action":"continue-fresh","handoffSummary":"prev built X","reason":"unrelated next step"}');
    expect(d.action).toBe("continue-fresh");
    expect(d.handoffSummary).toBe("prev built X");
  });
  it("defaults to continue-same on unparseable output", () => {
    const d = parseJudgeResponse("garbage");
    expect(d.action).toBe("continue-same");
  });
});

describe("judgeContinuation", () => {
  it("calls the injected aux LLM with goal + lastResult + nextPrompt and returns parsed decision", async () => {
    let seenPrompt = "";
    const fakeLlm = async (prompt: string) => { seenPrompt = prompt; return '{"action":"stop","reason":"done"}'; };
    const d = await judgeContinuation({ goal: "all tests pass", lastResult: "tests green", nextPrompt: "rerun" }, fakeLlm);
    expect(d.action).toBe("stop");
    expect(seenPrompt).toContain("all tests pass");
    expect(seenPrompt).toContain("tests green");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/cc-orchestrator/relevance-judge.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// relevance-judge.ts
export interface JudgeDecision {
  action: "continue-same" | "continue-fresh" | "stop";
  handoffSummary?: string;
  reason: string;
}

export interface JudgeInput {
  goal?: string;
  lastResult: string;
  nextPrompt: string;
}

/** Injected aux-model call: takes a prompt, returns raw text. */
export type AuxLlm = (prompt: string) => Promise<string>;

const SYSTEM = `You decide how a scheduled task loop should continue after one run.
Reply with ONLY a JSON object: {"action": "continue-same"|"continue-fresh"|"stop", "handoffSummary"?: string, "reason": string}.
- "stop": the goal is met; no more runs needed.
- "continue-same": next run should resume the SAME session (work is related, keep context).
- "continue-fresh": next run should start a FRESH session because the next step is unrelated to what was just done; put a short context summary in handoffSummary.`;

export function buildJudgePrompt(input: JudgeInput): string {
  return [
    SYSTEM,
    input.goal ? `\nOverall goal: ${input.goal}` : "",
    `\nWhat the last run produced:\n${input.lastResult.slice(0, 4000)}`,
    `\nThe next scheduled prompt:\n${input.nextPrompt}`,
    `\nDecision JSON:`,
  ].join("\n");
}

export function parseJudgeResponse(raw: string): JudgeDecision {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const d = JSON.parse(m ? m[0] : raw);
    if (d.action === "stop" || d.action === "continue-fresh" || d.action === "continue-same") {
      return { action: d.action, handoffSummary: typeof d.handoffSummary === "string" ? d.handoffSummary : undefined, reason: typeof d.reason === "string" ? d.reason : "" };
    }
  } catch { /* fall through */ }
  return { action: "continue-same", reason: "unparseable judge output; defaulting to continue-same" };
}

export async function judgeContinuation(input: JudgeInput, llm: AuxLlm): Promise<JudgeDecision> {
  const raw = await llm(buildJudgePrompt(input));
  return parseJudgeResponse(raw);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/cc-orchestrator/relevance-judge.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cc-orchestrator/relevance-judge.ts packages/core/src/cc-orchestrator/relevance-judge.test.ts
git commit -m "feat(cc-orchestrator): RelevanceJudge 续/新/停裁决（aux LLM 注入式）"
```

---

## Task 6: CC 任务 side-store（continuation/goal/sessionId）

**Files:**
- Create: `packages/core/src/cc-orchestrator/cc-task-store.ts`
- Test: `packages/core/src/cc-orchestrator/cc-task-store.test.ts`

> `CronJob`/`CronStore` 不含 continuation/goal/sessionId/kind 这些 CC 特有字段。用一个轻量 side-store（按 jobId 索引）配对存这些，与 CronStore 同目录。

- [ ] **Step 1: 写失败测试**

```ts
// cc-task-store.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCTaskStore } from "./cc-task-store.js";

describe("CCTaskStore", () => {
  it("round-trips CC task meta by jobId", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-task-")), "cc-tasks.json");
    const store = new CCTaskStore(file);
    store.set("job1", { kind: "loop", goal: "ship it", continuation: "auto", sessionId: undefined });
    const got = store.get("job1");
    expect(got?.kind).toBe("loop");
    expect(got?.continuation).toBe("auto");
    // new instance reads from disk
    expect(new CCTaskStore(file).get("job1")?.goal).toBe("ship it");
  });
  it("updates sessionId (judge picked fresh / run回写)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-task-")), "cc-tasks.json");
    const store = new CCTaskStore(file);
    store.set("j", { kind: "once", continuation: "always-fresh" });
    store.patch("j", { sessionId: "S5" });
    expect(store.get("j")?.sessionId).toBe("S5");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/cc-orchestrator/cc-task-store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// cc-task-store.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Continuation = "auto" | "always-resume" | "always-fresh";

export interface CCTaskMeta {
  kind: "once" | "loop";
  continuation: Continuation;
  goal?: string;
  sessionId?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
}

export function defaultCCTaskStorePath(): string {
  return join(homedir(), ".code-shell", "cc-tasks.json");
}

interface Snapshot { version: 1; tasks: Record<string, CCTaskMeta>; }

/** Side-store for CC-specific task metadata, keyed by CronJob id. */
export class CCTaskStore {
  private readonly file: string;
  constructor(file?: string) { this.file = file ?? defaultCCTaskStorePath(); }

  private read(): Record<string, CCTaskMeta> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Snapshot;
      return parsed?.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {};
    } catch { return {}; }
  }
  private write(tasks: Record<string, CCTaskMeta>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, tasks } satisfies Snapshot, null, 2));
    renameSync(tmp, this.file);
  }
  get(jobId: string): CCTaskMeta | undefined { return this.read()[jobId]; }
  set(jobId: string, meta: CCTaskMeta): void { const all = this.read(); all[jobId] = meta; this.write(all); }
  patch(jobId: string, patch: Partial<CCTaskMeta>): void {
    const all = this.read();
    all[jobId] = { ...(all[jobId] ?? { kind: "once", continuation: "auto" }), ...patch };
    this.write(all);
  }
  delete(jobId: string): void { const all = this.read(); delete all[jobId]; this.write(all); }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/cc-orchestrator/cc-task-store.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cc-orchestrator/cc-task-store.ts packages/core/src/cc-orchestrator/cc-task-store.test.ts
git commit -m "feat(cc-orchestrator): CCTaskStore side-store（continuation/goal/sessionId）"
```

---

## Task 7: 调度绑定（CronScheduler executor → driver + 裁判 + 回写）

**Files:**
- Create: `packages/core/src/cc-orchestrator/cc-scheduler-binding.ts`
- Test: `packages/core/src/cc-orchestrator/cc-scheduler-binding.test.ts`

> 这是核心编排：CronScheduler 到点 → executor 决定 session（按 continuation）→ 跑一轮 → 回写 sessionId → loop+auto 时调裁判决定续/新/停（stop 则禁用 job）。driver 用注入式（测试不真跑 claude）。

- [ ] **Step 1: 写失败测试**

```ts
// cc-scheduler-binding.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler } from "../automation/scheduler.js";
import { CCTaskStore } from "./cc-task-store.js";
import { runCCTask } from "./cc-scheduler-binding.js";

function tmpStore() { return new CCTaskStore(join(mkdtempSync(join(tmpdir(), "ccsb-")), "t.json")); }

describe("runCCTask", () => {
  it("always-fresh: 不传 resumeSessionId,回写新 sessionId", async () => {
    const store = tmpStore();
    store.set("j", { kind: "once", continuation: "always-fresh" });
    let sawResume: string | undefined = "SENTINEL";
    const runner = async (o: any) => { sawResume = o.resumeSessionId; return { sessionId: "NEW1", finalText: "ok", isError: false, exitCode: 0, lines: [] }; };
    await runCCTask({ jobId: "j", prompt: "do", cwd: "/x", store, runner, judge: async () => ({ action: "stop", reason: "" }), scheduler: new CronScheduler() });
    expect(sawResume).toBeUndefined();
    expect(store.get("j")?.sessionId).toBe("NEW1");
  });

  it("always-resume: 传已存 sessionId", async () => {
    const store = tmpStore();
    store.set("j", { kind: "once", continuation: "always-resume", sessionId: "OLD" });
    let sawResume: string | undefined;
    const runner = async (o: any) => { sawResume = o.resumeSessionId; return { sessionId: "OLD", finalText: "ok", isError: false, exitCode: 0, lines: [] }; };
    await runCCTask({ jobId: "j", prompt: "do", cwd: "/x", store, runner, judge: async () => ({ action: "continue-same", reason: "" }), scheduler: new CronScheduler() });
    expect(sawResume).toBe("OLD");
  });

  it("loop+auto+judge=continue-fresh: 清空 sessionId 供下轮开新,并存 handoff", async () => {
    const store = tmpStore();
    store.set("j", { kind: "loop", continuation: "auto", sessionId: "S1", goal: "g" });
    const runner = async () => ({ sessionId: "S1", finalText: "built X", isError: false, exitCode: 0, lines: [] });
    const judge = async () => ({ action: "continue-fresh" as const, handoffSummary: "did X", reason: "unrelated" });
    await runCCTask({ jobId: "j", prompt: "next", cwd: "/x", store, runner, judge, scheduler: new CronScheduler() });
    expect(store.get("j")?.sessionId).toBeUndefined();      // 下轮开新
    expect(store.get("j")?.handoffSummary).toBe("did X");   // 注入下轮 prompt 前缀
  });

  it("loop+auto+judge=stop: 禁用 job", async () => {
    const store = tmpStore();
    store.set("j", { kind: "loop", continuation: "auto", sessionId: "S1", goal: "g" });
    const scheduler = new CronScheduler();
    const created = scheduler.create("j-name", "30m", "next", { cwd: "/x" });
    store.set(created.id, { kind: "loop", continuation: "auto", sessionId: "S1", goal: "g" });
    const runner = async () => ({ sessionId: "S1", finalText: "all green", isError: false, exitCode: 0, lines: [] });
    const judge = async () => ({ action: "stop" as const, reason: "goal met" });
    await runCCTask({ jobId: created.id, prompt: "next", cwd: "/x", store, runner, judge, scheduler });
    expect(scheduler.get(created.id)?.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/cc-orchestrator/cc-scheduler-binding.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（先确认 CronScheduler 有 get/setEnabled，没有则用现有 pause/update）**

> 实现前 grep `packages/core/src/automation/scheduler.ts` 确认禁用 job 的方法名（如 `pause(id)` / `update(id,{enabled:false})` / `setEnabled`）。下面用 `pause`，若实际不同改为实际方法。

```ts
// cc-scheduler-binding.ts
import type { CronScheduler } from "../automation/scheduler.js";
import type { CCTaskStore, CCTaskMeta } from "./cc-task-store.js";
import type { JudgeDecision, JudgeInput } from "./relevance-judge.js";
import type { AgentRunResult } from "./external-agent-driver.js";

// CCTaskMeta 扩展一个 handoffSummary 字段（下轮 prompt 前缀）。在 cc-task-store.ts 的
// CCTaskMeta 接口加： handoffSummary?: string;  （Task 6 已建表，这里补字段）

export type CCRunner = (opts: { prompt: string; resumeSessionId?: string; cwd: string; permissionMode?: CCTaskMeta["permissionMode"] }) => Promise<AgentRunResult>;
export type CCJudge = (input: JudgeInput) => Promise<JudgeDecision>;

export interface RunCCTaskDeps {
  jobId: string;
  prompt: string;
  cwd: string;
  store: CCTaskStore;
  runner: CCRunner;
  judge: CCJudge;
  scheduler: CronScheduler;
}

/** Execute ONE scheduled CC task run: pick session by continuation, run, write
 *  back sessionId, then (loop+auto only) judge continue/fresh/stop. */
export async function runCCTask(deps: RunCCTaskDeps): Promise<void> {
  const { jobId, cwd, store, runner, judge, scheduler } = deps;
  const meta = store.get(jobId) ?? { kind: "once", continuation: "auto" };

  // 1. choose session
  const resumeSessionId =
    meta.continuation === "always-fresh" ? undefined : meta.sessionId;

  // 2. inject handoff summary as prompt prefix if a prior fresh decision left one
  const prompt = meta.handoffSummary ? `${meta.handoffSummary}\n\n${deps.prompt}` : deps.prompt;

  // 3. run one turn
  const result = await runner({ prompt, resumeSessionId, cwd, permissionMode: meta.permissionMode });

  // 4. write back sessionId; clear consumed handoff
  store.patch(jobId, { sessionId: result.sessionId || meta.sessionId, handoffSummary: undefined });

  // 5. once → done (scheduler 一次性 job 跑完自然不再 arm；显式 pause 防再触发)
  if (meta.kind === "once") { scheduler.pause(jobId); return; }

  // 6. loop: only "auto" consults the judge
  if (meta.continuation !== "auto") return;
  const decision = await judge({ goal: meta.goal, lastResult: result.finalText, nextPrompt: deps.prompt });
  if (decision.action === "stop") { scheduler.pause(jobId); return; }
  if (decision.action === "continue-fresh") {
    store.patch(jobId, { sessionId: undefined, handoffSummary: decision.handoffSummary });
  }
  // continue-same: keep sessionId as written in step 4
}
```

> CCTaskMeta 需加 `handoffSummary?: string`（编辑 Task 6 的 `cc-task-store.ts`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/cc-orchestrator/cc-scheduler-binding.test.ts`
Expected: PASS（4 tests）。若 `scheduler.pause`/`get` 方法名不符，改用实际 API 并更新测试。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cc-orchestrator/cc-scheduler-binding.ts packages/core/src/cc-orchestrator/cc-scheduler-binding.test.ts packages/core/src/cc-orchestrator/cc-task-store.ts
git commit -m "feat(cc-orchestrator): 调度 executor 绑定 driver+裁判（续/新/停+sessionId回写+handoff注入）"
```

---

## Task 8: 模块导出 index + 两个工具

**Files:**
- Create: `packages/core/src/cc-orchestrator/index.ts`
- Create: `packages/core/src/tool-system/builtin/drive-claude-code.ts`
- Create: `packages/core/src/tool-system/builtin/schedule-room-task.ts`
- Test: `packages/core/src/tool-system/builtin/drive-claude-code.test.ts`

- [ ] **Step 1: 写 index.ts（纯导出，无测试）**

```ts
// cc-orchestrator/index.ts
export * from "./cc-capability.js";
export * from "./agent-adapter.js";
export * from "./external-agent-driver.js";
export * from "./session-discovery.js";
export * from "./relevance-judge.js";
export * from "./cc-task-store.js";
export * from "./cc-scheduler-binding.js";
```

- [ ] **Step 2: 写 DriveClaudeCode 工具失败测试（注入式 runner）**

```ts
// drive-claude-code.test.ts
import { describe, it, expect } from "bun:test";
import { driveClaudeCodeToolDef, makeDriveClaudeCodeTool } from "./drive-claude-code.js";

describe("DriveClaudeCode tool", () => {
  it("has a name and an inputSchema with prompt", () => {
    expect(driveClaudeCodeToolDef.name).toBe("DriveClaudeCode");
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.prompt).toBeDefined();
  });
  it("runs one turn and reports sessionId + finalText", async () => {
    const tool = makeDriveClaudeCodeTool(async (o) => ({ sessionId: "S7", finalText: "did it", isError: false, exitCode: 0, lines: [] }));
    const out = await tool({ prompt: "go", cwd: "/x" });
    expect(out).toContain("S7");
    expect(out).toContain("did it");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/drive-claude-code.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现 DriveClaudeCode 工具**

```ts
// drive-claude-code.ts
import type { ToolDefinition } from "../../types.js";
import { runAgentOnce } from "../../cc-orchestrator/external-agent-driver.js";
import { claudeAdapter } from "../../cc-orchestrator/agent-adapter.js";
import type { AgentRunResult } from "../../cc-orchestrator/external-agent-driver.js";

export const driveClaudeCodeToolDef: ToolDefinition = {
  name: "DriveClaudeCode",
  description:
    "Run the external Claude Code CLI for ONE turn and return its final text + session id. " +
    "Use to delegate a coding task to Claude Code, or to continue an existing CC session. " +
    "This runs ONE turn then exits — it has NO time concept. For 'in N minutes' / 'every N' / " +
    "looping, use ScheduleRoomTask instead (never sleep). " +
    "To make this single turn work longer/deeper, write that into `prompt` (e.g. 'keep working " +
    "until everything is done'); to have the turn self-loop until a condition holds, embed a goal " +
    "directive in `prompt` such as '/goal all tests pass'. Pass `resumeSessionId` to continue a " +
    "prior CC session (keeps its context); omit it to start fresh.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The task/prompt to give Claude Code this turn." },
      resumeSessionId: { type: "string", description: "Existing CC session id to resume (keeps context). Omit for a fresh session." },
      cwd: { type: "string", description: "Working directory the CC run operates in." },
      permissionMode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions"], description: "CC permission mode for this run. Default 'default'." },
    },
    required: ["prompt", "cwd"],
  },
};

type Runner = (opts: { prompt: string; resumeSessionId?: string; cwd: string; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" }) => Promise<AgentRunResult>;

const defaultRunner: Runner = (opts) =>
  runAgentOnce(claudeAdapter, { command: "claude", prompt: opts.prompt, resumeSessionId: opts.resumeSessionId, cwd: opts.cwd, permissionMode: opts.permissionMode ?? "default" });

/** Factory so tests can inject a fake runner. */
export function makeDriveClaudeCodeTool(runner: Runner = defaultRunner) {
  return async (args: Record<string, unknown>): Promise<string> => {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
    if (!prompt) return "Error: prompt is required";
    const resumeSessionId = typeof args.resumeSessionId === "string" ? args.resumeSessionId : undefined;
    const permissionMode = (args.permissionMode === "acceptEdits" || args.permissionMode === "bypassPermissions") ? args.permissionMode : "default";
    const r = await runner({ prompt, resumeSessionId, cwd, permissionMode });
    if (r.isError) return `Claude Code 运行出错（session ${r.sessionId}）：\n${r.finalText}`;
    return `Claude Code 完成（session ${r.sessionId}）：\n${r.finalText}`;
  };
}

export const driveClaudeCodeTool = makeDriveClaudeCodeTool();
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/drive-claude-code.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 6: 写 ScheduleRoomTask 工具（复用 cronScheduler 单例 + CCTaskStore）失败测试**

```ts
// schedule-room-task.test.ts
import { describe, it, expect } from "bun:test";
import { scheduleRoomTaskToolDef } from "./schedule-room-task.js";

describe("ScheduleRoomTask tool", () => {
  it("declares schedule/kind/prompt schema", () => {
    expect(scheduleRoomTaskToolDef.name).toBe("ScheduleRoomTask");
    const p = (scheduleRoomTaskToolDef.inputSchema as any).properties;
    expect(p.schedule).toBeDefined();
    expect(p.kind).toBeDefined();
    expect(p.continuation).toBeDefined();
  });
});
```

- [ ] **Step 7: 跑测试确认失败 → 实现 ScheduleRoomTask**

```ts
// schedule-room-task.ts
import type { ToolDefinition } from "../../types.js";
import { cronScheduler } from "../../automation/scheduler.js";
import { CCTaskStore } from "../../cc-orchestrator/cc-task-store.js";

export const scheduleRoomTaskToolDef: ToolDefinition = {
  name: "ScheduleRoomTask",
  description:
    "Schedule a task to drive Claude Code later or repeatedly. Use for 'in N minutes/hours', " +
    "'at <time>', 'every N', or a looping goal — the room timer fires it (NEVER sleep in a turn). " +
    "schedule: interval ('10m','2h','1d') or 5-field cron ('0 9 * * 1-5'). kind: 'once' (one-shot) " +
    "or 'loop' (repeats; set `goal` so the relevance judge can stop it when met). continuation: " +
    "'auto' (judge decides resume-same vs fresh-session per run; default), 'always-resume' (keep " +
    "one session), 'always-fresh' (new session each run).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short name for the task." },
      schedule: { type: "string", description: "Interval ('10m','2h') or 5-field cron expression." },
      kind: { type: "string", enum: ["once", "loop"], description: "'once' or 'loop'." },
      prompt: { type: "string", description: "The prompt to give Claude Code each run." },
      cwd: { type: "string", description: "Project working directory." },
      goal: { type: "string", description: "loop only: overall goal; judge stops the loop when met." },
      continuation: { type: "string", enum: ["auto", "always-resume", "always-fresh"], description: "Session strategy. Default 'auto'." },
      permissionMode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions"] },
    },
    required: ["name", "schedule", "kind", "prompt", "cwd"],
  },
};

export async function scheduleRoomTaskTool(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? "");
  const schedule = String(args.schedule ?? "");
  const prompt = String(args.prompt ?? "");
  const cwd = String(args.cwd ?? "");
  const kind = args.kind === "loop" ? "loop" : "once";
  if (!name || !schedule || !prompt || !cwd) return "Error: name, schedule, prompt, cwd are required";
  const continuation = (args.continuation === "always-resume" || args.continuation === "always-fresh") ? args.continuation : "auto";
  const permissionMode = (args.permissionMode === "acceptEdits" || args.permissionMode === "bypassPermissions") ? args.permissionMode : "default";
  const job = cronScheduler.create(name, schedule, prompt, { cwd });
  new CCTaskStore().set(job.id, { kind, continuation, goal: typeof args.goal === "string" ? args.goal : undefined, permissionMode });
  return `已安排任务「${name}」（${kind}，${schedule}，continuation=${continuation}），id=${job.id}`;
}
```

- [ ] **Step 8: 跑测试确认通过 + 注册两工具进 builtin registry**

> grep `packages/core/src/tool-system/registry.ts` 的 `registerBuiltins` 找到 builtin 工具表（cron 工具如何登记），照同样方式登记 `driveClaudeCodeToolDef`/`driveClaudeCodeTool` 与 `scheduleRoomTaskToolDef`/`scheduleRoomTaskTool`。模仿 cron.ts 的登记点。

Run: `cd packages/core && bun test src/tool-system/builtin/drive-claude-code.test.ts src/tool-system/builtin/schedule-room-task.test.ts`
Expected: PASS

- [ ] **Step 9: 全量 core 测试 + tsc**

Run: `cd packages/core && bun test src/cc-orchestrator/ && bunx tsc --noEmit`
Expected: 全绿，0 tsc 错

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/cc-orchestrator/index.ts packages/core/src/tool-system/builtin/drive-claude-code.ts packages/core/src/tool-system/builtin/drive-claude-code.test.ts packages/core/src/tool-system/builtin/schedule-room-task.ts packages/core/src/tool-system/builtin/schedule-room-task.test.ts packages/core/src/tool-system/registry.ts
git commit -m "feat(cc-orchestrator): index 导出 + DriveClaudeCode/ScheduleRoomTask 工具并注册"
```

---

## Task 9: 后台模式接入 backgroundJobRegistry

**Files:**
- Modify: `packages/core/src/tool-system/builtin/drive-claude-code.ts`
- Test: `packages/core/src/tool-system/builtin/drive-claude-code.test.ts`（追加）

> 后台 CC = DriveClaudeCode 的 `background:true` 分支：注册进 backgroundJobRegistry，立即返回 jobId，进程退出时 finish（走现有通知唤醒通道，不新建机制）。

- [ ] **Step 1: 追加失败测试**

```ts
// 追加到 drive-claude-code.test.ts
import { backgroundJobRegistry } from "./background-jobs.js";
import { makeDriveClaudeCodeTool as mk } from "./drive-claude-code.js";

describe("DriveClaudeCode background mode", () => {
  it("registers a background job and finishes it on completion", async () => {
    backgroundJobRegistry.reset?.();
    let resolveRun: (r: any) => void;
    const runner = () => new Promise<any>((res) => { resolveRun = res; });
    const tool = mk(runner as any);
    const p = tool({ prompt: "long job", cwd: "/x", background: true, __sessionId: "SESS" } as any);
    const out = await p; // background returns immediately with a jobId
    expect(out).toContain("后台");
    expect(backgroundJobRegistry.hasRunningForSession("SESS")).toBe(true);
    // complete the underlying run
    resolveRun!({ sessionId: "S8", finalText: "done", isError: false, exitCode: 0, lines: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(backgroundJobRegistry.hasRunningForSession("SESS")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑确认失败 → 实现 background 分支**

> 在 `makeDriveClaudeCodeTool` 的返回函数里：若 `args.background === true`，生成 jobId，调 `backgroundJobRegistry.start(jobId, sessionId, "DriveClaudeCode: "+prompt.slice(0,40))`，不 await runner，而是 `.then`/`.finally` 里 `backgroundJobRegistry.finish(jobId)`，立即返回 `已在后台启动（jobId）`。`__sessionId` 由执行器上下文注入（grep 其他工具如何拿到当前 sessionId，如 generate-video.ts 的后台注册方式，照搬）。inputSchema 增加 `background: {type:"boolean"}` 属性，描述写明"后台跑,完成会通知唤醒你,别 sleep 轮询"。

```ts
// drive-claude-code.ts 内,返回函数顶部分支(伪示意,按 generate-video.ts 拿 sessionId 的真实方式对齐)
import { backgroundJobRegistry } from "./background-jobs.js";

// inputSchema.properties 追加：
//   background: { type: "boolean", description: "在后台运行;完成会通知唤醒你,不要 sleep 轮询。" }

// 返回函数内：
if (args.background === true) {
  const sessionId = typeof args.__sessionId === "string" ? args.__sessionId : "";
  const jobId = `cc-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  backgroundJobRegistry.start(jobId, sessionId, `DriveClaudeCode: ${prompt.slice(0, 40)}`);
  void runner({ prompt, resumeSessionId, cwd, permissionMode })
    .catch(() => undefined)
    .finally(() => backgroundJobRegistry.finish(jobId));
  return `已在后台启动 Claude Code（jobId ${jobId}）。完成时会通知你。`;
}
```

> ⚠️ 真实拿 sessionId 的方式：grep `generate-video.ts` 看后台工具如何从执行上下文取当前 sessionId（可能通过 executor 注入的 context 而非 args.__sessionId）。按实际范式接，别引入 args 隐藏字段。

- [ ] **Step 3: 跑测试确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/drive-claude-code.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/tool-system/builtin/drive-claude-code.ts packages/core/src/tool-system/builtin/drive-claude-code.test.ts
git commit -m "feat(cc-orchestrator): DriveClaudeCode 后台模式接入 backgroundJobRegistry（复用通知唤醒）"
```

---

## Task 10: 调度执行器接线到 cronScheduler 单例

**Files:**
- Modify: 在 desktop 主进程启动处接线（grep `startAutomation` / `cronScheduler.setExecutor` 调用点）
- Create/Modify: `packages/core/src/cc-orchestrator/cc-scheduler-binding.ts`（加 `installCCExecutor`）
- Test: `packages/core/src/cc-orchestrator/cc-scheduler-binding.test.ts`（追加）

> 现在调度的 executor 仍指向 RunManager（automation）。CC 任务的 job 也在同一个 cronScheduler 单例里，需要让 executor 区分：有 CCTaskStore 元数据的 job 走 `runCCTask`，否则走原 automation executor。最干净做法：executor 先查 CCTaskStore.get(job.id),命中则走 CC 路径。

- [ ] **Step 1: 追加失败测试（executor 分流）**

```ts
// 追加到 cc-scheduler-binding.test.ts
import { makeCCAwareExecutor } from "./cc-scheduler-binding.js";

describe("makeCCAwareExecutor", () => {
  it("routes CC jobs (has meta) to the CC runner, others to the fallback", async () => {
    const store = tmpStore();
    store.set("ccjob", { kind: "once", continuation: "always-fresh" });
    let ccRan = false, fallbackRan = false;
    const exec = makeCCAwareExecutor({
      store,
      runner: async () => { ccRan = true; return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] }; },
      judge: async () => ({ action: "stop", reason: "" }),
      scheduler: new CronScheduler(),
      fallback: async () => { fallbackRan = true; },
    });
    await exec({ id: "ccjob", name: "", schedule: "1h", prompt: "p", enabled: true, runCount: 0, createdAt: 0, cwd: "/x" } as any, new AbortController().signal);
    expect(ccRan).toBe(true); expect(fallbackRan).toBe(false);
    await exec({ id: "other", name: "", schedule: "1h", prompt: "p", enabled: true, runCount: 0, createdAt: 0 } as any, new AbortController().signal);
    expect(fallbackRan).toBe(true);
  });
});
```

- [ ] **Step 2: 跑确认失败 → 实现 makeCCAwareExecutor**

```ts
// cc-scheduler-binding.ts 追加
import type { CronJob } from "../automation/scheduler.js";

export interface CCExecutorDeps {
  store: CCTaskStore;
  runner: CCRunner;
  judge: CCJudge;
  scheduler: CronScheduler;
  /** Original automation executor for non-CC jobs (e.g. RunManager path). */
  fallback: (job: CronJob, signal: AbortSignal) => Promise<void>;
}

/** Build a scheduler executor that routes jobs with CC metadata to runCCTask,
 *  and everything else to the existing automation fallback. */
export function makeCCAwareExecutor(deps: CCExecutorDeps) {
  return async (job: CronJob, signal: AbortSignal): Promise<void> => {
    if (deps.store.get(job.id)) {
      await runCCTask({ jobId: job.id, prompt: job.prompt, cwd: job.cwd ?? process.cwd(), store: deps.store, runner: deps.runner, judge: deps.judge, scheduler: deps.scheduler });
      return;
    }
    await deps.fallback(job, signal);
  };
}
```

- [ ] **Step 3: 跑测试确认通过**

Run: `cd packages/core && bun test src/cc-orchestrator/cc-scheduler-binding.test.ts`
Expected: PASS

- [ ] **Step 4: 接线到 desktop 启动（grep cronScheduler.setExecutor / bindCronToRunManager 调用点）**

> 在 desktop 主进程接线处，用 `makeCCAwareExecutor` 包裹原 executor：runner=真 driver（`runAgentOnce(claudeAdapter,...)` 包装）、judge=aux LLM 包装（用现有 aux model 调用范式，grep goal-stop hook 如何拿 aux model）、fallback=原 automation executor。`signal` 透传给 runner（driver 接 abort）。

- [ ] **Step 5: tsc + 提交**

Run: `cd packages/core && bunx tsc --noEmit`
Expected: 0 错

```bash
git add packages/core/src/cc-orchestrator/cc-scheduler-binding.ts packages/core/src/cc-orchestrator/cc-scheduler-binding.test.ts <desktop 接线文件>
git commit -m "feat(cc-orchestrator): CC-aware 调度 executor 分流（CC job → driver+裁判, 其余 → automation）"
```

---

## Task 11: desktop IPC 桥

**Files:**
- Create: `packages/desktop/src/main/cc-room/cc-room-ipc.ts`
- Modify: `packages/desktop/src/main/index.ts`（注册 IPC）
- Modify: `packages/desktop/src/preload/index.ts`（暴露 `window.codeshell.ccRoom`）

- [ ] **Step 1: 实现 IPC handlers**

```ts
// cc-room-ipc.ts
import { ipcMain } from "electron";
import { probeClaudeCli } from "@cjhyy/code-shell-core";
import { discoverSessions } from "@cjhyy/code-shell-core";
import { CCTaskStore } from "@cjhyy/code-shell-core";
import { cronScheduler } from "@cjhyy/code-shell-core";

// 注：上述 import 路径以 core 实际 barrel 导出为准；若 core 主 index 未 re-export
// cc-orchestrator,先在 packages/core/src/index.ts 加 `export * from "./cc-orchestrator/index.js";`

export function registerCCRoomIpc(): void {
  ipcMain.handle("ccRoom:probe", async (_e, force?: boolean) => probeClaudeCli(force ?? false));
  ipcMain.handle("ccRoom:listSessions", async (_e, cwd: string) => discoverSessions(cwd));
  ipcMain.handle("ccRoom:listTasks", async () => {
    const store = new CCTaskStore();
    return cronScheduler.list().filter((j) => store.get(j.id)).map((j) => ({ job: j, meta: store.get(j.id) }));
  });
  ipcMain.handle("ccRoom:deleteTask", async (_e, jobId: string) => {
    cronScheduler.delete(jobId);
    new CCTaskStore().delete(jobId);
    return true;
  });
}
```

> grep core 的 `packages/core/src/index.ts` 确认 barrel 是否 re-export cc-orchestrator；没有则补 `export * from "./cc-orchestrator/index.js";`。grep `cronScheduler.list`/`delete` 确认方法名存在（Task 7 已用 list/get/pause/delete，确认一致）。

- [ ] **Step 2: 注册 + 暴露 preload**

```ts
// index.ts 主进程初始化处调用 registerCCRoomIpc()
// preload/index.ts 的 codeshell 对象里加：
//   ccRoom: {
//     probe: (force?: boolean) => ipcRenderer.invoke("ccRoom:probe", force),
//     listSessions: (cwd: string) => ipcRenderer.invoke("ccRoom:listSessions", cwd),
//     listTasks: () => ipcRenderer.invoke("ccRoom:listTasks"),
//     deleteTask: (jobId: string) => ipcRenderer.invoke("ccRoom:deleteTask", jobId),
//   }
```

- [ ] **Step 3: desktop tsc**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: 0 错

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/main/cc-room/cc-room-ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/index.ts packages/core/src/index.ts
git commit -m "feat(desktop): CC 房间 IPC 桥（探测/列session/列任务/删任务）"
```

---

## Task 12: desktop CC 房间 UI（session 列表为主）

**Files:**
- Create: `packages/desktop/src/renderer/cc-room/CCRoomView.tsx`
- Modify: 把 CCRoomView 挂到一个可达入口（grep 现有面板/路由如何挂载，照搬一个 tab/视图）

> 遵循 desktop CLAUDE.md：用 `@/components/ui` 的 shadcn 组件 + Tailwind 语义 token,不手写原生控件。首屏 session 列表为主 + 「新开 session」+ 探测不可用时置灰 + 引导文案。

- [ ] **Step 1: 实现 CCRoomView**

```tsx
// CCRoomView.tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface DiscoveredSession { sessionId: string; firstMessage: string; lastModified: number; messageCount: number; }
interface Availability { available: boolean; reason?: string; version?: string; }

export function CCRoomView({ cwd }: { cwd: string }) {
  const [avail, setAvail] = useState<Availability | null>(null);
  const [sessions, setSessions] = useState<DiscoveredSession[]>([]);

  useEffect(() => {
    window.codeshell.ccRoom.probe().then(setAvail);
  }, []);
  useEffect(() => {
    if (avail?.available && cwd) window.codeshell.ccRoom.listSessions(cwd).then(setSessions);
  }, [avail?.available, cwd]);

  if (avail && !avail.available) {
    return (
      <div className="p-4 text-muted-foreground">
        <p>未检测到 Claude Code CLI。</p>
        <p className="text-sm">请先安装 <code>claude</code> 并确保它在 PATH 中，然后{" "}
          <Button variant="link" className="px-1" onClick={() => window.codeshell.ccRoom.probe(true).then(setAvail)}>重新检测</Button>。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Claude Code 会话 · {cwd}</h2>
        <Button onClick={() => {/* 新开 session：进入对话视图,resumeSessionId 为空 */}}>新开 session</Button>
      </div>
      {sessions.length === 0 ? (
        <p className="text-muted-foreground text-sm">该项目下还没有 Claude Code 会话。</p>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((s) => (
            <Card key={s.sessionId} className="flex items-center justify-between p-3 hover:bg-accent cursor-pointer"
              onClick={() => {/* 进入对话视图,resume s.sessionId */}}>
              <div className="min-w-0">
                <div className="truncate font-medium">{s.firstMessage || "(无消息)"}</div>
                <div className="text-xs text-muted-foreground">{s.messageCount} 条消息 · {new Date(s.lastModified).toLocaleString()}</div>
              </div>
              <code className="text-xs text-muted-foreground shrink-0">{s.sessionId.slice(0, 8)}</code>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
```

> 「新开 session」/点 session 进入对话视图：本版先做到列表 + 入口；对话视图复用现有 mobile-remote/resident-agent 的事件渲染形态（驱动一轮 → 显示 finalText），可在本任务内做一个最简对话面板，或标注为紧随其后的迭代。最小可点版本：列表 + 探测门控 + 删任务,即满足"最小 desktop UI"。

- [ ] **Step 2: 挂载入口 + desktop 构建验证**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: tsc 0 错,build 成功

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/cc-room/CCRoomView.tsx <挂载点文件>
git commit -m "feat(desktop): CC 房间 UI（session 列表为主 + 探测门控置灰引导）"
```

---

## Task 13: 收尾 — 全量验证 + 真机冒烟清单

**Files:**
- Modify: `docs/smoke-checklist.md`（追加 section，按记忆约定统一进单文件）

- [ ] **Step 1: 全量 core 测试 + 两包 tsc**

Run:
```bash
cd packages/core && bun test src/cc-orchestrator/ && bunx tsc --noEmit
cd ../desktop && bunx tsc --noEmit && bun run build:renderer
```
Expected: core cc-orchestrator 测试全绿；core tsc 0；desktop tsc 0 + build 成功

- [ ] **Step 2: 追加真机冒烟清单 section（写进 docs/smoke-checklist.md）**

内容（新 section「驱动 Claude Code 编排」）：
- [ ] 没装 claude 时 CC 房间入口置灰 + 显示引导；装后「重新检测」恢复。
- [ ] CC 房间列出本项目的 claude session（首条消息/时间/计数正确，中文路径项目也能列出）。
- [ ] DriveClaudeCode 工具：对话里说"用 cc 跑一下 X" → 真的 spawn claude 跑一轮、返回结果。
- [ ] resume：选一个已有 session 续 → 上下文延续（claude 记得之前内容）。
- [ ] ScheduleRoomTask 一次性："2 分钟后用 cc 做 Y" → 2 分钟后真的触发（不是 sleep 假装）。
- [ ] ScheduleRoomTask loop + goal："每 1 分钟检查直到条件满足" → 裁判达成后自动停。
- [ ] continue-fresh：构造前后不相关的两步 → 第二轮开新 session（sessionId 变化）+ handoff 注入。
- [ ] 后台模式：background:true → 立即返回 jobId，完成时通知唤醒（不 sleep 轮询）。
- [ ] 睡眠唤醒：定时任务过点 >90s（合盖再开）→ misfire 跳过、re-arm,不补跑。

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-checklist.md
git commit -m "docs: 驱动 Claude Code 编排 — 真机冒烟清单 section"
```

---

## 落地后仍需用户真机验证（spec 第 11 节）

1. `claude -p "/goal <条件>"` headless 下是否真阻塞到条件满足才退（决定工具描述里该不该荐 /goal；不行则只留纯 prompt 措辞）。
2. continue-fresh 的 handoffSummary 注入新 session 的实际效果（上下文是否够用）。
3. bypassPermissions 之外的 permissionMode 在 headless 下被拒工具时的行为（会卡到超时还是直接失败）——决定是否要给 driver 加超时上限。
