# CC 房间对话视图 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Claude Code 面板点 session → 看历史 → resume 常驻对话 → 工具审批回路 → 手机同步;删旧 rooms 面板。

**Architecture:** 扩展现有 ResidentAgentProcess(+--resume +--permission-prompt-tool stdio +control 协议)+ RoomManager(+claudeSessionId/openForSession);新增 ApprovalBridge(desktop main,pending Promise map+超时)+ SessionHistory(core,读 jsonl 最近 N 条)+ CCConversationView(renderer)。删 RoomsPanel,底层复用。

**已实测事实(当真理用,勿重验)**:
- spawn `claude --print --verbose --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --permission-mode <mode> [--resume <id>]`。
- 敏感工具 → stdout: `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{...},"description":"...","permission_suggestions":[...],"tool_use_id":"..."}}`。
- 回写 stdin: `{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>","response":{"behavior":"allow","updatedInput":{...}}}}` 或 `{"behavior":"deny","message":"..."}`。
- 进程阻塞等 stdin,天然 backpressure。超时必兜底(自动 deny)。

---

## 文件结构

- 改 `packages/desktop/src/main/mobile-remote/resident-agent.ts`(parse+spawn+respondControl)
- 改 `packages/desktop/src/main/mobile-remote/room-manager.ts`(RoomMeta+openForSession+event)
- 新 `packages/desktop/src/main/cc-room/approval-bridge.ts`(+ test)
- 新 `packages/core/src/cc-orchestrator/session-history.ts`(+ test)
- 改 `packages/desktop/src/main/index.ts`(ccRoom IPC 扩展 + ApprovalBridge 接线)
- 改 `packages/desktop/src/preload/index.ts`(+ types.d.ts)
- 新 `packages/desktop/src/renderer/cc-room/CCConversationView.tsx`
- 改 `packages/desktop/src/renderer/cc-room/CCRoomView.tsx`(点 session→选档→进对话)
- 改 `packages/desktop/src/renderer/panels/PanelArea.tsx` + `view.ts` + i18n(删 rooms 面板)

---

## Task 1: SessionHistory(core,读 jsonl 最近 N 条)

**Files:** Create `packages/core/src/cc-orchestrator/session-history.ts` + `.test.ts`

- [ ] **Step 1: 失败测试**

```ts
// session-history.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecentHistory } from "./session-history.js";
import { encodeCwd } from "./session-discovery.js";

function setup(lines: object[]): { cwd: string; home: string; sid: string } {
  const home = mkdtempSync(join(tmpdir(), "claude-home-"));
  const cwd = "/tmp/proj";
  const sid = "sess-1111";
  const dir = join(home, "projects", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { cwd, home, sid };
}

describe("readRecentHistory", () => {
  it("returns last N user/assistant messages with hasMore", () => {
    const lines = [
      { type: "user", message: { role: "user", content: "first" } },
      { type: "assistant", message: { content: [{ type: "text", text: "reply1" }] } },
      { type: "user", message: { role: "user", content: "second" } },
      { type: "assistant", message: { content: [{ type: "text", text: "reply2" }] } },
    ];
    const { cwd, home, sid } = setup(lines);
    const r = readRecentHistory(cwd, sid, 2, home);
    expect(r.messages.length).toBe(2);
    expect(r.messages[r.messages.length - 1].text).toBe("reply2");
    expect(r.hasMore).toBe(true);
    expect(r.totalCount).toBe(4);
  });
  it("captures assistant tool_use as a tool summary", () => {
    const lines = [
      { type: "user", message: { role: "user", content: "do" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/a.txt" } }] } },
    ];
    const { cwd, home, sid } = setup(lines);
    const r = readRecentHistory(cwd, sid, 10, home);
    const a = r.messages.find((m) => m.role === "assistant");
    expect(a?.tools?.[0].name).toBe("Write");
  });
  it("skips caveat noise; returns empty when session absent", () => {
    expect(readRecentHistory("/tmp/none", "nope", 10, mkdtempSync(join(tmpdir(), "h-"))).messages).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/core && bun test src/cc-orchestrator/session-history.test.ts`

- [ ] **Step 3: 实现**

```ts
// session-history.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { encodeCwd } from "./session-discovery.js";

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  tools?: { name: string; summary: string }[];
  ts?: number;
}

const NOISE = ["<local-command-caveat>", "<command-name>"];
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}
function toolsOf(content: unknown): { name: string; summary: string }[] {
  if (!Array.isArray(content)) return [];
  const out: { name: string; summary: string }[] = [];
  for (const p of content as any[]) {
    if (p?.type === "tool_use") {
      const inp = p.input ?? {};
      const summary = inp.command ?? inp.file_path ?? inp.path ?? inp.url ?? inp.pattern ?? inp.query ?? "";
      out.push({ name: typeof p.name === "string" ? p.name : "tool", summary: String(summary).slice(0, 120) });
    }
  }
  return out;
}

/** Read the last `limit` user/assistant messages from a claude session jsonl. */
export function readRecentHistory(
  cwd: string,
  sessionId: string,
  limit: number,
  claudeHome = join(homedir(), ".claude"),
): { messages: HistoryMessage[]; hasMore: boolean; totalCount: number } {
  const file = join(claudeHome, "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
  if (!existsSync(file)) return { messages: [], hasMore: false, totalCount: 0 };
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch { return { messages: [], hasMore: false, totalCount: 0 }; }
  const all: HistoryMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "user") {
      const t = textOf(d.message?.content).trim();
      if (!t || NOISE.some((n) => t.startsWith(n))) continue;
      all.push({ role: "user", text: t.slice(0, 4000) });
    } else if (d.type === "assistant") {
      const t = textOf(d.message?.content).trim();
      const tools = toolsOf(d.message?.content);
      if (!t && tools.length === 0) continue;
      all.push({ role: "assistant", text: t.slice(0, 4000), tools: tools.length ? tools : undefined });
    }
  }
  const lim = limit > 0 ? limit : 20;
  const start = Math.max(0, all.length - lim);
  return { messages: all.slice(start), hasMore: start > 0, totalCount: all.length };
}
```

- [ ] **Step 4: 跑确认通过 + tsc** — `cd packages/core && bun test src/cc-orchestrator/session-history.test.ts && bunx tsc --noEmit`
- [ ] **Step 5: 加进 barrel** — 编辑 `packages/core/src/cc-orchestrator/index.ts` 加 `export * from "./session-history.js";`,再 `bunx tsc --noEmit`
- [ ] **Step 6: Commit** — `git add packages/core/src/cc-orchestrator/session-history.* packages/core/src/cc-orchestrator/index.ts && git commit -m "feat(cc-orchestrator): SessionHistory 读 jsonl 最近 N 条"`

---

## Task 2: ResidentAgentProcess 扩展(resume + 审批控制协议)

**Files:** 改 `packages/desktop/src/main/mobile-remote/resident-agent.ts` + 新 `resident-agent.test.ts`(若无)

现状:`parseStreamJsonLine(line)` 返回 `ResidentAgentEvent[]`;`ResidentAgentOptions` 有 command/cwd/permissionMode/onEvent;spawn 用 `--print --verbose --input-format stream-json --output-format stream-json --permission-mode <m>`;`send(text)` 写 user 消息。

- [ ] **Step 1: 失败测试(parse 识别 control_request)**

```ts
// resident-agent.test.ts(若已存在则追加)
import { describe, it, expect } from "bun:test";
import { parseStreamJsonLine } from "./resident-agent.js";

describe("parseStreamJsonLine approval", () => {
  it("maps control_request can_use_tool to approval_request event", () => {
    const line = JSON.stringify({
      type: "control_request", request_id: "r1",
      request: { subtype: "can_use_tool", tool_name: "Write", display_name: "Write",
        input: { file_path: "/a.txt" }, description: "a.txt" },
    });
    const evs = parseStreamJsonLine(line);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "approval_request", requestId: "r1", toolName: "Write" });
  });
  it("still ignores system/init noise", () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/desktop && bun test src/main/mobile-remote/resident-agent.test.ts`

- [ ] **Step 3: 实现扩展**

在 `ResidentAgentEvent` union 加:
```ts
  | { type: "approval_request"; requestId: string; toolName: string; displayName?: string; input: unknown; description?: string }
```
在 `parseStreamJsonLine` 顶部(system/init 判断前)加:
```ts
  if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
    return [{
      type: "approval_request",
      requestId: String(msg.request_id ?? ""),
      toolName: String(msg.request?.tool_name ?? "tool"),
      displayName: typeof msg.request?.display_name === "string" ? msg.request.display_name : undefined,
      input: msg.request?.input,
      description: typeof msg.request?.description === "string" ? msg.request.description : undefined,
    }];
  }
```
在 `ResidentAgentOptions` 加 `resumeSessionId?: string;`。
在 spawn args 里:`--permission-prompt-tool`, `"stdio"` 始终加;`resumeSessionId` 存在则加 `"--resume", this.opts.resumeSessionId`。
加方法:
```ts
respondControl(requestId: string, decision:
  { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string }): void {
  if (!this.child?.stdin || this.child.stdin.destroyed) return;
  const resp = { type: "control_response", response: { subtype: "success", request_id: requestId, response: decision } };
  this.child.stdin.write(JSON.stringify(resp) + "\n");
}
```

- [ ] **Step 4: 跑确认通过 + tsc** — `cd packages/desktop && bun test src/main/mobile-remote/resident-agent.test.ts && bunx tsc --noEmit`
- [ ] **Step 5: Commit** — `git commit -m "feat(cc-room): ResidentAgentProcess 支持 resume + 审批控制协议(control_request/response)"`

---

## Task 3: ApprovalBridge(desktop main,pending map + 超时)

**Files:** 新 `packages/desktop/src/main/cc-room/approval-bridge.ts` + `.test.ts`

- [ ] **Step 1: 失败测试**

```ts
// approval-bridge.test.ts
import { describe, it, expect } from "bun:test";
import { ApprovalBridge } from "./approval-bridge.js";

describe("ApprovalBridge", () => {
  it("resolves with the decision when respond is called", async () => {
    let pushed: any = null;
    const b = new ApprovalBridge({ timeoutMs: 10_000, onPush: (_r, req) => { pushed = req; } });
    const p = b.request("room1", "req1", { toolName: "Write", input: { file_path: "/a" } });
    expect(pushed.toolName).toBe("Write");
    b.respond("room1", "req1", { behavior: "allow" });
    expect(await p).toEqual({ behavior: "allow" });
  });
  it("auto-denies on timeout", async () => {
    const b = new ApprovalBridge({ timeoutMs: 20, onPush: () => {} });
    const p = b.request("room1", "req2", { toolName: "Bash", input: {} });
    const d = await p;
    expect(d.behavior).toBe("deny");
  });
  it("respond for unknown id returns false", () => {
    const b = new ApprovalBridge({ timeoutMs: 1000, onPush: () => {} });
    expect(b.respond("r", "nope", { behavior: "allow" })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/desktop && bun test src/main/cc-room/approval-bridge.test.ts`

- [ ] **Step 3: 实现**

```ts
// approval-bridge.ts
export type ApprovalDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

export interface ApprovalRequestPayload { toolName: string; displayName?: string; input: unknown; description?: string; }

interface Pending { resolve: (d: ApprovalDecision) => void; timer: ReturnType<typeof setTimeout>; }

export interface ApprovalBridgeOptions {
  timeoutMs?: number;
  onPush: (roomId: string, req: ApprovalRequestPayload & { requestId: string }) => void;
}

/** Bridges claude's control_request:can_use_tool to a remote/UI decision.
 *  Parks a Promise keyed by requestId, pushes the request out, auto-denies on
 *  timeout (guards against the host hanging — claude-code#52084). */
export class ApprovalBridge {
  private pending = new Map<string, Pending>(); // key = `${roomId}:${requestId}`
  private readonly timeoutMs: number;
  constructor(private readonly opts: ApprovalBridgeOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  }
  private key(roomId: string, requestId: string) { return `${roomId}:${requestId}`; }

  request(roomId: string, requestId: string, payload: ApprovalRequestPayload): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const k = this.key(roomId, requestId);
      const timer = setTimeout(() => {
        if (this.pending.delete(k)) resolve({ behavior: "deny", message: "approval timed out" });
      }, this.timeoutMs);
      this.pending.set(k, { resolve, timer });
      this.opts.onPush(roomId, { ...payload, requestId });
    });
  }
  respond(roomId: string, requestId: string, decision: ApprovalDecision): boolean {
    const k = this.key(roomId, requestId);
    const p = this.pending.get(k);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(k);
    p.resolve(decision);
    return true;
  }
}
```

- [ ] **Step 4: 跑确认通过 + tsc** — `cd packages/desktop && bun test src/main/cc-room/approval-bridge.test.ts && bunx tsc --noEmit`
- [ ] **Step 5: Commit** — `git commit -m "feat(cc-room): ApprovalBridge pending-promise map + 超时自动 deny"`

---

## Task 4: RoomManager 扩展(claudeSessionId + openForSession + approval 事件)

**Files:** 改 `packages/desktop/src/main/mobile-remote/room-manager.ts` + `room-manager.test.ts`(若有则追加,无则建)

现状已读:`RoomMeta` 有 id/name/cwd/kind/permissionMode/createdAt/lastActiveAt;`createRoom`/`open(id)`/`send`/`onAgentEvent` switch;`RoomAgentFactory(meta,onEvent)`;`agents` map 保证一 room↔一进程。

- [ ] **Step 1: 失败测试(openForSession 去重 + approval 事件回调)**

```ts
// room-manager.test.ts(追加/新建,用 fake agent)
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager } from "./room-manager.js";

function mk(onApproval?: (roomId: string, req: any) => void) {
  const started: string[] = [];
  const rm = new RoomManager({
    rootDir: mkdtempSync(join(tmpdir(), "rooms-")),
    createAgent: (_meta, onEvent) => ({
      start: () => { started.push("s"); },
      send: () => true, isRunning: () => true, stop: () => {},
      // expose onEvent so test can emit
      __emit: onEvent,
    } as any),
    onMessage: () => {},
    onApprovalRequest: onApproval,
    now: () => 1000,
  } as any);
  return { rm, started };
}

describe("openForSession", () => {
  it("creates a room bound to claudeSessionId and reuses on second call", () => {
    const { rm } = mk();
    const r1 = rm.openForSession("cc-sess-A", "/tmp/p", "default");
    const r2 = rm.openForSession("cc-sess-A", "/tmp/p", "default");
    expect(r1.roomId).toBe(r2.roomId); // same room reused
    expect(rm.getRoom(r1.roomId)?.claudeSessionId).toBe("cc-sess-A");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/desktop && bun test src/main/mobile-remote/room-manager.test.ts`

- [ ] **Step 3: 实现**

- `RoomMeta` 加 `claudeSessionId?: string;`。
- `RoomManagerOptions` 加 `onApprovalRequest?: (roomId: string, req: { requestId: string; toolName: string; displayName?: string; input: unknown; description?: string }) => void;`。
- `createRoom` input 加 `claudeSessionId?`,写进 meta。
- 新方法:
```ts
openForSession(claudeSessionId: string, cwd: string, mode: RoomPermissionMode): { roomId: string } {
  const existing = this.listRooms().find((r) => r.claudeSessionId === claudeSessionId);
  const meta = existing ?? this.createRoom({ cwd, permissionMode: mode, claudeSessionId });
  this.open(meta.id);
  return { roomId: meta.id };
}
```
- `onAgentEvent` switch 加:
```ts
  case "approval_request":
    this.append(id, { from: "agent", type: "approval", tool: event.toolName, summary: event.description ?? "" });
    this.opts.onApprovalRequest?.(id, event);
    break;
```
- `RoomMessage` 的 `type` 已是 string,无需改;`from:"agent" type:"approval"` 直接用。
- agent 工厂传 resumeSessionId:在创建 ResidentAgentProcess 的工厂里(desktop index.ts,Task 5),用 `meta.claudeSessionId` 作为 resumeSessionId、`meta.permissionMode` 作为 mode。RoomManager 只把 meta 传给 factory(已有),无需改 factory 签名。

- [ ] **Step 4: 跑确认通过 + tsc** — `cd packages/desktop && bun test src/main/mobile-remote/room-manager.test.ts && bunx tsc --noEmit`
- [ ] **Step 5: Commit** — `git commit -m "feat(cc-room): RoomManager openForSession(按 claudeSessionId 去重) + approval 事件转发"`

---

## Task 5: desktop main 接线(ccRoom IPC 扩展 + ApprovalBridge + resume 工厂)

**Files:** 改 `packages/desktop/src/main/index.ts` + `preload/index.ts` + `preload/types.d.ts`

现状:roomManager 已实例化(createAgent 工厂里 new ResidentAgentProcess)。ccRoom IPC 已有 probe/listSessions/listTasks/deleteTask。rooms IPC 有 list/open/send/history。

- [ ] **Step 1: ApprovalBridge 实例化 + 接进 roomManager**

在 roomManager 构造处:
- new ApprovalBridge({ onPush: (roomId, req) => { /* 发 renderer 事件 + 推手机 */ mainWindow?.webContents.send("ccRoom:approvalRequest", { roomId, ...req }); /* 复用现有 room:message 手机推送通道 */ } })。
- roomManager 的 `onApprovalRequest: (roomId, ev) => { approvalBridge.request(roomId, ev.requestId, ev).then((decision) => roomManager.respondApproval(roomId, ev.requestId, decision)); }`。
  > 需要 RoomManager 暴露 `respondApproval(roomId, requestId, decision)` 转发到 agent.respondControl —— 加一个小方法(Task 4 可一并加;若没加,在此加:`respondApproval(id, reqId, d){ (this.agents.get(id) as any)?.respondControl?.(reqId, d); }`)。
- createAgent 工厂:`new ResidentAgentProcess({ command: "claude", cwd: meta.cwd, permissionMode: meta.permissionMode, resumeSessionId: meta.claudeSessionId, onEvent })`。

- [ ] **Step 2: ccRoom IPC 扩展(在现有 ccRoom 块旁)**

```ts
ipcMain.handle("ccRoom:openSession", async (_e, claudeSessionId: string, cwd: string, mode: "default"|"acceptEdits"|"bypassPermissions") =>
  roomManager.openForSession(claudeSessionId, cwd, mode));
ipcMain.handle("ccRoom:send", async (_e, roomId: string, text: string) => roomManager.send(roomId, text));
ipcMain.handle("ccRoom:respondApproval", async (_e, roomId: string, requestId: string, decision: any) =>
  approvalBridge.respond(roomId, requestId, decision));
ipcMain.handle("ccRoom:history", async (_e, roomId: string, sinceSeq?: number) => roomManager.getMessages(roomId, sinceSeq ?? 0));
ipcMain.handle("ccRoom:readHistory", async (_e, cwd: string, sessionId: string, limit: number) =>
  readRecentHistory(cwd, sessionId, limit));   // import from @cjhyy/code-shell-core
ipcMain.handle("ccRoom:close", async (_e, roomId: string) => roomManager.close(roomId));
```
import 加 `readRecentHistory`(core barrel)、`ApprovalBridge`(./cc-room/approval-bridge.js)。
现有 room:message 推送(onMessage)已把房间消息发 renderer/手机 —— 复用;renderer 订阅 room:message 拿实时流。

- [ ] **Step 3: preload + types.d.ts**

preload `ccRoom` 命名空间加:
```ts
openSession: (sid: string, cwd: string, mode: string) => ipcRenderer.invoke("ccRoom:openSession", sid, cwd, mode),
send: (roomId: string, text: string) => ipcRenderer.invoke("ccRoom:send", roomId, text),
respondApproval: (roomId: string, requestId: string, decision: unknown) => ipcRenderer.invoke("ccRoom:respondApproval", roomId, requestId, decision),
history: (roomId: string, sinceSeq?: number) => ipcRenderer.invoke("ccRoom:history", roomId, sinceSeq),
readHistory: (cwd: string, sid: string, limit: number) => ipcRenderer.invoke("ccRoom:readHistory", cwd, sid, limit),
close: (roomId: string) => ipcRenderer.invoke("ccRoom:close", roomId),
onRoomMessage: (cb: (env: { roomId: string; msg: unknown }) => void) => { const h = (_e:any, env:any)=>cb(env); ipcRenderer.on("room:message", h); return () => ipcRenderer.removeListener("room:message", h); },
onApprovalRequest: (cb: (req: { roomId: string; requestId: string; toolName: string; displayName?: string; input: unknown; description?: string }) => void) => { const h=(_e:any,req:any)=>cb(req); ipcRenderer.on("ccRoom:approvalRequest", h); return () => ipcRenderer.removeListener("ccRoom:approvalRequest", h); },
```
types.d.ts 的 `ccRoom` 接口补这些成员。

- [ ] **Step 4: 两包 tsc** — `cd packages/core && bun run build && cd ../desktop && bunx tsc --noEmit`(desktop 依赖 core dist)。0 错。
- [ ] **Step 5: Commit** — `git commit -m "feat(cc-room): desktop 接线 — ccRoom 对话/审批 IPC + ApprovalBridge + resume 工厂"`

---

## Task 6: CCConversationView UI + CCRoomView 点 session 进对话

**Files:** 新 `packages/desktop/src/renderer/cc-room/CCConversationView.tsx` + 改 `CCRoomView.tsx`

遵 desktop CLAUDE.md(shadcn + Tailwind tokens,thin client 只用 window.codeshell)。

- [ ] **Step 1: CCRoomView 点 session → 选档 → 进对话**

CCRoomView 的 session 卡片 onClick:打开一个权限档选择(shadcn Dialog + 三个 Button:default/acceptEdits/bypassPermissions),选后 `const { roomId } = await window.codeshell.ccRoom.openSession(s.sessionId, cwd, mode)`,setState 切到 `<CCConversationView roomId cwd sessionId mode onBack=.../>`。"新开 session" 同理但传一个空 sessionId(openForSession 仍可,nofresh:传 sessionId="" 时 RoomManager createRoom 不绑 claudeSessionId,起全新 —— 或直接也走 openSession 传一个新 id;本版"新开"先用 openSession("", cwd, mode) 起裸进程)。

- [ ] **Step 2: CCConversationView 实现**

```tsx
import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface HistoryMessage { role: "user"|"assistant"; text: string; tools?: {name:string;summary:string}[]; }
interface RoomMessage { seq:number; from:string; type:string; text?:string; tool?:string; summary?:string; reason?:string; isError?:boolean; }
interface ApprovalReq { roomId:string; requestId:string; toolName:string; displayName?:string; input:unknown; description?:string; }

export function CCConversationView({ roomId, cwd, sessionId, mode, onBack }: { roomId:string; cwd:string; sessionId:string; mode:string; onBack:()=>void }) {
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const [live, setLive] = useState<RoomMessage[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalReq[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (sessionId) window.codeshell.ccRoom.readHistory(cwd, sessionId, 20).then((r:any)=>setHistory(r.messages));
    window.codeshell.ccRoom.history(roomId).then((m:any)=>setLive(m));
    const off1 = window.codeshell.ccRoom.onRoomMessage(({ roomId: rid, msg }:any) => { if (rid===roomId) setLive((p)=>[...p, msg as RoomMessage]); });
    const off2 = window.codeshell.ccRoom.onApprovalRequest((req:any) => { if (req.roomId===roomId) setPendingApprovals((p)=>[...p, req]); });
    return () => { off1(); off2(); };
  }, [roomId, cwd, sessionId]);

  const send = useCallback(() => { const t=input.trim(); if(!t)return; window.codeshell.ccRoom.send(roomId, t); setInput(""); }, [input, roomId]);
  const decide = (req: ApprovalReq, behavior: "allow"|"deny") => {
    window.codeshell.ccRoom.respondApproval(roomId, req.requestId, behavior==="allow"?{behavior:"allow"}:{behavior:"deny",message:"denied by user"});
    setPendingApprovals((p)=>p.filter((r)=>r.requestId!==req.requestId));
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-border p-2">
        <div className="text-sm font-medium">CC 会话 · <code className="text-xs">{(sessionId||roomId).slice(0,8)}</code> · {mode}</div>
        <Button variant="ghost" size="sm" onClick={onBack}>返回</Button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {/* 历史区(只读) */}
        {history.length>0 && <div className="text-xs text-muted-foreground">— 历史 —</div>}
        {history.map((m,i)=>(
          <div key={`h${i}`} className="opacity-70">
            <span className="text-xs font-semibold">{m.role}: </span>
            <span className="text-sm whitespace-pre-wrap">{m.text}</span>
            {m.tools?.map((t,j)=><div key={j} className="text-xs text-muted-foreground">🔧 {t.name} {t.summary}</div>)}
          </div>
        ))}
        {/* 实时区 */}
        {live.length>0 && <div className="text-xs text-muted-foreground">— 实时 —</div>}
        {live.map((m)=>(
          <div key={m.seq} className="text-sm">
            <span className="text-xs font-semibold">{m.from}: </span>
            {m.type==="text" && <span className="whitespace-pre-wrap">{m.text}</span>}
            {m.type==="tool" && <span className="text-muted-foreground">🔧 {m.tool} {m.summary}</span>}
            {m.type==="tool_result" && <span className={m.isError?"text-status-err":"text-muted-foreground"}>↳ {m.summary}</span>}
            {m.type==="turn_end" && <span className="text-xs text-muted-foreground">（完成）</span>}
            {m.type==="error" && <span className="text-status-err">{m.text}</span>}
          </div>
        ))}
        {/* 审批 */}
        {pendingApprovals.map((req)=>(
          <Card key={req.requestId} className="p-3 border-status-warn">
            <div className="text-sm font-medium">请求执行工具:{req.displayName ?? req.toolName}</div>
            {req.description && <div className="text-xs text-muted-foreground">{req.description}</div>}
            <pre className="text-xs bg-muted rounded p-1 overflow-x-auto mt-1">{JSON.stringify(req.input,null,2).slice(0,400)}</pre>
            <div className="flex gap-2 mt-2">
              <Button size="sm" onClick={()=>decide(req,"allow")}>允许</Button>
              <Button size="sm" variant="outline" onClick={()=>decide(req,"deny")}>拒绝</Button>
            </div>
          </Card>
        ))}
      </div>
      <div className="flex gap-2 border-t border-border p-2">
        <input className="flex-1 rounded-md border border-border bg-background px-2 text-sm" value={input}
          onChange={(e)=>setInput(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter")send();}} placeholder="发消息给 Claude Code…" />
        <Button size="sm" onClick={send}>发送</Button>
      </div>
    </div>
  );
}
```
> 注:输入框这里用了原生 input。desktop CLAUDE.md 要求用 `@/components/ui` 的 Input;若存在 `@/components/ui/input` 用它替换原生 input。实现时检查并用 shadcn Input(`import { Input } from "@/components/ui/input"`)。

- [ ] **Step 3: 两包构建** — `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`。0 错 + build OK。
- [ ] **Step 4: Commit** — `git commit -m "feat(cc-room): CCConversationView 历史+实时+审批 UI；CCRoomView 点 session 选档进对话"`

---

## Task 7: 删旧 RoomsPanel(新面板接管)

**Files:** 改 `packages/desktop/src/renderer/view.ts` + `panels/PanelArea.tsx` + i18n panels ns;删 `panels/RoomsPanel.tsx`(或留文件但移除入口)

- [ ] **Step 1: 移除 rooms 面板入口**
- `view.ts` 的 `PanelTab` 去掉 `"rooms"`。
- `PanelArea.tsx` 的 KINDS / META / PanelBody switch 移除 `rooms` 项 + RoomsPanel import。
- i18n panels ns 移除 `rooms` 标签(或留着无害)。
- 删 `RoomsPanel.tsx`(grep 确认无其他 import 后删;若 mobile 端或别处仍 import 则保留文件只去面板入口)。
> 底层 RoomManager / rooms:* IPC / 手机同步 **不删**(手机端仍用)。只删桌面 rooms 面板 UI 入口。

- [ ] **Step 2: 两包构建** — `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`。0 错。
- [ ] **Step 3: Commit** — `git commit -m "feat(cc-room): 删桌面旧 rooms 面板入口(Claude Code 面板接管,底层保留)"`

---

## Task 8: 收尾验证 + 冒烟清单

- [ ] **Step 1: 全量** — `cd packages/core && bun test src/cc-orchestrator/ && bunx tsc --noEmit && cd ../desktop && bunx tsc --noEmit && bun run build:renderer`。全绿。
- [ ] **Step 2: 回归** — `cd packages/desktop && bun test src/main/mobile-remote/`(rooms/resident 没破)。
- [ ] **Step 3: 冒烟清单** — 追加 section 到 `docs/smoke-checklist-cc-orchestrator.md`(或主 smoke-checklist.md):
  - [ ] 点 session→选 default→实时区让它写文件→审批卡弹→允许→文件真写、对话续。
  - [ ] 拒绝→claude 收 deny 不执行、对话续。
  - [ ] 审批 5min 不点→自动 deny 不挂死。
  - [ ] 历史区显示该 session 最近 N 条且正确(中文路径项目);看更多往前。
  - [ ] resume 续接:第一句后 claude 记得历史。
  - [ ] 并发:同 session 已开再点不重起(复用)。
  - [ ] 删 rooms 面板后手机端仍能用。
- [ ] **Step 4: Commit** — `git commit -m "docs: CC 房间对话视图冒烟清单"`

---

## 落地后真机验证(见 spec 第 8 节)

审批往返(allow/deny/超时)、历史正确性、resume 上下文延续、并发去重、手机端回归 —— 全需真机一遍。
