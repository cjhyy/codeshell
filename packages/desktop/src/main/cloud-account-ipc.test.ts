import { expect, test } from "bun:test";
import { registerCloudAccountIpc } from "./cloud-account-ipc.js";
import type { CloudAccountLogoutResult, CloudAccountStatus } from "../shared/cloud-account.js";

test.each(["confirmed", "unconfirmed"] as const)(
  "cloud logout IPC returns a public result for %s revocation without rejecting",
  async (revocation) => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const sender = { mainFrame: {}, isDestroyed: () => false };
    const result: CloudAccountLogoutResult = { state: "signed-out", revocation };
    registerCloudAccountIpc({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      isMainWindow: (contents) => contents === (sender as any),
      manager: { logout: async () => result } as any,
    });
    expect(
      await handlers.get("cloudAccount:logout")!({ sender, senderFrame: sender.mainFrame }),
    ).toEqual(result);
  },
);

test("cloud account IPC rejects non-main frames and rechecks ownership after login/OAuth responses", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let destroyed = false;
  let authorized: (() => boolean) | undefined;
  let capabilityOrigin: string | undefined;
  const sender = { mainFrame: {}, isDestroyed: () => destroyed };
  const event = { sender, senderFrame: sender.mainFrame };
  registerCloudAccountIpc({
    ipcMain: {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    isMainWindow: (contents) => contents === (sender as any),
    manager: {
      status: () => ({ state: "signed-out" }),
      capabilities: (origin) => {
        capabilityOrigin = origin;
        return { registrationAllowed: true, githubEnabled: false };
      },
      signIn: (_kind, _input, allowed) => {
        authorized = allowed;
      },
      signInWithGitHub: (_input, allowed) => {
        authorized = allowed;
        return Promise.resolve({ state: "signed-out" });
      },
      linkGitHub: (allowed) => {
        authorized = allowed;
        return Promise.resolve({ state: "signed-out" });
      },
      manageLinks: (_input, allowed) => {
        authorized = allowed;
      },
      profile: (_input, allowed) => {
        authorized = allowed;
      },
      logout: () => {},
      cancelSignIn: () => {},
    } as any,
  });
  expect([...handlers.keys()].sort()).toEqual(
    [
      "status",
      "capabilities",
      "login",
      "register",
      "github",
      "links",
      "profile",
      "cancelSignIn",
      "logout",
    ]
      .map((name) => `cloudAccount:${name}`)
      .sort(),
  );
  for (const handler of handlers.values()) {
    expect(() => handler({ ...event, senderFrame: {} }, {})).toThrow();
    expect(() => handler({ ...event, sender: { ...sender } }, {})).toThrow();
  }
  expect(handlers.get("cloudAccount:capabilities")!(event, "https://account.example")).toEqual({
    registrationAllowed: true,
    githubEnabled: false,
  });
  expect(capabilityOrigin).toBe("https://account.example");
  for (const name of ["login", "register"]) {
    handlers.get(`cloudAccount:${name}`)!(event, {});
    expect(authorized!()).toBe(true);
  }
  for (const [name, input] of [
    ["github", { mode: "login", input: { origin: "https://account.example" } }],
    ["github", { mode: "link" }],
    [
      "profile",
      {
        action: "read",
        origin: "https://account.example",
        accountId: "10000000-0000-0000-0000-000000000001",
      },
    ],
    [
      "links",
      {
        action: "list",
        origin: "https://account.example",
        accountId: "10000000-0000-0000-0000-000000000001",
      },
    ],
  ] as const) {
    handlers.get(`cloudAccount:${name}`)!(event, input);
    expect(authorized!()).toBe(true);
  }
  for (const bad of [{}, { mode: "revoke" }, { mode: "link", input: {} }]) {
    authorized = undefined;
    expect(() => handlers.get("cloudAccount:github")!(event, bad)).toThrow();
    expect(authorized).toBeUndefined();
  }
  handlers.get("cloudAccount:github")!(event, { mode: "link" });
  const originalFrame = sender.mainFrame;
  sender.mainFrame = {};
  expect(authorized!()).toBe(false);
  for (const handler of handlers.values()) expect(() => handler(event, {})).toThrow();
  sender.mainFrame = originalFrame;
  destroyed = true;
  expect(authorized!()).toBe(false);
  for (const handler of handlers.values()) expect(() => handler(event, {})).toThrow();
});

function githubFocusFixture(focus?: (sender: unknown) => void) {
  const handlers = new Map<string, (...args: any[]) => any>();
  let destroyed = false,
    liveMainWindow = true,
    calls = 0;
  const sender = { mainFrame: {}, isDestroyed: () => destroyed };
  const event = { sender, senderFrame: sender.mainFrame };
  let complete!: (status: CloudAccountStatus) => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<CloudAccountStatus>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  const operation = () => {
    calls++;
    return pending;
  };
  registerCloudAccountIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    isMainWindow: (contents) => liveMainWindow && contents === (sender as any),
    focusMainWindow: focus,
    manager: {
      status: () => ({ state: "signed-in" }),
      signInWithGitHub: operation,
      linkGitHub: operation,
    } as any,
  });
  return {
    sender,
    event,
    complete,
    fail,
    github: handlers.get("cloudAccount:github")!,
    get calls() {
      return calls;
    },
    destroy() {
      destroyed = true;
    },
    removeMainWindow() {
      liveMainWindow = false;
    },
    replaceFrame() {
      sender.mainFrame = {};
    },
  };
}

const githubSignIn = { mode: "login", input: { origin: "https://account.example" } };
const signedIn: CloudAccountStatus = {
  state: "signed-in",
  origin: "https://account.example",
  account: { id: "10000000-0000-0000-0000-000000000001", username: "test-user" },
};

test("GitHub sign-in and association return to their trusted main window only after successful completion", async () => {
  for (const input of [githubSignIn, { mode: "link" }]) {
    const focused: unknown[] = [];
    const view = githubFocusFixture((sender) => focused.push(sender));
    const result = view.github(view.event, input);
    expect(view.calls).toBe(1);
    expect(focused).toEqual([]);
    view.complete(signedIn);
    expect(await result).toBe(signedIn);
    expect(focused).toEqual([view.sender]);
  }
});

test("failed, cancelled and incomplete GitHub operations do not focus an existing signed-in account", async () => {
  for (const message of ["GitHub 登录失败。", "云账号操作已取消。"]) {
    let focused = false;
    const view = githubFocusFixture(() => {
      focused = true;
    });
    const result = view.github(view.event, githubSignIn);
    const error = new Error(message);
    view.fail(error);
    await expect(result).rejects.toBe(error);
    expect(focused).toBe(false);
  }
  for (const state of ["signed-out", "signing-in", "storage-error"] as const) {
    let focused = false;
    const view = githubFocusFixture(() => {
      focused = true;
    });
    const result = view.github(view.event, githubSignIn);
    const status: CloudAccountStatus = { state };
    view.complete(status);
    expect(await result).toBe(status);
    expect(focused).toBe(false);
  }
});

test("deferred GitHub completion cannot focus a destroyed, replaced or no-longer-owned window", async () => {
  for (const change of ["destroy", "replaceFrame", "removeMainWindow"] as const) {
    const focused: unknown[] = [];
    const view = githubFocusFixture((sender) => focused.push(sender));
    const result = view.github(view.event, githubSignIn);
    view[change]();
    view.complete(signedIn);
    expect(await result).toBe(signedIn);
    expect(focused).toEqual([]);
    expect(() => view.github(view.event, githubSignIn)).toThrow("桌面主窗口");
    expect(view.calls).toBe(1);
  }
});

test("a missing focus hook or window focus exception does not change a successful GitHub result", async () => {
  for (const focus of [
    undefined,
    () => {
      throw new Error("Window was disposed during focus");
    },
  ]) {
    const view = githubFocusFixture(focus);
    const result = view.github(view.event, githubSignIn);
    view.complete(signedIn);
    expect(await result).toBe(signedIn);
  }
});
