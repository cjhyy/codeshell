# session origin 字段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给每个 session 的 state.json 写 `origin`(desktop/tui/automation/subagent),桌面 disk 重建只显 desktop+automation,根治 tui 混入侧边栏 + automation 丢 ⚙ 标志;删存量无 origin 旧会话让恢复机制从干净起步。

**Architecture:** `SessionState`/`EngineConfig` 加 `origin`;`SessionManager.create` 第 6 参落盘;engine 传 `config.origin`;各宿主(agent-server-stdio=desktop / tui=tui / automation-host=automation / child.run=subagent)构造 Engine 时传 origin;`listDiskSessions` 追加 origin 过滤(只放 desktop/automation)。

**Tech Stack:** TypeScript, bun:test, core + tui + desktop(main/renderer)。

依据:`docs/superpowers/specs/2026-06-03-session-origin-design.md`。约定:直接在 main 提交;改 core 后 `cd packages/core && bun run build`;改 desktop 后 `cd packages/desktop && bunx tsc --noEmit`。

执行顺序:**T1 → T2 → T3 → T4 → T5**。

---

## Task 1: core — SessionState/EngineConfig 加 origin,create 落盘

**Files:**
- Modify: `packages/core/src/types.ts`(SessionState ~110-131)
- Modify: `packages/core/src/session/session-manager.ts`(create ~82-120)
- Modify: `packages/core/src/engine/engine.ts`(EngineConfig + create 调用 ~1018)
- Test: `packages/core/src/session/session-manager.origin.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/src/session/session-manager.origin.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager.create — origin", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "smo-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes origin into state.json when provided", () => {
    const sm = new SessionManager(dir);
    const b = sm.create("/tmp", "m", "p", "s1", null, "desktop");
    expect(b.state.origin).toBe("desktop");
    const onDisk = JSON.parse(readFileSync(join(dir, "s1", "state.json"), "utf8"));
    expect(onDisk.origin).toBe("desktop");
  });

  test("omits origin when not provided", () => {
    const sm = new SessionManager(dir);
    const b = sm.create("/tmp", "m", "p", "s2");
    expect(b.state.origin).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(dir, "s2", "state.json"), "utf8"));
    expect("origin" in onDisk).toBe(false);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/core && bun test src/session/session-manager.origin.test.ts`
Expected: FAIL — create 当前签名 5 参,第 6 参 origin 不被接收;state.origin undefined。

- [ ] **Step 3: 实现 — types + create + engine**

(a) `types.ts`:SessionState 加 origin + 类型(放在 parentSessionId 附近):
```typescript
export type SessionOrigin = "desktop" | "tui" | "automation" | "subagent";
```
SessionState 接口里加:
```typescript
  /** Which host/context created this session. Used by the desktop disk-rebuild
   *  to filter the sidebar to desktop + automation (tui/subagent excluded).
   *  Absent on legacy sessions written before this field existed. */
  origin?: SessionOrigin;
```

(b) `session-manager.ts` `create`:加第 6 参并落盘:
```typescript
  create(
    cwd: string,
    model: string,
    provider: string,
    explicitSessionId?: string,
    parentSessionId?: string,
    origin?: import("../types.js").SessionOrigin,
  ): SessionBundle {
    // ... existing id/dir setup unchanged ...
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
      parentSessionId: parentSessionId ?? null,
      ...(origin ? { origin } : {}),
    };
    // ... rest unchanged ...
  }
```
(SessionState import 已存在;若 SessionOrigin 没在该文件 import,用上面的 inline import 形式或在顶部 import 区加 `SessionOrigin`。)

(c) `engine.ts`:EngineConfig 加 `origin?: SessionOrigin`(在 isSubAgent 附近,~193;并确保从 types import SessionOrigin)。create 调用(~1018)传第 6 参:
```typescript
      session = this.sessionManager.create(
        cwd,
        this.config.llm.model,
        this.config.llm.provider,
        options?.sessionId,
        this.config.isSubAgent === true ? getCurrentSid() : undefined,
        this.config.isSubAgent === true ? "subagent" : this.config.origin,
      );
```

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/core && bun test src/session/session-manager.origin.test.ts`
Expected: PASS(2 tests)。

- [ ] **Step 5: typecheck + 全 core 测试 + build**

Run: `cd packages/core && bunx tsc --noEmit && bun test src/session/ src/engine/ && bun run build`
Expected: tsc 0(忽略已知无关的 pluginInstaller 脏文件报错);测试无回归;build OK。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/session/session-manager.ts packages/core/src/session/session-manager.origin.test.ts packages/core/src/engine/engine.ts
git commit -m "feat(core): SessionState/EngineConfig 加 origin,create 落盘

origin(desktop/tui/automation/subagent)记 session 来源;engine 子代理标 subagent,
否则用 config.origin。供桌面 disk 重建按来源过滤侧边栏。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 各宿主构造 Engine 时传 origin

**Files:**
- Modify: `packages/core/src/cli/agent-server-stdio.ts`(engineFactory ~164)
- Modify: `packages/tui/src/cli/commands/repl.ts`(new Engine ~198)、`packages/tui/src/cli/commands/run.ts`(new Engine ~243)
- Modify: `packages/desktop/src/main/automation-host.ts`(new Engine ~90)

纯接线,无独立单测;验证 = typecheck + build。

- [ ] **Step 1: 桌面 worker 固定 desktop**

`agent-server-stdio.ts` engineFactory 的 `new Engine({...})` 加一行:
```typescript
    return new Engine({
      llm: runtime.modelPool.resolveLLMConfig() ?? resolvedLlmConfig,
      clientDefaults: resolvedClientDefaults,
      cwd,
      runtime,
      settingsScope: "full",
      origin: "desktop",
      // ... 其余字段不变 ...
```

- [ ] **Step 2: tui 传 tui**

`repl.ts` ~198 和 `run.ts` ~243 的会话 `new Engine({...})`(注意是 engineFactory/会话 engine,不是 seedEngine)加 `origin: "tui",`。seedEngine(repl.ts:170 / run.ts:212)是引导用、不建持久会话,可不加(但加了无害)。两个会话工厂 new Engine 都加 `origin: "tui"`。

- [ ] **Step 3: automation 传 automation**

`automation-host.ts` ~90 的 `new Engine({...})` 加 `origin: "automation",`(放在 headless: true 附近):
```typescript
    const engine = new Engine({
      llm: { /* ... */ },
      cwd: jobCwd,
      settingsScope: "full",
      headless: true,
      origin: "automation",
      appendSystemPrompt: AUTOMATION_PROMPT_NOTE,
      // ... 其余不变 ...
```

- [ ] **Step 4: typecheck + build(三处)**

Run:
```
cd packages/core && bunx tsc --noEmit && bun run build
cd ../tui && bunx tsc --noEmit 2>&1 | tail -3   # tui 若有独立 tsc;否则跳过
cd ../desktop && bunx tsc --noEmit && bun run build:main
```
Expected: 各 tsc 0(忽略 pluginInstaller 已知脏文件)。若 tui 无独立 tsc 脚本,core build 通过即可(tui 从 core dist import)。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/cli/agent-server-stdio.ts packages/tui/src/cli/commands/repl.ts packages/tui/src/cli/commands/run.ts packages/desktop/src/main/automation-host.ts
git commit -m "feat: 各宿主构造 Engine 传 origin(desktop/tui/automation)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: listDiskSessions 按 origin 过滤 + DiskSessionMeta 带 origin

**Files:**
- Modify: `packages/desktop/src/main/sessions-service.ts`(DiskSessionMeta ~83、过滤循环 ~124-140)
- Test: `packages/desktop/src/main/sessions-service.disk.test.ts`(追加用例)

- [ ] **Step 1: 追加失败测试**

在现有 `describe("listDiskSessions", ...)` 里加(mkSession helper 已在文件中,支持任意 state 字段):

```typescript
  it("shows desktop + automation origins; hides tui and origin-less", () => {
    mkSession(dir, "d1", { cwd: "/p", parentSessionId: null, origin: "desktop" }, 4000);
    mkSession(dir, "a1", { cwd: "/p", parentSessionId: null, origin: "automation" }, 3000);
    mkSession(dir, "t1", { cwd: "/p", parentSessionId: null, origin: "tui" }, 2000);
    mkSession(dir, "n1", { cwd: "/p", parentSessionId: null }, 1000); // no origin
    const { sessions } = listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["d1", "a1"]);
    expect(sessions[0].origin).toBe("desktop");
  });
```

> 注:现有用例里 top-level 用 `parentSessionId: null` 但无 origin —— 加 origin 过滤后它们会被新规则排除。需把现有那几个"应显示"的 fixture 补上 `origin: "desktop"`(它们本意就是顶层桌面会话)。改现有用例:把 `{ cwd: "/p", parentSessionId: null, ... }` 的 fixture 都加 `origin: "desktop"`,使其仍通过。

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/desktop && bun test src/main/sessions-service.disk.test.ts`
Expected: FAIL — 新用例期望只 d1/a1,但当前无 origin 过滤会返回全部 4 个;且改了现有 fixture 后旧断言可能先失败(同一意图)。

- [ ] **Step 3: 实现 — DiskSessionMeta 加 origin + 过滤**

`sessions-service.ts`:
(a) `DiskSessionMeta` 接口加 `origin?: "desktop" | "tui" | "automation" | "subagent";`
(b) 过滤循环(现有 :132-133 之后)加 origin 闸:
```typescript
    if (!("parentSessionId" in state)) continue;          // legacy → skip
    if (state.parentSessionId) continue;                  // sub-agent → skip
    const origin = state.origin;
    if (origin !== "desktop" && origin !== "automation") continue; // only desktop/automation
    sessions.push({
      id,
      engineSessionId: id,
      cwd: typeof state.cwd === "string" ? state.cwd : "",
      title: typeof state.summary === "string" && state.summary ? state.summary : id,
      updatedAt: mtime,
      origin: origin as "desktop" | "automation",
    });
```

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/desktop && bun test src/main/sessions-service.disk.test.ts`
Expected: PASS(全部用例,含新增)。

- [ ] **Step 5: preload 类型加 origin(DiskSessionMeta 暴露处)**

`packages/desktop/src/preload/types.d.ts` 的 `listDiskSessions` 返回类型里,给 session 项加 `origin?: "desktop" | "automation"`:
```typescript
  listDiskSessions(opts?: { limit?: number; cursor?: string }): Promise<{
    sessions: Array<{ id: string; engineSessionId: string; cwd: string; title: string; updatedAt: number; origin?: "desktop" | "automation" }>;
    nextCursor: string | null;
  }>;
```

- [ ] **Step 6: typecheck + build + 提交**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:main`
```bash
git add packages/desktop/src/main/sessions-service.ts packages/desktop/src/main/sessions-service.disk.test.ts packages/desktop/src/preload/types.d.ts
git commit -m "feat(desktop): listDiskSessions 按 origin 过滤(只 desktop/automation),tui/无 origin 跳过

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: renderer — automation 会话标 source(⚙ 身份)

**Files:**
- Modify: `packages/desktop/src/renderer/automation/rebuildFromDisk.ts`(planDiskRebuild ~33-44)
- Test: `packages/desktop/src/renderer/automation/rebuildFromDisk.test.ts`(追加)

disk 重建时,origin==="automation" 的会话 summary 标 `source:"automation"`,让侧边栏显 ⚙(普通 desktop 不标)。

- [ ] **Step 1: 追加失败测试**

DiskSessionMeta(rebuildFromDisk.ts 自己的接口)需带 origin。测试:

```typescript
  it("marks automation-origin sessions with source:automation (⚙), desktop stays undefined", () => {
    const out = planDiskRebuild(
      [
        { id: "a", engineSessionId: "a", cwd: "/proj/a", title: "新闻", updatedAt: 2, origin: "automation" },
        { id: "d", engineSessionId: "d", cwd: "/proj/a", title: "聊天", updatedAt: 1, origin: "desktop" },
      ],
      [{ id: "r1", name: "a", path: "/proj/a" }],
      { caseInsensitive: false, createRepoForCwd: () => "X" },
    );
    const a = out.find((p) => p.summary.id === "a")!;
    const d = out.find((p) => p.summary.id === "d")!;
    expect(a.summary.source).toBe("automation");
    expect(d.summary.source).toBeUndefined();
  });
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd packages/desktop && bun test src/renderer/automation/rebuildFromDisk.test.ts`
Expected: FAIL — DiskSessionMeta 无 origin 字段(TS)/ source 未按 origin 设。

- [ ] **Step 3: 实现**

`rebuildFromDisk.ts`:
(a) `DiskSessionMeta` 接口加 `origin?: "desktop" | "automation";`
(b) summary 按 origin 设 source:
```typescript
    const summary: SessionSummary = {
      id: s.id,
      title: (s.title || s.id).slice(0, 60),
      createdAt: s.updatedAt,
      updatedAt: s.updatedAt,
      engineSessionId: s.engineSessionId,
      ...(s.origin === "automation" ? { source: "automation" as const } : {}),
    };
```

- [ ] **Step 4: 运行,确认通过**

Run: `cd packages/desktop && bun test src/renderer/automation/rebuildFromDisk.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + build + 提交**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
```bash
git add packages/desktop/src/renderer/automation/rebuildFromDisk.ts packages/desktop/src/renderer/automation/rebuildFromDisk.test.ts
git commit -m "feat(desktop): disk 重建时 automation-origin 会话标 source:automation(恢复 ⚙ 身份)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 删存量无 origin 旧 session(数据,非代码)

**Files:** 无(磁盘数据操作)。

用户决定:内容不重要,删存量让恢复机制从干净起步。先 tar 备份再删 `~/.code-shell/sessions/` 下**所有**会话(它们都无 origin)。

- [ ] **Step 1: 备份 + 删除**

```bash
python3 - <<'PY'
import os, tarfile, shutil
base = os.path.expanduser("~/.code-shell/sessions")
bak = os.path.expanduser("~/.code-shell/sessions-origin-wipe-backup.tar.gz")
dirs = [d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))]
with tarfile.open(bak, "w:gz") as t:
    for d in dirs: t.add(os.path.join(base, d), arcname=d)
for d in dirs: shutil.rmtree(os.path.join(base, d))
print(f"备份 {len(dirs)} 个 → {bak},已清空 sessions/")
PY
```
Expected: 输出备份数量,sessions/ 清空。

- [ ] **Step 2: 验证 listDiskSessions 现在返回空(无存量,等新会话产生)**

```bash
cd packages/desktop && cat > ./v.test.ts <<'EOF'
import { test, expect } from "bun:test";
import { listDiskSessions } from "./src/main/sessions-service";
test("empty after wipe", () => { expect(listDiskSessions({limit:50}).sessions).toEqual([]); });
EOF
bun test ./v.test.ts 2>&1 | grep -E "pass|fail"; rm -f ./v.test.ts
```
Expected: PASS（空）。

- [ ] **Step 3: 无提交**(纯数据操作,git 不跟踪 ~/.code-shell)。在最终总结里告知用户备份路径。

---

## Self-Review 记录

- **Spec 覆盖:** §4.A core origin→T1;§4.B 各宿主传 origin→T2;§4.C listDiskSessions 过滤→T3;
  automation ⚙ 标志→T4;§4.D 删存量→T5。无遗漏。
- **占位扫描:** 无 TODO/占位;每步给了完整代码。T2 "tui 若有独立 tsc" 给了 fallback(core build 兜底)。
- **类型一致:** `SessionOrigin`(core)与 DiskSessionMeta.origin(desktop,窄化为 desktop/automation)
  一致;create 第 6 参 origin、engine 传 config.origin/subagent 一致;rebuildFromDisk.origin 与 main 返回一致。
- **TDD:** T1/T3/T4 先写失败测试;T2 纯接线 typecheck 兜底;T5 数据操作有备份+验证。
- **存量删除:** T5 显式 tar 备份(sessions-origin-wipe-backup.tar.gz),可逆。
