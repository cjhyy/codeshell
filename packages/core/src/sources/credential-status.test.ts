import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDefaultCredentialAccess, type CredentialAccess } from "../credentials/access.js";
import { CredentialStore } from "../credentials/store.js";
import { defaultCredentialStatus } from "./credential-status.js";

describe("defaultCredentialStatus", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "codeshell-source-credential-status-"));
    process.env.HOME = home;
    setDefaultCredentialAccess(null);
  });

  afterEach(() => {
    setDefaultCredentialAccess(null);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("returns missing when the credential does not exist", () => {
    expect(defaultCredentialStatus("missing-credential")).toBe("missing");
  });

  test("returns expired for an expired oauth credential without a refresh token", () => {
    new CredentialStore().save("user", {
      id: "expired-oauth",
      type: "oauth",
      label: "Expired OAuth",
      secret: JSON.stringify({
        accessToken: "expired-access",
        expiresAt: "2000-01-01T00:00:00.000Z",
      }),
    });

    expect(defaultCredentialStatus("expired-oauth")).toBe("expired");
  });

  test("returns ok for other credentials, including refreshable expired oauth", () => {
    const store = new CredentialStore();
    store.save("user", {
      id: "token",
      type: "token",
      label: "Token",
      secret: "token-value",
    });
    store.save("user", {
      id: "refreshable-oauth",
      type: "oauth",
      label: "Refreshable OAuth",
      secret: JSON.stringify({
        accessToken: "expired-access",
        refreshToken: "refresh-token",
        expiresAt: "2000-01-01T00:00:00.000Z",
      }),
    });

    expect(defaultCredentialStatus("token")).toBe("ok");
    expect(defaultCredentialStatus("refreshable-oauth")).toBe("ok");
  });

  test("uses metadata only and never resolves or refreshes secret material", () => {
    const calls: string[] = [];
    const access: CredentialAccess = {
      listMasked() {
        throw new Error("listMasked should not be used");
      },
      resolveMeta(cwd, id, scope) {
        calls.push(`meta:${String(cwd)}:${id}:${scope}`);
        return {
          id,
          type: "oauth",
          label: "Refreshable OAuth",
          hasSecret: true,
          oauthStatus: { state: "expired", hasRefreshToken: true },
        };
      },
      envExposures() {
        throw new Error("envExposures should not be used");
      },
      async resolveValue() {
        calls.push("value");
        return "secret";
      },
      async resolveOAuthAccess() {
        calls.push("oauth-access");
        return { accessToken: "secret" };
      },
    };
    setDefaultCredentialAccess(access);

    expect(defaultCredentialStatus("refreshable-oauth")).toBe("ok");
    expect(calls).toEqual(["meta:undefined:refreshable-oauth:full"]);
  });
});
