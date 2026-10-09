import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOperationResolutionIpc } from "./operation-resolution-ipc.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "operation-native-"));
  roots.push(root);
  const handlers = new Map<string, (...args: any[]) => any>();
  const frame = {};
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const other = { isDestroyed: () => false, webContents: { mainFrame: {} } };
  const event = { sender: window.webContents, senderFrame: frame };
  const record = {
    id: "1".repeat(64),
    revision: "2".repeat(64),
    service: "github",
    action: "create_issue",
    state: "unknown",
    createdAt: 1,
    hasReference: false,
    canResolve: true,
  };
  let trusted = true,
    running = false,
    enabled = true,
    revision = "authority-1",
    project = "project-1";
  let confirmations = 0,
    resolutions = 0;
  let confirm: () => Promise<{ response: number }> = async () => ({ response: 1 });
  let beforeCas = () => {};
  let persist = () => {};
  const dispose = registerOperationResolutionIpc({
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    } as any,
    windows: () => [window, other] as any,
    enabled: () => enabled,
    store: {
      review: () => ({
        owner: { state: { status: "unverified_write" }, binding: "owner" } as any,
        records: [record],
        truncated: false,
      }),
      resolve: (_sessionId, _owner, _id, _revision, assertIdle) => {
        beforeCas();
        assertIdle();
        persist();
        resolutions++;
      },
    },
    resolveTarget: async (input) => {
      expect(input).toEqual({ sessionId: "session" });
      return {
        kind: "session",
        sessionId: "session",
        projectId: project,
        mainRootId: "root-1",
        cwd: root,
      };
    },
    trusted: async () => trusted,
    trustedSync: () => trusted,
    authorityRevision: () => revision,
    isSessionRunning: () => running,
    confirm: async (_window, options) => {
      confirmations++;
      expect(options.defaultId).toBe(0);
      expect(options.cancelId).toBe(0);
      expect(options.detail).toContain("结果仍未知");
      expect(options.detail).toContain("永远不会重发");
      return confirm();
    },
  });
  const invoke = async (name: string, input: unknown, sender = event) =>
    handlers.get(`operationResolution:${name}`)!(sender, input);
  const review = () => invoke("review", { sessionId: "session" });
  const resolve = (review: any, sender = event) =>
    invoke(
      "resolve",
      { reviewToken: review.reviewToken, operationId: record.id, revision: record.revision },
      sender,
    );
  return {
    invoke,
    review,
    resolve,
    record,
    event,
    window,
    other,
    dispose,
    counts: () => ({ confirmations, resolutions }),
    confirm: (next: typeof confirm) => {
      confirm = next;
    },
    beforeCas: (next: typeof beforeCas) => {
      beforeCas = next;
    },
    failPersist: () => {
      persist = () => {
        throw new Error("disk failure");
      };
    },
    change: (type: string) => {
      if (type === "untrust") trusted = false;
      if (type === "running") running = true;
      if (type === "registry") revision = "authority-2";
      if (type === "project") project = "project-2";
      if (type === "disabled") enabled = false;
      if (type === "frame") window.webContents.mainFrame = {};
      if (type === "destroyed") window.isDestroyed = () => true;
    },
  };
}

test("only exact top-frame native requests can review; renderer cannot provide owner, root or confirmation", async () => {
  const f = fixture();
  for (const input of [
    null,
    [],
    { sessionId: "session", cwd: "/forged" },
    { sessionId: "session", confirmed: true },
    { owner: "fake" },
  ])
    await expect(f.invoke("review", input)).rejects.toThrow();
  await expect(
    f.invoke("review", { sessionId: "session" }, { ...f.event, senderFrame: {} }),
  ).rejects.toThrow("top frame");
  const review = await f.review();
  expect(review.records).toEqual([f.record]);
  expect(JSON.stringify(review)).not.toContain("binding");
  await expect(
    f.resolve(review, { sender: f.other.webContents, senderFrame: f.other.webContents.mainFrame }),
  ).rejects.toThrow("expired");
  expect(await f.resolve(review)).toEqual({ status: "resolved", result: "unknown" });
  expect(f.counts()).toEqual({ confirmations: 1, resolutions: 1 });
  await expect(f.resolve(review)).rejects.toThrow("expired");
  f.dispose();
});

test("native cancel does not persist or reuse a consumed capability", async () => {
  const f = fixture();
  f.confirm(async () => ({ response: 0 }));
  const review = await f.review();
  expect(await f.resolve(review)).toEqual({ status: "cancelled", result: "unknown" });
  expect(f.counts()).toEqual({ confirmations: 1, resolutions: 0 });
  await expect(f.resolve(review)).rejects.toThrow("expired");
});

test("an already-running Session cannot review or open a native decision", async () => {
  const f = fixture();
  const previous = await f.review();
  f.change("running");
  await expect(f.review()).rejects.toThrow();
  await expect(f.resolve(previous)).rejects.toThrow();
  expect(f.counts()).toEqual({ confirmations: 0, resolutions: 0 });
});

for (const change of [
  "untrust",
  "running",
  "registry",
  "project",
  "disabled",
  "frame",
  "destroyed",
]) {
  test(`native acceptance rejects ${change} during the asynchronous dialog`, async () => {
    const f = fixture();
    const review = await f.review();
    f.confirm(async () => {
      f.change(change);
      return { response: 1 };
    });
    await expect(f.resolve(review)).rejects.toThrow();
    expect(f.counts().resolutions).toBe(0);
  });
}

for (const change of ["untrust", "running", "registry", "disabled", "frame"]) {
  test(`final synchronous CAS guard rejects ${change} after the dialog recheck`, async () => {
    const f = fixture();
    const review = await f.review();
    f.beforeCas(() => f.change(change));
    await expect(f.resolve(review)).rejects.toThrow();
    expect(f.counts().resolutions).toBe(0);
  });
}

test("concurrent resolves cannot create a second dialog and storage failure is never reported as resolved", async () => {
  const f = fixture();
  const review = await f.review();
  let finish!: (value: { response: number }) => void;
  f.confirm(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.resolve(review);
  await expect(f.resolve(review)).rejects.toThrow("expired");
  f.failPersist();
  finish({ response: 1 });
  await expect(first).rejects.toThrow("disk failure");
  expect(f.counts()).toEqual({ confirmations: 1, resolutions: 0 });
});
