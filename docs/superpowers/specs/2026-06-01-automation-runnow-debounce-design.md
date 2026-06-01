# Automation 操作按钮防重复点击 + Loading 状态 — Design

**Date**: 2026-06-01
**Status**: Approved design, pending spec review
**Related**: [[project-automation-run-sidebar]]（cron 堆叠 bug 的 UI 侧修复）, TODO.md「Bug — 2026-06-01」

## Problem

桌面「自动化」详情页的操作按钮（立即运行 / 删除 / 暂停-启用 Switch / 保存）共用一个 `act()` 包装（`AutomationView.tsx:69`），它**没有任何 in-flight 保护**：

```ts
const act = async (fn) => { try { await fn(); await refresh(); } catch (e) { setError(...) } };
```

按钮点完立刻可再点 → 连点 / 手抖会把同一个操作触发多次。对「立即运行」尤其严重：每点一次就 `runAutomationNow` → scheduler `fire` → `RunManager.submit` 一条新 run，连点就堆叠多条 run（实测同一 cron job 堆到 10 条）。

**根因定位（已确认）**：堆叠的真凶是 UI 这一层 —— 按钮无防重复 + 无 loading。core scheduler 的 `fire()` 再入守卫毫秒级失效是叠加因素，但既然「同一 cron job 允许多条并发」是期望行为（cron 到点就跑，重叠合法），cron 定时 tick 是分钟/天级、不会毫秒级重复，**唯一会毫秒级重复 submit 的来源就是无防护的「立即运行」按钮被连点**。所以本次**只修 UI**，core 不动（见决策）。

## Decisions (locked with user)

| Topic | Decision |
|---|---|
| 同 cron job 并发语义 | **允许同 job 多条并发**（cron 重叠合法）。不在 core 做「上一条没跑完就 skip」。 |
| 修复范围 | **只改 UI**（`AutomationView.tsx`）。core scheduler / RunManager 不动。 |
| Loading 粒度 | **每按钮独立**：只 disable + loading 正在执行的那个按钮，不影响其它按钮（可边删边改别的）。 |

## Architecture

单文件改动：`packages/desktop/src/renderer/automation/AutomationView.tsx`。无 core、无 IPC、无新文件。

`act()` 从「无状态」升级为「按 key 跟踪 in-flight」：

```
点击按钮 → act(key, fn)
  ├─ 若 pending[key] 已 true → 直接 return（防重复点击，幂等）
  ├─ 标记 pending[key] = true
  ├─ await fn(); await refresh()
  └─ finally: pending[key] = false（成功/失败都清除）

按钮渲染：disabled = pending[key]；触发中的按钮显示 loading（转圈/文案）
```

### 组件改动

1. **`AutomationView`（外层，持有 `act` 和状态）**
   - 新增 state：`const [pending, setPending] = useState<Record<string, boolean>>({})`。
   - `act` 签名改为 `act(key: string, fn: () => Promise<unknown>)`：
     ```ts
     const act = async (key: string, fn: () => Promise<unknown>) => {
       if (pending[key]) return;                        // 防重复点击
       setPending((p) => ({ ...p, [key]: true }));
       try { await fn(); await refresh(); }
       catch (e) { setError(String(e instanceof Error ? e.message : e)); }
       finally { setPending((p) => ({ ...p, [key]: false })); }
     };
     ```
   - 把 `pending` 传给 `AutomationDetail`（新增 prop），或把每个 handler 包好后连同其 busy 标志一起下传（见下）。

2. **传递方式**：`AutomationDetail` 已经通过 `onRunNow` / `onDelete` / `onToggleEnabled` / `onSave` 回调接收动作。为保持 `AutomationDetail` 不直接接触 `act`/`pending`（边界清晰），外层为每个动作算好 `busy` 布尔并作为 prop 传入：
   - `onRunNow={() => act("runNow:" + detail.id, () => window.codeshell.runAutomationNow(detail.id))}`，外加 `runNowBusy={!!pending["runNow:" + detail.id]}`。
   - 同理 `deleteBusy`、`toggleBusy`、`saveBusy`。
   - key 用 `"<动作>:" + detail.id`，这样切换不同 job 时 busy 不串。

3. **`AutomationDetail`（按钮渲染）**
   - 新增 props：`runNowBusy: boolean; deleteBusy: boolean; toggleBusy: boolean; saveBusy: boolean`。
   - 「立即运行」按钮（line 206）：
     ```tsx
     <Button size="sm" onClick={props.onRunNow} disabled={props.runNowBusy}>
       {props.runNowBusy ? <><Loader2 size={14} className="spin" />运行中…</> : "立即运行"}
     </Button>
     ```
   - 「删除」按钮：`disabled={props.deleteBusy}`，busy 时文案/图标转圈（删除较快，至少 disabled 防连点）。
   - 「暂停/启用」Switch（line 201-205）：`disabled={props.toggleBusy}`。
   - 「保存」按钮（prompt 编辑的保存，line ~223 附近）：`disabled={props.saveBusy || !promptDraft.trim()}`。

   `Loader2` 从 `lucide-react` 引入；`className="spin"` 沿用既有模式（见 `settings/MemorySection.tsx:265`，`Button` 的 base class 已含 `[&_svg]:size-4` + `disabled:opacity-50 disabled:pointer-events-none`）。

## Data flow / 幂等保证

- 防重复点击靠两道：(a) `act` 入口 `if (pending[key]) return`（即使 React 还没 re-render 到 disabled，第二次调用也被挡）；(b) 按钮 `disabled`（视觉 + 阻止点击）。两道叠加确保连点只触发一次。
- key 含 `detail.id`，切 job 不串；动作前缀（runNow/delete/toggle/save）区分同 job 的不同动作，互不阻塞（满足「每按钮独立」）。

## Error handling

- `act` 的 `finally` 保证无论成功/抛错都清除 `pending[key]`（不会卡在永久 loading）。
- 现有的错误处理（`setError` + 错误视图 + 重试按钮）不变。

## Testing

`AutomationView.tsx` 当前无测试文件。本改动是 UI 交互行为，最有价值的是验证「连点只触发一次」与「busy 期间 disabled」。

- **手动验证（主）**：跑 desktop，连点「立即运行」→ 确认只 submit 一条 run（看 `~/.code-shell/runs/` 只多一条 / 日志只一条 `run.submitted`）；按钮在请求期间显示「运行中…」且不可再点；完成后恢复。
- **可选单元测试**：若为 `act` 抽一个纯 hook（如 `useGuardedAction`），可对其单测：同 key 并发调用第二次被忽略；finally 清除 pending；不同 key 不互斥。**YAGNI 判断**：若抽 hook 仅为测试而过度拆分则不值得；优先就地实现 + 手动验证。实现时若 `act` 逻辑自然可抽成一个 10 行 hook，则抽并加 3 个单测；否则就地实现，靠 tsc + 手动验证。
- **tsc + build**：`cd packages/desktop && bunx tsc --noEmit && bun run build:renderer` 必须绿。

## Out of scope (YAGNI)

- core scheduler `fire()` 守卫 / RunManager 去重 —— 明确不改（同 job 并发合法；TODO.md 那条 bug 记录相应更新为「UI 侧已修，core 侧按设计不改」）。
- 全局 busy（一个操作锁全部按钮）—— 用户选了每按钮独立。
- 「立即运行」后跳转到该 run 的实时视图 —— 另一个 feature（live-push fast-follow）。
