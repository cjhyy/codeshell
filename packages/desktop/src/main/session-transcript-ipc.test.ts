import { describe, expect, test } from "bun:test";
import { registerSessionTranscriptIpc } from "./session-transcript-ipc.js";

function setup() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const diskReads: unknown[] = [];
  const rawReads: unknown[] = [];
  registerSessionTranscriptIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      listDiskSessions: async (options) => {
        diskReads.push(options);
        return { sessions: [], nextCursor: null };
      },
      getSessionEvents: async (...args) => {
        rawReads.push(args);
        return [];
      },
    },
  );
  return {
    diskReads,
    rawReads,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
  };
}

describe("session transcript IPC validation", () => {
  test("preserves bounded pagination defaults and explicit child queries without forwarding host scan options", async () => {
    const { call, diskReads } = setup();
    await call("sessions:listDisk");
    await call("sessions:listDisk", {
      limit: 999,
      cursor: "v1:100:child",
      parentSessionId: "parent-a",
      includeSubagents: true,
      includeArchived: true,
    });
    await call("sessions:listDisk", { limit: 1.5 });
    expect(diskReads).toEqual([
      { limit: 30, cursor: undefined, parentSessionId: undefined },
      { limit: 200, cursor: "v1:100:child", parentSessionId: "parent-a" },
      { limit: 30, cursor: undefined, parentSessionId: undefined },
    ]);
  });

  test("rejects unsafe child ids and malformed pagination cursors before touching storage", async () => {
    const { call, diskReads } = setup();
    for (const parentSessionId of ["../parent", "", ".", "parent/child", "a".repeat(129)]) {
      await expect(call("sessions:listDisk", { parentSessionId })).rejects.toThrow(
        "invalid desktop sessionId",
      );
    }
    for (const cursor of [123, "a\0b", "a".repeat(513)]) {
      await expect(call("sessions:listDisk", { cursor })).rejects.toThrow("invalid session cursor");
    }
    expect(diskReads).toEqual([]);
  });

  test("raw event readers receive the exact exclusive cursor only after id and cursor validation", async () => {
    const { call, rawReads } = setup();
    for (const sessionId of ["../outside", "", "a".repeat(129)])
      await expect(call("sessions:rawEvents", sessionId)).rejects.toThrow(
        "invalid desktop sessionId",
      );
    for (const cursor of [123, "a\0b", "a".repeat(513)])
      await expect(call("sessions:rawEvents", "session-a", cursor)).rejects.toThrow(
        "invalid transcript cursor",
      );
    expect(rawReads).toEqual([]);
    await call("sessions:rawEvents", "session-a", "event-123");
    await call("sessions:rawEvents", "session-a");
    expect(rawReads).toEqual([
      ["session-a", "event-123"],
      ["session-a", undefined],
    ]);
  });
});
