import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, PlaintextCipher } from "@cjhyy/code-shell-core";
import { createLinkService } from "@cjhyy/code-shell-server/links";
import {
  createNativeRemoteLinkManager,
  type NativeLinkAuthorizationInput,
  type NativeLinkAuthorizationWindow,
} from "./remote-link-manager.js";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(
  options: {
    open?: (
      input: NativeLinkAuthorizationInput,
      handle: NativeLinkAuthorizationWindow,
    ) => NativeLinkAuthorizationWindow | Promise<NativeLinkAuthorizationWindow>;
    onConnected?: () => void | Promise<void>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "native-link-manager-"));
  const store = new CredentialStore(undefined, new PlaintextCipher(), root);
  let opened: NativeLinkAuthorizationInput | undefined,
    closes = 0,
    allowed = true;
  const service = createLinkService({
    store,
    remoteLink: () => ({
      issuer: "https://link.example",
      clientId: "client",
      redirectUri: "http://127.0.0.1:43827/link/callback",
    }),
  });
  const manager = createNativeRemoteLinkManager({
    service,
    onConnected: options.onConnected,
    open: (input) => {
      opened = input;
      const handle = {
        close() {
          closes++;
          input.onCancel();
        },
      };
      return options.open?.(input, handle) ?? handle;
    },
  });
  cleanups.push(() => {
    manager.close();
    rmSync(root, { force: true, recursive: true });
  });
  return {
    manager,
    service,
    store,
    context: { ownerId: "owner", authorize: () => allowed },
    get opened() {
      return opened;
    },
    get closes() {
      return closes;
    },
    revoke() {
      allowed = false;
    },
  };
}
const input = {
  providerId: "github",
  methodId: "remote-link",
  label: "Native account",
  expectedRevision: null,
};
async function opened(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 40 && !f.opened; i++) await Promise.resolve();
  expect(f.opened).toBeDefined();
  return f.opened!;
}
test("native cancel belongs to its owner and closes the authorization once", async () => {
  const f = fixture(),
    id = randomUUID();
  const pending = f.manager.start(f.context, id, input);
  const window = await opened(f);
  expect(new URL(window.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
  expect(window).not.toHaveProperty("verifier");
  expect(f.manager.cancel({ ownerId: "other", authorize: () => true }, id)).toBe(false);
  expect(f.closes).toBe(0);
  expect(f.manager.cancel(f.context, id)).toBe(true);
  expect((await pending).state).toBe("cancelled");
  expect(f.closes).toBe(1);
  expect(f.store.list()).toEqual([]);
});

test("legacy cancellation during asynchronous browser dispatch closes its late handle", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    open: async (_input, handle) => {
      await gate;
      return handle;
    },
  });
  const requestId = randomUUID();
  const pending = f.manager.start(f.context, requestId, input);
  const window = await opened(f);
  f.manager.cancel(f.context, requestId);
  expect(window.signal?.aborted).toBe(true);
  expect((await pending).state).toBe("cancelled");
  release();
  for (let i = 0; i < 30 && !f.closes; i++) await Promise.resolve();
  expect(f.closes).toBe(1);
});

test("legacy connected result settles even when the owner focus notification throws", async () => {
  const f = fixture({
    onConnected: () => {
      throw new Error("focus unavailable");
    },
  });
  const pending = f.manager.start(f.context, randomUUID(), input);
  const window = await opened(f);
  f.service.completeRemoteAuth = async () => ({
    id: "synthetic",
    providerId: "github",
    state: "connected",
  });
  expect(await window.onCallback(`${window.redirectUri}?code=synthetic`)).toBe(true);
  expect((await pending).state).toBe("connected");
  expect(f.closes).toBe(1);
});
test("closing the login window cancels and permits a new attempt", async () => {
  const f = fixture();
  const first = f.manager.start(f.context, randomUUID(), input);
  (await opened(f)).onCancel();
  expect((await first).state).toBe("cancelled");
  const id = randomUUID();
  const next = f.manager.start(f.context, id, input);
  await opened(f);
  f.manager.cancel(f.context, id);
  expect((await next).state).toBe("cancelled");
});
test("cancellation arriving before start admission prevents a later window", async () => {
  const f = fixture(),
    id = randomUUID();
  f.manager.cancel(f.context, id);
  expect((await f.manager.start(f.context, id, input)).state).toBe("cancelled");
  expect(f.opened).toBeUndefined();
});
test("an owner cannot open two flows and destroying its manager cancels the pending attempt", async () => {
  const f = fixture();
  const pending = f.manager.start(f.context, randomUUID(), input);
  await opened(f);
  await expect(f.manager.start(f.context, randomUUID(), input)).rejects.toThrow("完成或取消");
  f.manager.close();
  expect((await pending).state).toBe("cancelled");
  expect(f.closes).toBe(1);
  await expect(f.manager.start(f.context, randomUUID(), input)).rejects.toThrow();
});
test("mismatched state is rejected before network exchange and never stores a connection", async () => {
  const f = fixture();
  const pending = f.manager.start(f.context, randomUUID(), input);
  void pending.catch(() => {});
  (await opened(f)).onCallback("http://127.0.0.1:43827/link/callback?code=unused&state=wrong");
  await expect(pending).rejects.toMatchObject({ code: "authorization_failed" });
  expect(f.store.list()).toEqual([]);
  expect(f.closes).toBe(1);
});
test("revoked project access rejects the return before network exchange", async () => {
  const f = fixture();
  const pending = f.manager.start(f.context, randomUUID(), input);
  void pending.catch(() => {});
  const window = await opened(f);
  f.revoke();
  window.onCallback(
    window.redirectUri +
      "?code=unused&state=" +
      new URL(window.authorizationUrl).searchParams.get("state"),
  );
  await expect(pending).rejects.toMatchObject({ code: "login_required" });
  expect(f.store.list()).toEqual([]);
});
