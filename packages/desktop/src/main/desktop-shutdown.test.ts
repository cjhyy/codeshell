import { expect, test } from "bun:test";
import { createDesktopShutdownHandler } from "./desktop-shutdown.js";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("quit waits for saves and actual child cleanup, coalesces retries and permits final quit", async () => {
  const calls: string[] = [];
  let release: () => void = () => {};
  const childCleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handler: ReturnType<typeof createDesktopShutdownHandler>;
  const event = { preventDefault: () => calls.push("block") };
  handler = createDesktopShutdownHandler({
    ownsInstance: () => true,
    flushRenderers: async () => {
      calls.push("save");
    },
    disposeOperationResolution: async () => {
      calls.push("children");
      await childCleanup;
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    quit: () => {
      calls.push("quit");
      handler(event);
    },
    onError: () => {
      throw new Error("unexpected failure");
    },
  });
  handler(event);
  handler(event);
  await settle();
  expect(calls).toEqual(["block", "block", "save", "children"]);
  release();
  await settle();
  expect(calls).toEqual(["block", "block", "save", "children", "cleanup", "quit"]);
});

for (const failing of ["save", "children", "cleanup"] as const) {
  test(`failed ${failing} prevents quit and allows an explicit retry`, async () => {
    const calls: string[] = [];
    let fail = true;
    const run = (name: string) => async () => {
      calls.push(name);
      if (name === failing && fail) throw new Error("unproven");
    };
    const handler = createDesktopShutdownHandler({
      ownsInstance: () => true,
      flushRenderers: run("save"),
      disposeOperationResolution: run("children"),
      cleanup: run("cleanup"),
      quit: () => calls.push("quit"),
      onError: (phase) => calls.push(phase),
    });
    const event = { preventDefault() {} };
    handler(event);
    await settle();
    expect(calls).not.toContain("quit");
    if (failing !== "cleanup") expect(calls).not.toContain("cleanup");
    if (failing === "save") expect(calls).not.toContain("children");
    fail = false;
    handler(event);
    await settle();
    expect(calls.slice(-4)).toEqual(["save", "children", "cleanup", "quit"]);
  });
}

test("synchronous adapter failure is retryable and a secondary instance does not block quit", async () => {
  let owned = false,
    attempts = 0,
    quits = 0,
    blocks = 0;
  const handler = createDesktopShutdownHandler({
    ownsInstance: () => owned,
    flushRenderers: () => {
      if (++attempts === 1) throw new Error("sync failure");
      return Promise.resolve();
    },
    disposeOperationResolution: async () => {},
    cleanup: async () => {},
    quit: () => {
      quits++;
    },
    onError: () => {},
  });
  const event = {
    preventDefault: () => {
      blocks++;
    },
  };
  handler(event);
  expect(blocks).toBe(0);
  expect(attempts).toBe(0);
  owned = true;
  handler(event);
  await settle();
  handler(event);
  await settle();
  expect(attempts).toBe(2);
  expect(quits).toBe(1);
});
