import { expect, test } from "bun:test";
import { MobileExternalRuntimeCommands } from "./external-runtime-commands.js";
import type { ExternalRuntimeService } from "../external-runtime-service.js";

function harness() {
  let authenticated = true,
    stamp = "session-incarnation/project-root",
    owner: number | undefined = 77;
  let runtime = {};
  let exists = true,
    external = true;
  let beforeInput: (() => Promise<void>) | undefined;
  let accepts = 0,
    physical = 0,
    cancelled = 0;
  let queued = false;
  let run = "run-a";
  const service = {
    get: () => runtime,
    getCwd: () => "/workspace",
    captureActiveRun: () => ({ session: runtime, runId: run }),
    interrupt: async (
      _id: string,
      _owner: number,
      expected: { session: object; runId: string },
    ) => {
      if (runtime !== expected.session || run !== expected.runId) throw new Error("stale run");
      cancelled++;
    },
    send: async (_id: string, _input: unknown, actualOwner: number, _goal: unknown, hooks: any) => {
      expect(actualOwner).toBe(77);
      beforeInput = async () => {
        await hooks.beforeInput();
        hooks.assertInputOwner?.();
        physical++;
        accepts++;
        hooks.accepted();
      };
      if (!queued) await beforeInput();
      return { ok: true, reason: "completed", streamed: true };
    },
  } as unknown as ExternalRuntimeService;
  let afterAuthority: (() => void) | undefined;
  const commands = new MobileExternalRuntimeCommands({
    authenticated: (viewer, device) => authenticated && viewer === "tab" && device === "phone",
    authority: async () => {
      const value = { stamp, cwd: "/workspace", projectId: "project", rootId: "root" };
      afterAuthority?.();
      return value;
    },
    owner: () => owner,
    service: () => service,
    isExternal: () => external,
    exists: () => exists,
    attachmentPath: async (path) => path,
  });
  const select = () =>
    commands.observe({
      type: "session.select",
      sessionId: "external",
      viewerId: "tab",
      deviceId: "phone",
    });
  const request = {
    id: "request",
    params: { task: "hello", clientMessageId: "input", attachments: [] },
  };
  return {
    commands,
    select,
    disappear: () => {
      exists = false;
      external = false;
    },
    recreateNative: () => {
      exists = true;
      external = false;
    },
    request,
    physical: () => physical,
    cancelled: () => cancelled,
    queue: () => {
      queued = true;
    },
    beforeInput: () => beforeInput!(),
    accepts: () => accepts,
    revoke: () => {
      authenticated = false;
    },
    replace: () => {
      runtime = {};
    },
    changeProject: () => {
      stamp = "new-root";
    },
    closeOwner: () => {
      owner = undefined;
    },
    onAuthority: (fn: () => void) => {
      afterAuthority = fn;
    },
    changeRun: () => {
      run = "run-b";
    },
  };
}

test("external Mobile commands use independent authenticated selected socket, existing owner and producer", async () => {
  const f = harness();
  await expect(f.commands.prepare("tab", "phone", "external")).rejects.toThrow();
  await f.select();
  for (const [viewer, device, session] of [
    ["other-tab", "phone", "external"],
    ["tab", "other-phone", "external"],
    ["tab", "phone", "other"],
  ])
    await expect(f.commands.prepare(viewer, device, session)).rejects.toThrow();
  const target = await f.commands.prepare("tab", "phone", "external");
  expect(await target.submit(f.request)).toEqual({ ok: true });
  expect(f.physical()).toBe(1);
  expect(f.accepts()).toBe(1);
});

for (const change of ["revoke", "replace", "changeProject", "closeOwner"] as const) {
  test(`queued external input rechecks ${change} before any physical request`, async () => {
    const f = harness();
    await f.select();
    const target = await f.commands.prepare("tab", "phone", "external");
    f.queue();
    const result = target.submit(f.request);
    // The mock completes without acceptance; importantly the captured hook is still revalidated.
    await result;
    f[change]();
    await expect(f.beforeInput()).rejects.toThrow();
    expect(f.physical()).toBe(0);
    expect(f.accepts()).toBe(0);
  });
}

test("cancel checks the actual run after authority awaits and never cancels a later run", async () => {
  const f = harness();
  await f.select();
  let count = 0;
  f.onAuthority(() => {
    if (++count === 2) f.changeRun();
  });
  await expect(f.commands.stop("tab", "phone", "external")).rejects.toThrow("stale run");
  expect(f.cancelled()).toBe(0);
  f.onAuthority(() => {});
  await f.commands.stop("tab", "phone", "external");
  expect(f.cancelled()).toBe(1);
});

test("selection retirement while authority awaits cannot establish a late command grant", async () => {
  const f = harness();
  f.onAuthority(() => f.commands.revoke("tab"));
  await f.select();
  await expect(f.commands.prepare("tab", "phone", "external")).rejects.toThrow();
  expect(f.physical()).toBe(0);
});

test("retired external selection never falls back to Core after missing state or same-ID recreation", async () => {
  const f = harness();
  await f.select();
  f.disappear();
  f.commands.revoke("tab");
  expect(f.commands.isExternal("external", "tab")).toBe(true);
  await expect(f.commands.prepare("tab", "phone", "external")).rejects.toThrow();
  f.recreateNative();
  await f.select();
  expect(f.commands.isExternal("external", "tab")).toBe(true);
  expect(f.physical()).toBe(0);
  await f.commands.observe({ type: "session.create", viewerId: "tab", deviceId: "phone" });
  f.disappear();
  expect(f.commands.isExternal("unknown-explicit-session", "tab")).toBe(true);
  expect(f.commands.isExternal("new-mobile-session", "tab", true)).toBe(false);
});
