import { expect, test } from "bun:test";
import { registerCloudAccountIpc } from "./cloud-account-ipc.js";

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
      },
      linkGitHub: (allowed) => {
        authorized = allowed;
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
