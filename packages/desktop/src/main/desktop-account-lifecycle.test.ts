import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { bindDesktopAccountLifecycle } from "./desktop-account-lifecycle.js";
import type { DesktopRelayStatus } from "../shared/device-relay.js";

test("saved account binding waits for app readiness, retries failures, and needs no incoming remote access", async () => {
  let ready!: () => void;
  const app = Object.assign(new EventEmitter(), {
    whenReady: () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  });
  const window = {};
  let reads = 0,
    resumes = 0;
  let local: DesktopRelayStatus = { state: "unregistered", registered: false };
  let allowed!: () => boolean;
  const account = {
    status: () => {
      reads++;
      return {
        state: "signed-in" as const,
        origin: "https://account.example",
        account: { id: "a", username: "member" },
      };
    },
    resume: async (authorized?: () => boolean) => {
      allowed = authorized!;
      if (++resumes === 1) throw new Error("offline");
      local = {
        state: "stopped",
        registered: true,
        accountId: "a",
        relayOrigin: "https://account.example",
        remoteAccessEnabled: false,
      };
      return account.status();
    },
  };
  const binding = bindDesktopAccountLifecycle(
    app as any,
    account,
    { relayStatus: () => local },
    () => [window] as any,
  );
  try {
    app.emit("browser-window-focus", {}, window);
    expect(reads).toBe(0);
    ready();
    await Promise.resolve();
    await binding.retry();
    expect(resumes).toBe(1);
    await binding.retry();
    expect(resumes).toBe(2);
    expect(local.remoteAccessEnabled).toBe(false);
    await binding.retry();
    expect(resumes).toBe(2);
    local = { ...local, remoteAccessEnabled: true, state: "disconnected" };
    await binding.retry();
    expect(resumes).toBe(3);
    local = { state: "unauthorized", registered: false };
    await binding.retry();
    expect(resumes).toBe(3);
    app.emit("will-quit");
    expect(allowed()).toBe(false);
    await binding.retry(true);
    expect(resumes).toBe(3);
  } finally {
    app.emit("will-quit");
  }
});

test("background account restore is singleflight and cannot start after quitting", async () => {
  let ready!: () => void, finish!: () => void;
  const app = Object.assign(new EventEmitter(), {
    whenReady: () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  });
  let resumes = 0;
  const status = {
    state: "signed-in" as const,
    origin: "https://account.example",
    account: { id: "a", username: "member" },
  };
  const binding = bindDesktopAccountLifecycle(
    app as any,
    {
      status: () => status,
      resume: async () => {
        resumes++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return status;
      },
    },
    { relayStatus: () => ({ state: "unregistered", registered: false }) },
    () => [],
  );
  ready();
  await Promise.resolve();
  const retry = binding.retry();
  expect(resumes).toBe(1);
  app.emit("will-quit");
  finish();
  await retry;
  await binding.retry(true);
  expect(resumes).toBe(1);
});
