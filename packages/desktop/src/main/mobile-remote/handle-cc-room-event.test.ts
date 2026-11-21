import { expect, test } from "bun:test";
import { ApprovalBridge } from "../cc-room/approval-bridge.js";
import { handleCcRoomEvent } from "./handle-cc-room-event.js";

function harness() {
  const viewers: Array<[string, Record<string, unknown>]> = [];
  const bridge = new ApprovalBridge({ onPush: () => undefined });
  const opens: Array<Record<string, any>> = [];
  const broadcasts: string[] = [];
  let online = true;
  let openResult: () => Promise<Record<string, unknown>> = async () => ({
    roomId: "room-a",
    status: "running",
    mode: "default",
    changed: false,
  });
  const ctx = {
    approvalBridge: bridge,
    remote: {
      sendToViewer: (viewerId: string, event: Record<string, unknown>) =>
        viewers.push([viewerId, event]),
      sendToDevice: () => undefined,
      broadcast: () => undefined,
      hasAuthenticatedViewer: () => online,
    },
    roomModes: {
      openSession: async (input: Record<string, any>) => {
        opens.push(input);
        return openResult();
      },
    },
    broadcastRoomState: (roomId: string) => broadcasts.push(roomId),
    roomMatchesTranscript: () => true,
    transcriptSubscriptions: {
      subscribe: () => ({
        active: true,
        messages: [],
        hasMore: false,
        totalCount: 0,
        roomCursor: 3,
      }),
    },
  } as any;
  return {
    ctx,
    bridge,
    viewers,
    opens,
    broadcasts,
    setOnline: (value: boolean) => (online = value),
    setOpenResult: (value: typeof openResult) => (openResult = value),
  };
}

test("phone open goes through the Host authority, echoes requestId and reports the applied mode", async () => {
  const f = harness();
  f.setOpenResult(async () => ({
    roomId: "room-a",
    status: "running",
    mode: "bypassPermissions",
    changed: true,
  }));
  await handleCcRoomEvent(f.ctx, {
    type: "ccRoom.openSession",
    sessionId: "thread-a",
    cwd: "/repo",
    mode: "bypassPermissions",
    kind: "codex",
    requestId: "open-1",
    deviceId: "device",
    viewerId: "tab-1",
  });
  expect(f.opens).toHaveLength(1);
  expect(f.opens[0]).toMatchObject({
    sessionId: "thread-a",
    cwd: "/repo",
    kind: "codex",
    mode: "bypassPermissions",
    requester: { key: "mobile:tab-1", channel: "mobile", openRequestId: "open-1" },
  });
  // The requester binding fails closed once the paired tab is gone.
  expect(() => f.opens[0]!.requester.assertCurrent()).not.toThrow();
  f.setOnline(false);
  expect(() => f.opens[0]!.requester.assertCurrent()).toThrow();
  expect(f.viewers[0]).toEqual([
    "tab-1",
    {
      type: "ccRoom.opened",
      roomId: "room-a",
      sessionId: "thread-a",
      status: "running",
      permissionMode: "bypassPermissions",
      modelKey: null,
      changed: true,
      requestId: "open-1",
    },
  ]);
  // Every other view learns the authoritative mode.
  expect(f.broadcasts).toEqual(["room-a"]);
});

test("a refused open (denied approval, busy room) is a visible error tied to its request, never a silent downgrade", async () => {
  const f = harness();
  f.setOpenResult(async () => {
    throw new Error("全放行未获批准，权限模式未更改（已拒绝）。");
  });
  await handleCcRoomEvent(f.ctx, {
    type: "ccRoom.openSession",
    sessionId: "thread-a",
    cwd: "/repo",
    mode: "bypassPermissions",
    requestId: "open-2",
    deviceId: "device",
    viewerId: "tab-1",
  });
  expect(f.viewers).toEqual([
    [
      "tab-1",
      {
        type: "room.error",
        message: "全放行未获批准，权限模式未更改（已拒绝）。",
        requestId: "open-2",
      },
    ],
  ]);
  expect(f.broadcasts).toEqual([]);
});

test("returning to a CLI room replays its still-pending approvals to that viewer", async () => {
  const { ctx, bridge, viewers } = harness();
  const pending = bridge.request("room-a", "read-1", {
    toolName: "Read",
    input: { file_path: "/repo/a.ts" },
    description: "Read a.ts",
  });
  void bridge.request("room-b", "other-room", { toolName: "Bash", input: {} });

  await handleCcRoomEvent(ctx, {
    type: "ccRoom.openSession",
    sessionId: "thread-a",
    cwd: "/repo",
    mode: "default",
    deviceId: "device",
    viewerId: "tab-1",
  });
  expect(viewers.map(([viewer, event]) => [viewer, event.type])).toEqual([
    ["tab-1", "ccRoom.opened"],
    ["tab-1", "ccRoom.approvalRequest"],
  ]);
  expect(viewers[0]![1]).toMatchObject({ roomId: "room-a", permissionMode: "default" });
  expect(viewers[1]![1]).toEqual({
    type: "ccRoom.approvalRequest",
    roomId: "room-a",
    req: {
      requestId: "read-1",
      toolName: "Read",
      input: { file_path: "/repo/a.ts" },
      description: "Read a.ts",
    },
  });

  // A reconnect resubscribes the transcript; the card is replayed again.
  viewers.length = 0;
  await handleCcRoomEvent(ctx, {
    type: "ccRoom.subscribeTranscript",
    roomId: "room-a",
    sessionId: "thread-a",
    cwd: "/repo",
    limit: 150,
    deviceId: "device",
    viewerId: "tab-2",
  });
  expect(viewers.map(([viewer, event]) => [viewer, event.type])).toEqual([
    ["tab-2", "ccRoom.transcriptSubscribed"],
    ["tab-2", "ccRoom.approvalRequest"],
  ]);

  // Answered requests are no longer replayed.
  bridge.respond("room-a", "read-1", { behavior: "allow" });
  await pending;
  viewers.length = 0;
  await handleCcRoomEvent(ctx, {
    type: "ccRoom.subscribeTranscript",
    roomId: "room-a",
    sessionId: "thread-a",
    cwd: "/repo",
    limit: 150,
    deviceId: "device",
    viewerId: "tab-2",
  });
  expect(viewers.map(([, event]) => event.type)).toEqual(["ccRoom.transcriptSubscribed"]);
  bridge.cancelRoom("room-b");
});

test("model changes forward the exact room binding and echo the actual Host model", async () => {
  const f = harness();
  f.setOpenResult(async () => ({
    roomId: "room-a",
    status: "running",
    mode: "acceptEdits",
    modelKey: "codex/fixture",
    changed: true,
  }));
  await handleCcRoomEvent(f.ctx, {
    type: "ccRoom.openSession",
    roomId: "room-a",
    sessionId: "thread-a",
    cwd: "/repo",
    kind: "codex",
    mode: "default",
    modelKey: "codex/fixture",
    requestId: "model-1",
    deviceId: "device",
    viewerId: "tab-1",
  });
  expect(f.opens[0]).toMatchObject({
    roomId: "room-a",
    sessionId: "thread-a",
    kind: "codex",
    modelKey: "codex/fixture",
  });
  expect(f.viewers[0]?.[1]).toMatchObject({
    type: "ccRoom.opened",
    roomId: "room-a",
    requestId: "model-1",
    permissionMode: "acceptEdits",
    modelKey: "codex/fixture",
  });
  expect(f.broadcasts).toEqual(["room-a"]);
});

test("a failed approval response reports its room and approval so the card can recover", async () => {
  const f = harness();
  f.ctx.approvalBridge = {
    respond: () => {
      throw new Error("bridge unavailable");
    },
    pendingRequests: () => [],
  };
  await handleCcRoomEvent(f.ctx, {
    type: "ccRoom.respondApproval",
    roomId: "room-a",
    requestId: "approval-7",
    decision: { behavior: "deny", message: "no" },
    deviceId: "device",
    viewerId: "tab-1",
  });
  expect(f.viewers).toEqual([
    [
      "tab-1",
      {
        type: "room.error",
        message: "bridge unavailable",
        roomId: "room-a",
        approvalRequestId: "approval-7",
      },
    ],
  ]);
});

test("every way a room's process ends reaches phones as room.closed, not only a phone close", async () => {
  const { RoomManager } = await import("@cjhyy/code-shell-server/mobile-remote");
  const { publishRoomEnded } = await import("./lifecycle.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "rooms-ended-"));
  const broadcasts: Array<Record<string, unknown>> = [];
  const cancelled: string[] = [];
  const emits: Array<(event: { type: "exit"; code: number }) => void> = [];
  try {
    const manager = new RoomManager({
      rootDir: dir,
      createAgent: (_room, onEvent) => {
        let running = false;
        emits.push((event) => {
          running = false;
          onEvent(event);
        });
        return {
          start: () => void (running = true),
          send: () => true,
          isRunning: () => running,
          stop: () => void (running = false),
        };
      },
      onMessage: () => undefined,
      onRoomEnded: (roomId) =>
        publishRoomEnded(
          {
            approvals: { cancelRoom: (id) => (cancelled.push(id), 0) },
            transcripts: { endRoom: () => undefined },
            remote: { broadcast: (event) => void broadcasts.push(event as never) },
          },
          roomId,
        ),
    });
    // Closed from a Desktop window (ccRoom:closeSession / rooms:close IPC).
    const desktopClosed = manager.createRoom({ name: "a", cwd: dir });
    manager.open(desktopClosed.id);
    manager.close(desktopClosed.id);
    // The CLI process exits on its own.
    const exited = manager.createRoom({ name: "b", cwd: dir });
    manager.open(exited.id);
    emits[1]!({ type: "exit", code: 1 });
    expect(broadcasts).toEqual([
      { type: "room.closed", roomId: desktopClosed.id },
      { type: "room.closed", roomId: exited.id },
    ]);
    expect(cancelled).toEqual([desktopClosed.id, exited.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
