import { describe, expect, test } from "bun:test";
import { createInProcessTransport } from "../protocol/transport.js";
import { createIpcCredentialAccess, type CredentialSnapshot } from "./access.js";
import { RemoteLinkError } from "../links/remote.js";

describe("createIpcCredentialAccess", () => {
  test("Figma file authorization instructions survive IPC only for the bound remote action method", async () => {
    for (const [method, code] of [
      ["remote", "file_not_authorized"],
      ["remote", "unreviewed_code"],
      ["resolve", "file_not_authorized"],
    ]) {
      const [main, worker] = createInProcessTransport();
      const access = createIpcCredentialAccess(worker);
      main.onMessage((message) => {
        if (!("id" in message) || !("method" in message)) return;
        main.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: "Provider-supplied text must not replace the reviewed instruction",
            data: { remoteLinkCode: code },
          },
        });
      });
      const request =
        method === "remote"
          ? access.executeRemoteLinkAction!({
              id: "figma",
              scope: "full",
              grantId: "grant",
              action: "get_file",
              params: { file_url_or_key: "File" },
            })
          : access.resolveValue!({ id: "figma", scope: "full", purpose: "use" });
      let error: unknown;
      try {
        await request;
      } catch (cause) {
        error = cause;
      }
      if (method === "remote" && code === "file_not_authorized") {
        expect(error).toBeInstanceOf(RemoteLinkError);
        expect((error as Error).message).toContain("添加文件");
        expect((error as Error).message).not.toContain("Provider-supplied");
      } else {
        expect(error).not.toBeInstanceOf(RemoteLinkError);
        expect((error as Error).message).toContain("Provider-supplied");
      }
    }
  });
  test("propagates scoped read failures and treats missing or legacy snapshots as unknown", () => {
    const [main, worker] = createInProcessTransport();
    const access = createIpcCredentialAccess(worker);
    expect(access.listMaskedWithStatus!("/repo", "full")).toEqual({
      credentials: [],
      readable: false,
    });
    const credential = { id: "link", type: "link" as const, label: "Link", hasSecret: true };
    const snapshot: CredentialSnapshot = {
      revision: 1,
      entries: [
        {
          cwd: "/repo",
          full: [credential],
          project: [credential],
          readableFull: false,
          readableProject: true,
          envFull: {},
          envProject: {},
        },
        { cwd: "/legacy", full: [], project: [], envFull: {}, envProject: {} },
      ],
    };
    main.send({ jsonrpc: "2.0", method: "desktop/credentialSnapshot", params: { ...snapshot } });

    expect(access.listMaskedWithStatus!("/repo", "full")).toEqual({
      credentials: [credential],
      readable: false,
    });
    expect(access.listMaskedWithStatus!("/repo", "project")).toEqual({
      credentials: [credential],
      readable: true,
    });
    expect(access.listMaskedWithStatus!("/legacy", "full")).toEqual({
      credentials: [],
      readable: false,
    });
    expect(access.listMasked("/repo", "full")).toEqual([credential]);
  });

  test("uses snapshots for metadata/env and internal requests for secret operations", async () => {
    const [main, worker] = createInProcessTransport();
    const access = createIpcCredentialAccess(worker);
    let snapshotNotifications = 0;
    const unsubscribe = access.subscribe?.(() => {
      snapshotNotifications += 1;
    });
    const snapshot: CredentialSnapshot = {
      revision: 1,
      entries: [
        {
          cwd: "/repo",
          full: [
            { id: "figma", type: "token", label: "Figma", hasSecret: true },
            { id: "xhs", type: "cookie", label: "XHS", hasSecret: true },
          ],
          project: [],
          envFull: { FIGMA_TOKEN: "env-secret" },
          envProject: {},
        },
      ],
    };
    main.send({ jsonrpc: "2.0", method: "desktop/credentialSnapshot", params: { ...snapshot } });
    expect(snapshotNotifications).toBe(1);

    expect(access.listMasked("/repo", "full").map((c) => c.id)).toEqual(["figma", "xhs"]);
    expect(access.resolveMeta("/repo", "figma", "full")?.label).toBe("Figma");
    expect(access.envExposures("/repo", "full")).toEqual({ FIGMA_TOKEN: "env-secret" });
    expect(access.listMasked("/missing", "full")).toEqual([]);

    const seenMethods: string[] = [];
    main.onMessage((msg) => {
      if (!("method" in msg) || !("id" in msg)) return;
      seenMethods.push(msg.method);
      if (msg.method === "desktop/credentialResolve") {
        main.send({ jsonrpc: "2.0", id: msg.id, result: { value: "tok-123" } });
      } else if (msg.method === "desktop/credentialMaterializeCookie") {
        main.send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { cookiesFile: "/tmp/cookies.txt", count: 3 },
        });
      } else if (msg.method === "desktop/remoteLinkAction") {
        expect(msg.params).toEqual({
          cwd: "/repo",
          id: "remote",
          scope: "project",
          grantId: "selected-grant",
          action: "list_repositories",
          params: {},
        });
        main.send({ jsonrpc: "2.0", id: msg.id, result: { repositories: [] } });
      } else if (msg.method === "desktop/oauthAccessResolve") {
        expect(msg.params).toEqual({ id: "oauth", scope: "full", forceRefresh: true });
        main.send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { accessToken: "access-only", expiresAt: "2030-01-01T00:00:00.000Z" },
        });
      }
    });

    await expect(
      access.resolveValue?.({ cwd: "/repo", id: "figma", scope: "full", purpose: "use" }),
    ).resolves.toBe("tok-123");
    await expect(
      access.materializeCookie?.({ cwd: "/repo", id: "xhs", scope: "full" }),
    ).resolves.toEqual({ cookiesFile: "/tmp/cookies.txt", count: 3 });
    await expect(
      access.resolveOAuthAccess?.({ id: "oauth", scope: "full", forceRefresh: true }),
    ).resolves.toEqual({
      accessToken: "access-only",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await expect(
      access.executeRemoteLinkAction?.({
        cwd: "/repo",
        id: "remote",
        scope: "project",
        grantId: "selected-grant",
        action: "list_repositories",
        params: {},
      }),
    ).resolves.toEqual({ repositories: [] });
    expect(seenMethods).toEqual([
      "desktop/credentialResolve",
      "desktop/credentialMaterializeCookie",
      "desktop/oauthAccessResolve",
      "desktop/remoteLinkAction",
    ]);
    unsubscribe?.();
  });
});

test("local OAuth worker seam returns only action data and propagates cancellation to Host", async () => {
  const [main, worker] = createInProcessTransport();
  const access = createIpcCredentialAccess(worker);
  const seen: Array<{ method: string; params: unknown }> = [];
  main.onMessage((message) => {
    if (!("method" in message)) return;
    seen.push({ method: message.method, params: message.params });
  });
  const controller = new AbortController();
  const pending = access.executeLocalOAuthLinkAction!(
    {
      id: "selected-link",
      scope: "full",
      accountId: "42",
      verifiedAt: "2026-10-09T10:00:00Z",
      action: "get_issue",
      params: { owner: "acme", repo: "demo", issue_number: 1 },
    },
    { signal: controller.signal },
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(seen.map((item) => item.method)).toEqual([
    "desktop/localOAuthLinkAction",
    "desktop/localOAuthLinkActionCancel",
  ]);
  expect(seen[1]!.params).toEqual({ requestId: "cred-1" });
  expect(JSON.stringify(seen)).not.toContain("refreshToken");
});

test("legacy local secret resolution denies browser OAuth Links and preserves ordinary MCP tokens", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { CredentialStore } = await import("./store.js");
  const { localCredentialAccess } = await import("./access.js");
  const directory = mkdtempSync(join(tmpdir(), "local-oauth-access-"));
  try {
    const store = new CredentialStore(directory);
    store.save("project", {
      id: "local-browser",
      type: "link",
      label: "OAuth Link",
      secret: JSON.stringify({ accessToken: "private-access", refreshToken: "private-refresh" }),
      meta: {
        linkProvider: "github",
        linkExecutionRuntime: "local",
        linkAuthSource: "browser-oauth",
      },
    });
    store.save("project", {
      id: "ordinary-mcp",
      type: "token",
      label: "MCP bearer",
      secret: "mcp-bearer",
    });
    for (const purpose of ["link", "use", "mcp"] as const)
      await expect(
        localCredentialAccess.resolveValue!({
          cwd: directory,
          id: "local-browser",
          scope: "project",
          purpose,
        }),
      ).rejects.toThrow("Host-owned actions");
    expect(
      await localCredentialAccess.resolveValue!({
        cwd: directory,
        id: "ordinary-mcp",
        scope: "project",
        purpose: "mcp",
      }),
    ).toBe("mcp-bearer");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
