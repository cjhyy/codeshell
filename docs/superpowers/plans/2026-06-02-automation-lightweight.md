# 自动化轻量化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** automation 改走 headless Engine(绕开 RunManager),做到内容可见(transcript)、配置按项目、权限按 3 档真生效、跨运行 memory、进项目侧边栏,并修复只读会话被 InvestigationGuard 拦死。

**Architecture:** scheduler 用现成但未启用的 `runner`(CronRunner)路径替代 `runManager`;`bindCronToEngine` 接线 `resolveWritePolicy(job.permissionLevel)`;desktop runner 用 headless Engine + `job.cwd` + `onStream`(逐条落 transcript)+ memory 注入/工具。RunManager 代码降级保留不删。

**Tech Stack:** TypeScript,bun:test,Electron(main/preload/renderer),@cjhyy/code-shell-core。

设计依据:`docs/superpowers/specs/2026-06-02-automation-lightweight-session-design.md`。

**全程约定:** 直接在 `main` 分支提交(用户偏好 [[feedback_git_commit_on_main]]);desktop 有独立 `tsc --noEmit` 和 build,改 desktop 后在 `packages/desktop` 跑 `bunx tsc --noEmit`。

---

## Phase A — 权限接线(问题一,方案 A)

### Task A1: `bindCronToEngine` 按 job 权限档解析,不再硬编码只读

**Files:**
- Modify: `packages/core/src/automation/runner.ts:54-64`
- Test: `packages/core/src/automation/runner.permission.test.ts` (create)

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/src/automation/runner.permission.test.ts
import { describe, test, expect } from "bun:test";
import { bindCronToEngine, type CronRunRequest } from "./runner.js";
import { CronScheduler } from "./scheduler.js";
import { CronStore } from "./store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function schedulerWith(level: "read-only" | "workspace-write" | "full") {
  const store = new CronStore(join(mkdtempSync(join(tmpdir(), "cron-")), "cron.json"));
  const scheduler = new CronScheduler(store);
  scheduler.create({ name: "t", schedule: "0 0 * * *", prompt: "p", cwd: "/tmp", permissionLevel: level });
  return scheduler;
}

describe("bindCronToEngine — permission tier wiring", () => {
  test("workspace-write job approves a Write tool (not forced read-only)", async () => {
    let captured: CronRunRequest | undefined;
    const scheduler = schedulerWith("workspace-write");
    bindCronToEngine(scheduler, async (req) => { captured = req; return { text: "", reason: "completed" }; });
    await scheduler.runNow(scheduler.list()[0].id);
    const decision = await captured!.approvalBackend.requestApproval({ toolName: "Write" } as never);
    expect(decision.approved).toBe(true);
  });

  test("read-only job denies a Write tool", async () => {
    let captured: CronRunRequest | undefined;
    const scheduler = schedulerWith("read-only");
    bindCronToEngine(scheduler, async (req) => { captured = req; return { text: "", reason: "completed" }; });
    await scheduler.runNow(scheduler.list()[0].id);
    const decision = await captured!.approvalBackend.requestApproval({ toolName: "Write" } as never);
    expect(decision.approved).toBe(false);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/core && bun test src/automation/runner.permission.test.ts`
Expected: FAIL — workspace-write 测试里 `decision.approved` 为 false(当前硬编码 approve-read-only 拒 Write)。

- [ ] **Step 3: 最小实现 — 接线 resolveWritePolicy**

修改 `packages/core/src/automation/runner.ts`:顶部 import,改 `bindCronToEngine` body。

```typescript
// 顶部已有 import 区追加:
import { resolveWritePolicy } from "./write-policy.js";

// 替换 bindCronToEngine 的 executor body(原 :55-63):
export function bindCronToEngine(scheduler: CronScheduler, runner: CronRunner): void {
  scheduler.setExecutor(async (job: CronJob) => {
    const policy = resolveWritePolicy(job.permissionLevel);
    const req: CronRunRequest = {
      job,
      prompt: job.prompt,
      permissionMode: policy.permissionMode,
      approvalBackend: policy.approvalBackend,
    };
    await runner(req);
  });
}
```

`HeadlessApprovalBackend` 的 import 若在此文件已不再使用,保留即可(bindCronToRunManager 注释引用);不强行删。

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/core && bun test src/automation/runner.permission.test.ts`
Expected: PASS(2 tests)。再跑 `bun test src/automation/` 确认无回归。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/automation/runner.ts packages/core/src/automation/runner.permission.test.ts
git commit -m "fix(core): cron 执行按 job.permissionLevel 解析权限,不再硬编码只读

bindCronToEngine 接线现成的 resolveWritePolicy/TierApprovalBackend(已有测试但无人调用),
read-only/workspace-write/full 三档真生效。automation 能按配置读写。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase B — automation 走 headless Engine runner(主线核心)

### Task B1: desktop runner 用 headless Engine + onStream + job.cwd,接 memory

**Files:**
- Modify: `packages/desktop/src/main/automation-host.ts:49-74` (`buildDesktopAutomationRunner`)
- Modify: `packages/desktop/src/main/index.ts:285-292` (注入 runner 而非 runManager)
- Test: 手动 + 下游 build(runner 依赖 Electron Engine,纯单测在 B3/B4 的纯函数覆盖)

- [ ] **Step 1: 改 `buildDesktopAutomationRunner` — 接 onStream + memory 读注入**

`automation-host.ts` 中替换该函数(保留它已有的 headless / job.cwd / req.permissionMode / req.approvalBackend):

```typescript
import { readAutomationMemory } from "./automationMemory.js"; // B3 产出

export function buildDesktopAutomationRunner(emit?: (sessionId: string, event: unknown) => void): CronRunner {
  return async (req): Promise<CronRunResult> => {
    const jobCwd = req.job.cwd ?? process.cwd();
    const settings = new SettingsManager(jobCwd, "full").get();
    const memory = readAutomationMemory(req.job.id); // 跨运行记忆,空则 ""
    const engine = new Engine({
      llm: {
        provider: settings.model.provider,
        model: settings.model.name,
        apiKey: settings.model.apiKey ?? "",
        baseUrl: settings.model.baseUrl,
        maxTokens: settings.model.maxTokens,
      },
      cwd: jobCwd,
      settingsScope: "full",
      headless: true,
      permissionMode: req.permissionMode,
      approvalBackend: req.approvalBackend,
      sessionStorageDir: undefined, // 默认 ~/.code-shell/sessions —— 自动落 transcript.jsonl
    });
    const prompt = memory
      ? `${req.prompt}\n\n<previous_runs_memory>\n${memory}\n</previous_runs_memory>`
      : req.prompt;
    const onStream = emit ? (e: unknown) => emit(req.job.id, e) : undefined;
    const result = await engine.run(prompt, { cwd: jobCwd, onStream });
    return { text: result.text, reason: result.reason };
  };
}
```

注:`CronJob.cwd` 现为正式字段(scheduler.ts),`req.job.cwd` 直接用,去掉旧的 `(req.job as {cwd?})` 防御。

- [ ] **Step 2: 改 index.ts 注入 runner 而非 runManager**

`index.ts:285-292` 把 `runManager: buildDesktopRunManager()` 改为 `runner: buildDesktopAutomationRunner(emitAutomationEvent)`。`emitAutomationEvent` 由 B5 提供;本步先用占位 `undefined`(`buildDesktopAutomationRunner()`),B5 再回填。

```typescript
    automationHandle = startAutomation({
      store: new CronStore(defaultCronStorePath()),
      runner: buildDesktopAutomationRunner(), // B5 回填 emit
    });
    setAutomationScheduler(automationHandle.scheduler);
```

import 增 `buildDesktopAutomationRunner`,移除不再用的 `buildDesktopRunManager`(若 lint 报未用)。

- [ ] **Step 3: typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:main`
Expected: tsc exit 0;main bundle 成功。(此步依赖 B3 的 `automationMemory.ts` 已存在 —— 故 B3 应先做;见下方执行顺序说明。)

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/main/automation-host.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): automation 改走 headless Engine runner(绕开 RunManager)

scheduler 用现成的 runner 路径(startAutomation 早已支持 runner?:CronRunner)替代 runManager:
headless Engine 按 job.cwd 解析配置/skill、engine.run 带 onStream → 逐条自动落 transcript.jsonl、
跑前注入任务级 memory。RunManager 代码降级保留不删(buildDesktopRunManager 仍在)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **执行顺序:** B3(memory store)无依赖,应在 B1 之前实现,使 B1 的 `readAutomationMemory` import 可解析。本计划按主题编号;subagent 执行时按 A1 → B3 → B4 → B1 → B2 → B5 → C1 顺序做。

---

### Task B3: 任务级 memory store(纯函数 + fs)

**Files:**
- Create: `packages/desktop/src/main/automationMemory.ts`
- Test: `packages/desktop/src/main/automationMemory.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/desktop/src/main/automationMemory.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readAutomationMemory, appendAutomationMemory } from "./automationMemory";

describe("automationMemory", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("read returns '' for unknown job", () => {
    expect(readAutomationMemory("job1", dir)).toBe("");
  });

  it("append then read returns the summary", () => {
    appendAutomationMemory("job1", "ran ok", dir);
    expect(readAutomationMemory("job1", dir)).toContain("ran ok");
  });

  it("append accumulates across runs, newest appended after older", () => {
    appendAutomationMemory("job1", "first", dir);
    appendAutomationMemory("job1", "second", dir);
    const mem = readAutomationMemory("job1", dir);
    expect(mem.indexOf("first")).toBeLessThan(mem.indexOf("second"));
  });

  it("isolates by jobId (path traversal rejected)", () => {
    appendAutomationMemory("job1", "x", dir);
    expect(readAutomationMemory("job2", dir)).toBe("");
    expect(readAutomationMemory("../escape", dir)).toBe(""); // unsafe id → empty, no throw
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/desktop && bun test src/main/automationMemory.test.ts`
Expected: FAIL — Cannot find module './automationMemory'。

- [ ] **Step 3: 实现**

```typescript
// packages/desktop/src/main/automationMemory.ts
/**
 * 任务级跨运行记忆:每个 automation 任务一份 memory.md
 * (~/.code-shell/automations/<jobId>/memory.md)。跑前读、跑完追加。
 * 独立于项目主记忆,不污染。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const BASE = path.join(os.homedir(), ".code-shell", "automations");
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

function memFile(jobId: string, baseDir: string): string | null {
  if (!SAFE_ID.test(jobId) || jobId === "." || jobId === "..") return null;
  return path.join(baseDir, jobId, "memory.md");
}

export function readAutomationMemory(jobId: string, baseDir: string = BASE): string {
  const f = memFile(jobId, baseDir);
  if (!f) return "";
  try { return fs.readFileSync(f, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return ""; throw e; }
}

export function appendAutomationMemory(jobId: string, summary: string, baseDir: string = BASE): void {
  const f = memFile(jobId, baseDir);
  if (!f) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, summary.trim() + "\n\n", "utf8");
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/desktop && bun test src/main/automationMemory.test.ts`
Expected: PASS(4 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/automationMemory.ts packages/desktop/src/main/automationMemory.test.ts
git commit -m "feat(desktop): automation 任务级 memory store(每任务一份 memory.md)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task B4: `UpdateAutomationMemory` builtin 工具 + automation 工具白名单

**Files:**
- Create: `packages/core/src/tool-system/builtin/update-automation-memory.ts`
- Modify: `packages/core/src/tool-system/builtin/index.ts:66+` (注册进 BUILTIN_TOOLS)
- Test: `packages/core/src/tool-system/builtin/update-automation-memory.test.ts`

> 说明:工具写盘需要 jobId + baseDir。core 不依赖 desktop 的 automationMemory.ts;故工具通过**注入的回调**写入(执行上下文提供),工具本身只校验入参 + 调回调。desktop runner 构造 toolRegistry 时注入「写本 jobId memory」的回调。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/src/tool-system/builtin/update-automation-memory.test.ts
import { describe, test, expect } from "bun:test";
import { makeUpdateAutomationMemoryTool } from "./update-automation-memory.js";

describe("UpdateAutomationMemory", () => {
  test("calls the injected sink with the summary and reports success", async () => {
    const writes: string[] = [];
    const tool = makeUpdateAutomationMemoryTool((s) => writes.push(s));
    const res = await tool.execute({ summary: "today: 3 items" });
    expect(writes).toEqual(["today: 3 items"]);
    expect(res.result).toContain("saved");
  });

  test("rejects empty summary without calling the sink", async () => {
    const writes: string[] = [];
    const tool = makeUpdateAutomationMemoryTool((s) => writes.push(s));
    const res = await tool.execute({ summary: "" });
    expect(writes).toEqual([]);
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/update-automation-memory.test.ts`
Expected: FAIL — Cannot find module。

- [ ] **Step 3: 实现工具工厂**

```typescript
// packages/core/src/tool-system/builtin/update-automation-memory.ts
/**
 * UpdateAutomationMemory — 自动化任务在跑完调用一次,写一段「本次运行摘要」供下次参考。
 * 工具本身不碰文件:写入经注入的 sink(desktop runner 提供「写本 jobId memory.md」)。
 * 只在 automation 执行态挂载(见 desktop 白名单)。
 */
export interface UpdateAutomationMemoryTool {
  definition: {
    name: string;
    description: string;
    inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  };
  execute(args: { summary?: string }): Promise<{ result?: string; isError?: boolean }>;
}

export function makeUpdateAutomationMemoryTool(
  sink: (summary: string) => void,
): UpdateAutomationMemoryTool {
  return {
    definition: {
      name: "UpdateAutomationMemory",
      description:
        "Record a short summary of THIS automation run (key findings / state) so the NEXT scheduled run can use it as context. Call exactly once, at the end.",
      inputSchema: {
        type: "object",
        properties: { summary: { type: "string", description: "Concise run summary for next time." } },
        required: ["summary"],
      },
    },
    async execute(args) {
      const summary = (args.summary ?? "").trim();
      if (!summary) return { isError: true, result: "summary is required and must be non-empty" };
      sink(summary);
      return { result: "saved to automation memory" };
    },
  };
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/update-automation-memory.test.ts`
Expected: PASS(2 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool-system/builtin/update-automation-memory.ts packages/core/src/tool-system/builtin/update-automation-memory.test.ts
git commit -m "feat(core): UpdateAutomationMemory 工具工厂(写入经注入 sink)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: automation 工具白名单 — 去 cron 工具、挂 UpdateAutomationMemory

**Files:**
- Modify: `packages/desktop/src/main/automation-host.ts` (`buildDesktopAutomationRunner` 内构造 Engine 处)
- Test: `packages/desktop/src/main/automationToolset.test.ts` (create — 纯函数白名单计算)

- [ ] **Step 1: 写失败测试(纯函数:automation builtin 白名单)**

```typescript
// packages/desktop/src/main/automationToolset.test.ts
import { describe, it, expect } from "bun:test";
import { automationBuiltinTools } from "./automationToolset";

describe("automationBuiltinTools", () => {
  it("excludes the cron tools", () => {
    const names = automationBuiltinTools();
    expect(names).not.toContain("CronCreate");
    expect(names).not.toContain("CronDelete");
    expect(names).not.toContain("CronList");
  });
  it("keeps a normal read tool like Read", () => {
    expect(automationBuiltinTools()).toContain("Read");
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/desktop && bun test src/main/automationToolset.test.ts`
Expected: FAIL — Cannot find module。

- [ ] **Step 3: 实现白名单(基于 core 的 BUILTIN_TOOLS 全集去掉 cron)**

```typescript
// packages/desktop/src/main/automationToolset.ts
/**
 * automation 执行态的 builtin 工具白名单:全集去掉 cron 工具(禁嵌套设自动化)。
 * UpdateAutomationMemory 是 desktop 经 registerTool 单独注入,不在 builtin 白名单里。
 */
import { BUILTIN_TOOLS } from "@cjhyy/code-shell-core";

const CRON_TOOLS = new Set(["CronCreate", "CronDelete", "CronList"]);

export function automationBuiltinTools(): string[] {
  return BUILTIN_TOOLS
    .map((t: { definition: { name: string } }) => t.definition.name)
    .filter((n: string) => !CRON_TOOLS.has(n));
}
```

> 若 `BUILTIN_TOOLS` 未从 core 顶层 export,在 `packages/core/src/index.ts` 加 `export { BUILTIN_TOOLS } from "./tool-system/builtin/index.js";`,然后 `cd packages/core && bun run build`(desktop 从 dist import)。

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/desktop && bun test src/main/automationToolset.test.ts`
Expected: PASS(2 tests)。

- [ ] **Step 5: 在 runner 里用白名单构造 Engine + 注入 memory 工具**

`automation-host.ts` 的 Engine 构造补 `runtime`(toolRegistry 白名单)并 `registerTool` 注入 UpdateAutomationMemory:

```typescript
import { ToolRegistry } from "@cjhyy/code-shell-core";
import { automationBuiltinTools } from "./automationToolset.js";
import { makeUpdateAutomationMemoryTool } from "@cjhyy/code-shell-core";
import { appendAutomationMemory } from "./automationMemory.js";

// 在 new Engine 之前:
const toolRegistry = new ToolRegistry({ builtinTools: automationBuiltinTools() });
const memTool = makeUpdateAutomationMemoryTool((s) => appendAutomationMemory(req.job.id, s));
toolRegistry.registerTool(
  { definition: memTool.definition as never, execute: memTool.execute as never },
  memTool.execute as never,
);
// Engine 构造里加: runtime: { toolRegistry } (其余 runtime 资源用默认 —— 确认 EngineConfig.runtime 允许部分注入;若要求整套,改为 engine.registerTool 在构造后注入,且用 EngineConfig.builtinToolsAllowlist 若有)
```

> ⚠ 落地校验点:`EngineConfig.runtime` 是否允许只注入 `toolRegistry`(engine.ts:407 `config.runtime?.toolRegistry ?? new ToolRegistry(...)`)。若 runtime 要求整套资源,改用:不传 runtime,改在构造后 `engine.registerTool(memTool…)` 注入 memory 工具,cron 工具的排除则需 `EngineConfig` 暴露 builtin 白名单入口;实现时先验证 engine.ts:407 路径,二选一,提交信息注明所选。

- [ ] **Step 6: typecheck + build + 提交**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:main`
```bash
git add packages/desktop/src/main/automationToolset.ts packages/desktop/src/main/automationToolset.test.ts packages/desktop/src/main/automation-host.ts packages/core/src/index.ts
git commit -m "feat: automation 工具集去 cron 工具、挂 UpdateAutomationMemory

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task B5: automation 事件喂 main 快照(享受 renderer 重连)+ prompt note

**Files:**
- Modify: `packages/desktop/src/main/agent-bridge.ts` (暴露 `ingestExternalEvent(sessionId, event)`)
- Modify: `packages/desktop/src/main/index.ts` (把 emit 接到 bridge,回填 B1 Step2 的占位)
- Modify: `packages/core/src/run/EngineRunner.ts:40-45` (`AUTOMATION_PROMPT_NOTE` 末尾追加 memory 指令)

- [ ] **Step 1: AgentBridge 暴露外部事件入口(测试:append 进快照可被 getSnapshot 取回)**

`agent-bridge.ts` 加方法(复用已有 `this.snapshots` + `safeSend`):

```typescript
/** Feed an event produced OUTSIDE the stdio worker (e.g. an in-main automation
 *  Engine) into the same snapshot + renderer stream, so renderer reconnect works
 *  identically for automation sessions. */
ingestExternalEvent(sessionId: string, event: unknown): void {
  this.snapshots.append(sessionId, event);
  this.safeSend("agent:msg", JSON.stringify({
    jsonrpc: "2.0", method: "agent/streamEvent", params: { sessionId, event },
  }));
}
```

- [ ] **Step 2: index.ts 把 emit 接到 bridge,回填 B1 占位**

```typescript
const emitAutomationEvent = (sessionId: string, event: unknown) =>
  bridge?.ingestExternalEvent(sessionId, event);
// startAutomation 注入改为:
runner: buildDesktopAutomationRunner(emitAutomationEvent),
```

但 runner 的 onStream 拿到的是 job.id,不是 Engine 的 sessionId。**校验点:** automation Engine 的 sessionId 从 `session_started` 事件取(engine 首个事件携带真实 sid),emit 时优先用事件里的 sessionId;runner 侧维护 job.id→sid 映射,或直接把 `engine.run` 返回/`session_started` 的 sid 用作 ingest key。实现时:在 onStream 内,若 `event.type==="session_started"` 记下 `event.sessionId`,后续事件用它作 ingest 的 sessionId(无则回退 job.id)。

- [ ] **Step 3: AUTOMATION_PROMPT_NOTE 追加 memory 指令**

`EngineRunner.ts:40-45` 末尾(字符串拼接)追加一句:

```typescript
export const AUTOMATION_PROMPT_NOTE =
  "This is an unattended, scheduled automation run. No human is watching, and " +
  "AskUserQuestion will not reach anyone. You ARE the automation — do not ask " +
  "the user questions and do not offer to set up or schedule automation. " +
  "Produce the requested output directly; when uncertain, state your assumption " +
  "and proceed. " +
  "When finished, call UpdateAutomationMemory exactly once with a concise summary " +
  "of this run's key findings/state for the next run.";
```

runner 构造 Engine 时传 `appendSystemPrompt: AUTOMATION_PROMPT_NOTE`(import 自 core)。

- [ ] **Step 4: typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:main && bun run build:preload`
另:`cd packages/core && bun test src/run/` 确认 PROMPT_NOTE 改动无回归(buildAppendSystemPrompt 测试若有)。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/agent-bridge.ts packages/desktop/src/main/index.ts packages/core/src/run/EngineRunner.ts
git commit -m "feat: automation Engine 事件喂 main 快照 + prompt 要求写 memory

automation 在 main 进程内跑,事件经 AgentBridge.ingestExternalEvent 进同一快照+转发,
renderer 打开/重挂可重连(复用已交付的 main 快照机制)。AUTOMATION_PROMPT_NOTE 追加
「跑完调 UpdateAutomationMemory」指令。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — InvestigationGuard 只读误伤(问题二,方案①)

### Task C1: 只读 automation 会话开 soft-mode

**Files:**
- Modify: `packages/desktop/src/main/automation-host.ts` (runner 内,read-only 时设 headless soft 已默认;此处确认 read-only 档不被 dedupe 拦)

> 事实:`headless:true` 的 Engine 已对 InvestigationGuard 走 soft-mode(engine.ts:1151 `if (this.config.headless) investigationGuard.setSoftMode(true)`)。automation runner 已 `headless:true`,**所以只读 automation 已自动免疫 dedupe hard-block**。问题二的真正缺口是**交互式只读会话**(非 headless)无 override。

- [ ] **Step 1: 写失败测试 — 交互式只读会话该免 hard-block**

```typescript
// packages/core/src/tool-system/investigation-guard.readonly.test.ts
import { describe, test, expect } from "bun:test";
import { InvestigationGuard } from "./investigation-guard.js";

describe("InvestigationGuard — read-only sessions never hard-block", () => {
  test("readOnly soft-mode: 3rd dedupe read yields reminder, not block", () => {
    const g = new InvestigationGuard();
    g.setSoftMode(true); // read-only 会话应被置为 soft
    let last;
    for (let i = 0; i < 3; i++) last = g.onToolStart({ toolName: "Read", args: { file_path: "/a", offset: 0 } } as never);
    expect(last?.block).toBeUndefined(); // soft-mode 下不 hard-block
  });
});
```

> 注:`onToolStart` 的确切方法名/签名以 investigation-guard.ts 为准,实现 Step 时对齐(读该文件 :66 起);若方法名不同(如 `check`/`onRead`),改测试调用名。

- [ ] **Step 2: 运行,确认状态**

Run: `cd packages/core && bun test src/tool-system/investigation-guard.readonly.test.ts`
Expected: 若已有 setSoftMode 行为正确 → PASS(说明 core 侧已够,缺的只是「交互式只读会话谁调 setSoftMode」的接线);若 FAIL → 按 :90-97 soft 分支修。

- [ ] **Step 3: 接线 — 交互式只读会话设 soft-mode**

在创建会话/Engine 处(交互式 read-only 权限模式),调用 `engine` 暴露的 guard soft-mode 开关。**校验点:** Engine 是否暴露设置 guard soft-mode 的公共入口;若无,加一个 `EngineConfig.readOnlySession?: boolean`,在 engine.ts:1151 旁 `if (this.config.headless || this.config.readOnlySession) investigationGuard.setSoftMode(true)`。desktop 交互式会话在 permissionMode 为只读时传 `readOnlySession:true`。

- [ ] **Step 4: 运行 + typecheck**

Run: `cd packages/core && bun test src/tool-system/ && bunx tsc --noEmit`(core 根)
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool-system/investigation-guard.readonly.test.ts packages/core/src/engine/engine.ts
git commit -m "fix(core): 只读会话开 InvestigationGuard soft-mode,dedupe 第3次不再 hard-block

headless automation 已自动 soft;补交互式只读会话(readOnlySession)同样 soft,
避免本就只读的会话多读几次被拦死。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — session 进项目侧边栏(主线收尾)

### Task D1: automation run 的 session 归项目侧边栏(复用已有 run→sidebar)

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx` (automation session 的标题/source 标记)
- 复用:[[project_automation_run_sidebar]] 已有的 run 按 cwd 归项目 + import 机制。

> 事实依赖:B5 让 automation 的 `session_started`(带真实 sid)经 ingestExternalEvent 到 renderer。renderer 已有 `source:"automation"` 的 session 处理(App.tsx:328 hydrate 分支)。本任务确保新 automation session 带日期标题、source:automation、按 job.cwd 归项目。

- [ ] **Step 1: 确认 renderer 收到 automation session_started 后建/归 session**

读 App.tsx 现有 `session_started` 处理(:653 区)与 automation import 逻辑,确认 ingest 来的 automation 事件能落到一个 source:automation 的 bucket。若已覆盖(因走同一 streamEvent 通道)→ 仅需标题带日期。

- [ ] **Step 2: 手动验证(无纯单测;集成行为)**

启动 desktop,手动 `runNow` 一个 automation,确认:① 项目侧边栏出现「⚙ <任务名> <日期>」session;② 点进去能像聊天一样看到逐条过程;③ transcript.jsonl 落盘;④ memory.md 追加。

- [ ] **Step 3: 提交(若有标题/source 改动)**

```bash
git add packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): automation run 进项目侧边栏,带日期标题 + source:automation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 执行顺序(subagent 按此)

A1 → B3 → B4 → B1 → B2 → B5 → C1 → D1

A1/C1 在 core,独立可先做。B 系列有依赖(B3/B4 是 B1/B2 的零件)。D1 依赖 B5 的事件接线。

## Self-Review 记录

- **Spec 覆盖:** §4.2 执行路→B1/B2/B5;§4.3 权限→A1;§4.4 按项目 cwd→B1;§4.5 memory→B3/B4/B5;
  §4.6 Runs 只读→不动(默认保留);§8 快照接线→B5;§10 guard→C1;侧边栏→D1。无遗漏。
- **占位扫描:** 三处标了「校验点」(B2 Step5 runtime 注入、B5 Step2 sessionId 来源、C1 Step3 guard 入口),
  均给了二选一的具体落地路径 + 验证方法,非「TODO」。实现时按指示验证后择一,提交信息注明。
- **类型一致:** `automationBuiltinTools()`/`makeUpdateAutomationMemoryTool`/`readAutomationMemory`/
  `appendAutomationMemory`/`ingestExternalEvent` 跨任务命名一致。
- **TDD:** 每个纯函数任务(A1/B3/B4/B2/C1)均先写失败测试;集成任务(B1/B5/D1)以 typecheck/build/手动验证兜底
  (依赖 Electron Engine,纯单测不经济)。
