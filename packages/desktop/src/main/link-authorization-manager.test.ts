import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, PlaintextCipher } from "@cjhyy/code-shell-core";
import { createLinkService } from "@cjhyy/code-shell-server/links";
import { createNativeLinkAuthorizationManager } from "./link-authorization-manager.js";
import type {
  NativeLinkAuthorizationInput,
  NativeLinkAuthorizationWindow,
} from "./remote-link-manager.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const input = {
  providerId: "github",
  methodId: "remote-link",
  label: "Account",
  expectedRevision: null,
};
function fixture(
  options: {
    open?: (
      input: NativeLinkAuthorizationInput,
      handle: NativeLinkAuthorizationWindow,
    ) => NativeLinkAuthorizationWindow | Promise<NativeLinkAuthorizationWindow>;
    now?: () => number;
    onConnected?: () => void | Promise<void>;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "native-link-steps-"));
  const store = new CredentialStore(undefined, new PlaintextCipher(), directory);
  const service = createLinkService({
    store,
    now: options.now,
    remoteLink: () => ({
      issuer: "https://link.example",
      clientId: "client",
      redirectUri: "http://127.0.0.1/link/callback",
    }),
    readRemoteCatalog: async () => ["github"],
    validateToken: async () => ({
      providerId: "github",
      identity: { externalAccountId: "42", label: "fixture" },
      capabilityIds: [],
      verifiedAt: new Date().toISOString(),
    }),
  });
  let opened: NativeLinkAuthorizationInput | undefined,
    closes = 0,
    focuses = 0,
    allowed = true;
  const manager = createNativeLinkAuthorizationManager({
    service,
    onConnected: options.onConnected,
    open: (value) => {
      opened = value;
      const handle = {
        close() {
          closes++;
          value.onCancel();
        },
        focus() {
          focuses++;
        },
      };
      return options.open?.(value, handle) ?? handle;
    },
  });
  cleanups.push(() => {
    manager.close();
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    manager,
    service,
    store,
    context: { ownerId: "one", authorize: () => allowed },
    get opened() {
      return opened!;
    },
    get closes() {
      return closes;
    },
    get focuses() {
      return focuses;
    },
    revoke() {
      allowed = false;
    },
  };
}
test("native authorization returns pending immediately and status is authoritative", async () => {
  const f = fixture();
  const job = await f.manager.start(f.context, randomUUID(), input, "remote-link");
  expect(job.state).toBe("pending");
  expect(job.step?.kind).toBe("redirect");
  expect(f.opened).toBeDefined();
  expect(new URL(f.opened.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
  expect(JSON.stringify(job)).not.toContain("verifier");
  expect(await f.manager.get(f.context, job.id)).toEqual(job);
  expect(await f.manager.open(f.context, job.id)).toBe(true);
  expect(f.focuses).toBe(1);
  await f.manager.cancel(f.context, job.id);
  expect((await f.manager.get(f.context, job.id)).state).toBe("cancelled");
  expect(f.closes).toBe(1);
  expect(f.store.list()).toEqual([]);
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function waitForOpen(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 100 && !f.opened; i++) await Promise.resolve();
  expect(f.opened).toBeDefined();
}
test("cancellation while binding or opening aborts and closes the late handle", async () => {
  const release = deferred<void>();
  const f = fixture({
    open: async (_input, handle) => {
      await release.promise;
      return handle;
    },
  });
  const requestId = randomUUID();
  const pending = f.manager.start(f.context, requestId, input, "remote-link");
  await waitForOpen(f);
  await f.manager.cancel(f.context, requestId);
  expect(f.opened.signal?.aborted).toBe(true);
  release.resolve();
  expect((await pending).state).toBe("cancelled");
  expect(f.closes).toBe(1);
  expect(f.store.list()).toEqual([]);
});
test("owner retirement during opening cannot leave pending authorization or reopen", async () => {
  const release = deferred<void>();
  const f = fixture({
    open: async (_input, handle) => {
      await release.promise;
      return handle;
    },
  });
  const pending = f.manager.start(f.context, randomUUID(), input, "remote-link");
  await waitForOpen(f);
  f.manager.close();
  expect(f.opened.signal?.aborted).toBe(true);
  release.resolve();
  expect((await pending).state).toBe("cancelled");
  expect(f.closes).toBe(1);
});
test("real expiry starts before asynchronous browser dispatch finishes", async () => {
  const release = deferred<void>();
  let now = Date.now() - 10 * 60_000 + 80;
  const f = fixture({
    now: () => now,
    open: async (_input, handle) => {
      await release.promise;
      return handle;
    },
  });
  const pending = f.manager.start(f.context, randomUUID(), input, "remote-link");
  await waitForOpen(f);
  const expiresAt = Date.parse(f.opened.expiresAt!);
  now = expiresAt + 1;
  await new Promise<void>((resolve) =>
    f.opened.signal!.addEventListener("abort", () => resolve(), { once: true }),
  );
  release.resolve();
  const result = await pending;
  expect(result.state).toBe("failed");
  expect(result.errorCode).toBe("authorization_expired");
  expect(f.closes).toBe(1);
});
test("browser dispatch failure is visible and releases the current attempt", async () => {
  let calls = 0;
  const f = fixture({
    open: async (_input, handle) => {
      if (++calls === 1) throw new Error("browser unavailable");
      return handle;
    },
  });
  await expect(f.manager.start(f.context, randomUUID(), input, "remote-link")).rejects.toThrow(
    "browser unavailable",
  );
  expect((await f.manager.start(f.context, randomUUID(), input, "remote-link")).state).toBe(
    "pending",
  );
});
test("focus notification failure never changes an authoritative connected callback", async () => {
  const f = fixture({
    onConnected: () => {
      throw new Error("focus unavailable");
    },
  });
  const job = await f.manager.start(f.context, randomUUID(), input, "remote-link");
  f.service.completeRemoteAuth = async () => ({ ...job, state: "connected", step: undefined });
  expect(await f.opened.onCallback("synthetic")).toBe(true);
  expect(f.closes).toBe(1);
});
test("owner validation failure after confirmation skips focus and retains connected result", async () => {
  let focused = false;
  const f = fixture({
    onConnected: () => {
      focused = true;
    },
  });
  const job = await f.manager.start(f.context, randomUUID(), input, "remote-link");
  f.service.completeRemoteAuth = async () => {
    f.context.authorize = () => {
      throw new Error("owner gone");
    };
    return { ...job, state: "connected", step: undefined };
  };
  expect(await f.opened.onCallback("synthetic")).toBe(true);
  expect(focused).toBe(false);
  expect(f.closes).toBe(1);
});
test("request cancellation before admission prevents a later window", async () => {
  const f = fixture(),
    requestId = randomUUID();
  await f.manager.cancel(f.context, requestId);
  expect((await f.manager.start(f.context, requestId, input, "remote-link")).state).toBe(
    "cancelled",
  );
  expect(f.opened).toBeUndefined();
});
test("different owners cannot inspect, focus or cancel another native authorization", async () => {
  const f = fixture();
  const job = await f.manager.start(f.context, randomUUID(), input, "remote-link");
  const other = { ownerId: "two", authorize: () => true };
  await expect(f.manager.get(other, job.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(f.manager.cancel(other, job.id)).rejects.toThrow();
  expect(await f.manager.open(other, job.id)).toBe(false);
  expect(f.closes).toBe(0);
});
test("user closing the provider window cancels without saving or reopening", async () => {
  const f = fixture();
  const job = await f.manager.start(f.context, randomUUID(), input, "remote-link");
  f.opened.onCancel();
  for (let i = 0; i < 30 && (await f.manager.get(f.context, job.id)).state === "pending"; i++)
    await Promise.resolve();
  expect((await f.manager.get(f.context, job.id)).state).toBe("cancelled");
  expect(f.closes).toBe(1);
  expect(f.store.list()).toEqual([]);
});
test("invalid callback closes the window and records a failed task without network exchange", async () => {
  const f = fixture();
  const job = await f.manager.start(f.context, randomUUID(), input, "remote-link");
  f.opened.onCallback("http://127.0.0.1/link/callback?code=unused&state=wrong");
  for (let i = 0; i < 100 && !f.closes; i++) await Promise.resolve();
  expect((await f.manager.get(f.context, job.id)).state).toBe("failed");
  expect(f.closes).toBe(1);
  expect(f.store.list()).toEqual([]);
});
test("local token uses the same native lifecycle without opening a browser", async () => {
  const f = fixture();
  const job = await f.manager.start(
    f.context,
    randomUUID(),
    { ...input, methodId: "fine-grained-pat" },
    "token",
  );
  expect(f.opened).toBeUndefined();
  expect(job.step?.kind).toBe("credential-input");
  const result = await f.manager.respond(f.context, job.id, {
    stepId: job.step!.id,
    operation: "submit",
    input: { token: "synthetic" },
  });
  expect(result.state).toBe("connected");
  expect((await f.manager.get(f.context, job.id)).state).toBe("connected");
  expect(f.store.resolve(result.connection!.id)?.secret).toBe("synthetic");
});
test("one native owner cannot start another pending flow", async () => {
  const f = fixture();
  await f.manager.start(f.context, randomUUID(), input, "remote-link");
  await expect(f.manager.start(f.context, randomUUID(), input, "remote-link")).rejects.toThrow(
    "完成或取消",
  );
  f.revoke();
  await expect(
    f.manager.start(f.context, randomUUID(), input, "remote-link"),
  ).rejects.toMatchObject({ code: "login_required" });
});
