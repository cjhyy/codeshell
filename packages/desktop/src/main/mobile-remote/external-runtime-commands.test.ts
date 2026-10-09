import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import { getProjectStore } from "../project-store.js";
import { mobileSessionCommandAuthority } from "./output-recovery-authority.js";
import {
  MobileExternalRuntimeCommands,
  isPersistedExternalRuntime,
} from "./external-runtime-commands.js";
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
        afterBeforeInput?.();
        hooks.assertInputOwner?.();
        physical++;
        accepts++;
        hooks.accepted();
      };
      if (!queued) await beforeInput();
      return { ok: true, reason: "completed", streamed: true };
    },
  } as unknown as ExternalRuntimeService;
  let afterBeforeInput: (() => void) | undefined;
  let afterAuthority: (() => void) | undefined;
  const commands = new MobileExternalRuntimeCommands({
    authenticated: (viewer, device) => authenticated && viewer === "tab" && device === "phone",
    authority: async () => {
      const capturedStamp = stamp;
      const value = {
        stamp,
        cwd: "/workspace",
        projectId: "project",
        rootId: "root",
        assertCurrent: () => {
          if (stamp !== capturedStamp) throw new Error("project revoked before input");
        },
      };
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
    afterBeforeInput: (fn: () => void) => {
      afterBeforeInput = fn;
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

test("persisted external provider cannot become native merely because its model field is missing or invalid", () => {
  expect(isPersistedExternalRuntime({ provider: "codex" })).toBe(true);
  expect(isPersistedExternalRuntime({ provider: "claude-code", model: "malformed" })).toBe(true);
  expect(isPersistedExternalRuntime({ provider: "other", model: "codex/synthetic" })).toBe(true);
  expect(isPersistedExternalRuntime({ provider: "openai", model: "gpt-4o" })).toBe(false);
});

test("project revocation after the final async check is fenced synchronously before physical input", async () => {
  const f = harness();
  await f.select();
  const target = await f.commands.prepare("tab", "phone", "external");
  f.afterBeforeInput(f.changeProject);
  expect((await target.submit(f.request)).ok).toBe(false);
  expect(f.physical()).toBe(0);
  expect(f.accepts()).toBe(0);
});

test("actual mounted project metadata fence rejects revocation after asynchronous authority returned", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mobile-command-authority-"));
  const project = await getProjectStore().createFromPath(cwd);
  const manager = new SessionManager();
  const session = manager.create(cwd, "codex/synthetic", "codex");
  manager.migrateSessionMainRoot(
    session.state.sessionId,
    { projectId: project.id, mainRootId: project.roots[0]!.id },
    cwd,
  );
  try {
    const authority = await mobileSessionCommandAuthority(session.state.sessionId);
    expect(() => authority.assertCurrent()).not.toThrow();
    await getProjectStore().remove(project.id);
    expect(() => authority.assertCurrent()).toThrow("authority changed");
    expect(session.transcript.getEvents().filter((event) => event.type === "message")).toHaveLength(
      0,
    );
  } finally {
    rmSync(join(manager.getStorageDir(), session.state.sessionId), {
      recursive: true,
      force: true,
    });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy native Session binds the currently registered project without inventing a persisted binding", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mobile-legacy-authority-"));
  const project = await getProjectStore().createFromPath(cwd);
  const manager = new SessionManager();
  const session = manager.create(cwd, "gpt-4o", "openai");
  try {
    const authority = await mobileSessionCommandAuthority(session.state.sessionId);
    expect(() => authority.assertCurrent()).not.toThrow();
    expect(manager.readSessionState(session.state.sessionId)?.project).toBeUndefined();
    await getProjectStore().remove(project.id);
    expect(() => authority.assertCurrent()).toThrow();
  } finally {
    rmSync(join(manager.getStorageDir(), session.state.sessionId), {
      recursive: true,
      force: true,
    });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("actual worktree replacement after final async cancel authority cannot interrupt its captured run", async () => {
  const main = mkdtempSync(join(tmpdir(), "mobile-worktree-cancel-"));
  const cwd = join(main, "worktree");
  mkdirSync(cwd);
  const project = await getProjectStore().createFromPath(main);
  const manager = new SessionManager();
  const session = manager.create(main, "codex/synthetic", "codex");
  const sessionId = session.state.sessionId;
  manager.migrateSessionMainRoot(
    sessionId,
    { projectId: project.id, mainRootId: project.roots[0]!.id },
    main,
  );
  manager.setSessionWorkspace(sessionId, {
    root: cwd,
    kind: "worktree",
    worktree: { path: cwd, branch: "fixture", baseRef: "main", createdBy: "codeshell" },
  });
  const runtime = {};
  let cancelled = 0,
    reads = 0;
  const service = {
    get: () => runtime,
    getCwd: () => cwd,
    captureActiveRun: () => ({ session: runtime, runId: "actual-run" }),
    interrupt: async () => {
      cancelled++;
    },
  } as unknown as ExternalRuntimeService;
  const commands = new MobileExternalRuntimeCommands({
    authenticated: () => true,
    authority: async () => {
      const authority = await mobileSessionCommandAuthority(sessionId);
      if (++reads === 3) {
        renameSync(cwd, join(main, "retired"));
        mkdirSync(cwd);
      }
      return authority;
    },
    owner: () => 77,
    service: () => service,
    isExternal: () => true,
    exists: () => true,
    attachmentPath: async (path) => path,
  });
  try {
    await commands.observe({
      type: "session.select",
      viewerId: "tab",
      deviceId: "phone",
      sessionId,
    });
    await expect(commands.stop("tab", "phone", sessionId)).rejects.toThrow();
    expect(cancelled).toBe(0);
    expect(session.transcript.getEvents().filter((event) => event.type === "message")).toHaveLength(
      0,
    );
  } finally {
    await getProjectStore().remove(project.id);
    rmSync(join(manager.getStorageDir(), sessionId), { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  }
});
