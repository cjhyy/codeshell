import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import {
  createDesktopOutputRecoveryAuthorizer,
  registerDesktopOutputHistoryHost,
} from "./session-output-history-host.js";
import { __resetProjectStoreForTest, getProjectStore } from "./project-store.js";

function fixture() {
  let owner: number | undefined;
  let revision = 0;
  let destroyed = false;
  let physical = "same-physical-workspace";
  let pause: Promise<void> | undefined;
  const frame = {};
  const window = {
    isDestroyed: () => destroyed,
    webContents: { id: 71, mainFrame: frame, isDestroyed: () => destroyed },
  };
  const windows = [window];
  const bridge = {
    panelOwnerWebContentsId: () => owner,
    sessionPanelOwnerRevision: () => revision,
  };
  const authorize = createDesktopOutputRecoveryAuthorizer({
    windows: () => windows as any,
    bridge: () => bridge,
    workspace: async () => {
      const stamp = physical;
      if (pause) await pause;
      return {
        cwd: "/owned/project",
        mainRoot: "/owned/project",
        projectId: "project",
        rootId: "root",
        stamp,
        assertCurrent() {
          if (stamp !== physical) throw new Error("physical workspace changed");
        },
      };
    },
  });
  return {
    authorize,
    caller: { kind: "desktop" as const, webContentsId: 71 },
    window,
    windows,
    bridge,
    own: (value: number | undefined) => {
      owner = value;
      revision++;
    },
    destroy: () => {
      destroyed = true;
    },
    replace: () => {
      physical = "replacement";
    },
    wait: (value: Promise<void>) => {
      pause = value;
    },
  };
}

test("Desktop authorization preserves a cold Session's absent owner and never claims it", async () => {
  const f = fixture();
  const first = await f.authorize("session", f.caller);
  expect(first.ownerWebContentsId).toBeUndefined();
  expect(first.projectId).toBe("project");
  first.assertCurrent();
  expect((await f.authorize("session", f.caller)).key).toBe(first.key);
  f.own(71);
  expect(() => first.assertCurrent()).toThrow();
  const owned = await f.authorize("session", f.caller);
  expect(owned.ownerWebContentsId).toBe(71);
  expect(owned.key).not.toBe(first.key);
});

test("Desktop cannot steal another live window's Session or use a fabricated window ID", async () => {
  const f = fixture();
  f.own(99);
  await expect(f.authorize("session", f.caller)).rejects.toThrow("owner changed");
  f.own(undefined);
  await expect(f.authorize("session", { kind: "desktop", webContentsId: 999 })).rejects.toThrow();
});

for (const mode of ["owner", "owner-aba", "window", "navigation", "physical"] as const)
  test(`Desktop authorization remains fenced after a fresh capture (${mode})`, async () => {
    const f = fixture();
    const auth = await f.authorize("session", f.caller);
    if (mode === "owner") f.own(99);
    if (mode === "owner-aba") {
      f.own(71);
      f.own(undefined);
    }
    if (mode === "window") f.destroy();
    if (mode === "navigation") f.window.webContents.mainFrame = {};
    if (mode === "physical") f.replace();
    expect(() => auth.assertCurrent()).toThrow();
  });

for (const mode of ["owner", "window", "physical"] as const)
  test(`Desktop revalidates authorization after asynchronous workspace resolution (${mode})`, async () => {
    const f = fixture();
    let release!: () => void;
    f.wait(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = f.authorize("session", f.caller);
    if (mode === "owner") f.own(99);
    if (mode === "window") f.destroy();
    if (mode === "physical") f.replace();
    release();
    await expect(pending).rejects.toThrow();
  });

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

test.each(["workspace", "session"] as const)(
  "default Desktop authorization reads inactive disk metadata and detects physical %s replacement",
  async (replacement) => {
    const home = mkdtempSync(join(tmpdir(), "cs-desktop-recovery-authority-"));
    const previous = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
    __resetProjectStoreForTest();
    cleanup.push(() => {
      if (previous === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = previous;
      __resetProjectStoreForTest();
      rmSync(home, { recursive: true, force: true });
    });
    const cwd = join(home, "workspace");
    mkdirSync(cwd);
    const project = await getProjectStore().createFromPath(cwd);
    const manager = new SessionManager();
    manager.create(cwd, "fixture-model", "fixture", "inactive-session");
    manager.migrateSessionMainRoot(
      "inactive-session",
      { projectId: project.id, mainRootId: project.primaryRootId },
      cwd,
    );
    const window = {
      isDestroyed: () => false,
      webContents: { id: 71, isDestroyed: () => false, mainFrame: {} },
    };
    const authorize = createDesktopOutputRecoveryAuthorizer({
      windows: () => [window] as any,
      bridge: () => null,
    });
    const stateBefore = manager.readSessionState("inactive-session");
    const authorization = await authorize("inactive-session", {
      kind: "desktop",
      webContentsId: 71,
    });
    expect(authorization.ownerWebContentsId).toBeUndefined();
    expect(authorization.projectId).toBe(project.id);
    expect(manager.readSessionState("inactive-session")).toEqual(stateBefore);
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    let installed: unknown;
    let mobileAuthorizations = 0;
    const shared = registerDesktopOutputHistoryHost({
      ipcMain: {
        handle: (name, handler) => {
          handlers.set(name, handler as any);
        },
        removeHandler() {},
      },
      windows: () => [window] as any,
      historyWindows: () => [window] as any,
      bridge: () => null,
      external: () => null,
      mobile: {
        setOutputHistoryRecoveryService(service) {
          installed = service;
        },
        async authorizeOutputHistoryRecovery() {
          mobileAuthorizations++;
          return authorization;
        },
        retireOutputHistorySession() {
          throw new Error("planning must not retire a Session");
        },
      },
    });
    expect(installed).toBe(shared);
    expect(handlers.has("sessions:transcript")).toBe(true);
    expect(handlers.has("sessions:outputRecoveryApply")).toBe(true);
    const result = await handlers.get("sessions:outputRecoveryPlan")!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      "inactive-session",
    );
    expect(result.sessionId).toBe("inactive-session");
    expect(mobileAuthorizations).toBe(0);
    await shared.plan("inactive-session", {
      kind: "mobile",
      viewerId: "viewer",
      deviceId: "device",
    });
    expect(mobileAuthorizations).toBe(1);
    expect(manager.readSessionState("inactive-session")).toEqual(stateBefore);

    await expect(authorize("missing", { kind: "desktop", webContentsId: 71 })).rejects.toThrow();
    if (replacement === "workspace") {
      renameSync(cwd, `${cwd}-old`);
      symlinkSync(`${cwd}-old`, cwd, "dir");
    } else {
      const session = join(manager.getStorageDir(), "inactive-session");
      renameSync(session, `${session}-old`);
      cpSync(`${session}-old`, session, { recursive: true });
    }
    expect(() => authorization.assertCurrent()).toThrow();
  },
);
