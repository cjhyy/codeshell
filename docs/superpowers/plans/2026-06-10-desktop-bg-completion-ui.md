# desktop 后台完成提示 UI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** desktop 收到 `background_agent_completed`(视频等后台任务完成)时,消息流插一条系统消息 + 弹 toast。

**Architecture:** reducer(types.ts)加 case 插 `kind:"system"` 消息(状态);App.tsx 的 onStreamEvent 回调里调 useToast(副作用);共用一个 `bgCompletionText` helper。

**Tech Stack:** React + TS,desktop renderer。**desktop 独立 tsc/build**(根目录不覆盖),改完在 packages/desktop 跑 `bunx tsc --noEmit` + `bun run build:renderer`。subagent 不动 git。

---

## 现状(已确认)

- `background_agent_completed` 事件字段(core types.ts):`{ type, agentId, name?, description, status:"completed"|"failed", finalText?, error?, enqueuedAt }`。视频:name="video generation",finalText="Video saved to <path>"。
- `applyStreamEvent(state, event, now?)`(types.ts:292)纯 reducer;`freshId(prefix)`(types.ts:273,模块内)可用;default 分支在 ~766 行 `return state`。
- `SystemMessage = { kind:"system"; id; text }`,MessageStream 已渲染(居中小灰字)。
- App.tsx:`window.codeshell.onStreamEvent((env)=>{ const event = env.event; ... })`(~1048,组件体内)。App 被 ToastProvider 包裹(main.tsx)。`useToast()` 来自 `./ui/ToastProvider`,返回 `(opts:{message,variant?})=>void`。App.tsx 尚未 import useToast。

---

## Task 1: bgCompletionText helper + reducer case

**Files:**
- Modify: `packages/desktop/src/renderer/types.ts`
- Test: `packages/desktop/src/renderer/types.test.ts`

- [ ] **Step 1: 写 reducer 测试**

在 `types.test.ts` 末尾追加(沿用文件已有的 `applyStreamEvent`/`INITIAL_STATE`/`withMessages` import;若无 withMessages 用 INITIAL_STATE):

```typescript
describe("applyStreamEvent — background_agent_completed", () => {
  test("completed → appends a system message with the saved path", () => {
    const ev = {
      type: "background_agent_completed",
      agentId: "video-1",
      name: "video generation",
      description: "Video generated: /p/.code-shell/generated_videos/1.mp4",
      status: "completed",
      finalText: "Video saved to /p/.code-shell/generated_videos/1.mp4",
      enqueuedAt: 1,
    } as unknown as StreamEvent;
    const s = applyStreamEvent(INITIAL_STATE, ev);
    const last = s.messages[s.messages.length - 1];
    expect(last.kind).toBe("system");
    expect((last as { text: string }).text).toContain("video generation");
    expect((last as { text: string }).text).toContain("Video saved to /p/.code-shell/generated_videos/1.mp4");
  });

  test("failed → appends a system message with the error", () => {
    const ev = {
      type: "background_agent_completed",
      agentId: "video-2",
      name: "video generation",
      description: "Video generation failed",
      status: "failed",
      error: "content policy",
      enqueuedAt: 1,
    } as unknown as StreamEvent;
    const s = applyStreamEvent(INITIAL_STATE, ev);
    const last = s.messages[s.messages.length - 1];
    expect(last.kind).toBe("system");
    expect((last as { text: string }).text).toContain("content policy");
  });
});
```

(确认 `types.test.ts` 顶部已 import `StreamEvent` 类型;若没有,加 `import type { StreamEvent } from "@cjhyy/code-shell-core";`。)

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/desktop && bun test src/renderer/types.test.ts`
Expected: FAIL(事件被 default 忽略,messages 末尾不是 system)。

- [ ] **Step 3: 加 helper + case**

在 `types.ts`,`applyStreamEvent` 函数**之前**加导出 helper:

```typescript
/** Shared text for a background-task completion (video etc.) — used by the
 *  reducer (message stream) and App.tsx (toast) so the two never drift. */
export function bgCompletionText(event: {
  name?: string;
  description: string;
  status: "completed" | "failed";
  finalText?: string;
  error?: string;
}): string {
  const who = event.name ?? "后台任务";
  if (event.status === "completed") {
    return `✓ ${who}完成:${event.finalText ?? event.description}`;
  }
  return `✗ ${who}失败:${event.error ?? event.description}`;
}
```

在 `applyStreamEvent` 的 switch 里(default 之前)加 case:

```typescript
    case "background_agent_completed": {
      return {
        ...state,
        messages: [
          ...state.messages,
          { kind: "system", id: freshId("bg-done"), text: bgCompletionText(event) },
        ],
      };
    }
```

(`event` 在该 case 下已被 TS 收窄为 BackgroundAgentCompletedEvent,字段可直接取。)

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/desktop && bun test src/renderer/types.test.ts`
Expected: PASS。

---

## Task 2: App.tsx 弹 toast

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx`

- [ ] **Step 1: import useToast + bgCompletionText**

App.tsx 顶部 import 区:
- 加 `import { useToast } from "./ui/ToastProvider";`
- 确保从 `./types` 的 import 里带上 `bgCompletionText`(找到现有 `applyStreamEvent` 的 import 行,加 `bgCompletionText`)。

- [ ] **Step 2: 取 toast**

在 `function App() {` 体内靠前(其它 hook 旁,如 `const [transcripts, dispatch] = useReducer(...)` 附近)加:
```typescript
  const toast = useToast();
```

- [ ] **Step 3: onStreamEvent 回调里触发 toast**

在 `window.codeshell.onStreamEvent((env: StreamEventEnvelope) => {` 回调里,`const event = env.event;` 之后、路由逻辑之前,加:
```typescript
      if (event.type === "background_agent_completed") {
        toast({
          message: bgCompletionText(event),
          variant: event.status === "completed" ? "success" : "error",
        });
        // fall through: the reducer still appends the system message below.
      }
```
注意:不要 `return` —— 让事件继续走下面的 dispatch,这样消息流那条系统消息照常插入(Task 1)。

- [ ] **Step 4: 确认 toast 依赖**

`onStreamEvent` 注册在某个 useEffect 里;若该 effect 的依赖数组存在,把 `toast` 加进去(useToast 返回的函数引用稳定,但加上更规范)。若加 toast 触发 lint/依赖告警,确保 effect 仍只注册一次(toast 引用稳定不会导致重复注册)。

---

## Task 3: 验证

- [ ] **Step 1:** `cd packages/desktop && bun test src/renderer/types.test.ts` → PASS
- [ ] **Step 2:** `cd packages/desktop && bunx tsc --noEmit` → 0 错误
- [ ] **Step 3:** `cd packages/desktop && bun run build:renderer` → 成功
- [ ] **Step 4:** 报告真实输出,不 commit。

---

## 验证标准
- reducer:background_agent_completed(completed/failed)→ 消息流末尾多一条 kind:"system",文案含路径/错误。
- App.tsx:同事件触发 toast(success/error),且不阻断消息流插入(无 return)。
- helper 两处复用,文案一致。
- desktop tsc 0 错误 + build:renderer 成功。
- (主代理/人工)真机:视频完成时消息流出现完成提示 + 弹 toast。
