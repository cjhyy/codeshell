import { describe, expect, test } from "bun:test";
import { createInProcessTransport } from "../protocol/transport.js";
import type { RpcRequest } from "../protocol/types.js";
import {
  createIpcCredentialAccess,
  type CredentialMetadata,
  type CredentialSnapshot,
  type RemoteLinkActionReply,
} from "./access.js";
import { RemoteLinkError } from "../links/remote.js";
import { McpLinkActionError } from "../links/figma-mcp.js";
import { FIGMA_MCP_SERVER_URL } from "@cjhyy/code-shell-link";

describe("createIpcCredentialAccess", () => {
  test("MCP recovery codes are reviewed and bound to the dedicated Host method", async () => {
    for (const kind of ["mcp", "resolve"] as const) {
      for (const code of ["reconnect", "response_too_large", "unreviewed"] as const) {
        const [main, worker] = createInProcessTransport();
        const access = createIpcCredentialAccess(worker);
        main.onMessage((message) => {
          if (!("id" in message) || !("method" in message)) return;
          main.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: "untrusted provider text",
              data: { mcpLinkCode: code },
            },
          });
        });
        let error: unknown;
        try {
          await (kind === "mcp"
            ? access.executeMcpLinkAction!({
                id: "figma",
                scope: "full",
                accountId: "1",
                verifiedAt: "2026-10-15",
                action: "get_metadata",
                params: { file_key: "File" },
              })
            : access.resolveValue!({ id: "figma", scope: "full", purpose: "use" }));
        } catch (cause) {
          error = cause;
        }
        if (kind === "mcp" && code !== "unreviewed") {
          expect(error).toBeInstanceOf(McpLinkActionError);
          expect((error as Error).message).toBe(new McpLinkActionError(code).message);
        } else expect(error).not.toBeInstanceOf(McpLinkActionError);
      }
    }
  });
  test("reviewed remote Link recovery codes survive IPC only for the bound remote action method", async () => {
    const reviewedCodes = [
      "invalid_request",
      "unavailable",
      "reconnect",
      "changed",
      "forbidden",
      "file_not_authorized",
      "unsupported_file_type",
      "response_too_large",
      "content_unavailable",
      "busy",
    ] as const;
    for (const method of ["remote", "resolve"] as const) {
      for (const code of [
        ...reviewedCodes,
        "unreviewed_code",
        "reconnect ",
        null,
        42,
        { code: "reconnect" },
        ["busy"],
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
        let error: unknown;
        try {
          await (method === "remote"
            ? access.executeRemoteLinkAction!({
                id: "figma",
                scope: "full",
                grantId: "grant",
                action: "get_file",
                params: { file_url_or_key: "File" },
              })
            : access.resolveValue!({ id: "figma", scope: "full", purpose: "use" }));
        } catch (cause) {
          error = cause;
        }
        if (method === "remote" && reviewedCodes.includes(code as (typeof reviewedCodes)[number])) {
          expect(error).toBeInstanceOf(RemoteLinkError);
          expect((error as RemoteLinkError).code).toBe(code);
          expect((error as Error).message).toBe(
            new RemoteLinkError(code as (typeof reviewedCodes)[number]).message,
          );
          expect((error as Error).message).not.toContain("Provider-supplied");
        } else {
          expect(error).not.toBeInstanceOf(RemoteLinkError);
          expect((error as Error).message).toContain("Provider-supplied");
        }
        main.close();
        worker.close();
      }
    }
  });

  test("a newer grant and its later removal cannot be overwritten by delayed or duplicate snapshots", () => {
    const [main, worker] = createInProcessTransport();
    const access = createIpcCredentialAccess(worker);
    let notifications = 0;
    access.subscribe!(() => {
      notifications++;
    });
    const credential = (grantId: string): CredentialMetadata => ({
      id: "figma-remote",
      type: "oauth",
      label: "Selected designer",
      hasSecret: true,
      meta: {
        linkProvider: "figma",
        linkExecutionRuntime: "server",
        linkExecutionBackend: "remote",
        linkRemoteGrantId: grantId,
        linkRemoteState: "connected",
        linkAccountId: "selected-account",
      },
    });
    const publish = (revision: number, credentials: CredentialMetadata[], readable = true) => {
      const snapshot: CredentialSnapshot = {
        revision,
        entries: [
          {
            cwd: "/repo",
            full: credentials,
            project: credentials,
            readableFull: readable,
            readableProject: readable,
            envFull: { CURRENT_SNAPSHOT: String(revision) },
            envProject: { CURRENT_SNAPSHOT: String(revision) },
          },
        ],
      };
      main.send({ jsonrpc: "2.0", method: "desktop/credentialSnapshot", params: { ...snapshot } });
    };
    publish(1, [credential("original-grant")]);
    publish(3, [credential("newly-authorized-grant")]);
    publish(2, [credential("original-grant")], false);
    publish(3, [credential("original-grant")], false);
    for (const scope of ["full", "project"] as const) {
      expect(access.resolveMeta("/repo", "figma-remote", scope)?.meta?.linkRemoteGrantId).toBe(
        "newly-authorized-grant",
      );
      expect(access.listMaskedWithStatus!("/repo", scope)).toEqual({
        credentials: [credential("newly-authorized-grant")],
        readable: true,
      });
      expect(access.envExposures("/repo", scope)).toEqual({ CURRENT_SNAPSHOT: "3" });
    }
    expect(notifications).toBe(2);

    publish(4, []);
    publish(3, [credential("newly-authorized-grant")]);
    publish(4, [credential("original-grant")]);
    expect(access.listMasked("/repo", "full")).toEqual([]);
    expect(access.resolveMeta("/repo", "figma-remote", "project")).toBeUndefined();
    expect(access.envExposures("/repo", "full")).toEqual({ CURRENT_SNAPSHOT: "4" });
    expect(notifications).toBe(3);
    main.close();
    worker.close();
  });

  test("invalid snapshot revisions cannot replace metadata or poison subsequent valid revisions", () => {
    const [main, worker] = createInProcessTransport();
    const access = createIpcCredentialAccess(worker);
    let notifications = 0;
    access.subscribe!(() => {
      notifications++;
    });
    for (const revision of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      main.send({
        jsonrpc: "2.0",
        method: "desktop/credentialSnapshot",
        params: {
          revision,
          entries: [{ cwd: "/invalid", full: [], project: [], envFull: {}, envProject: {} }],
        },
      });
    }
    expect(notifications).toBe(0);
    main.send({
      jsonrpc: "2.0",
      method: "desktop/credentialSnapshot",
      params: {
        revision: 1,
        entries: [
          {
            cwd: "/valid",
            full: [],
            project: [],
            readableFull: true,
            readableProject: true,
            envFull: { VALID: "current" },
            envProject: {},
          },
        ],
      },
    });
    expect(access.envExposures("/invalid", "full")).toEqual({});
    expect(access.envExposures("/valid", "full")).toEqual({ VALID: "current" });
    expect(access.listMaskedWithStatus!("/valid", "full").readable).toBe(true);
    expect(notifications).toBe(1);
    main.close();
    worker.close();
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
        expect(msg.params).toEqual({
          id: "oauth",
          scope: "full",
          serverUrl: "https://mcp.example/mcp",
          forceRefresh: true,
        });
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
      access.resolveOAuthAccess?.({
        id: "oauth",
        scope: "full",
        serverUrl: "https://mcp.example/mcp",
        forceRefresh: true,
      }),
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

describe("remote Action atomic snapshot replies", () => {
  function fixture() {
    const [main, worker] = createInProcessTransport();
    const access = createIpcCredentialAccess(worker);
    const requests: RpcRequest[] = [];
    const cancellations: unknown[] = [];
    main.onMessage((message) => {
      if (!("method" in message)) return;
      if ("id" in message) requests.push(message);
      else if (message.method === "desktop/localOAuthLinkActionCancel")
        cancellations.push(message.params);
    });
    const snapshot = (
      revision: number,
      grantId = "original-grant",
      state: "connected" | "reconnect" = "connected",
    ): CredentialSnapshot => {
      const credential: CredentialMetadata = {
        id: "selected-remote-link",
        type: "oauth",
        label: "Selected designer",
        hasSecret: true,
        meta: {
          linkProvider: "figma",
          linkExecutionBackend: "remote",
          linkRemoteGrantId: grantId,
          linkRemoteState: state,
          linkAccountId: "selected-account",
        },
      };
      return {
        revision,
        entries: [
          {
            cwd: "/repo",
            full: [credential],
            project: [credential],
            readableFull: true,
            readableProject: true,
            envFull: {},
            envProject: {},
          },
        ],
      };
    };
    const publish = (value: CredentialSnapshot) =>
      main.send({ jsonrpc: "2.0", method: "desktop/credentialSnapshot", params: { ...value } });
    publish(snapshot(1));
    return {
      access,
      requests,
      cancellations,
      snapshot,
      publish,
      meta: () => access.resolveMeta("/repo", "selected-remote-link", "full")?.meta,
      execute: (options: { signal?: AbortSignal; assertAuthorized?: () => void } = {}) =>
        access.executeRemoteLinkAction!(
          {
            cwd: "/repo",
            id: "selected-remote-link",
            scope: "full",
            grantId: "original-grant",
            action: "get_file",
            params: { file_url_or_key: "File" },
          },
          options,
        ),
      reply: (reply: RemoteLinkActionReply) => main.send(reply),
      close: () => {
        main.close();
        worker.close();
      },
    };
  }

  test("snapshot cancellation preserves this reply's reviewed error and cancels other in-flight Actions", async () => {
    const f = fixture();
    const current = new AbortController();
    const other = new AbortController();
    let observedState: string | undefined;
    f.access.subscribe!(() => {
      observedState = f.meta()?.linkRemoteState;
      current.abort();
      other.abort();
    });
    const pending = f.execute({ signal: current.signal }).catch((error) => error);
    const otherPending = f.execute({ signal: other.signal }).catch((error) => error);
    f.reply({
      jsonrpc: "2.0",
      id: f.requests[0]!.id,
      credentialSnapshot: f.snapshot(2, "original-grant", "reconnect"),
      error: {
        code: -32603,
        message: "untrusted provider text",
        data: { remoteLinkCode: "reconnect" },
      },
    });
    expect(observedState).toBe("reconnect");
    expect(current.signal.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(RemoteLinkError);
    expect(await pending).toMatchObject({
      code: "reconnect",
      message: new RemoteLinkError("reconnect").message,
    });
    expect(await otherPending).toMatchObject({ name: "AbortError" });
    expect(f.cancellations).toEqual([{ requestId: f.requests[1]!.id }]);
    f.close();
  });

  test.each(["signal", "authority"] as const)(
    "successful replies still reject protected results after snapshot %s revocation",
    async (kind) => {
      const f = fixture();
      const controller = new AbortController();
      let authorized = true;
      let checks = 0;
      f.access.subscribe!(() => {
        authorized = false;
        if (kind === "signal") controller.abort();
      });
      const pending = f
        .execute({
          signal: controller.signal,
          assertAuthorized: () => {
            checks++;
            if (!authorized) throw new Error("run authority changed");
          },
        })
        .catch((error) => error);
      f.reply({
        jsonrpc: "2.0",
        id: f.requests[0]!.id,
        credentialSnapshot: f.snapshot(2, "new-grant"),
        result: { protected: "must not return" },
      });
      const error = await pending;
      if (kind === "signal") {
        expect(error).toMatchObject({ name: "AbortError" });
        expect(checks).toBe(1);
      } else {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("run authority changed");
        expect(checks).toBe(2);
      }
      expect(f.meta()?.linkRemoteGrantId).toBe("new-grant");
      expect(f.cancellations).toEqual([]);
      f.close();
    },
  );

  test("explicit cancellation before a reply wins and its abandoned snapshot cannot change authority", async () => {
    const f = fixture();
    let notifications = 0;
    f.access.subscribe!(() => notifications++);
    const controller = new AbortController();
    const pending = f.execute({ signal: controller.signal }).catch((error) => error);
    controller.abort();
    f.reply({
      jsonrpc: "2.0",
      id: f.requests[0]!.id,
      credentialSnapshot: f.snapshot(2, "original-grant", "reconnect"),
      error: { code: -32603, message: "reviewed", data: { remoteLinkCode: "reconnect" } },
    });
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(f.meta()?.linkRemoteState).toBe("connected");
    expect(notifications).toBe(0);
    expect(f.cancellations).toEqual([{ requestId: f.requests[0]!.id }]);
    f.close();
  });

  test("only a matching pending remote Action response may install its snapshot", async () => {
    const f = fixture();
    let notifications = 0;
    f.access.subscribe!(() => notifications++);
    const remote = f.execute();
    f.reply({
      jsonrpc: "2.0",
      id: f.requests[0]!.id,
      credentialSnapshot: f.snapshot(2, "new-grant"),
      result: { file: "reviewed" },
    });
    expect(await remote).toEqual({ file: "reviewed" });
    const rejectedSnapshot = f.snapshot(999, "original-grant", "reconnect");
    for (const id of [f.requests[0]!.id, "unknown-request"])
      f.reply({ jsonrpc: "2.0", id, credentialSnapshot: rejectedSnapshot, result: {} });
    const ordinary = f.access.resolveValue!({
      id: "ordinary-token",
      scope: "full",
      purpose: "use",
    });
    f.reply({
      jsonrpc: "2.0",
      id: f.requests[1]!.id,
      credentialSnapshot: rejectedSnapshot,
      result: { value: "synthetic-token" },
    });
    expect(await ordinary).toBe("synthetic-token");
    expect(f.meta()?.linkRemoteGrantId).toBe("new-grant");
    expect(f.meta()?.linkRemoteState).toBe("connected");
    expect(notifications).toBe(1);
    f.close();
  });

  test("an old or duplicate reply snapshot cannot restore the grant replaced by a newer notification", async () => {
    const f = fixture();
    f.publish(f.snapshot(3, "new-grant"));
    let notifications = 0;
    f.access.subscribe!(() => notifications++);
    for (const revision of [2, 3]) {
      const pending = f.execute().catch((error) => error);
      f.reply({
        jsonrpc: "2.0",
        id: f.requests.at(-1)!.id,
        credentialSnapshot: f.snapshot(revision, "original-grant", "reconnect"),
        error: { code: -32603, message: "reviewed", data: { remoteLinkCode: "changed" } },
      });
      expect(await pending).toMatchObject({ code: "changed" });
      expect(await pending).toBeInstanceOf(RemoteLinkError);
      expect(f.meta()?.linkRemoteGrantId).toBe("new-grant");
      expect(f.meta()?.linkRemoteState).toBe("connected");
    }
    expect(notifications).toBe(0);
    f.close();
  });
});

test.each(["local", "mcp"] as const)(
  "%s OAuth worker seam propagates cancellation to Host",
  async (kind) => {
    const [main, worker] = createInProcessTransport();
    const access = createIpcCredentialAccess(worker);
    const seen: Array<{ method: string; params: unknown }> = [];
    main.onMessage((message) => {
      if (!("method" in message)) return;
      seen.push({ method: message.method, params: message.params });
    });
    const controller = new AbortController();
    const pending = (
      kind === "mcp" ? access.executeMcpLinkAction! : access.executeLocalOAuthLinkAction!
    )(
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
      kind === "mcp" ? "desktop/mcpLinkAction" : "desktop/localOAuthLinkAction",
      "desktop/localOAuthLinkActionCancel",
    ]);
    expect(seen[1]!.params).toEqual({ requestId: "cred-1" });
    expect(JSON.stringify(seen)).not.toContain("refreshToken");
  },
);

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
      id: "figma-mcp",
      type: "oauth",
      label: "Figma MCP",
      secret: JSON.stringify({ accessToken: "private-access", refreshToken: "private-refresh" }),
      meta: {
        linkProvider: "figma",
        linkExecutionRuntime: "local",
        linkExecutionBackend: "mcp",
        linkAuthSource: "mcp-oauth",
        mcpServerUrl: FIGMA_MCP_SERVER_URL,
      },
    });
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
    for (const id of ["local-browser", "figma-mcp"])
      for (const purpose of ["link", "use", "mcp"] as const)
        await expect(
          localCredentialAccess.resolveValue!({
            cwd: directory,
            id,
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
