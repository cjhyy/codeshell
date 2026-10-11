import { test, expect, afterEach } from "bun:test";
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw Error("Review deny-all network guard");
}) as any;
const { act } = await import("../../../../node_modules/react/index.js");
const { ensureMiniDom, flushMicrotasks, renderHook } =
  await import("../../../../packages/web/src/test-utils/renderHook.tsx");
const { useRemoteApp } = await import("../../../../packages/web/src/hooks/useRemoteApp.ts");
const { ApprovalBridge } =
  await import("../../../../packages/desktop/src/main/cc-room/approval-bridge.ts");
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: any;
  onmessage: any;
  onclose: any;
  onerror: any;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(payload: any) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}
const restores: (() => void)[] = [];
function set(target: object, key: string, value: any) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() =>
    descriptor
      ? Object.defineProperty(target, key, descriptor)
      : Reflect.deleteProperty(target, key),
  );
}
async function setup() {
  ensureMiniDom();
  FakeWebSocket.instances = [];
  const data = new Map([
    ["cs.deviceId", "device-1"],
    ["cs.deviceSecret", "secret-1"],
    ["cs.deviceName", "Phone"],
  ]);
  set(globalThis, "localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  });
  set(globalThis, "WebSocket", FakeWebSocket);
  set(window, "location", { origin: "http://127.0.0.1:3000", search: "", pathname: "/mobile" });
  set(window, "history", { replaceState() {} });
  const hook = await renderHook(() => useRemoteApp());
  const ws = FakeWebSocket.instances[0]!;
  await act(async () => {
    ws.open();
    ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
    await flushMicrotasks();
  });
  await act(async () => {
    ws.message({
      type: "room.list.ok",
      rooms: [
        {
          id: "room_a_b",
          cwd: "/repo",
          kind: "claude-code",
          name: "Fixture",
          permissionMode: "default",
          createdAt: 1,
          lastActiveAt: 1,
          open: true,
        },
      ],
    });
    ws.message({
      type: "ccRoom.opened",
      roomId: "room_a_b",
      sessionId: "cli-session",
      status: "running",
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.activeRoom?.id).toBe("room_a_b");
  return { hook, ws };
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  FakeWebSocket.instances = [];
});
const payload = {
  toolName: "Bash",
  input: { command: "pwd" },
  description: "Read current directory",
};
const history = {
  type: "room.history.ok",
  roomId: "room_a_b",
  latestSeq: 2,
  messages: [
    {
      seq: 2,
      ts: 123,
      from: "agent",
      type: "approval",
      tool: "Bash",
      summary: "Read current directory",
    },
  ],
};

test("review reproduction: switching away and returning loses a still-pending CC approval", async () => {
  const { hook, ws } = await setup();
  let pushed = 0;
  const bridge = new ApprovalBridge({
    timeoutMs: 10000,
    onPush: (roomId, req) => {
      pushed++;
      ws.message({ type: "ccRoom.approvalRequest", roomId, req });
    },
  });
  try {
    let outcome: unknown;
    await act(async () => {
      void bridge.request("room_a_b", "approval-1", payload).then((v) => (outcome = v));
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toHaveLength(1);
    await act(async () => {
      hook.result.current.selectSession("core-session");
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toHaveLength(0);
    await act(async () => {
      ws.message({
        type: "ccRoom.opened",
        roomId: "room_a_b",
        sessionId: "cli-session",
        status: "running",
      });
      ws.message(history);
      await flushMicrotasks();
    });
    expect(hook.result.current.activeRoom?.id).toBe("room_a_b");
    expect(hook.result.current.approvals).toHaveLength(0);
    expect(pushed).toBe(1);
    expect(outcome).toBeUndefined();
    expect(
      bridge.respond("room_a_b", "approval-1", { behavior: "deny", message: "fixture cleanup" }),
    ).toBe(true);
    console.info(
      "Confirmed: returned to same room with history replayed, but pending approval is missing and server is still waiting.",
    );
  } finally {
    bridge.cancelRoom("room_a_b");
    await hook.unmount();
  }
});

test("review reproduction: an offline CC approval response removes the only card without sending", async () => {
  const { hook, ws } = await setup();
  try {
    await act(async () => {
      ws.message({
        type: "ccRoom.approvalRequest",
        roomId: "room_a_b",
        req: { ...payload, requestId: "approval-2" },
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toHaveLength(1);
    await act(async () => {
      ws.close();
      await flushMicrotasks();
    });
    const sentBefore = ws.sent.length;
    await act(async () => {
      hook.result.current.respondCcApproval("room_a_b", "approval-2", {
        behavior: "allow",
        updatedInput: {},
      });
      await flushMicrotasks();
    });
    expect(ws.sent.length).toBe(sentBefore);
    expect(hook.result.current.approvals).toHaveLength(0);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const reconnect = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      reconnect.open();
      reconnect.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      reconnect.message(history);
      await flushMicrotasks();
    });
    expect(reconnect.sent.some((line) => JSON.parse(line).type === "room.history")).toBe(true);
    expect(hook.result.current.approvals).toHaveLength(0);
    console.info(
      "Confirmed: offline approval click sends nothing, removes card, and reconnect history does not restore it.",
    );
  } finally {
    await hook.unmount();
  }
});
