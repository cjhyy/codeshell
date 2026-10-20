import { expect, test } from "bun:test";
import { ApprovalBridge } from "../cc-room/approval-bridge.js";
import { handleCcRoomEvent } from "./handle-cc-room-event.js";

function harness() {
  const viewers: Array<[string, Record<string, unknown>]> = [];
  const bridge = new ApprovalBridge({ onPush: () => undefined });
  const ctx = {
    approvalBridge: bridge,
    remote: {
      sendToViewer: (viewerId: string, event: Record<string, unknown>) =>
        viewers.push([viewerId, event]),
      sendToDevice: () => undefined,
      broadcast: () => undefined,
    },
    roomManager: {
      openForSession: () => ({ roomId: "room-a", status: "running" }),
    },
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
  return { ctx, bridge, viewers };
}

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
