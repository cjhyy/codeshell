# 自动化 cron 触发接力修复 + 详情页整理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 在对话里用 CronCreate 建的定时任务能真正触发（跨进程事件推送），并整理自动化详情页（绑定 session 单卡、相对时间、去重、权限对齐、时区双下拉可搜索）。

**Architecture:** worker 建/删 cron 后通过现成 stdio JSON-RPC 通道推 `agent/cronChanged` 通知 → main 拦截并 `loadJobs()` reload+arm，零轮询。详情页按 `resumeSessionId` 分流展示；新增 cmdk Combobox 通用件供时区城市搜索。

**Tech Stack:** TypeScript、Electron（core worker 进程 + main 进程 + renderer）、shadcn/ui + Radix + Tailwind v4 + cmdk、bun test、Vitest（renderer）。

**规矩：** 功能改动，全程在 worktree 内进行（执行前用 using-git-worktrees 创建）。改 core 后必须 rebuild core，desktop 有独立 typecheck/build（`cd packages/desktop && bunx tsc --noEmit`）。

---

## 设计来源

Spec: `docs/superpowers/specs/2026-07-01-automation-cron-delivery-and-detail-ui-design.md`

## 六块任务映射

- **A** 事件推送修 bug → Task 1–3
- **F** 时区双下拉（含 cmdk Combobox 前置）→ Task 4–6
- **D** 详情页整理 → Task 7
- **B** 绑定 session 单卡 → Task 8–9
- **C** 相对时间（并发排队天然满足，仅需相对时间）→ Task 10
- **E** 权限措辞/tone 对齐 → Task 11

---

## 文件结构总览

**core（worker 侧）：**
- `packages/core/src/automation/scheduler.ts` — 已有 `resumeSessionId`（确认，无需改）。
- `packages/core/src/tool-system/builtin/cron.ts` — CronCreate/CronDelete 成功后发 cronChanged 通知；CronCreate 默认时区改系统时区。
- `packages/core/src/cli/agent-server-stdio.ts` — 注入「发 cronChanged 通知」的 sink（拿 agentServer 的 notify 能力给 cron 工具）。
- `packages/core/src/tool-system/context.ts` 或工具上下文 — 传递 notify sink 给 cron 工具（视现有工具如何拿宿主回调而定）。

**desktop main：**
- `packages/desktop/src/main/automation-service.ts` — 导出 `reloadAutomations()`；`AutomationSummary` + `toSummary` 加 `resumeSessionId`。
- `packages/desktop/src/main/agent-bridge.ts` — 加 `maybeHandleCronChanged(line)` 拦截 worker→main 的 cronChanged，调 reload。

**desktop renderer：**
- `packages/desktop/src/renderer/components/ui/command.tsx`（新，shadcn 拷贝）
- `packages/desktop/src/renderer/components/ui/popover.tsx`（新，shadcn 拷贝）
- `packages/desktop/src/renderer/components/ui/combobox.tsx`（新，通用可搜索下拉）
- `packages/desktop/src/renderer/automation/timezones.ts`（新，时区列表 + 偏移 helper）
- `packages/desktop/src/renderer/automation/relativeTime.ts`（新，fmtRelative）
- `packages/desktop/src/renderer/automation/AutomationView.tsx` — B/C/D/E/F 详情页改造
- `packages/desktop/src/renderer/i18n/ns/automation.ts` — E/F 文案（zh+en）
- `packages/desktop/src/preload/types.d.ts` — `AutomationSummary` 加 `resumeSessionId`

---

## Task 1: worker cron 工具发 `agent/cronChanged` 通知（core 侧）

**背景：** worker 的 `cronCreateTool`/`cronDeleteTool`（`cron.ts`）成功后，需要一个可注入的回调通知宿主 cron 已变更。core 不认识 Electron，所以用模块级可注入 sink。

**Files:**
- Modify: `packages/core/src/tool-system/builtin/cron.ts`
- Test: `packages/core/src/tool-system/builtin/cron.cronchanged.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/core/src/tool-system/builtin/cron.cronchanged.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cronCreateTool, cronDeleteTool, setCronChangedSink } from "./cron.js";
import { cronScheduler } from "../../automation/scheduler.js";

describe("cron tools fire cronChanged sink", () => {
  let fired: string[] = [];
  beforeEach(() => {
    fired = [];
    setCronChangedSink(() => fired.push("changed"));
  });
  afterEach(() => {
    setCronChangedSink(null);
    for (const j of cronScheduler.list()) cronScheduler.delete(j.id);
  });

  test("CronCreate success fires the sink", async () => {
    const out = await cronCreateTool({ name: "t", schedule: "5m", prompt: "p" });
    expect(out).not.toMatch(/^Error/);
    expect(fired).toEqual(["changed"]);
  });

  test("CronDelete success fires the sink", async () => {
    const created = await cronCreateTool({ name: "t", schedule: "5m", prompt: "p" });
    fired = [];
    const id = created.match(/#(\d+)/)?.[1] ?? "";
    await cronDeleteTool({ jobId: id });
    expect(fired).toEqual(["changed"]);
  });

  test("CronCreate failure does NOT fire the sink", async () => {
    await cronCreateTool({ name: "t", schedule: "bogus", prompt: "p" });
    expect(fired).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/core && bun test src/tool-system/builtin/cron.cronchanged.test.ts`
Expected: FAIL —「setCronChangedSink is not exported」。

- [ ] **Step 3: 实现 sink**

在 `packages/core/src/tool-system/builtin/cron.ts` 顶部（import 之后）加：

```typescript
/** Sink notified after a cron job is created/deleted, so the host (Electron
 *  main) can reload+arm the scheduler that actually executes jobs. The worker
 *  process only persists cron jobs (executionEnabled=false); without this the
 *  host never learns about an AI-created job until the user opens the UI. */
type CronChangedSink = () => void;
let cronChangedSink: CronChangedSink | null = null;
export function setCronChangedSink(sink: CronChangedSink | null): void {
  cronChangedSink = sink;
}
function fireCronChanged(): void {
  try {
    cronChangedSink?.();
  } catch {
    // Notifying the host is best-effort; never break the tool on it.
  }
}
```

在 `cronCreateTool` 成功 return 之前（`job` 创建成功后、构造返回串处）插入 `fireCronChanged();`。具体：在 `const tz = job.timezone ? ...` 这一行**之前**加 `fireCronChanged();`。

在 `cronDeleteTool` 里，改成只在删除成功时 fire：

```typescript
export async function cronDeleteTool(args: Record<string, unknown>): Promise<string> {
  const id = args.jobId as string;
  if (!id) return "Error: jobId is required";
  const deleted = cronScheduler.delete(id);
  if (deleted) fireCronChanged();
  return deleted ? `Cron job #${id} deleted.` : `Cron job #${id} not found.`;
}
```

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/core && bun test src/tool-system/builtin/cron.cronchanged.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool-system/builtin/cron.ts packages/core/src/tool-system/builtin/cron.cronchanged.test.ts
git commit -m "feat(cron): worker cron 工具成功后触发 cronChanged sink"
```

---

## Task 2: worker 启动处接线 sink → 发 stdio 通知（core 侧）

**背景：** 把 Task 1 的 sink 接到 worker 的 stdio transport，让它真的往 stdout 写一条 `agent/cronChanged` JSON-RPC 通知。`StdioTransport.send()`（`transport.ts:98`）+ `createNotification`（types.js）是现成的。

**Files:**
- Modify: `packages/core/src/cli/agent-server-stdio.ts`
- Test: 手动验证（启动处接线，无独立单测；行为在 Task 3 端到端覆盖）

- [ ] **Step 1: 接线**

在 `packages/core/src/cli/agent-server-stdio.ts` 里，`stdioTransport` 创建之后（line 275 之后），加：

```typescript
import { setCronChangedSink } from "../tool-system/builtin/cron.js";
import { createNotification } from "../protocol/types.js";

// Route cron create/delete (from the agent's CronCreate/CronDelete tools) to a
// stdout notification so Electron main — the process that actually arms+executes
// cron timers — reloads immediately instead of only when the user opens the UI.
setCronChangedSink(() => {
  stdioTransport.send(createNotification("agent/cronChanged", {}));
});
```

（import 放文件顶部 import 区；`createNotification` 若已被 server.ts 用到，确认其从 `../protocol/types.js` 导出——探查已确认 `notify` 走 `createNotification`。）

- [ ] **Step 2: rebuild core + typecheck**

Run: `cd packages/core && bun run build && bunx tsc --noEmit`
Expected: 构建通过、无类型错误。

- [ ] **Step 3: 提交**

```bash
git add packages/core/src/cli/agent-server-stdio.ts
git commit -m "feat(cron): worker 启动接线 cronChanged sink→stdio 通知"
```

---

## Task 3: main 拦截 cronChanged → reload scheduler（desktop main）

**背景：** main 在 `agent-bridge.ts:155` 的 `rl.on("line")` 读 worker stdout。加一个 `maybeHandleCronChanged(line)`，命中就调 `reloadAutomations()` 并**不**转发给 renderer。先给 automation-service 导出 reload。

**Files:**
- Modify: `packages/desktop/src/main/automation-service.ts`
- Modify: `packages/desktop/src/main/agent-bridge.ts`
- Test: `packages/desktop/src/main/automation-service.test.ts`（扩展）

- [ ] **Step 1: 写失败测试（reload 导出）**

在 `packages/desktop/src/main/automation-service.test.ts` 末尾加：

```typescript
import { reloadAutomations, setAutomationScheduler } from "./automation-service.js";

test("reloadAutomations calls scheduler.loadJobs", () => {
  let loaded = 0;
  // Minimal scheduler stub — only loadJobs is exercised here.
  setAutomationScheduler({ loadJobs: () => { loaded++; } } as unknown as import("@cjhyy/code-shell-core").CronScheduler);
  reloadAutomations();
  expect(loaded).toBe(1);
  setAutomationScheduler(null);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/desktop && bun test src/main/automation-service.test.ts`
Expected: FAIL —「reloadAutomations is not exported」。

- [ ] **Step 3: 导出 reloadAutomations**

在 `packages/desktop/src/main/automation-service.ts`，把内部 `syncFromStore` 暴露为公开 reload：

```typescript
/** Reload cron jobs from the shared on-disk store into main's live scheduler,
 *  arming any newly-seen job. Called when the worker reports a cron change
 *  (agent/cronChanged) so an AI-created job takes effect without the user
 *  opening the automation UI. loadJobs() is idempotent. */
export function reloadAutomations(): void {
  scheduler?.loadJobs();
}
```

（`syncFromStore` 保留，内部继续用；`reloadAutomations` 就是它的公开别名。）

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/desktop && bun test src/main/automation-service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交（reload 导出）**

```bash
git add packages/desktop/src/main/automation-service.ts packages/desktop/src/main/automation-service.test.ts
git commit -m "feat(automation): 导出 reloadAutomations 供 cronChanged 触发"
```

- [ ] **Step 6: 在 agent-bridge 加拦截**

在 `packages/desktop/src/main/agent-bridge.ts` 的 `rl.on("line")` 内，紧接 `if (this.maybeHandleCredentialAction(line)) return;`（line 163）之后加：

```typescript
if (this.maybeHandleCronChanged(line)) return;
```

并在类里加方法（仿 `maybeHandleCredentialAction` 的结构）：

```typescript
/** Intercept the worker's `agent/cronChanged` notification: reload main's
 *  cron scheduler so an AI-created/deleted job arms immediately. Returns true
 *  (consume, don't forward to renderer) when handled. */
private maybeHandleCronChanged(line: string): boolean {
  let parsed: { method?: string };
  try { parsed = JSON.parse(line); } catch { return false; }
  if (parsed.method !== "agent/cronChanged") return false;
  try {
    reloadAutomations();
  } catch (err) {
    dlog("bridge", "cronChanged.reload_failed", { error: String(err) });
  }
  return true;
}
```

在 `agent-bridge.ts` 顶部 import 加：`import { reloadAutomations } from "./automation-service.js";`

- [ ] **Step 7: typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 8: 提交（拦截接线）**

```bash
git add packages/desktop/src/main/agent-bridge.ts
git commit -m "feat(automation): main 拦截 agent/cronChanged 即时 reload scheduler"
```

---

## Task 4: 装 cmdk + 拷 shadcn command.tsx / popover.tsx（renderer）

**背景：** 时区城市下拉需可搜索。按 shadcn 标准做法用 cmdk。这两个是 shadcn 官方组件源码，直接拷进 `components/ui/`。

**Files:**
- Modify: `packages/desktop/package.json`（加 cmdk、@radix-ui/react-popover 依赖）
- Create: `packages/desktop/src/renderer/components/ui/command.tsx`
- Create: `packages/desktop/src/renderer/components/ui/popover.tsx`

- [ ] **Step 1: 装依赖**

Run:
```bash
cd packages/desktop && bun add cmdk @radix-ui/react-popover
```
Expected: package.json 出现 `cmdk` 和 `@radix-ui/react-popover`。

- [ ] **Step 2: 拷 popover.tsx**

Create `packages/desktop/src/renderer/components/ui/popover.tsx`（shadcn 标准，Tailwind token 版）:

```tsx
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-md border border-border bg-popover p-0 text-popover-foreground shadow-md outline-none",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent };
```

- [ ] **Step 3: 拷 command.tsx**

Create `packages/desktop/src/renderer/components/ui/command.tsx`（shadcn 标准，去掉 Dialog 变体，只留列表版）:

```tsx
import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn("flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground", className)}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center border-b border-border px-3">
    <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List ref={ref} className={cn("max-h-64 overflow-y-auto overflow-x-hidden", className)} {...props} />
));
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-sm text-muted-foreground" {...props} />);
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group ref={ref} className={cn("overflow-hidden p-1 text-foreground", className)} {...props} />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem };
```

- [ ] **Step 4: typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: 无类型错误（若 `bg-popover`/`text-popover-foreground` token 未定义，改用 `bg-card`/`text-foreground`——先跑 typecheck，token 缺失不会报 ts 错，构建时才见；见 Step 5）。

- [ ] **Step 5: 构建验证 token**

Run: `cd packages/desktop && bun run build:renderer`
Expected: 构建通过。若报未知 token，把 `bg-popover`→`bg-card`、`text-popover-foreground`→`text-foreground`、`bg-accent`→`bg-muted`、`text-accent-foreground`→`text-foreground` 后重跑。

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/package.json packages/desktop/bun.lock packages/desktop/src/renderer/components/ui/command.tsx packages/desktop/src/renderer/components/ui/popover.tsx
git commit -m "feat(ui): 加 cmdk + shadcn command/popover 组件"
```

---

## Task 5: 通用 Combobox 组件（renderer）

**背景：** 在 command+popover 之上封装一个 `Combobox`，接受 `{value,label}[]` 选项 + 当前值 + onChange，供时区城市下拉及将来复用。

**Files:**
- Create: `packages/desktop/src/renderer/components/ui/combobox.tsx`
- Test: `packages/desktop/src/renderer/components/ui/combobox.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `packages/desktop/src/renderer/components/ui/combobox.test.tsx`:

```tsx
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Combobox } from "./combobox";

const OPTS = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana" },
];

describe("Combobox", () => {
  test("shows current label on trigger", () => {
    render(<Combobox options={OPTS} value="b" onChange={() => {}} placeholder="pick" />);
    expect(screen.getByRole("button")).toHaveTextContent("Banana");
  });

  test("selecting an option calls onChange with its value", () => {
    const onChange = vi.fn();
    render(<Combobox options={OPTS} value="a" onChange={onChange} placeholder="pick" />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByText("Banana"));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/desktop && bunx vitest run src/renderer/components/ui/combobox.test.tsx`
Expected: FAIL —「Cannot find module './combobox'」。

- [ ] **Step 3: 实现 Combobox**

Create `packages/desktop/src/renderer/components/ui/combobox.tsx`:

```tsx
import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Popover, PopoverTrigger, PopoverContent } from "./popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from "./command";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Optional muted suffix shown after the label (e.g. "UTC+8"). */
  hint?: string;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  triggerClassName?: string;
}

/** A searchable single-select dropdown (cmdk + popover). Reusable across the
 *  app wherever a plain <Select> has too many options to scroll. */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  className,
  triggerClassName,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("h-8 justify-between font-normal", triggerClassName)}
        >
          <span className="truncate">{current ? current.label : placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn("w-[var(--radix-popover-trigger-width)] min-w-[200px]", className)}>
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.value}
                value={`${o.label} ${o.hint ?? ""}`}
                onSelect={() => { onChange(o.value); setOpen(false); }}
              >
                <Check className={cn("mr-2 h-4 w-4", o.value === value ? "opacity-100" : "opacity-0")} />
                <span className="truncate">{o.label}</span>
                {o.hint && <span className="ml-auto text-xs text-muted-foreground">{o.hint}</span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/desktop && bunx vitest run src/renderer/components/ui/combobox.test.tsx`
Expected: PASS。（若 cmdk 的 value 匹配导致点击定位问题，测试用 `screen.getByText("Banana")` 已足够稳。）

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/renderer/components/ui/combobox.tsx packages/desktop/src/renderer/components/ui/combobox.test.tsx
git commit -m "feat(ui): 通用可搜索 Combobox 组件"
```

---

## Task 6: 时区双下拉（城市 Combobox + UTC 偏移过滤）（renderer, F）

**背景：** 时区列表来自 `Intl.supportedValuesOf('timeZone')`（引擎内置，非硬编码）。城市下拉用 Combobox；UTC 偏移下拉过滤城市列表。存的始终是 IANA 城市。

**Files:**
- Create: `packages/desktop/src/renderer/automation/timezones.ts`
- Test: `packages/desktop/src/renderer/automation/timezones.test.ts`
- Modify: `packages/desktop/src/renderer/automation/AutomationView.tsx`（替换现有时区 FieldRow）

- [ ] **Step 1: 写失败测试（timezones helper）**

Create `packages/desktop/src/renderer/automation/timezones.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { allTimezones, offsetLabel, offsetBucket, uniqueOffsetBuckets } from "./timezones";

describe("timezones", () => {
  test("allTimezones comes from the engine and includes UTC + Shanghai", () => {
    const zones = allTimezones();
    expect(zones.length).toBeGreaterThan(100); // engine list is hundreds, not hardcoded 6
    expect(zones).toContain("UTC");
    expect(zones).toContain("Asia/Shanghai");
  });

  test("offsetLabel formats as UTC±H", () => {
    expect(offsetLabel("Asia/Shanghai")).toBe("UTC+8");
    expect(offsetLabel("UTC")).toBe("UTC+0");
  });

  test("offsetBucket is a stable number of minutes for filtering", () => {
    expect(offsetBucket("Asia/Shanghai")).toBe(480);
    expect(offsetBucket("UTC")).toBe(0);
  });

  test("uniqueOffsetBuckets are sorted ascending", () => {
    const b = uniqueOffsetBuckets();
    expect(b[0]).toBeLessThan(b[b.length - 1]);
    expect(b).toContain(480);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/timezones.test.ts`
Expected: FAIL —「Cannot find module './timezones'」。

- [ ] **Step 3: 实现 timezones helper**

Create `packages/desktop/src/renderer/automation/timezones.ts`:

```typescript
/** Timezone data derived entirely from the JS engine (Intl) — no hardcoded
 *  list to maintain. `allTimezones()` returns every IANA zone the runtime
 *  supports; offsets are computed via Intl.DateTimeFormat so DST is reflected
 *  at compute time. The stored value is always an IANA id (handles DST); the
 *  UTC-offset dropdown is only a filter over these. */

/** Every IANA timezone the engine supports (hundreds). Falls back to a tiny
 *  set only if the runtime lacks supportedValuesOf (very old engines). */
export function allTimezones(): string[] {
  const withSupported = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  if (typeof withSupported.supportedValuesOf === "function") {
    return withSupported.supportedValuesOf("timeZone");
  }
  return ["UTC", "Asia/Shanghai", "America/New_York", "Europe/London", "Asia/Tokyo"];
}

/** Offset in minutes east of UTC for a zone at "now" (e.g. Asia/Shanghai=480). */
export function offsetBucket(tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
    // raw like "GMT+8", "GMT-5:30", "GMT" (=UTC)
    const m = raw.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    const h = parseInt(m[2], 10);
    const min = m[3] ? parseInt(m[3], 10) : 0;
    return sign * (h * 60 + min);
  } catch {
    return 0;
  }
}

/** "UTC+8" / "UTC-5:30" / "UTC+0" label for a zone. */
export function offsetLabel(tz: string): string {
  const b = offsetBucket(tz);
  const sign = b < 0 ? "-" : "+";
  const abs = Math.abs(b);
  const h = Math.floor(abs / 60);
  const min = abs % 60;
  return min === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(min).padStart(2, "0")}`;
}

/** Distinct offset buckets across all zones, sorted ascending — the UTC-offset
 *  dropdown options. */
export function uniqueOffsetBuckets(): number[] {
  const set = new Set<number>();
  for (const tz of allTimezones()) set.add(offsetBucket(tz));
  return [...set].sort((a, b) => a - b);
}

/** "UTC+8" label from a raw bucket (for the offset dropdown). */
export function bucketLabel(bucket: number): string {
  const sign = bucket < 0 ? "-" : "+";
  const abs = Math.abs(bucket);
  const h = Math.floor(abs / 60);
  const min = abs % 60;
  return min === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(min).padStart(2, "0")}`;
}

/** System IANA zone, for the new-job default. */
export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/timezones.test.ts`
Expected: PASS。（若 CI 时区非东八区，`offsetBucket("Asia/Shanghai")` 仍为 480，因为按 tz 计算与本机无关。）

- [ ] **Step 5: 在 AutomationView 替换时区 FieldRow**

在 `packages/desktop/src/renderer/automation/AutomationView.tsx`：
1. 顶部 import 加：
```tsx
import { Combobox } from "@/components/ui/combobox";
import { allTimezones, offsetLabel, offsetBucket, uniqueOffsetBuckets, bucketLabel } from "./timezones";
```
2. 删除旧的 `BASE_TIMEZONES`（line ~80）、`timezoneOptions`（line ~89）、`tzOptions`（line 518）、以及旧 `offsetNote`/`systemTimezone`（被 timezones.ts 取代——若别处仍用则保留，仅删自动化内的重复；grep 确认无其他消费者后删）。
3. 在 `AutomationDetail` 组件内，job 之上加 UTC 过滤 state：
```tsx
const [tzOffsetFilter, setTzOffsetFilter] = React.useState<number | "all">("all");
const tzCityOptions = React.useMemo(
  () =>
    allTimezones()
      .filter((z) => tzOffsetFilter === "all" || offsetBucket(z) === tzOffsetFilter)
      .map((z) => ({ value: z, label: z, hint: offsetLabel(z) })),
  [tzOffsetFilter],
);
const offsetOptions = React.useMemo(
  () => [
    { value: "all", label: t("auto.detail.tzAllOffsets") },
    ...uniqueOffsetBuckets().map((b) => ({ value: String(b), label: bucketLabel(b) })),
  ],
  [t],
);
```
4. 替换现有时区 `FieldRow`（line 702-714）为双控件：
```tsx
<FieldRow label={t("auto.detail.timezone")}>
  <div className="flex items-center gap-2">
    <Combobox
      options={offsetOptions}
      value={tzOffsetFilter === "all" ? "all" : String(tzOffsetFilter)}
      onChange={(v) => setTzOffsetFilter(v === "all" ? "all" : Number(v))}
      triggerClassName="w-[110px]"
      searchPlaceholder={t("auto.detail.tzSearch")}
    />
    <Combobox
      options={tzCityOptions}
      value={job.timezone ?? "UTC"}
      onChange={(v) => { if (v !== job.timezone) props.onSave({ timezone: v }); }}
      triggerClassName="w-[200px]"
      searchPlaceholder={t("auto.detail.tzSearch")}
      emptyText={t("auto.detail.tzEmpty")}
    />
  </div>
</FieldRow>
```

- [ ] **Step 6: 加 i18n key（zh + en）**

在 `packages/desktop/src/renderer/i18n/ns/automation.ts` 的 zh `detail` 块加：
```typescript
tzAllOffsets: "全部时区",
tzSearch: "搜索城市/时区",
tzEmpty: "无匹配时区",
```
en `detail` 块加：
```typescript
tzAllOffsets: "All offsets",
tzSearch: "Search city / zone",
tzEmpty: "No matching zone",
```

- [ ] **Step 7: 新建默认系统时区**

在 `packages/core/src/tool-system/builtin/cron.ts` 的 `cronCreateTool`，把 timezone 解析改为默认系统时区（当 cron 表达式型且未传 timezone 时）。找到 `const timezone = typeof args.timezone === "string" ? args.timezone : undefined;`，改为：
```typescript
const timezone =
  typeof args.timezone === "string"
    ? args.timezone
    : (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
        catch { return undefined; }
      })();
```
（worker 进程的 Intl 反映宿主机器时区。）

- [ ] **Step 8: typecheck + build + 全测**

Run:
```bash
cd packages/desktop && bunx tsc --noEmit && bun run build:renderer
cd ../core && bun run build
```
Expected: 全通过。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat(automation): 时区双下拉(城市Combobox+UTC偏移过滤)+默认系统时区"
```

---

## Task 7: 详情页去重 + 「配置」分区（renderer, D）

**背景：** 删掉与 stat 卡/session 区重复的 FieldRow（状态/下次运行/上次运行/最近运行），可编辑项归「配置」小标题分区。stat 卡三格改为 下次运行/上次运行/运行次数。

**Files:**
- Modify: `packages/desktop/src/renderer/automation/AutomationView.tsx`
- Modify: `packages/desktop/src/renderer/i18n/ns/automation.ts`（新增 configSection 标题 key）
- Test: `packages/desktop/src/renderer/automation/AutomationView.dedup.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `packages/desktop/src/renderer/automation/AutomationView.dedup.test.tsx`:

```tsx
import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AutomationDetail } from "./AutomationView";
// NOTE: AutomationDetail must be exported for this test (add `export` in Step 3).

// Minimal props stub — only fields the detail panel reads.
const job = {
  id: "1", name: "夜间复查", schedule: "0 22 * * *", prompt: "p",
  enabled: true, cwd: null, timezone: "Asia/Shanghai", permissionLevel: "read-only",
  lastRun: Date.now() - 86400000, nextRun: Date.now() + 3600000, runCount: 12,
  createdAt: 0, lastRunId: null, once: false, resumeSessionId: null,
} as const;

const noop = () => {};
const baseProps = {
  job, repos: [], toggleBusy: false, runNowBusy: false, deleteBusy: false, saveBusy: false,
  onToggleEnabled: noop, onRunNow: noop, onDelete: noop, onSave: noop, onViewRun: noop,
  sessionLinks: [], onOpenSession: noop,
} as never;

describe("AutomationDetail dedup", () => {
  test("does not render duplicate FieldRow labels for 下次运行/上次运行/最近运行/状态", () => {
    render(<AutomationDetail {...baseProps} />);
    // stat cards use their own labels; FieldRow duplicates must be gone.
    // 下次运行 appears once (stat card), not twice.
    expect(screen.getAllByText("下次运行").length).toBe(1);
    expect(screen.getAllByText("上次运行").length).toBe(1);
    // 状态 FieldRow removed (state is the header switch).
    expect(screen.queryByText("状态")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/AutomationView.dedup.test.tsx`
Expected: FAIL（AutomationDetail 未 export 或重复标签仍在）。

- [ ] **Step 3: 改 AutomationView**

在 `AutomationView.tsx`：
1. 确保 `AutomationDetail` 有 `export`（`export function AutomationDetail(...)`）。
2. stat 卡三格（line 570-583）第三格从「历史 session」改为「运行次数」：
```tsx
<div className="rounded-md border bg-card p-3">
  <span className="text-xs text-muted-foreground">{t("auto.detail.runTimes")}</span>
  <strong className="mt-1 block text-sm text-foreground">{job.runCount}</strong>
</div>
```
3. 删除 FieldRow 区里这些行：`状态`（622-633）、`下次运行`（734）、`上次运行`（735）、`运行次数`（736，已移到 stat 卡）、`最近运行`（753-762）。
4. 剩下的可编辑 FieldRow（频率/时区/权限/项目）外层卡片加「配置」小标题：在这些 FieldRow 的容器 `<div className="rounded-md border bg-card p-3">`（line 621）内、首个 FieldRow 之前加：
```tsx
<p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("auto.detail.configSection")}</p>
```

- [ ] **Step 4: 加 i18n key**

zh `detail` 块加 `configSection: "配置",`；en 块加 `configSection: "Configuration",`。

- [ ] **Step 5: 运行验证通过**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/AutomationView.dedup.test.tsx`
Expected: PASS。

- [ ] **Step 6: typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor(automation): 详情页去重+可编辑项归配置分区"
```

---

## Task 8: AutomationSummary 透出 resumeSessionId（main + preload）

**Files:**
- Modify: `packages/desktop/src/main/automation-service.ts`
- Modify: `packages/desktop/src/preload/types.d.ts`
- Test: `packages/desktop/src/main/automation-service.test.ts`（扩展）

- [ ] **Step 1: 写失败测试**

在 `automation-service.test.ts` 加：

```typescript
test("summary carries resumeSessionId from the job", () => {
  setAutomationScheduler(realSchedulerForTest()); // uses the existing test helper/pattern in this file
  const created = createAutomation({ name: "n", schedule: "5m", prompt: "p" });
  // createAutomation path doesn't set resumeSessionId; assert the field exists and is null.
  expect(created).toHaveProperty("resumeSessionId");
  expect(created.resumeSessionId).toBeNull();
});
```

（若文件已有 scheduler 构造 helper，用之；否则用现有 `setAutomationScheduler` + 真 `CronScheduler` 模式，与文件内既有测试一致。）

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/desktop && bun test src/main/automation-service.test.ts`
Expected: FAIL（resumeSessionId 不存在）。

- [ ] **Step 3: 加字段**

`automation-service.ts`：
- `AutomationSummary` 接口加：`resumeSessionId: string | null;`
- `toSummary()` 加：`resumeSessionId: job.resumeSessionId ?? null,`

`preload/types.d.ts` 的 `AutomationSummary`（line ~1359）加同一字段：`resumeSessionId: string | null;`

- [ ] **Step 4: 运行验证通过 + typecheck**

Run: `cd packages/desktop && bun test src/main/automation-service.test.ts && bunx tsc --noEmit`
Expected: PASS + 无类型错误。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/automation-service.ts packages/desktop/src/preload/types.d.ts packages/desktop/src/main/automation-service.test.ts
git commit -m "feat(automation): AutomationSummary 透出 resumeSessionId"
```

---

## Task 9: 绑定 session 详情页分流（单卡 + 续接 badge）（renderer, B）

**背景：** 有 resumeSessionId → 顶部 `🔗 续接对话` badge + 「绑定的对话」单卡（隐藏历史列表）；无 → 现有历史列表。

**Files:**
- Modify: `packages/desktop/src/renderer/automation/AutomationView.tsx`
- Modify: `packages/desktop/src/renderer/i18n/ns/automation.ts`
- Test: `packages/desktop/src/renderer/automation/AutomationView.bound.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `AutomationView.bound.test.tsx`:

```tsx
import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AutomationDetail } from "./AutomationView";

const baseJob = {
  id: "1", name: "n", schedule: "0 22 * * *", prompt: "p", enabled: true,
  cwd: null, timezone: "UTC", permissionLevel: "read-only",
  lastRun: null, nextRun: Date.now() + 1000, runCount: 0, createdAt: 0,
  lastRunId: null, once: false,
};
const noop = () => {};
const mk = (over: Partial<typeof baseJob> & { resumeSessionId: string | null }) =>
  ({
    job: { ...baseJob, ...over }, repos: [], toggleBusy: false, runNowBusy: false,
    deleteBusy: false, saveBusy: false, onToggleEnabled: noop, onRunNow: noop,
    onDelete: noop, onSave: noop, onViewRun: noop, sessionLinks: [], onOpenSession: noop,
  }) as never;

describe("AutomationDetail bound-session branch", () => {
  test("resumeSessionId set → shows 续接对话 badge + bound card, hides history list", () => {
    render(<AutomationDetail {...mk({ resumeSessionId: "sess-9" })} />);
    expect(screen.getByText("续接对话")).toBeTruthy();
    expect(screen.getByText("绑定的对话")).toBeTruthy();
    expect(screen.queryByText("运行 session")).toBeNull();
  });

  test("resumeSessionId null → shows history list, no bound card", () => {
    render(<AutomationDetail {...mk({ resumeSessionId: null })} />);
    expect(screen.queryByText("续接对话")).toBeNull();
    expect(screen.getByText("运行 session")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/AutomationView.bound.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现分流**

`AutomationView.tsx`：
1. import 加 `Link2` icon：`import { Link2 } from "lucide-react";`（lucide 已在用）。
2. 在卡片头（line 531-534，name+schedule 那块）name 下方，条件渲染 badge：
```tsx
{job.resumeSessionId && (
  <Badge variant="outline" className="mt-1 border-[hsl(199_89%_55%/0.4)] bg-[hsl(199_89%_55%/0.12)] text-[hsl(199_89%_55%)]">
    <Link2 size={11} className="mr-1" />{t("auto.detail.resumeBadge")}
  </Badge>
)}
```
3. 把 session 区（line 765 起「运行 session」卡）包成条件：
```tsx
{job.resumeSessionId ? (
  <div className="rounded-md border bg-card p-3">
    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("auto.detail.boundConversation")}</p>
    {(() => {
      const bound = props.sessionLinks.find((l) => (l.session.engineSessionId ?? l.session.id) === job.resumeSessionId);
      if (!bound) return <p className="text-sm text-muted-foreground">{t("auto.detail.boundNotFound")}</p>;
      return (
        <div className="flex flex-col gap-2 rounded-md border border-[hsl(199_89%_55%/0.3)] bg-[hsl(199_89%_55%/0.06)] p-3">
          <div className="flex items-center gap-2">
            <Link2 size={14} className="text-[hsl(199_89%_55%)]" />
            <span className="truncate text-sm font-medium">{bound.session.title || t("auto.detail.untitled")}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {bound.session.runStatus && <Badge variant="outline">{runStatusLabel(t, bound.session.runStatus)}</Badge>}
            <span>{shortDate(bound.run?.updatedAt ?? bound.session.updatedAt)}</span>
          </div>
          <Button size="sm" variant="outline" className="self-start" onClick={() => props.onOpenSession(bound)}>
            {t("auto.detail.openConversation")} →
          </Button>
        </div>
      );
    })()}
  </div>
) : (
  /* existing history-list card (the current line 765 block) */
  <div className="rounded-md border bg-card p-3">
    {/* ...unchanged existing 运行 session list... */}
  </div>
)}
```
（`runStatusLabel`、`shortDate`、`props.sessionLinks`、`props.onOpenSession` 均为文件内既有——确认名字，探查已见 `runStatusLabel(t, status)`、`shortDate()`、`sessionLinks`。若 `onOpenSession` 参数签名不同，按现有历史列表的点击 handler 对齐。）

- [ ] **Step 4: 加 i18n key（zh + en）**

zh `detail`：
```typescript
resumeBadge: "续接对话",
boundConversation: "绑定的对话",
boundNotFound: "绑定的对话尚未运行过",
openConversation: "打开对话",
untitled: "未命名对话",
```
en `detail`：
```typescript
resumeBadge: "Resumes chat",
boundConversation: "Bound conversation",
boundNotFound: "Bound conversation hasn't run yet",
openConversation: "Open conversation",
untitled: "Untitled",
```

- [ ] **Step 5: 运行验证通过**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/AutomationView.bound.test.tsx`
Expected: PASS（两用例）。

- [ ] **Step 6: typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(automation): 绑定 session 详情页单卡+续接标识"
```

---

## Task 10: 下次/上次运行相对时间（renderer, C）

**背景：** stat 卡的下次/上次运行改「约 X 后 / X 前」相对时间 + 小字绝对。（并发排队：`enqueueTurn` 已天然排队，无需额外代码——见 spec；此任务只做相对时间。）

**Files:**
- Create: `packages/desktop/src/renderer/automation/relativeTime.ts`
- Test: `packages/desktop/src/renderer/automation/relativeTime.test.ts`
- Modify: `packages/desktop/src/renderer/automation/AutomationView.tsx`
- Modify: `packages/desktop/src/renderer/i18n/ns/automation.ts`

- [ ] **Step 1: 写失败测试**

Create `relativeTime.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { fmtRelative } from "./relativeTime";

const t = ((k: string, o?: Record<string, unknown>) => `${k}:${JSON.stringify(o ?? {})}`) as never;

describe("fmtRelative", () => {
  const now = 1_000_000_000_000;
  test("future within an hour → minutes", () => {
    expect(fmtRelative(now + 10 * 60_000, t, now)).toContain("auto.rel.inMinutes");
  });
  test("future hours", () => {
    expect(fmtRelative(now + 3 * 3600_000, t, now)).toContain("auto.rel.inHours");
  });
  test("past → ago", () => {
    expect(fmtRelative(now - 2 * 3600_000, t, now)).toContain("auto.rel.hoursAgo");
  });
  test("null → dash", () => {
    expect(fmtRelative(null, t, now)).toBe("—");
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/relativeTime.test.ts`
Expected: FAIL（无模块）。

- [ ] **Step 3: 实现 fmtRelative**

Create `relativeTime.ts`:

```typescript
import type { TranslationKey } from "../i18n/dict";

type T = (k: TranslationKey, o?: Record<string, unknown>) => string;

/** Relative time for cron next/last run — "约 3 小时后" / "2 小时前". `now` is
 *  injectable for testing. Returns "—" for null. Keys resolved via t(). */
export function fmtRelative(ms: number | null, t: T, now = Date.now()): string {
  if (ms == null) return "—";
  const diff = ms - now;
  const future = diff >= 0;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  const hr = Math.round(abs / 3_600_000);
  const day = Math.round(abs / 86_400_000);
  if (min < 1) return t("auto.rel.now" as TranslationKey);
  if (min < 60) return t((future ? "auto.rel.inMinutes" : "auto.rel.minutesAgo") as TranslationKey, { n: min });
  if (hr < 24) return t((future ? "auto.rel.inHours" : "auto.rel.hoursAgo") as TranslationKey, { n: hr });
  return t((future ? "auto.rel.inDays" : "auto.rel.daysAgo") as TranslationKey, { n: day });
}
```

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/relativeTime.test.ts`
Expected: PASS。

- [ ] **Step 5: 用到 stat 卡**

`AutomationView.tsx`：import `import { fmtRelative } from "./relativeTime";`。stat 卡「下次运行」「上次运行」两格改为相对时间 + 小字绝对：
```tsx
<div className="rounded-md border bg-card p-3">
  <span className="text-xs text-muted-foreground">{t("auto.detail.nextRun")}</span>
  <strong className="mt-1 block text-sm text-foreground">{fmtRelative(job.nextRun, t)}</strong>
  {job.nextRun != null && <span className="text-[10px] text-muted-foreground tabular-nums">{fmtTime(job.nextRun)}</span>}
</div>
```
上次运行同理（`job.lastRun`）。

- [ ] **Step 6: 加 i18n key（zh + en，带 {n} 插值）**

zh 新增 `rel` 块（在 automation ns zh 根下）：
```typescript
rel: {
  now: "刚刚",
  inMinutes: "约 {{n}} 分钟后",
  minutesAgo: "{{n}} 分钟前",
  inHours: "约 {{n}} 小时后",
  hoursAgo: "{{n}} 小时前",
  inDays: "约 {{n}} 天后",
  daysAgo: "{{n}} 天前",
},
```
en：
```typescript
rel: {
  now: "just now",
  inMinutes: "in ~{{n}} min",
  minutesAgo: "{{n}} min ago",
  inHours: "in ~{{n}} h",
  hoursAgo: "{{n}} h ago",
  inDays: "in ~{{n}} d",
  daysAgo: "{{n}} d ago",
},
```
（插值语法以本仓库 i18n 约定为准——探查 `t(c.labelKey)`/`t("auto.cadence.everyHours",{hours:h})` 已证明支持 `{{var}}` 或 `{var}`；对齐既有 `everyHours` 用法的花括号写法。）

- [ ] **Step 7: 运行全 automation 测 + build**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/ && bunx tsc --noEmit && bun run build:renderer`
Expected: 全 PASS + 构建通过。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(automation): 下次/上次运行相对时间显示"
```

---

## Task 11: 权限措辞/tone 向对话对齐（renderer, E）

**背景：** 三档不变，只改文案（加说明）+ tone 颜色，向对话 PermissionPill 的 ok/warn/err 靠拢。

**Files:**
- Modify: `packages/desktop/src/renderer/automation/AutomationView.tsx`（PERMISSION_OPTIONS 加 tone）
- Modify: `packages/desktop/src/renderer/i18n/ns/automation.ts`（三档文案加说明）
- Test: `packages/desktop/src/renderer/automation/AutomationView.perm.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `AutomationView.perm.test.tsx`:

```tsx
import { describe, test, expect } from "vitest";
import { PERMISSION_OPTIONS } from "./AutomationView";
// PERMISSION_OPTIONS must be exported (Step 3).

describe("permission options carry tone aligned with chat", () => {
  test("each option has a tone; full is err", () => {
    const full = PERMISSION_OPTIONS.find((p) => p.value === "full");
    const ro = PERMISSION_OPTIONS.find((p) => p.value === "read-only");
    expect(full?.tone).toBe("err");
    expect(ro?.tone).toBe("ok");
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/AutomationView.perm.test.tsx`
Expected: FAIL（PERMISSION_OPTIONS 未 export / 无 tone）。

- [ ] **Step 3: 加 tone**

`AutomationView.tsx`：`PERMISSION_OPTIONS`（line 35）改为带 tone 且 export：
```tsx
export const PERMISSION_OPTIONS: { value: string; labelKey: TranslationKey; tone: "ok" | "warn" | "err" }[] = [
  { value: "read-only", labelKey: "auto.permission.readOnly", tone: "ok" },
  { value: "workspace-write", labelKey: "auto.permission.workspaceWrite", tone: "warn" },
  { value: "full", labelKey: "auto.permission.full", tone: "err" },
];
```
在权限 Select 的 `SelectItem` 渲染（line 727-729）里，给 label 加 tone 颜色点：
```tsx
{PERMISSION_OPTIONS.map((p) => (
  <SelectItem key={p.value} value={p.value}>
    <span className={cn(
      "mr-2 inline-block h-2 w-2 rounded-full align-middle",
      p.tone === "ok" ? "bg-status-ok" : p.tone === "warn" ? "bg-status-warn" : "bg-status-err",
    )} />
    {t(p.labelKey)}
  </SelectItem>
))}
```

- [ ] **Step 4: 文案加说明**

`i18n/ns/automation.ts` 的 zh `permission` 块（line 51-55）改为：
```typescript
permission: {
  readOnly: "只读（只看不改）",
  workspaceWrite: "可写工作区（改本项目文件）",
  full: "完全（改文件 + 提 PR）",
},
```
en `permission` 块对齐：
```typescript
permission: {
  readOnly: "Read-only (look, don't touch)",
  workspaceWrite: "Workspace write (edit project files)",
  full: "Full (edit + open PRs)",
},
```

- [ ] **Step 5: 运行验证通过**

Run: `cd packages/desktop && bunx vitest run src/renderer/automation/AutomationView.perm.test.tsx`
Expected: PASS。

- [ ] **Step 6: typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(automation): 权限措辞加说明+tone颜色向对话对齐"
```

---

## Task 12: 端到端回归 + core 全测 + rebuild

**背景：** 全部改完后跑整套测试，确保无回归；rebuild core（tui/dist 依赖）。

- [ ] **Step 1: core 全测 + build**

Run: `cd packages/core && bun test && bun run build`
Expected: 全 PASS、构建通过。

- [ ] **Step 2: desktop 全测 + typecheck + build**

Run: `cd packages/desktop && bun test && bunx vitest run && bunx tsc --noEmit && bun run build:renderer`
Expected: 全 PASS。

- [ ] **Step 3: 仓库根 install（恢复 symlink，防 predist 物化）**

Run: `cd <repo root> && bun install`
Expected: 无报错。（见记忆 predist物化破坏desktop测试。）

- [ ] **Step 4: 最终提交（若有 lock/构建产物变动）**

```bash
git add -A
git commit -m "chore(automation): 全量回归通过 + rebuild"
```

---

## Self-Review

**Spec 覆盖：**
- A 事件推送 → Task 1（sink）+2（接线）+3（main 拦截 reload）✅
- B 绑定单卡 → Task 8（透出字段）+9（分流 UI）✅
- C 相对时间 + 并发排队 → Task 10（相对时间）；并发排队经探查确认 `enqueueTurn` 天然队列，无需代码，spec/plan 已说明 ✅
- D 详情页整理 → Task 7 ✅
- E 权限对齐 → Task 11 ✅
- F 时区双下拉 → Task 4（cmdk/command/popover）+5（Combobox）+6（时区双下拉+默认系统时区）✅

**占位符扫描：** 无 TBD/TODO；每个代码步都有完整代码。`AutomationDetail`/`PERMISSION_OPTIONS` 需 export 已在对应任务显式说明。

**类型一致：** `resumeSessionId: string | null`（main summary/preload）与 core `CronJob.resumeSessionId?: string`（`?? null` 归一）一致；`fmtRelative(ms, t, now?)` 签名测试与实现一致；`Combobox` props（options/value/onChange）测试与实现一致；`ComboboxOption{value,label,hint?}` 一致。

**已知实现时需现场确认（非占位，是集成点）：**
- `props.onOpenSession` / `sessionLinks` 项的精确形状——Task 9 用现有历史列表点击 handler 对齐（同文件既有代码）。
- i18n 插值花括号风格（`{{n}}` vs `{n}`）——对齐同 ns 既有 `everyHours` 用法。
- shadcn token 名（popover/accent）缺失时的降级——Task 4 Step 5 给了降级映射。
