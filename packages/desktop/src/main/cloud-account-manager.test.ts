import { expect, test } from "bun:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { CloudAccountManager } from "./cloud-account-manager.js";
import type { CloudAccountStore, SavedCloudAccount } from "./cloud-account-store.js";
import type { CloudAccountRequest, CloudAccountTransport } from "./cloud-account-http.js";
import { CloudAccountHttpError } from "./cloud-account-http.js";

const origin = "https://account.example";
const token = () => randomBytes(32).toString("base64url");
const grant = (overrides: Partial<SavedCloudAccount> = {}): SavedCloudAccount => ({
  origin,
  accessToken: token(),
  refreshToken: token(),
  sessionId: randomUUID(),
  account: { id: randomUUID(), username: "alice" },
  kind: "account",
  audience: origin,
  accessTokenExpiresAt: Date.now() + 600_000,
  refreshTokenExpiresAt: Date.now() + 86400_000,
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(initial?: SavedCloudAccount, transport?: CloudAccountTransport) {
  let stored = initial;
  let writes = 0;
  const requests: CloudAccountRequest[] = [];
  const events: unknown[] = [];
  const retired: unknown[] = [];
  const launched: string[] = [];
  let unavailable = false;
  let retireFailure = false;
  let saveFailure = false;
  const store = {
    load: () => stored,
    save: (value) => {
      writes++;
      if (saveFailure) throw new Error("account store cannot save");
      stored = value;
    },
    preflight: () => {
      if (unavailable) throw new Error("keyring unavailable");
    },
    forget: () => {
      stored = undefined;
    },
  } as unknown as CloudAccountStore;
  const manager = new CloudAccountManager({
    store,
    request: async (input) => {
      requests.push(input);
      return transport ? transport(input) : {};
    },
    changed: (value) => events.push(value),
    retireRelay: async (identity) => {
      retired.push(identity);
      if (retireFailure) throw new Error("relay store cannot delete");
    },
    openExternal: async (url) => {
      launched.push(url);
    },
    sleep: async () => {},
  });
  return {
    manager,
    requests,
    events,
    retired,
    launched,
    store,
    saved: () => stored,
    writes: () => writes,
    unavailable: () => {
      unavailable = true;
    },
    failRetire: () => {
      retireFailure = true;
    },
    failSave: () => {
      saveFailure = true;
    },
  };
}

test("anonymous startup/status is entirely local, including unavailable keyring; no cloud requests", async () => {
  const ctx = setup();
  ctx.unavailable();
  expect(ctx.manager.status()).toEqual({ state: "signed-out" });
  await expect(ctx.manager.getCredential(origin)).rejects.toThrow("登录");
  expect(ctx.requests).toHaveLength(0);
  expect(ctx.writes()).toBe(0);
});
test("password login keeps tokens in main and does not enroll, start or share a computer", async () => {
  const next = grant();
  const ctx = setup(undefined, async () => next);
  const state = await ctx.manager.signIn("login", {
    origin,
    username: "alice",
    password: "long password here",
  });
  expect(state.account).toEqual(next.account);
  expect(ctx.requests.map((req) => req.path)).toEqual(["/api/v1/account/login"]);
  expect(ctx.retired).toHaveLength(0);
  expect(ctx.saved()?.accessToken).toBe(next.accessToken);
  const publicState = JSON.stringify([state, ctx.events]);
  for (const secret of [next.accessToken, next.refreshToken, "long password here"])
    expect(publicState).not.toContain(secret);
  const before = ctx.requests.length;
  await expect(ctx.manager.getCredential("https://other.example")).rejects.toThrow("登录");
  await expect(ctx.manager.getCredential(origin, randomUUID())).rejects.toThrow("登录");
  expect(ctx.requests).toHaveLength(before);
});
test("keyring preflight rejects login before sending the password", async () => {
  const ctx = setup();
  ctx.unavailable();
  await expect(
    ctx.manager.signIn("register", { origin, username: "alice", password: "long password here" }),
  ).rejects.toThrow("keyring");
  expect(ctx.requests).toHaveLength(0);
});
test("rotating refresh is singleflight, persisted before use and scoped to the same account/session", async () => {
  const old = grant({ accessTokenExpiresAt: Date.now() + 1000 });
  const next = grant({ account: old.account, sessionId: old.sessionId });
  const response = deferred<unknown>();
  const ctx = setup(old, async () => response.promise);
  const a = ctx.manager.getCredential(origin, old.account.id);
  const b = ctx.manager.getCredential(origin, old.account.id);
  expect(ctx.requests).toHaveLength(1);
  expect(ctx.requests[0]?.body).toEqual({ refreshToken: old.refreshToken });
  response.resolve(next);
  expect(await a).toBe(next.accessToken);
  expect(await b).toBe(next.accessToken);
  expect(ctx.saved()?.refreshToken).toBe(next.refreshToken);
  expect(ctx.writes()).toBe(1);
});
test("logout fences late refresh and login results, retiring only account-scoped relay identity", async () => {
  const old = grant({ accessTokenExpiresAt: Date.now() + 1000 });
  const response = deferred<unknown>();
  const ctx = setup(old, async (input) => (input.path.endsWith("refresh") ? response.promise : {}));
  const pending = ctx.manager.getCredential(origin).catch(() => "cancelled");
  const logout = ctx.manager.logout();
  expect(ctx.manager.status().state).toBe("signed-out");
  response.resolve(grant({ account: old.account, sessionId: old.sessionId }));
  await logout;
  expect(await pending).toBe("cancelled");
  expect(ctx.saved()).toBeUndefined();
  expect(ctx.manager.status()).toEqual({ state: "signed-out" });
  expect(ctx.retired).toEqual([{ origin, accountId: old.account.id }]);

  const late = deferred<unknown>();
  const signIn = setup(undefined, async (input) =>
    input.path.endsWith("login") ? late.promise : {},
  );
  const result = signIn.manager
    .signIn("login", { origin, username: "alice", password: "long password here" })
    .catch(() => "cancelled");
  await new Promise((done) => setTimeout(done, 0));
  await signIn.manager.logout();
  late.resolve(grant());
  expect(await result).toBe("cancelled");
  expect(signIn.saved()).toBeUndefined();
  expect(signIn.requests.some((req) => req.path.endsWith("logout"))).toBe(true);
});
test("authorization failure clears cloud account but temporary network failure preserves it", async () => {
  const old = grant({ accessTokenExpiresAt: Date.now() + 1000 });
  const offline = setup(old, async () => {
    throw new CloudAccountHttpError(0);
  });
  await expect(offline.manager.getCredential(origin)).rejects.toThrow();
  expect(offline.saved()).toEqual(old);
  const revoked = setup(old, async (input) => {
    if (input.path.endsWith("refresh")) throw new CloudAccountHttpError(401);
    return {};
  });
  await expect(revoked.manager.getCredential(origin)).rejects.toThrow();
  expect(revoked.saved()).toBeUndefined();
  expect(revoked.retired).toHaveLength(1);
});
test("GitHub login opens only fixed provider URL with PKCE, keeps proof private, and explicit linking preserves the account session", async () => {
  const receipt = token();
  let challenge = "";
  const next = grant();
  const transport: CloudAccountTransport = async (req) => {
    if (req.path.endsWith("status")) return { enabled: true };
    if (req.path.endsWith("start")) {
      challenge = (req.body as { codeChallenge: string }).codeChallenge;
      return {
        authorizationUrl: `https://github.com/login/oauth/authorize?code_challenge=${challenge}&code_challenge_method=S256`,
        receipt,
        expiresAt: Date.now() + 60_000,
        pollIntervalMs: 1000,
      };
    }
    if (req.path.endsWith("poll")) {
      const proof = req.body as { codeVerifier: string };
      expect(createHash("sha256").update(proof.codeVerifier).digest("base64url")).toBe(challenge);
      return next;
    }
    return {};
  };
  const ctx = setup(undefined, transport);
  await ctx.manager.signInWithGitHub({ origin });
  expect(ctx.launched).toHaveLength(1);
  expect(ctx.launched[0]).not.toContain(receipt);
  expect(JSON.stringify(ctx.events)).not.toContain(receipt);
  expect(ctx.manager.status().account?.id).toBe(next.account.id);

  const linked = setup(next, async (req) =>
    req.path.endsWith("poll") ? { linked: true, account: next.account } : transport(req),
  );
  await linked.manager.linkGitHub();
  expect(linked.saved()).toEqual(next);
  expect(linked.retired).toHaveLength(0);
  const start = linked.requests.find((req) => req.path.endsWith("start"))!;
  expect(start.token).toBe(next.accessToken);
  expect((start.body as { mode: string }).mode).toBe("link");
});
test("malicious provider navigation is rejected before browser launch", async () => {
  const ctx = setup(undefined, async (req) =>
    req.path.endsWith("status")
      ? { enabled: true }
      : {
          authorizationUrl: "https://evil.example/login/oauth/authorize",
          receipt: token(),
          expiresAt: Date.now() + 60_000,
        },
  );
  await expect(ctx.manager.signInWithGitHub({ origin })).rejects.toThrow("地址无效");
  expect(ctx.launched).toHaveLength(0);
  expect(ctx.saved()).toBeUndefined();
});

test("switching accounts revokes a rotated grant that arrives after the old refresh was fenced", async () => {
  const old = grant({ accessTokenExpiresAt: Date.now() + 1000 });
  const rotated = grant({ account: old.account, sessionId: old.sessionId });
  const next = grant({ account: { id: randomUUID(), username: "bob" } });
  const response = deferred<unknown>();
  const ctx = setup(old, async (req) => {
    if (req.path.endsWith("refresh")) return response.promise;
    if (req.path.endsWith("login")) return next;
    return {};
  });
  const refreshing = ctx.manager.getCredential(origin).catch(() => "cancelled");
  await ctx.manager.signIn("login", { origin, username: "bob", password: "another long password" });
  response.resolve(rotated);
  expect(await refreshing).toBe("cancelled");
  expect(ctx.saved()?.sessionId).toBe(next.sessionId);
  expect(
    ctx.requests.some((req) => req.path.endsWith("logout") && req.token === rotated.accessToken),
  ).toBe(true);
});

test("failed server revocation reports uncertainty after local logout; local credentials remain erased", async () => {
  const old = grant();
  const ctx = setup(old, async () => {
    throw new CloudAccountHttpError(0);
  });
  await expect(ctx.manager.logout()).rejects.toThrow("本机已退出");
  expect(ctx.saved()).toBeUndefined();
  expect(ctx.manager.status().state).toBe("signed-out");
  expect(ctx.retired).toHaveLength(1);
});

test("cancelling GitHub login aborts the private polling proof and cannot accept a late grant", async () => {
  const receipt = token();
  const response = deferred<unknown>();
  const ctx = setup(undefined, async (req) => {
    if (req.path.endsWith("status")) return { enabled: true };
    if (req.path.endsWith("start"))
      return {
        authorizationUrl: `https://github.com/login/oauth/authorize?code_challenge=${(req.body as any).codeChallenge}&code_challenge_method=S256`,
        receipt,
        expiresAt: Date.now() + 60_000,
        pollIntervalMs: 1000,
      };
    if (req.path.endsWith("poll")) return response.promise;
    return {};
  });
  const pending = ctx.manager.signInWithGitHub({ origin }).catch(() => "cancelled");
  while (!ctx.requests.some((req) => req.path.endsWith("poll")))
    await new Promise((done) => setTimeout(done, 0));
  ctx.manager.cancelSignIn();
  response.resolve(grant());
  expect(await pending).toBe("cancelled");
  expect(ctx.saved()).toBeUndefined();
  expect(ctx.requests.find((req) => req.path.endsWith("poll"))!.signal!.aborted).toBe(true);
  expect(ctx.requests.some((req) => req.path.endsWith("cancel"))).toBe(true);
});

test("relay cleanup failure cannot skip root-session revocation or leave sign-in permanently pending", async () => {
  const old = grant();
  const ctx = setup(old);
  ctx.failRetire();
  await expect(ctx.manager.logout()).rejects.toThrow("relay store");
  expect(ctx.saved()).toBeUndefined();
  expect(
    ctx.requests.some((req) => req.path.endsWith("logout") && req.token === old.accessToken),
  ).toBe(true);
  const login = setup(old);
  login.failRetire();
  await expect(
    login.manager.signIn("login", { origin, username: "alice", password: "long fixture password" }),
  ).rejects.toThrow("relay store");
  expect(login.manager.status().state).toBe("signed-in");
  expect(login.requests).toHaveLength(0);
});

test("refresh persistence and relay cleanup failures still revoke the rotated root grant", async () => {
  const old = grant({ accessTokenExpiresAt: Date.now() + 1000 });
  const next = grant({ account: old.account, sessionId: old.sessionId });
  const ctx = setup(old, async (req) => (req.path.endsWith("refresh") ? next : {}));
  ctx.failSave();
  ctx.failRetire();
  await expect(ctx.manager.getCredential(origin)).rejects.toThrow("relay store");
  expect(ctx.manager.status().state).toBe("storage-error");
  expect(ctx.writes()).toBe(1);
  expect(ctx.retired).toEqual([{ origin, accountId: old.account.id }]);
  expect(ctx.requests.filter((req) => req.path.endsWith("logout")).map((req) => req.token)).toEqual([
    next.accessToken,
  ]);
  await expect(ctx.manager.getCredential(origin)).rejects.toThrow("登录");
});
