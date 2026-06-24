# 调度去耦合(定时能力从「驱动 CC 房间」剥回通用层)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「一次性定时」并进已有的通用 `CronCreate` 工具,删掉把定时与「驱动 CC」焊死的整条 CC 执行链(`ScheduleRoomTask` / `CCTaskStore` / `runCCTask` / `makeCCAwareExecutor`),让所有 cron job 走同一条 headless Engine 路径。

**Architecture:** 底层 `CronScheduler` 已是通用调度器,只补「跑一次就删」(`once`)语义。所有 CC 专属调度机制删除;驱动 CC 退化为「定时任务跑的那轮引擎在 prompt 指引下调用 `DriveClaudeCode`」。无人值守审批无需改动(`DriveClaudeCode` 已默认 bypass)。前端「Claude Code 面板」的定时任务区暂时下架,保留会话/对话区。

**Tech Stack:** TypeScript / bun test。core 包(`packages/core`)+ desktop 包(`packages/desktop`,有自己的 `tsc --noEmit` / `vite build`)。

参考设计稿:`docs/superpowers/specs/2026-06-24-schedule-decouple-from-cc-room-design.md`

---

## 文件结构

**core — 改:**
- `packages/core/src/automation/scheduler.ts` — `CronJob` / `CreateJobOptions` 加 `once`;`fire()` 一次性后自删;`armCron` re-arm 前查 `this.jobs.has`。
- `packages/core/src/automation/scheduler.test.ts` — 新增一次性 interval/cron 测试。
- `packages/core/src/tool-system/builtin/cron.ts` — `CronCreate` 暴露 `once` + 文案。
- `packages/core/src/tool-system/builtin/cron.test.ts`(若存在;不存在则在此文件新建)— `once` 透传测试。
- `packages/core/src/tool-system/builtin/drive-claude-code.ts` — 描述里 `ScheduleRoomTask` → `CronCreate`。
- `packages/core/src/tool-system/builtin/index.ts` — 删 ScheduleRoomTask import(36)+ 注册块(485-494)。
- `packages/core/src/preset/index.ts` — 删白名单 `"ScheduleRoomTask"`(82)+ 改注释。
- `packages/core/src/preset/preset-builtin-tools.test.ts` — 反转 ScheduleRoomTask 断言(42/44/50)。
- `packages/core/src/cc-orchestrator/index.ts` — 删 `cc-task-store` / `cc-scheduler-binding` 的 re-export。

**core — 删文件:**
- `packages/core/src/tool-system/builtin/schedule-room-task.ts`
- `packages/core/src/tool-system/builtin/schedule-room-task.test.ts`
- `packages/core/src/cc-orchestrator/cc-task-store.ts`
- `packages/core/src/cc-orchestrator/cc-task-store.test.ts`
- `packages/core/src/cc-orchestrator/cc-scheduler-binding.ts`
- `packages/core/src/cc-orchestrator/cc-scheduler-binding.test.ts`

**保留(不动):** `packages/core/src/cc-orchestrator/relevance-judge.ts`(+ 其测试)——独立判断模块,删 binding 后无源码消费者但保留其 re-export 与测试,留作未来真 aux 裁判用。

**desktop — 改:**
- `packages/desktop/src/main/index.ts` — 删 import(38-41 中 `makeCCAwareExecutor`/`CCTaskStore`/`runAgentOnce`/`claudeAdapter`)、删 CC-aware executor 块(约 1033-1087)、删 `ccRoom:listTasks`/`ccRoom:deleteTask` 两 handler(1723-1733)。
- `packages/desktop/src/preload/index.ts` — 删 `listTasks`/`deleteTask`(804-805)。
- `packages/desktop/src/preload/types.d.ts` — 删 `listTasks`/`deleteTask` 类型(931-932)及不再被引用的 `CCTaskMeta` 导入(若有)。
- `packages/desktop/src/renderer/cc-room/CCRoomView.tsx` — 删 `CCTaskRow` 类型、tasks state、refresh 里 listTasks 调用、定时任务区渲染段。

---

## Task 1: scheduler 支持一次性任务(`once`)

**Files:**
- Modify: `packages/core/src/automation/scheduler.ts`
- Test: `packages/core/src/automation/scheduler.test.ts`

- [ ] **Step 1: 写失败测试 — 一次性 interval job fire 后自删**

在 `scheduler.test.ts` 末尾(最后一个 `});` 之前的顶层 describe 内,或新建一个 describe)加:

```ts
import { CronScheduler } from "./scheduler.js";

describe("once (one-shot) jobs", () => {
  it("一次性 interval job:fire 一次后从 list 消失且不再触发", async () => {
    const s = new CronScheduler();
    let runs = 0;
    s.setExecutor(async () => {
      runs++;
    });
    s.create("oneshot", "30s", "do it", { once: true });
    expect(s.list()).toHaveLength(1);

    // 直接触发该 job 的执行路径(runNow 复用 fire,force=true)
    s.runNow(s.list()[0].id);
    // 等待 in-flight 执行 settle
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(runs).toBe(1);
    expect(s.list()).toHaveLength(0); // 一次性:跑完即删
  });

  it("循环 interval job:runNow 后仍在 list", async () => {
    const s = new CronScheduler();
    s.setExecutor(async () => {});
    s.create("loop", "30s", "do it"); // once 默认 false
    s.runNow(s.list()[0].id);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(s.list()).toHaveLength(1); // 循环:不删
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd packages/core && bun test src/automation/scheduler.test.ts -t "once"`
Expected: FAIL —— `create` 不识别 `once`,且一次性 job 不会自删,`list()` 仍有 1 条。

- [ ] **Step 3: 实现 `once`**

在 `scheduler.ts`:

(a) `CronJob` 接口加字段(在 `lastRunId?` 后):
```ts
  /** True = one-shot: delete the job after its first real execution. */
  once?: boolean;
```

(b) `CreateJobOptions` 加字段:
```ts
  once?: boolean;
```

(c) `create()` 两个分支(有 store / 无 store)构造 job 时都透传 `once`。在两处 `createdAt: Date.now(),` 之后各加:
```ts
          ...(opts?.once === true ? { once: true } : {}),
```
(有 store 分支在 mutate 内的 job 字面量;无 store 分支在第二个 job 字面量。)

(d) `fire()` 的 `finally` 块,在 `resolveDone();` 之前加自删:
```ts
      // One-shot: delete after its first real execution so it never fires again.
      if (job.once) {
        this.delete(job.id);
      }
```

(e) `armCron` 的 setTimeout 回调里,re-arm 前确认 job 仍存在(一次性删除后闭包持有旧引用):把
```ts
      void this.fire(job, () => {
        // Re-arm for the following occurrence.
        if (job.enabled) this.armCron(job);
      });
```
改为
```ts
      void this.fire(job, () => {
        // Re-arm for the following occurrence — but only if the job still
        // exists (a one-shot job deletes itself in fire()'s finally).
        if (job.enabled && this.jobs.has(job.id)) this.armCron(job);
      });
```

- [ ] **Step 4: 写失败测试 — 一次性 cron job fire 后自删 + 不 re-arm**

加到同一 describe:
```ts
  it("一次性 cron job:fire 一次后从 list 消失,不 re-arm", async () => {
    const s = new CronScheduler();
    let runs = 0;
    s.setExecutor(async () => {
      runs++;
    });
    // 用一个能被接受的 cron 表达式;runNow 走 fire,不依赖到点
    s.create("oneshot-cron", "0 9 * * *", "morning", { once: true, timezone: "UTC" });
    expect(s.list()).toHaveLength(1);
    s.runNow(s.list()[0].id);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(1);
    expect(s.list()).toHaveLength(0);
  });
```

- [ ] **Step 5: 跑全部 once 测试,确认通过**

Run: `cd packages/core && bun test src/automation/scheduler.test.ts -t "once"`
Expected: PASS(3 个用例)。

- [ ] **Step 6: 跑整个 scheduler 测试,确认无回归**

Run: `cd packages/core && bun test src/automation/scheduler.test.ts`
Expected: 全 PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/automation/scheduler.ts packages/core/src/automation/scheduler.test.ts
git commit -m "feat(scheduler): 支持一次性(once)任务,fire 后自删 + cron 不 re-arm"
```

---

## Task 2: `CronCreate` 暴露 `once`

**Files:**
- Modify: `packages/core/src/tool-system/builtin/cron.ts`
- Test: `packages/core/src/tool-system/builtin/cron.test.ts`(新建或追加)

- [ ] **Step 1: 写失败测试**

若 `packages/core/src/tool-system/builtin/cron.test.ts` 不存在,新建:
```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { cronCreateTool } from "./cron.js";
import { cronScheduler } from "../../automation/scheduler.js";

describe("CronCreate once", () => {
  beforeEach(() => {
    // 清掉上次测试残留的 job(共享单例)
    for (const j of cronScheduler.list()) cronScheduler.delete(j.id);
  });

  it("once:true 透传到 scheduler,job.once 为 true", async () => {
    const out = await cronCreateTool({ name: "r", schedule: "1h", prompt: "p", once: true });
    const job = cronScheduler.list().find((j) => j.name === "r");
    expect(job?.once).toBe(true);
    expect(out).toContain("一次"); // 文案区分一次性
  });

  it("不传 once 时 job.once 不为 true(循环语义)", async () => {
    await cronCreateTool({ name: "r2", schedule: "1h", prompt: "p" });
    const job = cronScheduler.list().find((j) => j.name === "r2");
    expect(job?.once).not.toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/cron.test.ts`
Expected: FAIL —— `once` 未透传(`job.once` undefined),文案不含「一次」。

- [ ] **Step 3: 实现**

在 `cron.ts` 的 `cronCreateToolDef.inputSchema.properties` 里 `permissionLevel` 之后加:
```ts
      once: {
        type: "boolean",
        description:
          "true = 一次性任务:到点跑一次后自动删除(用于「N 分钟后/明早 X 点提醒或干一件事」)。" +
          "默认 false = 按 schedule 反复跑。一次性也用 schedule 表达时间:'10m'=10 分钟后;" +
          "cron '0 7 25 6 *'=6 月 25 日 07:00 一次。",
      },
```

在 `cronCreateTool` 里,读取 `once` 并透传。把:
```ts
  const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
```
之后加:
```ts
  const once = args.once === true;
```
把 `cronScheduler.create(name, schedule, prompt, { ... })` 的 opts 加上:
```ts
      ...(once ? { once: true } : {}),
```
把返回文案改为区分一次性:
```ts
  const tz = job.timezone ? ` (${job.timezone})` : "";
  const next = job.nextRun ? new Date(job.nextRun).toLocaleString() : "n/a";
  if (job.once) {
    return `一次性任务 #${job.id} "${job.name}" 已创建。将于 ${next}${tz} 执行一次后自动删除。`;
  }
  return `Cron job #${job.id} "${job.name}" created. Schedule: ${job.schedule}${tz}. Next run: ${next}.`;
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/cron.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool-system/builtin/cron.ts packages/core/src/tool-system/builtin/cron.test.ts
git commit -m "feat(CronCreate): 暴露 once(一次性任务)参数 + 区分返回文案"
```

---

## Task 3: 删 ScheduleRoomTask 工具 + 注册 + preset

**Files:**
- Delete: `packages/core/src/tool-system/builtin/schedule-room-task.ts` + `.test.ts`
- Modify: `packages/core/src/tool-system/builtin/index.ts`(36, 485-494)
- Modify: `packages/core/src/tool-system/builtin/drive-claude-code.ts`(14)
- Modify: `packages/core/src/preset/index.ts`(82 + 注释)
- Modify: `packages/core/src/preset/preset-builtin-tools.test.ts`(42, 44, 50)

- [ ] **Step 1: 反转 preset 测试断言(先让它表达新契约)**

`preset-builtin-tools.test.ts`:把测试名与注释里的 `ScheduleRoomTask` 去掉,并把第 50 行
```ts
    expect(general.builtinTools).toContain("ScheduleRoomTask");
```
改为
```ts
    expect(general.builtinTools).not.toContain("ScheduleRoomTask");
```
测试名(42 行)`"...(DriveClaudeCode / ScheduleRoomTask)"` 改为 `"...(DriveClaudeCode;无 ScheduleRoomTask)"`。

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd packages/core && bun test src/preset/preset-builtin-tools.test.ts`
Expected: FAIL —— 当前白名单仍含 ScheduleRoomTask,`not.toContain` 失败。

- [ ] **Step 3: 删工具文件**

```bash
git rm packages/core/src/tool-system/builtin/schedule-room-task.ts \
       packages/core/src/tool-system/builtin/schedule-room-task.test.ts
```

- [ ] **Step 4: 删 builtin/index.ts 的 import 与注册块**

删第 36 行:
```ts
import { scheduleRoomTaskToolDef, scheduleRoomTaskTool } from "./schedule-room-task.js";
```
删 485-494 的整个注册对象(`{ definition: { ...scheduleRoomTaskToolDef, ... }, execute: scheduleRoomTaskTool },`)。

- [ ] **Step 5: 删 preset 白名单条目 + 改注释**

`preset/index.ts`:删第 82 行 `"ScheduleRoomTask",`。把其上方那段解释 cc-orchestrator 工具的注释中提及 `ScheduleRoomTask` 的话改为:只保留 `DriveClaudeCode`;补一句「定时/循环统一走 CronCreate(无人值守由 DriveClaudeCode 自身 bypass 解决)」。

- [ ] **Step 6: 改 DriveClaudeCode 描述**

`drive-claude-code.ts` 第 13-14 行,把
```ts
    "This runs ONE turn then exits — it has NO time concept. For 'in N minutes' / 'every N' / " +
    "looping, use ScheduleRoomTask instead (never sleep). " +
```
改为
```ts
    "This runs ONE turn then exits — it has NO time concept. For 'in N minutes' / 'every N' / " +
    "looping, use CronCreate instead (never sleep). A scheduled CronCreate job runs one codeshell " +
    "turn whose prompt can instruct it to call DriveClaudeCode; to continue a prior CC session " +
    "across runs, have that turn pass the sessionId this tool returned as resumeSessionId. " +
```

- [ ] **Step 7: 跑 preset 测试,确认通过**

Run: `cd packages/core && bun test src/preset/preset-builtin-tools.test.ts`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add -A packages/core/src/tool-system/builtin/index.ts \
           packages/core/src/tool-system/builtin/drive-claude-code.ts \
           packages/core/src/preset/index.ts \
           packages/core/src/preset/preset-builtin-tools.test.ts
git commit -m "refactor: 删 ScheduleRoomTask 工具,定时统一走 CronCreate"
```

---

## Task 4: 删 CCTaskStore + cc-scheduler-binding 执行链

**Files:**
- Delete: `packages/core/src/cc-orchestrator/cc-task-store.ts` + `.test.ts`
- Delete: `packages/core/src/cc-orchestrator/cc-scheduler-binding.ts` + `.test.ts`
- Modify: `packages/core/src/cc-orchestrator/index.ts`(删第 6、7 行 re-export)

- [ ] **Step 1: 删文件 + re-export**

```bash
git rm packages/core/src/cc-orchestrator/cc-task-store.ts \
       packages/core/src/cc-orchestrator/cc-task-store.test.ts \
       packages/core/src/cc-orchestrator/cc-scheduler-binding.ts \
       packages/core/src/cc-orchestrator/cc-scheduler-binding.test.ts
```
在 `cc-orchestrator/index.ts` 删这两行:
```ts
export * from "./cc-task-store.js";
export * from "./cc-scheduler-binding.js";
```
(保留 `export * from "./relevance-judge.js";`。)

- [ ] **Step 2: tsc 当守卫,扫 core 内悬空引用**

Run: `cd packages/core && bunx tsc --noEmit`
Expected: 0 错(core 内已无 `CCTaskStore`/`makeCCAwareExecutor` 消费者;desktop 是独立包,下一 Task 处理)。
若报错,按报错文件清理残留 import(预期无)。

- [ ] **Step 3: 跑 core 全量测试**

Run: `cd packages/core && bun test`
Expected: 全 PASS(被删测试已随文件移除)。

- [ ] **Step 4: 提交**

```bash
git add -A packages/core/src/cc-orchestrator/index.ts
git commit -m "refactor(cc-orchestrator): 删 CCTaskStore + cc-scheduler-binding 执行链(保留 relevance-judge)"
```

---

## Task 5: desktop 主进程回退到通用 executor + 删 CC 任务 IPC

**Files:**
- Modify: `packages/desktop/src/main/index.ts`(import 38-41、CC-aware 块 ~1033-1087、IPC handler 1723-1733)

- [ ] **Step 1: 删 CC-aware executor 块**

在 `main/index.ts` 删整段 `// ── CC-aware executor ──` 块(从 `{` 包裹的 `const ccScheduler = automationHandle.scheduler;` 到 `ccScheduler.setExecutor(ccAware);` 的 `}`,约 1033-1087)。保留其上方 `startAutomation({...})` 与 `setAutomationScheduler(...)`——`startAutomation` 默认装配的 executor(`bindCronToEngine`)即原 `automationFallback` 等价逻辑,所有 job 走它。

- [ ] **Step 2: 删 CC 任务 IPC handler**

删 1723-1733 的 `ccRoom:listTasks` 与 `ccRoom:deleteTask` 两个 `ipcMain.handle(...)`。保留同区其它 `ccRoom:*`(probe/listSessions/openSession/send/respondApproval 等)。

- [ ] **Step 3: 删不再使用的 import**

`main/index.ts` 顶部 import 块(38-41)删 `makeCCAwareExecutor`、`CCTaskStore`;`runAgentOnce` 与 `claudeAdapter` 若删块后无其它使用则一并删(用下一步 tsc 确认)。

- [ ] **Step 4: desktop tsc 守卫**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: 报 `CCRoomView` / preload 仍引用 `listTasks`/`deleteTask`(Task 6 处理),以及 import 未使用错。**先只修 main/index.ts 内的未使用 import**,留 CCRoomView/preload 给 Task 6。若 main 内仍有 `CCTaskMeta` 等类型引用残留,清掉。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/index.ts
git commit -m "refactor(desktop): cron 统一走默认 automation executor;删 CC 任务 IPC"
```

---

## Task 6: 下架 CCRoomView 定时任务区 + preload

**Files:**
- Modify: `packages/desktop/src/preload/index.ts`(804-805)
- Modify: `packages/desktop/src/preload/types.d.ts`(931-932 + CCTaskMeta 引用)
- Modify: `packages/desktop/src/renderer/cc-room/CCRoomView.tsx`(37-40, 45, 67, 158-186)

- [ ] **Step 1: 删 preload 暴露**

`preload/index.ts` 删第 804-805 行:
```ts
    listTasks: () => ipcRenderer.invoke("ccRoom:listTasks"),
    deleteTask: (jobId: string) => ipcRenderer.invoke("ccRoom:deleteTask", jobId),
```

- [ ] **Step 2: 删 preload 类型**

`preload/types.d.ts` 删第 931-932 行 `listTasks(...)` / `deleteTask(...)`。若该文件顶部为这两行 import 了 `CCTaskMeta` 且无其它使用,一并删该 import。

- [ ] **Step 3: 删 CCRoomView 任务区**

`CCRoomView.tsx`:
- 删 `CCTaskRow` 接口(37-40)。
- 删 `const [tasks, setTasks] = useState<CCTaskRow[]>([]);`(45)。
- `refresh` 里删 `void window.codeshell.ccRoom.listTasks().then(setTasks);`(67)。
- 删整个 `{/* Scheduled CC tasks */}` section(158-186)。
- 顶部 JSDoc(13-22)把「and the CC-backed scheduled tasks」「+ CCTaskMeta」措辞删掉,改为只描述 sessions。

- [ ] **Step 4: desktop tsc + 构建守卫**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: 0 错、构建成功(`window.codeshell.ccRoom.listTasks`/`deleteTask` 已无引用)。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/preload/index.ts \
        packages/desktop/src/preload/types.d.ts \
        packages/desktop/src/renderer/cc-room/CCRoomView.tsx
git commit -m "refactor(cc-room): 下架面板定时任务区(随 CCTaskStore 删除)"
```

---

## Task 8: 自动化界面区分一次性任务(消除「每 N 分钟」误导)

**背景:** `AutomationView` 用 `describeSchedule(j.schedule)` 显示节奏。一次性任务的 schedule 也是 `10m`/cron 表达式,在它跑掉自删之前会被错显成「每 10 分钟」(等同 RRULE `COUNT=1` 被显示成循环的误导)。让一次性任务显示「一次性 · <下次时间>」。

**Files:**
- Modify: `packages/desktop/src/main/automation-service.ts`(`AutomationSummary` 12-26、`toSummary` 44-60)
- Modify: `packages/desktop/src/preload/types.d.ts`(`AutomationSummary` 1228 附近,与 service 端同步)
- Modify: `packages/desktop/src/renderer/automation/AutomationView.tsx`(377 行 schedule 显示处)

- [ ] **Step 1: `AutomationSummary` 加 `once` 字段(两处定义同步)**

`automation-service.ts` 的 `AutomationSummary` 在 `lastRunId` 后加:
```ts
  once: boolean;
```
`preload/types.d.ts` 的 `AutomationSummary`(1228)同样加 `once: boolean;`(两处字段必须一致,否则 tsc 报跨 IPC 类型不符)。

- [ ] **Step 2: `toSummary` 透传 `once`**

`automation-service.ts` 的 `toSummary` 返回对象在 `lastRunId: job.lastRunId ?? null,` 后加:
```ts
    once: job.once === true,
```

- [ ] **Step 3: 渲染端区分显示**

`AutomationView.tsx` 第 377 行:
```tsx
                <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">{describeSchedule(j.schedule)}</span>
```
改为:
```tsx
                <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {j.once
                    ? `一次性${j.nextRun ? ` · ${new Date(j.nextRun).toLocaleString()}` : ""}`
                    : describeSchedule(j.schedule)}
                </span>
```

- [ ] **Step 4: desktop tsc + 构建守卫**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: 0 错、构建成功。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/automation-service.ts \
        packages/desktop/src/preload/types.d.ts \
        packages/desktop/src/renderer/automation/AutomationView.tsx
git commit -m "feat(automation): 一次性任务显示「一次性·时间」而非「每 N 分钟」"
```

---

## Task 9: 全量收口

- [ ] **Step 1: core 全量测试 + tsc**

Run: `cd packages/core && bun test && bunx tsc --noEmit`
Expected: 全 PASS、0 tsc 错。

- [ ] **Step 2: desktop tsc + 构建**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: 0 错、构建成功。

- [ ] **Step 3: 全仓残留 grep(应为空)**

Run:
```bash
grep -rn "ScheduleRoomTask\|CCTaskStore\|cc-task-store\|cc-scheduler-binding\|makeCCAwareExecutor\|runCCTask\|scheduleRoomTask\|ccRoom.listTasks\|ccRoom.deleteTask\|ccRoom:listTasks\|ccRoom:deleteTask" packages/*/src --include="*.ts" --include="*.tsx"
```
Expected: 无输出(`relevance-judge` 不在此列表,保留)。

- [ ] **Step 4: 最终提交(如有 colleftover)**

```bash
git add -A && git commit -m "chore: 调度去耦合收口 — 残留清理 + 全量绿" || echo "无残留改动"
```

---

## 备注

- 本计划在 worktree 内执行(用户规矩:打工走 worktree 别动 main)。完成后 rebase 本地 main → FF 合并。
- `~/.code-shell/cc-tasks.json` 是旧旁存文件,功能未 push、无需迁移、不主动删用户磁盘文件。
- 真机冒烟(让 AI 用 `CronCreate(once:true)` 定一个一次性 CC 任务、用 `CronCreate` 定一个循环 CC 任务,确认到点驱动 CC)留用户。
