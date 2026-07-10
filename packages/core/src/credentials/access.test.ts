import { describe, expect, test } from "bun:test";
import { createInProcessTransport } from "../protocol/transport.js";
import { createIpcCredentialAccess, type CredentialSnapshot } from "./access.js";

describe("createIpcCredentialAccess", () => {
  test("uses snapshots for metadata/env and internal requests for secret operations", async () => {
    const [main, worker] = createInProcessTransport();
    const access = createIpcCredentialAccess(worker);
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
    expect(seenMethods).toEqual([
      "desktop/credentialResolve",
      "desktop/credentialMaterializeCookie",
      "desktop/oauthAccessResolve",
    ]);
  });
});
