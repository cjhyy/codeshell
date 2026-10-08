import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "../credentials/store.js";
import type { Credential } from "../credentials/types.js";
import { asGlobalFetch } from "../testing/fetch-stub.js";
import { executeLocalOAuthLinkAction, type LocalOAuthLinkActionRequest } from "./local-oauth.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const now = () => Date.parse("2026-10-09T12:00:00Z");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function fixture(provider = "github", expired = true) {
  const directory = mkdtempSync(join(tmpdir(), "local-link-oauth-"));
  roots.push(directory);
  const store = new CredentialStore(directory, undefined, join(directory, "user"));
  const tokenEndpoint =
    provider === "github"
      ? "https://github.com/login/oauth/access_token"
      : "https://gitlab.com/oauth/token";
  const credential: Credential = {
    id: `local-${provider}`,
    type: "link",
    label: provider,
    secret: JSON.stringify({
      version: 1,
      accessToken: "old-access",
      refreshToken: `refresh-${directory}`,
      tokenType: "Bearer",
      clientId: "public-client",
      tokenEndpoint,
      scope: provider === "gitlab" ? "read_api read_user" : "",
      expiresAt: new Date(now() + (expired ? -1000 : 3600000)).toISOString(),
    }),
    meta: {
      linkProvider: provider,
      linkExecutionRuntime: "local",
      linkAuthSource: "browser-oauth",
      linkExecutionBackend: "http-token",
      agentExposable: false,
      linkAccountId: "42",
      linkLastVerifiedAt: "2026-10-09T10:00:00Z",
      linkCapabilityIds:
        provider === "github"
          ? ["github.list_repositories", "github.get_issue", "github.create_issue"]
          : ["gitlab.list_projects", "gitlab.list_issues"],
    },
  };
  store.save("user", credential);
  const input: LocalOAuthLinkActionRequest = {
    id: credential.id,
    scope: "full",
    accountId: "42",
    verifiedAt: credential.meta!.linkLastVerifiedAt!,
    action: provider === "github" ? "get_issue" : "list_projects",
    params: provider === "github" ? { owner: "acme", repo: "demo", issue_number: 1 } : {},
  };
  return { store, input, credential, tokenEndpoint, directory };
}
function upstream(
  f: ReturnType<typeof fixture>,
  options: {
    scope?: string;
    accountId?: number;
    failOld?: boolean;
    token?: Record<string, unknown>;
    onToken?: () => Promise<void>;
    onAction?: () => Promise<void>;
    failAll?: boolean;
  } = {},
) {
  const counts = { refresh: 0, account: 0, action: 0 };
  const fetchImpl = asGlobalFetch(async (url, init) => {
    expect(init?.redirect).toBe("error");
    const target = String(url);
    if (target === f.tokenEndpoint) {
      counts.refresh++;
      expect(f.store.resolve(f.input.id)?.meta?.linkOAuthState).toBe("refreshing");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("public-client");
      expect(body.has("client_secret")).toBe(false);
      if (f.input.id.endsWith("gitlab")) expect(body.get("scope")).toBe("read_api read_user");
      await options.onToken?.();
      return json({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        token_type: "bearer",
        expires_in: 7200,
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...options.token,
      });
    }
    const headers = new Headers(init?.headers);
    expect(headers.has("PRIVATE-TOKEN")).toBe(false);
    if (target === "https://api.github.com/user" || target === "https://gitlab.com/api/v4/user") {
      counts.account++;
      expect(headers.get("authorization")).toBe("Bearer new-access");
      return json({ id: options.accountId ?? 42, login: "owner", username: "owner" });
    }
    counts.action++;
    await options.onAction?.();
    if (
      options.failAll ||
      (options.failOld && headers.get("authorization") === "Bearer old-access")
    )
      return json({ message: "expired" }, 401);
    if (target.includes("gitlab.com")) return json([{ id: 7, name: "Project" }]);
    return json({ number: 1, title: "Issue" });
  });
  return { counts, fetchImpl };
}

for (const provider of ["github", "gitlab"])
  test(`${provider} refreshes expired device OAuth inside Host and persists rotation`, async () => {
    const f = fixture(provider),
      u = upstream(f, provider === "gitlab" ? { scope: "read_api" } : {});
    const result = await executeLocalOAuthLinkAction(f.input, {
      store: f.store,
      now,
      fetchImpl: u.fetchImpl,
    });
    expect(result).toBeTruthy();
    expect(u.counts).toEqual({ refresh: 1, account: 1, action: 1 });
    const current = f.store.resolve(f.input.id)!;
    expect(current.meta?.linkOAuthState).toBe("connected");
    expect(JSON.parse(current.secret!).refreshToken).toBe("rotated-refresh");
    expect(current.meta?.linkLastVerifiedAt).toBe(f.input.verifiedAt);
    expect(JSON.stringify(result)).not.toContain("access");
  });

test("concurrent expired actions share exactly one rotating refresh", async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const u = upstream(f, { onToken: () => wait });
  const first = executeLocalOAuthLinkAction(f.input, {
    store: f.store,
    now,
    fetchImpl: u.fetchImpl,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = executeLocalOAuthLinkAction(f.input, {
    store: f.store,
    now,
    fetchImpl: u.fetchImpl,
  });
  release();
  await Promise.all([first, second]);
  expect(u.counts).toEqual({ refresh: 1, account: 1, action: 2 });
});

test("401 read refreshes once while writes never refresh or retry a rejected mutation", async () => {
  const f = fixture("github", false),
    u = upstream(f, { failOld: true });
  await executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl });
  expect(u.counts).toEqual({ refresh: 1, account: 1, action: 2 });
  f.store.save("user", f.credential);
  await expect(
    executeLocalOAuthLinkAction(
      {
        ...f.input,
        action: "create_issue",
        params: { owner: "acme", repo: "demo", title: "Approved" },
      },
      { store: f.store, now, fetchImpl: u.fetchImpl },
    ),
  ).rejects.toMatchObject({ code: "reconnect" });
  expect(u.counts).toEqual({ refresh: 1, account: 1, action: 3 });
});

test("a second 401 never loops and marks reconnection", async () => {
  const f = fixture("github", false),
    u = upstream(f, { failAll: true });
  await expect(
    executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl }),
  ).rejects.toMatchObject({ code: "reconnect" });
  expect(u.counts).toEqual({ refresh: 1, account: 1, action: 2 });
  expect(f.store.resolve(f.input.id)?.meta?.linkOAuthState).toBe("reconnect");
});

for (const scenario of [
  "account-drift",
  "scope-expansion",
  "scope-loss",
  "malformed-expiry",
  "missing-rotation",
])
  test(`${scenario} fails closed without running an action`, async () => {
    const f = fixture("gitlab");
    const u = upstream(
      f,
      scenario === "account-drift"
        ? { accountId: 99 }
        : scenario === "scope-expansion"
          ? { scope: "api" }
          : scenario === "scope-loss"
            ? { scope: "read_user" }
            : scenario === "malformed-expiry"
              ? { token: { expires_in: "7200" } }
              : { token: { refresh_token: undefined } },
    );
    await expect(
      executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl }),
    ).rejects.toBeInstanceOf(Error);
    expect(u.counts.action).toBe(0);
    if (scenario !== "scope-loss")
      expect(f.store.resolve(f.input.id)?.meta?.linkOAuthState).toBe("reconnect");
    else expect(f.store.resolve(f.input.id)?.meta?.linkCapabilityIds).toEqual([]);
  });

test("lost response and a restarted Host never replay a consumed refresh token", async () => {
  const f = fixture();
  let calls = 0;
  const fetchImpl = asGlobalFetch(async () => {
    calls++;
    throw new Error("PRIVATE lost response");
  });
  await expect(
    executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl }),
  ).rejects.toMatchObject({ code: "reconnect" });
  await expect(
    executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl }),
  ).rejects.toMatchObject({ code: "reconnect" });
  expect(calls).toBe(1);
  f.store.save("user", {
    ...f.credential,
    secret: JSON.stringify({
      ...JSON.parse(f.credential.secret!),
      refreshToken: "unique-unfinished-rotation",
    }),
    meta: { ...f.credential.meta, linkOAuthState: "refreshing" },
  });
  await expect(
    executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl }),
  ).rejects.toMatchObject({ code: "busy" });
  expect(calls).toBe(1);
});

for (const mutation of ["disconnect", "replace-account", "revoke-action"])
  test(`CAS prevents ${mutation} from being overwritten during rotation`, async () => {
    const f = fixture();
    const u = upstream(f, {
      onToken: async () => {
        if (mutation === "disconnect") f.store.remove("user", f.input.id);
        else {
          const saved = f.store.resolve(f.input.id)!;
          f.store.save("user", {
            ...saved,
            meta: {
              ...saved.meta,
              ...(mutation === "replace-account"
                ? { linkAccountId: "99" }
                : { linkCapabilityIds: [] }),
            },
          });
        }
      },
    });
    await expect(
      executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl }),
    ).rejects.toMatchObject({ code: "changed" });
    expect(u.counts.action).toBe(0);
    expect(f.store.resolve(f.input.id)?.secret ?? "").not.toContain("new-access");
  });

test("caller cancellation completes shared custody rotation but sends no action", async () => {
  const f = fixture(),
    controller = new AbortController();
  const u = upstream(f, {
    onToken: async () => {
      controller.abort();
    },
  });
  await expect(
    executeLocalOAuthLinkAction(f.input, {
      store: f.store,
      now,
      fetchImpl: u.fetchImpl,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(u.counts).toEqual({ refresh: 1, account: 1, action: 0 });
  expect(f.store.resolve(f.input.id)?.meta?.linkOAuthState).toBe("connected");
});

test("execution rechecks account, actions and endpoint before any secret-bearing request", async () => {
  for (const mutation of ["account", "action", "endpoint", "refresh-expired"]) {
    const f = fixture(),
      current = f.store.resolve(f.input.id)!;
    if (mutation === "account") current.meta!.linkAccountId = "99";
    if (mutation === "action") current.meta!.linkCapabilityIds = [];
    if (mutation === "endpoint")
      current.secret = JSON.stringify({
        ...JSON.parse(current.secret!),
        tokenEndpoint: "https://attacker.example/token",
      });
    if (mutation === "refresh-expired")
      current.secret = JSON.stringify({
        ...JSON.parse(current.secret!),
        refreshTokenExpiresAt: new Date(now() - 1).toISOString(),
      });
    f.store.save("user", current);
    const u = upstream(f);
    await expect(
      executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl }),
    ).rejects.toBeInstanceOf(Error);
    expect(u.counts).toEqual({ refresh: 0, account: 0, action: 0 });
  }
});

test("revoked authority during an in-flight action discards its output", async () => {
  const f = fixture("github", false),
    u = upstream(f, {
      onAction: async () => {
        const current = f.store.resolve(f.input.id)!;
        f.store.save("user", { ...current, meta: { ...current.meta, linkCapabilityIds: [] } });
      },
    });
  await expect(
    executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("late concurrent 401 uses the already rotated credential without consuming refresh twice", async () => {
  const f = fixture("github", false);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let oldReads = 0,
    newReads = 0,
    refreshes = 0;
  const fetchImpl = asGlobalFetch(async (url, init) => {
    if (String(url) === f.tokenEndpoint) {
      refreshes++;
      return json({
        access_token: "new-access",
        refresh_token: "rotated",
        token_type: "bearer",
        expires_in: 7200,
      });
    }
    if (String(url) === "https://api.github.com/user") return json({ id: 42, login: "owner" });
    if (new Headers(init?.headers).get("authorization") === "Bearer old-access") {
      oldReads++;
      if (oldReads === 2) await delayed;
      else await new Promise((resolve) => setTimeout(resolve, 15));
      return json({ message: "expired" }, 401);
    }
    newReads++;
    if (newReads === 1) release();
    return json({ number: 1, title: "Issue" });
  });
  await Promise.all([
    executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl }),
    executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl }),
  ]);
  expect({ oldReads, newReads, refreshes }).toEqual({ oldReads: 2, newReads: 2, refreshes: 1 });
});

for (const status of [403, 429, 502])
  test(`HTTP ${status} never refreshes or repeats a local action`, async () => {
    const f = fixture("github", false);
    let calls = 0;
    const fetchImpl = asGlobalFetch(async (url) => {
      calls++;
      expect(String(url)).toContain("/issues/1");
      return json({ message: "provider failure" }, status);
    });
    await expect(
      executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl }),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

test("unknown expiry with no refresh token retains a valid long-lived device access token", async () => {
  const f = fixture("github", false),
    secret = JSON.parse(f.credential.secret!);
  delete secret.expiresAt;
  delete secret.refreshToken;
  f.store.save("user", { ...f.credential, secret: JSON.stringify(secret) });
  const u = upstream(f);
  await executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl });
  expect(u.counts).toEqual({ action: 1, refresh: 0, account: 0 });
});

for (const placement of ["same-store", "different-store"]) {
  for (const timing of ["concurrent", "sequential"])
    test(`${placement} ${timing} duplicate rotating token is durably rejected`, async () => {
      const first = fixture(),
        second =
          placement === "same-store"
            ? { ...first, input: { ...first.input, id: "copied-record" } }
            : fixture();
      second.store.save("user", { ...first.credential, id: second.input.id });
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const u = upstream(first, { onToken: timing === "concurrent" ? () => wait : undefined });
      const original = executeLocalOAuthLinkAction(first.input, {
        store: first.store,
        now,
        fetchImpl: u.fetchImpl,
      });
      if (timing === "concurrent") await new Promise((resolve) => setTimeout(resolve, 10));
      else await original;
      await expect(
        executeLocalOAuthLinkAction(second.input, {
          store: second.store,
          now,
          fetchImpl: u.fetchImpl,
        }),
      ).rejects.toMatchObject({ code: "reconnect" });
      expect(second.store.resolve(second.input.id)?.meta?.linkOAuthState).toBe("reconnect");
      expect(JSON.parse(second.store.resolve(second.input.id)!.secret!).accessToken).toBe(
        "old-access",
      );
      release();
      await original;
      // Even a later call, after the first Promise has been removed, cannot replay.
      await expect(
        executeLocalOAuthLinkAction(second.input, {
          store: second.store,
          now,
          fetchImpl: u.fetchImpl,
        }),
      ).rejects.toMatchObject({ code: "reconnect" });
      expect(u.counts).toEqual({ refresh: 1, account: 1, action: 1 });
    });
}

test("distinct Store instances for the same physical record share one rotation", async () => {
  const first = fixture();
  const store = new CredentialStore(first.directory, undefined, join(first.directory, "user"));
  expect(store.recordIdentity("user", first.input.id)).toBe(
    first.store.recordIdentity("user", first.input.id),
  );
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const u = upstream(first, { onToken: () => wait });
  const original = executeLocalOAuthLinkAction(first.input, {
    store: first.store,
    now,
    fetchImpl: u.fetchImpl,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const shared = executeLocalOAuthLinkAction(first.input, { store, now, fetchImpl: u.fetchImpl });
  release();
  await Promise.all([original, shared]);
  expect(u.counts).toEqual({ refresh: 1, account: 1, action: 2 });
  expect(store.resolve(first.input.id)?.meta?.linkOAuthState).toBe("connected");
});

test("restoring an old token into its original record cannot replay it in the running Host", async () => {
  const f = fixture(),
    u = upstream(f);
  await executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl });
  f.store.save("user", f.credential);
  await expect(
    executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl }),
  ).rejects.toMatchObject({ code: "reconnect" });
  expect(f.store.resolve(f.input.id)?.meta?.linkOAuthState).toBe("reconnect");
  expect(u.counts).toEqual({ refresh: 1, account: 1, action: 1 });
});

for (const change of ["scope", "client"])
  test(`in-flight ${change} changes cannot publish old authority results`, async () => {
    const f = fixture("gitlab", false),
      u = upstream(f, {
        onAction: async () => {
          const current = f.store.resolve(f.input.id)!;
          current.secret = JSON.stringify({
            ...JSON.parse(current.secret!),
            ...(change === "scope" ? { scope: "read_user" } : { clientId: "other-public-client" }),
          });
          f.store.save("user", current);
        },
      });
    await expect(
      executeLocalOAuthLinkAction(f.input, { store: f.store, now, fetchImpl: u.fetchImpl }),
    ).rejects.toMatchObject({ code: change === "scope" ? "forbidden" : "changed" });
  });
