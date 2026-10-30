import { expect, test } from "bun:test";
import { registerSessionOutputHistoryIpc } from "./session-output-history-ipc.js";

const planId = "9a7133c0-03e7-4a80-b9b6-3bdc026d9891";
function fixture() {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let destroyed = false;
  const frame = {};
  const sender = { id: 71, mainFrame: frame, isDestroyed: () => destroyed };
  const window = { webContents: sender, isDestroyed: () => destroyed };
  const windows = [window];
  const event = { sender, senderFrame: frame };
  const calls: unknown[][] = [];
  let work = async () => ({ status: "blocked", sessionId: "session", reason: "unavailable" });
  registerSessionOutputHistoryIpc(
    {
      handle: (name, handler) => {
        handlers.set(name, handler as any);
      },
    },
    () => windows as any,
    {
      plan: async (...args) => {
        calls.push(args);
        return (await work()) as any;
      },
      apply: async (...args) => {
        calls.push(args);
        return (await work()) as any;
      },
    },
  );
  return {
    calls,
    event,
    sender,
    windows,
    destroy: () => {
      destroyed = true;
    },
    setWork: (next: typeof work) => {
      work = next;
    },
    call: (channel: "Plan" | "Apply", args: unknown[], input = event) =>
      handlers.get(`sessions:outputRecovery${channel}`)!(input, ...args),
  };
}

test("recovery IPC fixes caller identity from the actual trusted Main window", async () => {
  const f = fixture();
  await f.call("Plan", ["session"]);
  await f.call("Apply", ["session", { planId, acceptHistoricalGap: true }]);
  expect(f.calls).toEqual([
    ["session", { kind: "desktop", webContentsId: 71 }],
    ["session", { planId, acceptHistoricalGap: true }, { kind: "desktop", webContentsId: 71 }],
  ]);
});

for (const mode of ["subframe", "other-window", "closed", "unregistered"] as const)
  test(`recovery IPC rejects ${mode} before calling the service`, async () => {
    const f = fixture();
    if (mode === "subframe") f.event.senderFrame = {};
    if (mode === "other-window") f.event.sender = { ...f.sender };
    if (mode === "closed") f.destroy();
    if (mode === "unregistered") f.windows.length = 0;
    await expect(f.call("Plan", ["session"])).rejects.toThrow("Desktop main window");
    await expect(
      f.call("Apply", ["session", { planId, acceptHistoricalGap: true }]),
    ).rejects.toThrow("Desktop main window");
    expect(f.calls).toEqual([]);
  });

test("malformed session, confirmation and forged authority never touch the recovery service", async () => {
  const f = fixture();
  for (const id of [null, 1, "", "../outside", "a/b", "a".repeat(129)]) {
    await expect(f.call("Plan", [id])).rejects.toThrow();
    await expect(f.call("Apply", [id, { planId, acceptHistoricalGap: true }])).rejects.toThrow();
  }
  for (const input of [
    null,
    [],
    false,
    {},
    { planId },
    { planId, acceptHistoricalGap: false },
    { planId: "../plan", acceptHistoricalGap: true },
    { planId: "x".repeat(200), acceptHistoricalGap: true },
    { planId, acceptHistoricalGap: true, caller: { kind: "desktop", webContentsId: 999 } },
    { planId, acceptHistoricalGap: true, cwd: "/other" },
  ])
    await expect(f.call("Apply", ["session", input])).rejects.toThrow(
      "invalid output history recovery acceptance",
    );
  await expect(f.call("Plan", ["session", { webContentsId: 999 }])).rejects.toThrow();
  await expect(
    f.call("Apply", ["session", { planId, acceptHistoricalGap: true }, { webContentsId: 999 }]),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

for (const mode of ["destroy", "navigate", "remove"] as const)
  test(`recovery IPC rejects a response after the trusted window expires (${mode})`, async () => {
    const f = fixture();
    let release!: () => void;
    f.setWork(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: "blocked", sessionId: "session", reason: "unavailable" };
    });
    const pending = f.call("Plan", ["session"]);
    if (mode === "destroy") f.destroy();
    if (mode === "navigate") f.sender.mainFrame = {};
    if (mode === "remove") f.windows.length = 0;
    release();
    await expect(pending).rejects.toThrow("Desktop main window");
    expect(f.calls).toHaveLength(1);
  });
