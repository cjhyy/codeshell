import { expect, test } from "bun:test";
import {
  registerComputerUseSettingsIpc,
  type ComputerUseSettingsDependencies,
} from "./settings-ipc";

function harness() {
  const handlers = new Map<string, (event: any, value?: unknown) => any>();
  const effects: unknown[] = [];
  let enabled = false;
  let active = false;
  const permissions = {
    supported: true,
    accessibility: "denied" as const,
    screenRecording: "denied" as const,
    screenRequestAvailable: true,
    restartRequired: false,
  };
  const sender = { isDestroyed: () => false, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  const deps: ComputerUseSettingsDependencies = {
    ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler) },
    isMainWindow: (value) => value === (sender as any),
    getEnabled: () => enabled,
    saveEnabled: (next) => {
      effects.push(["save", next]);
      enabled = next;
    },
    isActive: () => active,
    driverAvailable: () => true,
    packaged: true,
    permissions: {
      status: async () => ({ ...permissions }),
      request: async (kind) => {
        effects.push(["request", kind]);
        return { ...permissions };
      },
      openSettings: async (kind) => {
        effects.push(["open", kind]);
      },
    },
    stop: async () => {
      effects.push("stop");
      active = false;
    },
    restart: () => {
      effects.push("restart");
    },
  };
  registerComputerUseSettingsIpc(deps);
  const invoke = (method: string, value?: unknown, caller = event) =>
    handlers.get(`computerUse:${method}`)!(caller, value);
  return {
    deps,
    effects,
    event,
    sender,
    invoke,
    setActive: () => {
      active = true;
    },
  };
}

test("reading settings never prompts, saves, starts or restarts", async () => {
  const h = harness();
  expect(await h.invoke("status")).toMatchObject({
    enabled: false,
    active: false,
    restartRequired: false,
  });
  expect(h.effects).toEqual([]);
});

test("every setup method rejects guest frames and foreign or destroyed windows", async () => {
  for (const method of [
    "status",
    "setEnabled",
    "requestPermission",
    "openSettings",
    "restart",
    "setCompanion",
    "previewCompanion",
  ]) {
    for (const caller of ["guest", "foreign", "destroyed"]) {
      const h = harness();
      const event =
        caller === "guest"
          ? { ...h.event, senderFrame: {} }
          : caller === "foreign"
            ? {
                sender: { isDestroyed: () => false, mainFrame: h.sender.mainFrame },
                senderFrame: h.sender.mainFrame,
              }
            : { ...h.event };
      if (caller === "destroyed") h.sender.isDestroyed = () => true;
      expect(() => h.invoke(method, true, event)).toThrow("桌面主窗口");
      expect(h.effects).toEqual([]);
    }
  }
});

test("companion toggles and previews independently without starting CUA or requesting permissions", async () => {
  const h = harness();
  let enabled = false;
  let size = 320;
  let previews = 0;
  h.deps.companion = {
    status: () => ({ enabled, size, available: true, appearance: "mimi-sprite" }),
    update: async (value) => {
      enabled = value.enabled ?? enabled;
      size = value.size ?? size;
    },
    preview: async () => {
      previews++;
    },
  };
  expect(await h.invoke("setCompanion", { enabled: true, size: 400 })).toMatchObject({
    enabled: false,
    active: false,
    restartRequired: false,
    companion: { enabled: true, size: 400 },
  });
  await h.invoke("previewCompanion");
  await h.invoke("setCompanion", { enabled: false });
  expect(enabled).toBe(false);
  expect(previews).toBe(1);
  expect(h.effects).toEqual([]);
  for (const invalid of [
    { size: NaN },
    { size: 10 },
    { enabled: "yes" },
    { modelPath: "/tmp/arbitrary" },
  ]) {
    expect(() => h.invoke("setCompanion", invalid)).toThrow("无效");
  }
});

test("enabling persists once and requires restart without implicitly requesting OS access", async () => {
  const h = harness();
  expect(await h.invoke("setEnabled", true)).toMatchObject({
    enabled: true,
    restartRequired: true,
  });
  await h.invoke("setEnabled", true);
  expect(h.effects).toEqual([["save", true]]);
  await h.invoke("requestPermission", "screenRecording");
  expect(h.effects).toEqual([
    ["save", true],
    ["request", "screenRecording"],
  ]);
});

test("disabling stops an active daemon before returning", async () => {
  const h = harness();
  await h.invoke("setEnabled", true);
  h.setActive();
  expect(await h.invoke("setEnabled", false)).toMatchObject({ enabled: false, active: false });
  expect(h.effects).toEqual([["save", true], ["save", false], "stop"]);
});

test("requests require enabled opt-in and accept only fixed permission names", async () => {
  const h = harness();
  await expect(h.invoke("requestPermission", "accessibility")).rejects.toThrow("先启用");
  expect(() => h.invoke("requestPermission", "/tmp/arbitrary-helper")).toThrow("未知");
  expect(() => h.invoke("openSettings", "https://example.com")).toThrow("未知");
  expect(() => h.invoke("setEnabled", "true")).toThrow("布尔值");
  expect(h.effects).toEqual([]);
});

test("missing platform or driver cannot enable the setting", async () => {
  const h = harness();
  h.deps.driverAvailable = () => false;
  await expect(h.invoke("setEnabled", true)).rejects.toThrow("驱动");
  h.deps.driverAvailable = () => true;
  h.deps.permissions.status = async () => ({
    supported: false,
    accessibility: "unsupported",
    screenRecording: "unsupported",
    screenRequestAvailable: false,
    restartRequired: false,
  });
  await expect(h.invoke("setEnabled", true)).rejects.toThrow("macOS");
  expect(h.effects).toEqual([]);
});

test("one pending permission request prevents duplicate prompts, writes and restart", async () => {
  const h = harness();
  await h.invoke("setEnabled", true);
  let finish!: (value: any) => void;
  h.deps.permissions.request = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = h.invoke("requestPermission", "screenRecording");
  await expect(h.invoke("requestPermission", "screenRecording")).rejects.toThrow("稍候");
  await expect(h.invoke("setEnabled", false)).rejects.toThrow("稍候");
  expect(() => h.invoke("restart")).toThrow("等待");
  finish(await h.deps.permissions.status());
  await pending;
  h.invoke("restart");
  expect(h.effects).toEqual([["save", true], "restart"]);
});

test("an owner closed during async status cannot persist a setting", async () => {
  const h = harness();
  let finish!: (value: any) => void;
  const original = await h.deps.permissions.status();
  h.deps.permissions.status = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = h.invoke("setEnabled", true);
  h.sender.isDestroyed = () => true;
  finish(original);
  await expect(pending).rejects.toThrow("桌面主窗口");
  expect(h.effects).toEqual([]);
});
