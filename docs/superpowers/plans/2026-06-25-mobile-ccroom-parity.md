# 手机遥控 cc 房间对齐桌面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手机遥控 UI 在「新建会话 / 切项目 / 不同项目下 session 点击 / cc 房间→不同 cc session」四条流程上对齐桌面,并把项目列表统一到磁盘真源。

**Architecture:** 三段。(A) 给手机 WebSocket 补 `ccRoom.*` RPC 表面,复用桌面已有的 core 发现层(`probeClaudeCli`/`discoverSessions`/`readRecentHistory`)和 `roomManager.openForSession`;同时修审批解决无广播的 bug。(B) 手机引入 `activeProjectCwd` 一等状态,从「跟会话走」改「选项目」。(C) 磁盘 recents 升为项目唯一真源(收编 pin + 软删除),localStorage 降为只读投影。

**Tech Stack:** TypeScript;Electron 主进程 + preload + React renderer/mobile;`bun:test`;shadcn/ui + Tailwind v4。

**测试运行:** 在 `packages/desktop` 目录下 `bun test <文件>`。类型检查 `bunx tsc --noEmit`(desktop 有独立 tsc)。

**Spec:** `docs/superpowers/specs/2026-06-25-mobile-ccroom-parity-design.md`

---

## File Structure

**Section A — ccRoom RPC + 审批广播修复:**
- Modify `packages/desktop/src/main/mobile-remote/types.ts` — 两个事件 union 扩 `ccRoom.*` 字段 + 共享 `ApprovalDecision`/`CcDiscoveredSession`/`CcHistoryMessage` 类型(mobile-remote 不能 import core,需本地声明)
- Modify `packages/desktop/src/main/cc-room/approval-bridge.ts` — 加 `onResolve` 回调,`respond()` 和超时都触发
- Create `packages/desktop/src/main/cc-room/approval-bridge.test.ts` — onResolve 触发测试
- Modify `packages/desktop/src/main/index.ts` — `handleCcRoomEvent` 分支接入 `handleMobileClientEvent`;`ApprovalBridge` 加 `onResolve` 广播

**Section B — 手机 activeProjectCwd + cc 会话 UI:**
- Modify `packages/desktop/src/mobile/hooks/useRemoteApp.ts` — `activeProjectCwd` 状态、ccRoom RPC 调用、`ccRoom.approvalResolved` 消费、newSession 竞态修复、cc 会话列表状态
- Modify `packages/desktop/src/mobile/components/SessionList.tsx` — 按 `activeProjectCwd` 过滤渲染
- Create `packages/desktop/src/mobile/components/CcSessionList.tsx` — 手机端 cc 会话列表(对照 renderer/cc-room/CCRoomView)
- Modify `packages/desktop/src/mobile/lib/format.ts` — 导出 `sameCwd`(目前是私有)供组件用

**Section C — 磁盘 recents 升真源:**
- Modify `packages/desktop/src/main/recents-store.ts` — `RecentProject` 扩 `pinned`/`deletedAt`;新增 `setPinned`/`softDelete`/`loadProjects`;放宽 MAX 语义
- Create `packages/desktop/src/main/recents-store.test.ts` — pin/软删除/重启持久化测试
- Modify `packages/desktop/src/main/index.ts` — 项目变更 IPC + 变更后广播 `room.projects.ok` 给手机 + IPC 事件给桌面
- Modify `packages/desktop/src/preload/index.ts` — 暴露 `projects.*` 给渲染层 + `onProjectsChanged` 监听
- Modify `packages/desktop/src/renderer/repos.ts` — 投影模式:从主进程灌,localStorage 仅缓存
- Modify `packages/desktop/src/renderer/App.tsx` — repo 增删 pin 改走主进程 + 回灌投影

---

## SECTION A — ccRoom RPC 表面 + 审批解决广播

### Task A1: ApprovalBridge 加 onResolve 回调(修审批解决无广播 bug)

**Files:**
- Modify: `packages/desktop/src/main/cc-room/approval-bridge.ts`
- Test: `packages/desktop/src/main/cc-room/approval-bridge.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/desktop/src/main/cc-room/approval-bridge.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ApprovalBridge, type ApprovalDecision } from "./approval-bridge.js";

describe("ApprovalBridge onResolve", () => {
  test("respond() fires onResolve with the decision", () => {
    const resolved: { roomId: string; requestId: string; decision: ApprovalDecision }[] = [];
    const bridge = new ApprovalBridge({
      onPush: () => {},
      onResolve: (roomId, requestId, decision) => resolved.push({ roomId, requestId, decision }),
    });
    const p = bridge.request("room1", "req1", { toolName: "Edit", input: {} });
    const ok = bridge.respond("room1", "req1", { behavior: "allow" });
    expect(ok).toBe(true);
    expect(resolved).toEqual([{ roomId: "room1", requestId: "req1", decision: { behavior: "allow" } }]);
    return p; // settle the parked promise
  });

  test("timeout fires onResolve with the auto-deny decision", async () => {
    const resolved: { roomId: string; requestId: string; decision: ApprovalDecision }[] = [];
    const bridge = new ApprovalBridge({
      timeoutMs: 5,
      onPush: () => {},
      onResolve: (roomId, requestId, decision) => resolved.push({ roomId, requestId, decision }),
    });
    const decision = await bridge.request("room2", "req2", { toolName: "Edit", input: {} });
    expect(decision).toEqual({ behavior: "deny", message: "approval timed out" });
    expect(resolved).toEqual([
      { roomId: "room2", requestId: "req2", decision: { behavior: "deny", message: "approval timed out" } },
    ]);
  });

  test("respond() on unknown request does NOT fire onResolve", () => {
    const resolved: unknown[] = [];
    const bridge = new ApprovalBridge({ onPush: () => {}, onResolve: () => resolved.push(1) });
    expect(bridge.respond("nope", "nope", { behavior: "allow" })).toBe(false);
    expect(resolved).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && bun test src/main/cc-room/approval-bridge.test.ts`
Expected: FAIL — `onResolve` not in `ApprovalBridgeOptions`, callback never called.

- [ ] **Step 3: Add onResolve to ApprovalBridge**

In `packages/desktop/src/main/cc-room/approval-bridge.ts`, change `ApprovalBridgeOptions` and both the timeout and `respond()` paths:

```typescript
export interface ApprovalBridgeOptions {
  timeoutMs?: number;
  onPush: (roomId: string, req: ApprovalRequestPayload & { requestId: string }) => void;
  /** Fired whenever a parked request is decided (user response OR timeout
   *  auto-deny), so every transport can clear its stale approval card. */
  onResolve?: (roomId: string, requestId: string, decision: ApprovalDecision) => void;
}
```

In `request()`, the timeout branch must notify before resolving:

```typescript
  request(roomId: string, requestId: string, payload: ApprovalRequestPayload): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const k = this.key(roomId, requestId);
      const timer = setTimeout(() => {
        if (this.pending.delete(k)) {
          const decision: ApprovalDecision = { behavior: "deny", message: "approval timed out" };
          this.opts.onResolve?.(roomId, requestId, decision);
          resolve(decision);
        }
      }, this.timeoutMs);
      this.pending.set(k, { resolve, timer });
      this.opts.onPush(roomId, { ...payload, requestId });
    });
  }
```

In `respond()`, fire onResolve on success:

```typescript
  respond(roomId: string, requestId: string, decision: ApprovalDecision): boolean {
    const k = this.key(roomId, requestId);
    const p = this.pending.get(k);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(k);
    this.opts.onResolve?.(roomId, requestId, decision);
    p.resolve(decision);
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && bun test src/main/cc-room/approval-bridge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/cc-room/approval-bridge.ts packages/desktop/src/main/cc-room/approval-bridge.test.ts
git commit -m "feat(cc-room): ApprovalBridge onResolve callback (fixes multi-端僵尸审批卡)"
```

---

### Task A2: 扩 mobile-remote types 加 ccRoom.* 事件

**Files:**
- Modify: `packages/desktop/src/main/mobile-remote/types.ts`

> mobile-remote 不能 import core(它在 main 进程但 types 被 mobile renderer 也引用),
> 所以 `DiscoveredSession`/`HistoryMessage`/`ApprovalDecision` 的结构在此**本地重声明**
> (与 core / approval-bridge 保持字段一致)。

- [ ] **Step 1: Add shared local types + client/server events**

In `packages/desktop/src/main/mobile-remote/types.ts`, after the `PermissionMode` type (line 27), add:

```typescript
/** Mirror of core DiscoveredSession (mobile-remote can't import core). */
export interface CcDiscoveredSession {
  sessionId: string;
  firstMessage: string;
  lastModified: number;
  messageCount: number;
}

/** Mirror of core HistoryMessage. */
export interface CcHistoryMessage {
  role: "user" | "assistant";
  text: string;
  tools?: { name: string; summary: string }[];
  ts?: number;
}

/** Mirror of cc-room ApprovalDecision. */
export type CcApprovalDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };
```

Add to the `MobileClientEvent` union (after the `room.history` line, before the closing `;` at line 87):

```typescript
  // ── CC Room (external claude CLI sessions, per-project) ───────────────
  | { type: "ccRoom.probe"; force?: boolean }
  | { type: "ccRoom.listSessions"; cwd: string }
  | { type: "ccRoom.openSession"; sessionId: string; cwd: string; mode: PermissionMode }
  | { type: "ccRoom.readHistory"; cwd: string; sessionId: string; limit: number }
  | { type: "ccRoom.respondApproval"; roomId: string; requestId: string; decision: CcApprovalDecision };
```

> NOTE: the existing union ends with `room.history` followed by `;`. Move the `;`
> to the end of the new `ccRoom.respondApproval` line.

Add to the `MobileServerEvent` union (after the `ccRoom.approvalRequest` block, which currently ends the union at line 135 with `};`):

```typescript
  | { type: "ccRoom.probe.ok"; available: boolean; command?: string; version?: string; reason?: "not-found" | "not-executable" }
  | { type: "ccRoom.listSessions.ok"; cwd: string; sessions: CcDiscoveredSession[] }
  | { type: "ccRoom.opened"; roomId: string; sessionId: string; status: "running" | "missing" }
  | { type: "ccRoom.readHistory.ok"; sessionId: string; messages: CcHistoryMessage[]; hasMore: boolean; totalCount: number }
  | { type: "ccRoom.approvalResolved"; roomId: string; requestId: string; decision: CcApprovalDecision };
```

> NOTE: the existing `ccRoom.approvalRequest` member ends the union with `};`.
> Change that `};` to `}` and append the new members, ending the union with `;`.

- [ ] **Step 2: Typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: PASS (no errors from types.ts; downstream switch handlers may now warn about
unhandled cases — those are added in later tasks. If tsc is clean because nothing
exhaustively switches yet, that's fine).

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/main/mobile-remote/types.ts
git commit -m "feat(mobile): ccRoom.* client/server event types"
```

---

### Task A3: 主进程 handleCcRoomEvent 分支

**Files:**
- Modify: `packages/desktop/src/main/index.ts` (handleMobileClientEvent ~542, handleRoomEvent ~839, ApprovalBridge ~305)

- [ ] **Step 1: Route ccRoom.* events**

In `handleMobileClientEvent` (`packages/desktop/src/main/index.ts:542`), the function currently
starts by routing `room.` events. Add a ccRoom branch BEFORE the `room.` branch (so `ccRoom.`
doesn't get swallowed by a `startsWith("room.")` — note `"ccRoom.".startsWith("room.")` is
false, but `"ccRoom.respondApproval"` does NOT start with `"room."`, so order is safe; still,
make the ccRoom check explicit and first):

```typescript
async function handleMobileClientEvent(event: MobileClientEvent & { deviceId?: string }): Promise<void> {
  if (event.type.startsWith("ccRoom.")) {
    await handleCcRoomEvent(event);
    return;
  }
  // ── Rooms (independent of the chat worker bridge) ─────────────────────
  if (event.type.startsWith("room.")) {
    await handleRoomEvent(event);
    return;
  }
  // ...existing body unchanged...
```

- [ ] **Step 2: Add handleCcRoomEvent**

Add this function next to `handleRoomEvent` (after it, ~line 885 in `index.ts`). It uses
per-device reply for discovery queries (so a phone's listSessions回包只回它自己),but room
open/approval stay broadcast (双端共享):

```typescript
/**
 * CC Room (external `claude` CLI sessions) for mobile — mirrors the desktop
 * ccRoom:* IPC handlers, reusing the SAME core discovery + roomManager backend.
 * Discovery replies (probe/listSessions/readHistory) go per-device; open and
 * approval-response feed the shared roomManager / approvalBridge (the room is
 * dual-ended, like desktop). listSessions echoes the cwd so a phone that has
 * since switched projects can discard a stale reply.
 */
async function handleCcRoomEvent(event: MobileClientEvent & { deviceId?: string }): Promise<void> {
  const deviceId = event.deviceId;
  const reply = (e: MobileServerEvent): void => {
    if (deviceId) mobileRemote.sendToDevice(deviceId, e);
    else mobileRemote.broadcast(e);
  };
  try {
    if (event.type === "ccRoom.probe") {
      const a = await probeClaudeCli(Boolean(event.force));
      reply({
        type: "ccRoom.probe.ok",
        available: a.available,
        command: a.command,
        version: a.version,
        reason: a.reason,
      });
      return;
    }
    if (event.type === "ccRoom.listSessions") {
      const sessions = discoverSessions(event.cwd);
      reply({ type: "ccRoom.listSessions.ok", cwd: event.cwd, sessions });
      return;
    }
    if (event.type === "ccRoom.openSession") {
      const mode = await resolveRoomPermissionMode(event.cwd, event.mode);
      const { roomId } = roomManager.openForSession(event.sessionId, event.cwd, mode);
      const room = roomManager.getRoom(roomId);
      reply({
        type: "ccRoom.opened",
        roomId,
        sessionId: event.sessionId,
        status: room?.open ? "running" : "missing",
      });
      return;
    }
    if (event.type === "ccRoom.readHistory") {
      const h = readRecentHistory(event.cwd, event.sessionId, event.limit);
      reply({
        type: "ccRoom.readHistory.ok",
        sessionId: event.sessionId,
        messages: h.messages,
        hasMore: h.hasMore,
        totalCount: h.totalCount,
      });
      return;
    }
    if (event.type === "ccRoom.respondApproval") {
      approvalBridge.respond(event.roomId, event.requestId, event.decision);
      return;
    }
  } catch (err) {
    reply({ type: "room.error", message: err instanceof Error ? err.message : String(err) });
  }
}
```

> `roomManager.getRoom(roomId)` returns the room meta with `.open` boolean (confirmed by
> room-manager.test.ts: `mgr.getRoom(room.id)?.permissionMode`). If `getRoom` returns no
> `open` field, use `roomManager.listRooms().find(r => r.id === roomId)?.open` — verify the
> RoomPublic shape (it has `open: boolean`, types.ts:144).

- [ ] **Step 3: Wire ApprovalBridge.onResolve to broadcast**

In `packages/desktop/src/main/index.ts`, the `new ApprovalBridge({...})` block (line 305) currently
only has `onPush`. Add `onResolve`:

```typescript
const approvalBridge = new ApprovalBridge({
  onPush: (roomId, req) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("ccRoom:approvalRequest", { roomId, ...req });
    }
    mobileRemote.broadcast({ type: "ccRoom.approvalRequest", roomId, req });
  },
  onResolve: (roomId, requestId, decision) => {
    // Mirror resolution to BOTH transports so every端 clears its stale card —
    // fixes the "点了/超时后审批卡不消失" bug across desktop windows + phones.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("ccRoom:approvalResolved", { roomId, requestId, decision });
    }
    mobileRemote.broadcast({ type: "ccRoom.approvalResolved", roomId, requestId, decision });
  },
});
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: PASS. (probeClaudeCli/discoverSessions/readRecentHistory already imported at
index.ts:37-41; resolveRoomPermissionMode + roomManager + approvalBridge in scope.)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/index.ts
git commit -m "feat(mobile): handleCcRoomEvent + approvalResolved broadcast"
```

---

### Task A4: 桌面渲染层消费 ccRoom:approvalResolved(清卡)

**Files:**
- Modify: `packages/desktop/src/preload/index.ts` (onApprovalRequest listener区, ~887-910)
- Modify: `packages/desktop/src/renderer/cc-room/CCRoomView.tsx` 或其会话视图 — 消费 resolved 清卡

- [ ] **Step 1: Expose onApprovalResolved in preload**

In `packages/desktop/src/preload/index.ts`, in the `ccRoom` object (near `onApprovalRequest`,
~line 887), add a sibling listener:

```typescript
    onApprovalResolved: (cb: (p: { roomId: string; requestId: string; decision: unknown }) => void) => {
      const h = (_e: unknown, p: { roomId: string; requestId: string; decision: unknown }) => cb(p);
      ipcRenderer.on("ccRoom:approvalResolved", h);
      return () => ipcRenderer.removeListener("ccRoom:approvalResolved", h);
    },
```

Also add its type to `packages/desktop/src/preload/types.d.ts` in the `ccRoom` block (mirror the
`onApprovalRequest` signature already there).

- [ ] **Step 2: Consume in the CC conversation view**

In the component that holds CC approval cards (`packages/desktop/src/renderer/cc-room/CCConversationView.tsx`
— it currently subscribes to `onApprovalRequest`), add an effect subscribing to
`onApprovalResolved` that removes the card whose `requestId` matches:

```typescript
  useEffect(() => {
    return window.codeshell.ccRoom.onApprovalResolved(({ requestId }) => {
      setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    });
  }, []);
```

> Adapt `setApprovals` / the approval state field name to whatever CCConversationView uses
> for its pending-approval list. If approvals are keyed differently, match by requestId.

- [ ] **Step 3: Typecheck + build renderer**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts packages/desktop/src/renderer/cc-room/CCConversationView.tsx
git commit -m "feat(cc-room): desktop clears approval card on approvalResolved"
```

---

## SECTION B — 手机 activeProjectCwd + cc 会话列表

### Task B1: 导出 sameCwd from format.ts

**Files:**
- Modify: `packages/desktop/src/mobile/lib/format.ts`

- [ ] **Step 1: Export sameCwd**

In `packages/desktop/src/mobile/lib/format.ts`, change the private `sameCwd` (currently
`function sameCwd(...)`) to an export:

```typescript
export function sameCwd(a?: string | null, b?: string | null): boolean {
  const norm = (v?: string | null): string => (v ?? "").replace(/[/\\]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/mobile/lib/format.ts
git commit -m "refactor(mobile): export sameCwd helper"
```

---

### Task B2: useRemoteApp 加 activeProjectCwd + ccRoom RPC + 竞态修复

**Files:**
- Modify: `packages/desktop/src/mobile/hooks/useRemoteApp.ts`

- [ ] **Step 1: Add activeProjectCwd state + cc session state**

Near the other `useState` declarations in `useRemoteApp` (around the approvals state, line 132),
add:

```typescript
  // The currently SELECTED project (one-true-source for "what am I looking at"),
  // distinct from activeSessionCwd which is derived from the bound session. Drives
  // session-list filtering AND ccRoom.listSessions.
  const [activeProjectCwd, setActiveProjectCwd] = useState<string | null>(null);
  // External claude-CLI sessions discovered for activeProjectCwd.
  const [ccSessions, setCcSessions] = useState<CcDiscoveredSession[]>([]);
  const [ccProbe, setCcProbe] = useState<{ available: boolean; reason?: string } | null>(null);
```

Import the type at the top of the file:

```typescript
import type { CcDiscoveredSession } from "../../main/mobile-remote/types.js";
```

> Match the existing import style for types from mobile-remote/types in this file (it already
> imports `RoomPublic`, `PermissionMode`, etc. — add `CcDiscoveredSession` alongside).

- [ ] **Step 2: Add selectProject + ccRoom callbacks**

Add these callbacks near `selectSession` (line 391):

```typescript
  const selectProject = useCallback(
    (cwd: string) => {
      setActiveProjectCwd(cwd);
      setLoadingKey("sessions", true);
      socket.send({ type: "session.list" });
      socket.send({ type: "ccRoom.probe" });
      socket.send({ type: "ccRoom.listSessions", cwd });
    },
    [socket, setLoadingKey],
  );

  const openCcSession = useCallback(
    (sessionId: string, cwd: string, mode: PermissionMode) => {
      socket.send({ type: "ccRoom.openSession", sessionId, cwd, mode });
    },
    [socket],
  );

  const respondCcApproval = useCallback(
    (roomId: string, requestId: string, decision: { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string }) => {
      const a = approvalsRef.current.find((p) => p.requestId === requestId);
      if (!a) return; // already resolved (approve-once)
      socket.send({ type: "ccRoom.respondApproval", roomId, requestId, decision });
      approvalsRef.current = approvalsRef.current.filter((p) => p.requestId !== requestId);
      setApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [socket],
  );
```

- [ ] **Step 3: Consume ccRoom server events**

In the `MobileServerEvent` switch (where `approval.resolved` / `room.list.ok` etc. are handled),
add cases:

```typescript
      case "ccRoom.probe.ok":
        setCcProbe({ available: event.available, reason: event.reason });
        break;
      case "ccRoom.listSessions.ok":
        // cwd echo guard: ignore replies for a project we've since left.
        if (event.cwd === activeProjectCwdRef.current) setCcSessions(event.sessions);
        break;
      case "ccRoom.opened":
        // Reuse the room-view binding: an opened cc room behaves like room.open.
        setActiveRoomId(event.roomId);
        boundSessionRef.current = undefined;
        setApprovals([]);
        dispatchChat({ kind: "reset" });
        socket.send({ type: "room.history", roomId: event.roomId });
        break;
      case "ccRoom.approvalResolved":
        approvalsRef.current = approvalsRef.current.filter((p) => p.requestId !== event.requestId);
        setApprovals((prev) => prev.filter((p) => p.requestId !== event.requestId));
        break;
```

> `activeProjectCwdRef` is needed because the switch is inside a stable callback. Add a ref that
> tracks `activeProjectCwd` (mirror the existing `approvalsRef`/`activeCwdRef` pattern):
> ```typescript
> const activeProjectCwdRef = useRef(activeProjectCwd);
> activeProjectCwdRef.current = activeProjectCwd;
> ```

- [ ] **Step 4: Fix newSession race**

`ccRoom.approvalRequest` and `room.message` are already handled. Now fix `newSession` so the
phone doesn't reset+send before it has the minted sessionId. Replace `newSession` (line 406):

```typescript
  const newSession = useCallback((cwd?: string | null, name?: string) => {
    const nextCwd = cwd === undefined ? activeCwdRef.current : cwd;
    boundSessionRef.current = undefined;
    // Mark "awaiting a minted session" — chat.send before chat.accepted lands
    // must wait for the server's sessionId rather than racing an undefined one.
    pendingNewSessionRef.current = true;
    setActiveRoomId(undefined);
    setActiveSessionCwd(nextCwd === undefined ? undefined : nextCwd ?? null);
    setApprovals([]);
    setLoadingKey("sessionHistory", false);
    dispatchChat({ kind: "reset" });
    socket.send(
      cwd === undefined
        ? { type: "session.create", ...(name ? { name } : {}) }
        : { type: "session.create", cwd, ...(name ? { name } : {}) },
    );
  }, [socket, setLoadingKey]);
```

Add the ref near the others:

```typescript
  const pendingNewSessionRef = useRef(false);
```

In the `chat.accepted` server-event case, clear it and bind:

```typescript
      case "chat.accepted":
        if (event.sessionId) {
          boundSessionRef.current = event.sessionId;
          setActiveSessionId(event.sessionId);
          if (event.cwd !== undefined) setActiveSessionCwd(event.cwd);
        }
        pendingNewSessionRef.current = false;
        break;
```

> If a `chat.accepted` case already exists, merge these lines into it instead of duplicating.

- [ ] **Step 5: Return new API from the hook**

Add to the hook's return object (line ~528):

```typescript
    activeProjectCwd,
    selectProject,
    ccSessions,
    ccProbe,
    openCcSession,
    respondCcApproval,
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/mobile/hooks/useRemoteApp.ts
git commit -m "feat(mobile): activeProjectCwd state + ccRoom RPC + newSession race fix"
```

---

### Task B3: SessionList 按 activeProjectCwd 过滤

**Files:**
- Modify: `packages/desktop/src/mobile/components/SessionList.tsx`

- [ ] **Step 1: Filter the rendered group to the selected project**

`SessionList` currently renders ALL `groups`. Change it to render only the group matching
`activeProjectCwd` (passed in as a prop), with the others collapsed into a project switcher.
Add `activeProjectCwd` + `onSelectProject` props to the component signature, then filter:

```typescript
  const groups = groupByProject(sessions, projects);
  const current = activeProjectCwd
    ? groups.find((g) => sameCwd(projectContextCwd(g.cwd, projects), activeProjectCwd))
    : undefined;
  const others = groups.filter((g) => g !== current);
```

Render `current.items` in the existing session list, and render `others` as a compact
"切换项目" list of buttons calling `onSelectProject(g.cwd)`. Import `sameCwd` and
`projectContextCwd` from `../lib/format.js`.

> Keep the existing per-item button markup (the `onSelect(s.id)` list). Only the outer
> grouping/filtering changes. If `activeProjectCwd` is null (nothing selected), fall back to
> rendering all groups as today so the screen is never empty on first load.

- [ ] **Step 2: Pass the props from the parent**

In the mobile app shell that renders `<SessionList>` (find it via the `onSelect`/`onNew` props
it already receives), pass `activeProjectCwd={app.activeProjectCwd}` and
`onSelectProject={app.selectProject}` from the `useRemoteApp()` return value.

- [ ] **Step 3: Typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/mobile/components/SessionList.tsx
git commit -m "feat(mobile): SessionList filters to activeProjectCwd"
```

---

### Task B4: 手机 cc 会话列表组件

**Files:**
- Create: `packages/desktop/src/mobile/components/CcSessionList.tsx`

- [ ] **Step 1: Create the component**

Create `packages/desktop/src/mobile/components/CcSessionList.tsx` mirroring desktop CCRoomView,
but driven by the mobile hook (probe/list come from props, not `window.codeshell`):

```typescript
import { Loader2 } from "lucide-react";
import type { CcDiscoveredSession } from "../../main/mobile-remote/types.js";
import { relativeTime } from "../lib/format.js";
import { cn } from "../lib/utils.js";

interface Props {
  cwd: string | null;
  probe: { available: boolean; reason?: string } | null;
  sessions: CcDiscoveredSession[];
  loading?: boolean;
  onOpen: (sessionId: string, cwd: string, mode: "default" | "acceptEdits" | "bypassPermissions") => void;
}

export function CcSessionList({ cwd, probe, sessions, loading, onOpen }: Props) {
  if (!cwd) {
    return <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">先选择一个项目。</p>;
  }
  if (probe === null) {
    return (
      <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin text-status-running" />
        正在检测 Claude Code CLI…
      </p>
    );
  }
  if (!probe.available) {
    return (
      <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
        未检测到 Claude Code CLI(需在桌面端机器的 PATH 中)。
      </p>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      {loading && sessions.length === 0 ? (
        <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin text-status-running" />
          正在加载 cc 会话…
        </p>
      ) : sessions.length === 0 ? (
        <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
          该项目下没有 Claude Code 会话。
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                type="button"
                onClick={() => onOpen(s.sessionId, cwd, "default")}
                className={cn("mobile-list-item flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left")}
              >
                <span className="truncate text-sm font-medium text-foreground">
                  {s.firstMessage || s.sessionId}
                </span>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{s.messageCount} 条</span>
                  <span className="ml-auto shrink-0">{relativeTime(s.lastModified)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

> `onOpen` passes `"default"` mode; the server applies `resolveRoomPermissionMode`, so a
> non-trusted workspace stays default even if a future UI lets the user pick bypass. (Per spec:
> 复用 resolveRoomPermissionMode, 手机不引入新权限语义.) `cn` + `relativeTime` are existing
> mobile helpers — confirm their import paths match other mobile components.

- [ ] **Step 2: Mount it in the mobile shell**

In the mobile app shell, add a tab/section (next to the chat-session list) that renders
`<CcSessionList>` with props from `useRemoteApp()`:

```tsx
<CcSessionList
  cwd={app.activeProjectCwd}
  probe={app.ccProbe}
  sessions={app.ccSessions}
  onOpen={app.openCcSession}
/>
```

> Place it under the same project context (it shows cc sessions for `activeProjectCwd`),
> matching the desktop "一个项目下有 chat + CC Room" layout. Use whatever tab primitive the
> mobile shell already has; if none, a simple labeled section is fine.

- [ ] **Step 3: Typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/mobile/components/CcSessionList.tsx packages/desktop/src/mobile/
git commit -m "feat(mobile): cc session list per project (CcSessionList)"
```

---

## SECTION C — 磁盘 recents 升项目真源(pin + 软删除)

> **设计决策(plan 阶段发现):** `recents-store.ts` 现有 `MAX = 10` 硬上限 + `existsSync`
> 自愈剪枝。把它当项目唯一真源后:
> - **MAX 仍保留**但只对「自动 push 的 recents 排序」生效;**pinned 项目永不被 MAX 挤掉**。
> - 软删除标记 `deletedAt` 让删除持久(重启不回来),与 existsSync 自愈正交(自愈针对
>   目录已删,软删除针对用户主动删但目录还在)。
> - `loadProjects()` 返回**未软删除**的项目供 UI 用;`loadRecents()` 保持原语义不破坏其它调用方。

### Task C1: recents-store 扩 pinned/deletedAt + setPinned/softDelete/loadProjects

**Files:**
- Modify: `packages/desktop/src/main/recents-store.ts`
- Test: `packages/desktop/src/main/recents-store.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/desktop/src/main/recents-store.test.ts`. It must isolate HOME so it never
writes real `~/.code-shell` (per memory: core writes must honor a redirected home — here we
override via an injectable file path):

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadProjects, pushRecent, setPinned, softDelete, __setRecentsFileForTest } from "./recents-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recents-"));
  __setRecentsFileForTest(join(dir, "recents.json"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __setRecentsFileForTest(null);
});

describe("recents-store project source", () => {
  test("softDelete hides project from loadProjects and persists across reload", async () => {
    await pushRecent({ path: dir, name: "a", lastOpenedAt: 1 });
    await softDelete(dir);
    expect((await loadProjects()).find((p) => p.path === dir)).toBeUndefined();
    // simulate restart: loadProjects re-reads the file
    expect((await loadProjects()).find((p) => p.path === dir)).toBeUndefined();
  });

  test("pinned project survives even when many recents are pushed", async () => {
    await pushRecent({ path: dir, name: "pinme", lastOpenedAt: 1 });
    await setPinned(dir, true);
    for (let i = 0; i < 15; i++) {
      const p = join(dir, `sub${i}`);
      // path must exist for existsSync self-heal not to drop it
      const { mkdirSync } = await import("node:fs");
      mkdirSync(p, { recursive: true });
      await pushRecent({ path: p, name: `n${i}`, lastOpenedAt: i + 2 });
    }
    const projects = await loadProjects();
    expect(projects.find((p) => p.path === dir)?.pinned).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/desktop && bun test src/main/recents-store.test.ts`
Expected: FAIL — `loadProjects`/`setPinned`/`softDelete`/`__setRecentsFileForTest` undefined.

- [ ] **Step 3: Implement**

Modify `packages/desktop/src/main/recents-store.ts`. Add fields + a test seam + new functions:

```typescript
export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
  pinned?: boolean;
  /** Set when the user removes the project; persists so it doesn't reappear. */
  deletedAt?: number;
}

let FILE = path.join(os.homedir(), ".code-shell", "desktop", "recents.json");
/** Test-only: redirect the store file so tests never touch real ~/.code-shell. */
export function __setRecentsFileForTest(p: string | null): void {
  FILE = p ?? path.join(os.homedir(), ".code-shell", "desktop", "recents.json");
}
const MAX = 10;

async function readAll(): Promise<RecentProject[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as RecentProject[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

async function writeAll(list: RecentProject[]): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(list, null, 2), "utf8");
  } catch {
    // best effort
  }
}
```

Rewrite `loadRecents` to keep its original contract (auto-pruned, capped) but skip soft-deleted:

```typescript
export async function loadRecents(): Promise<RecentProject[]> {
  const all = await readAll();
  return all
    .filter((r) => r.path && !r.deletedAt && fsSync.existsSync(r.path))
    .slice(0, MAX);
}
```

Add the project-source functions:

```typescript
/** Full project list for UI: not soft-deleted, dir still exists, pinned first.
 *  pinned items are exempt from the MAX cap (recents capping only applies to the
 *  unpinned tail). */
export async function loadProjects(): Promise<RecentProject[]> {
  const all = await readAll();
  const live = all.filter((r) => r.path && !r.deletedAt && fsSync.existsSync(r.path));
  const pinned = live.filter((r) => r.pinned);
  const rest = live.filter((r) => !r.pinned).slice(0, MAX);
  return [...pinned, ...rest];
}

export async function setPinned(projectPath: string, pinned: boolean): Promise<void> {
  const all = await readAll();
  await writeAll(all.map((r) => (r.path === projectPath ? { ...r, pinned } : r)));
}

export async function softDelete(projectPath: string): Promise<void> {
  const all = await readAll();
  await writeAll(all.map((r) => (r.path === projectPath ? { ...r, deletedAt: Date.now() } : r)));
}
```

Update `pushRecent` to use the shared read/write + un-delete on re-open:

```typescript
export async function pushRecent(p: RecentProject): Promise<RecentProject[]> {
  const all = await readAll();
  const prior = all.find((r) => r.path === p.path);
  const merged: RecentProject = { ...prior, ...p, deletedAt: undefined }; // re-opening un-deletes
  const next = [merged, ...all.filter((r) => r.path !== p.path)];
  await writeAll(next);
  return loadRecents();
}
```

> NOTE: `Date.now()` is fine in app code (the no-Date.now() rule is for Workflow scripts only).
> The test for softDelete doesn't assert the timestamp value, only presence/effect.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/desktop && bun test src/main/recents-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/recents-store.ts packages/desktop/src/main/recents-store.test.ts
git commit -m "feat(recents): pinned + soft-delete + loadProjects (project source of truth)"
```

---

### Task C2: 主进程项目 IPC + 变更广播

**Files:**
- Modify: `packages/desktop/src/main/index.ts`

- [ ] **Step 1: Add project IPC handlers + broadcast helper**

In `packages/desktop/src/main/index.ts`, import the new functions (add to the recents-store import):

```typescript
import { loadRecents, pushRecent, loadProjects, setPinned, softDelete } from "./recents-store.js";
```

> If recents-store isn't yet imported in index.ts, add the import. Confirm the existing import
> line and extend it.

Add a broadcast helper + IPC handlers (near the other `ipcMain.handle` registrations):

```typescript
async function broadcastProjects(): Promise<void> {
  const projects = (await loadProjects()).map((p) => ({
    path: p.path,
    name: p.name,
    addedAt: p.lastOpenedAt,
    pinned: p.pinned,
  }));
  // Phones: reuse the existing room.projects.ok shape.
  mobileRemote.broadcast({ type: "room.projects.ok", projects });
  // Desktop windows: a dedicated channel so the renderer re-projects localStorage.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("projects:changed", projects);
  }
}

ipcMain.handle("projects:list", async () =>
  (await loadProjects()).map((p) => ({ path: p.path, name: p.name, addedAt: p.lastOpenedAt, pinned: p.pinned })),
);
ipcMain.handle("projects:add", async (_e, project: { path: string; name: string }) => {
  await pushRecent({ path: project.path, name: project.name, lastOpenedAt: Date.now() });
  await broadcastProjects();
});
ipcMain.handle("projects:remove", async (_e, projectPath: string) => {
  await softDelete(projectPath);
  await broadcastProjects();
});
ipcMain.handle("projects:setPinned", async (_e, projectPath: string, pinned: boolean) => {
  await setPinned(projectPath, pinned);
  await broadcastProjects();
});
```

- [ ] **Step 2: Make sendMobileProjectList use loadProjects**

Find `sendMobileProjectList` / the `room.projects` handler (index.ts:~509-518, currently uses
`loadRecents()`). Switch it to `loadProjects()` so phones get pinned+non-deleted projects:

```typescript
async function sendMobileProjectList(deviceId?: string): Promise<void> {
  const projects = (await loadProjects()).map((p) => ({
    path: p.path,
    name: p.name,
    addedAt: p.lastOpenedAt,
    pinned: p.pinned,
  }));
  const e = { type: "room.projects.ok", projects } as const;
  if (deviceId) mobileRemote.sendToDevice(deviceId, e);
  else mobileRemote.broadcast(e);
}
```

> Match the actual current signature of `sendMobileProjectList` (the explorer reported it sends
> `room.projects.ok`). Preserve per-device vs broadcast behavior.

- [ ] **Step 3: Typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/main/index.ts
git commit -m "feat(projects): main IPC (list/add/remove/setPinned) + change broadcast"
```

---

### Task C3: preload 暴露 projects.* + onProjectsChanged

**Files:**
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/types.d.ts`

- [ ] **Step 1: Expose the API**

In `packages/desktop/src/preload/index.ts`, add a `projects` object to the exposed `codeshell` API:

```typescript
    projects: {
      list: (): Promise<Array<{ path: string; name: string; addedAt: number; pinned?: boolean }>> =>
        ipcRenderer.invoke("projects:list"),
      add: (project: { path: string; name: string }): Promise<void> =>
        ipcRenderer.invoke("projects:add", project),
      remove: (projectPath: string): Promise<void> => ipcRenderer.invoke("projects:remove", projectPath),
      setPinned: (projectPath: string, pinned: boolean): Promise<void> =>
        ipcRenderer.invoke("projects:setPinned", projectPath, pinned),
      onChanged: (cb: (projects: Array<{ path: string; name: string; addedAt: number; pinned?: boolean }>) => void) => {
        const h = (_e: unknown, p: Array<{ path: string; name: string; addedAt: number; pinned?: boolean }>) => cb(p);
        ipcRenderer.on("projects:changed", h);
        return () => ipcRenderer.removeListener("projects:changed", h);
      },
    },
```

- [ ] **Step 2: Add types**

In `packages/desktop/src/preload/types.d.ts`, add the matching `projects` block to the
`codeshell` interface (mirror the shapes above).

- [ ] **Step 3: Typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts
git commit -m "feat(projects): preload projects.* API + onChanged"
```

---

### Task C4: 渲染层 repos 改投影模式

**Files:**
- Modify: `packages/desktop/src/renderer/repos.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`

- [ ] **Step 1: Add a projection loader to repos.ts**

`loadRepos()`/`saveRepos()` stay (localStorage cache), but add a function to hydrate from the
disk source and project it into the cache shape:

```typescript
/** Project the disk project list (source of truth) into the Repo cache shape.
 *  localStorage is now only a fast read cache rehydrated from this. */
export function projectToRepos(
  projects: Array<{ path: string; name: string; addedAt: number; pinned?: boolean }>,
): Repo[] {
  return projects.map((p) => ({
    id: makeRepoId(p.path),
    name: p.name,
    path: p.path,
    addedAt: p.addedAt,
    pinned: p.pinned,
  }));
}
```

> `makeRepoId` already exists in repos.ts (used by loadRepos consumers). Confirm its name; if it's
> `repoIdFor` or similar, use the actual exported helper. Drop `displayName` from the projection
> (rename isn't synced per spec — desktop keeps any local displayName separately if it wants, but
> the source list doesn't carry it).

- [ ] **Step 2: Hydrate + subscribe in App.tsx**

In `App.tsx`, where `repos` state is initialized from `loadRepos()`, add an effect that pulls the
disk source on mount and subscribes to changes, writing through to the localStorage cache:

```typescript
  useEffect(() => {
    let alive = true;
    void window.codeshell.projects.list().then((projects) => {
      if (!alive) return;
      const next = projectToRepos(projects);
      setRepos(next);
      saveRepos(next);
    });
    const unsub = window.codeshell.projects.onChanged((projects) => {
      const next = projectToRepos(projects);
      setRepos(next);
      saveRepos(next);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);
```

- [ ] **Step 3: Route mutations through main**

Change the four repo mutation handlers (App.tsx:813/825/844/848) to call the disk source instead
of mutating localStorage directly. The `onChanged` subscription will re-project, so they don't
need to `setRepos` optimistically (but may, for snappiness):

```typescript
  // ADD repo:
  const handleAddRepo = (path: string, name: string) => {
    void window.codeshell.projects.add({ path, name });
  };
  // REMOVE repo:
  const handleRemoveRepo = (id: string) => {
    const repo = repos.find((r) => r.id === id);
    if (repo) void window.codeshell.projects.remove(repo.path);
  };
  // PIN repo:
  const handlePinRepo = (id: string, pinned: boolean) => {
    const repo = repos.find((r) => r.id === id);
    if (repo) void window.codeshell.projects.setPinned(repo.path, pinned);
  };
```

> RENAME (`handleRenameRepo`): per spec, rename is NOT synced to disk. Keep the existing
> localStorage-only behavior for displayName, OR drop the rename feature. Recommended: keep it
> localStorage-only and note it's device-local (it won't survive a re-projection that overwrites
> repos — so store displayName in a SEPARATE localStorage map keyed by path, applied on top of the
> projected list). If that's too much scope, drop rename. Decide at implementation time;
> simplest correct path: drop the displayName override to avoid it being clobbered by re-projection.

- [ ] **Step 4: Typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/repos.ts packages/desktop/src/renderer/App.tsx
git commit -m "feat(projects): renderer repos as disk-source projection"
```

---

### Task C5: 手机进项目选择时主动刷新 + 桌面增删手机实时可见(集成验证)

**Files:**
- Modify: `packages/desktop/src/mobile/hooks/useRemoteApp.ts`

- [ ] **Step 1: Refresh projects on selectProject / mount**

`selectProject` (B2) already sends `session.list` + ccRoom probe/list. Also ensure the project
list is fresh: in `selectProject`, add `socket.send({ type: "room.projects" })`. And confirm the
existing mount effect (useRemoteApp.ts:522 — the `room.list` on online) also sends `room.projects`
so a freshly-connected phone gets the current disk list:

```typescript
  useEffect(() => {
    if (socket.status !== "online") return;
    socket.send({ type: "room.list" });
    socket.send({ type: "room.projects" });
  }, [socket.status, socket.send]);
```

> The phone already consumes `room.projects.ok` into `projects` state. Because main now
> broadcasts `room.projects.ok` on every disk change (C2 `broadcastProjects`), a desktop
> add/remove/pin reaches the phone live with no extra phone code.

- [ ] **Step 2: Typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/mobile/hooks/useRemoteApp.ts
git commit -m "feat(mobile): refresh project list on connect + project select"
```

---

## Final Verification

- [ ] **Run all desktop tests**

Run: `cd packages/desktop && bun test`
Expected: all PASS (new approval-bridge + recents-store tests included; no regressions).

- [ ] **Full typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: PASS.

- [ ] **Manual smoke (user, on device):** 见 `docs/smoke-checklist.md` — 加一节:
  手机切项目→只见该项目 session+cc 会话;开 cc 会话→能发消息+审批多端同步消失;
  桌面删项目→手机实时消失且重启不回来。

---

## Self-Review notes

- **Spec coverage:** A1=审批解决广播 bug;A2/A3/A4=ccRoom RPC 表面(probe/list/open/history/approve);
  B2/B3/B4=activeProjectCwd 选项目 + cc 会话 UI + newSession 竞态;C1–C5=磁盘真源(pin+软删除)
  + localStorage 投影 + 双端实时同步。全部 spec 段落有对应 task。
- **不迁移**:C 段无 localStorage→磁盘迁移任务(spec 已决定不迁移)。✓
- **权限**:openCcSession 固定 default,服务端 resolveRoomPermissionMode 兜底,不引入新语义。✓
- **审批广播**:保持广播(A3 onResolve 也广播),未改每设备路由。✓
- **类型一致**:CcDiscoveredSession/CcHistoryMessage/CcApprovalDecision 在 types.ts 定义,
  hook 与组件引用同名。loadProjects/setPinned/softDelete 跨 C1–C4 同名。✓
- **待实现时定夺的点**(已在步骤内标注,非占位):rename 是否保留(C4 Step3,推荐 drop);
  getRoom vs listRooms 取 open 字段(A3 Step2);mobile shell 挂载 CcSessionList 的 tab 原语(B4 Step2)。
