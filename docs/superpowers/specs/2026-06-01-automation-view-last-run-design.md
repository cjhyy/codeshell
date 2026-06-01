# 自动化详情「最近运行」改为「查看」按钮 → 跳运行历史并选中 — Design

**Date**: 2026-06-01
**Status**: Approved design, pending spec review
**Related**: [[project-automation-run-sidebar]]

## Problem

自动化详情页有一行 `<FieldRow label="最近运行">{job.lastRunId ?? "—"}</FieldRow>`（`AutomationView.tsx:361`），直接把 `lastRunId`（一串 runId 乱码，如 `zlbqNwOQzb5ZtEK8`）显示给用户，毫无意义。

用户要求：把这行改成**一个按钮，点进去看那条 run 的详情**。详情呈现方式（用户拍板）：**跳到「运行历史」(RunsView) 页并自动选中该 run**。

## Decisions (locked with user)

| Topic | Decision |
|---|---|
| 「最近运行」这行 | 不显示 runId，改成一个「查看最近运行」按钮 |
| 点击后 | 切到 `viewMode: "runs"`（运行历史页），并自动选中 `job.lastRunId` 那条 run 显示详情 |
| 无 lastRunId 时 | 按钮 disabled / 显示「—」（job 还没跑过） |
| 状态存哪 | App 的**瞬态** React state（不写 `view.ts` 持久化）——「待选 run」不该在 reload 后存活 |

## Architecture

四处小改动，无 core、无 IPC、无新文件。

```
AutomationView「查看最近运行」按钮  ──onViewRun(lastRunId)──▶  App
                                                              │ setRunsInitialRunId(runId)
                                                              │ setViewMode("runs")
                                                              ▼
                                                    <RunsView initialRunId={runsInitialRunId} />
                                                              │ useEffect: 若 initialRunId 存在,
                                                              │ setSelected(initialRunId)(挂载/变化时)
                                                              ▼
                                                    getRun(initialRunId) → 详情渲染
```

### 改动 1 — App.tsx：瞬态 state + 回调 + 传 prop

- 新增 state：`const [runsInitialRunId, setRunsInitialRunId] = useState<string | null>(null);`（瞬态，不进 view.ts）。
- `AutomationView` 挂载处（App.tsx:1242）加回调 prop：
  ```tsx
  <AutomationView
    onCreateConversational={startConversationalAutomation}
    onViewRun={(runId) => { setRunsInitialRunId(runId); setViewMode("runs"); }}
  />
  ```
- `RunsView` 挂载处（App.tsx:1240）传 prop：
  ```tsx
  <RunsView initialRunId={runsInitialRunId} />
  ```
- （可选清理）当离开 runs 视图或 RunsView 消费后无需主动清 `runsInitialRunId`——它只在切到 runs 且 RunsView mount 时被读一次；留着不影响（下次从自动化页再点会覆盖成新值）。为避免「手动从侧栏进运行历史时被旧值预选」的轻微突兀，在 `setViewMode` 切到非 automation→runs 的其它入口时不设它即可（默认 null）。**简化**：手动进 runs 时 `runsInitialRunId` 是上一次的值——可能预选一条旧 run。为干净起见，RunsView 只在「initialRunId 变化且非 null」时预选（见改动 3），且 App 在每次 `onViewRun` 设新值；其它切到 runs 的入口不碰它。可接受的轻微副作用：从别处进 runs 可能预选最后一次 onViewRun 的 run。若要彻底干净，可在 RunsView 消费后回调 App 清空——本设计**不做**（YAGNI），预选一条已存在的 run 无害。

### 改动 2 — AutomationView.tsx：props 加 onViewRun + 那行改按钮

- `AutomationView` 顶层 props 加 `onViewRun: (runId: string) => void`，下传给 `AutomationDetail`（`AutomationDetail` props 加同名）。
- 把 `AutomationView.tsx:361` 那行替换：
  ```tsx
  <FieldRow label="最近运行">
    {job.lastRunId ? (
      <Button size="sm" variant="outline" onClick={() => props.onViewRun(job.lastRunId!)}>
        查看
      </Button>
    ) : (
      "—"
    )}
  </FieldRow>
  ```
  （`Button` 已 import。`onViewRun` 在 `AutomationView` 与 `AutomationDetail` props 里都是**必填** `(runId: string) => void`。`job.lastRunId!` 的 `!` 是因为外层 `job.lastRunId ?` 已判 truthy，TS 在 onClick 闭包里收窄不到，故需 `!`。）

### 改动 3 — RunsView.tsx：接 initialRunId 并预选

- 组件签名 `export function RunsView({ initialRunId }: { initialRunId?: string | null })`。
- 现有 `const [selected, setSelected] = useState<string | null>(null);` 改为用 initialRunId 作初值：`useState<string | null>(initialRunId ?? null)`。
- 加一个 effect，使「从自动化页带着新的 initialRunId 跳进来」时也能更新选中（组件可能已挂载、仅 prop 变化）：
  ```tsx
  useEffect(() => {
    if (initialRunId) setSelected(initialRunId);
  }, [initialRunId]);
  ```
  现有 `useEffect([selected])` 会据此 `getRun(selected)` 拉详情并渲染——无需再改详情逻辑。

## Data flow

1. 自动化详情页「最近运行」行：有 `lastRunId` → 显示「查看」按钮；无 → 「—」。
2. 点「查看」→ `onViewRun(lastRunId)` → App 设 `runsInitialRunId` + 切 `viewMode:"runs"`。
3. RunsView（已挂载或新挂载）`initialRunId` 变化 → `setSelected(initialRunId)` → 既有 `[selected]` effect 调 `getRun` → 右侧渲染该 run 详情（复用现有 `RunDetailView`，含状态/摘要/检查点/事件）。

## Error handling

- `getRun` 对不存在的 runId 返回 `null`（main 侧已实现），RunsView 详情区显示「选一个 run 查看详情」——若 lastRunId 指向已删除的 run（如之前清理过），不崩，回落到空详情。可接受。
- `lastRunId` 不在当前 `runs` 列表（list 默认全量，应在）——即使不在列表，详情仍能通过 `getRun` 单独拉取并显示。

## Testing

- 主要为 UI 交互，靠 tsc + 手动验证。
- 手动：自动化详情页有 lastRunId 时显示「查看」按钮 → 点击 → 跳到运行历史页且右侧自动显示该 run 详情；无 lastRunId 时显示「—」。
- tsc + build：`cd packages/desktop && bunx tsc --noEmit && bun run build:renderer` 必须绿。
- 回归：`cd packages/desktop && bun test` 不变绿（157 pass）。

## Out of scope (YAGNI)

- 把 runsInitialRunId 持久化进 view.ts（瞬态即可，reload 不该记住）。
- RunsView 消费后回调清空 App 状态（预选一条已存在 run 无害，不值得加来回回调）。
- 「最近运行」之外其它行（下次运行/上次运行/运行次数/项目）——保持不动。
