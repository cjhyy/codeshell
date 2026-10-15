import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EncryptionCipher } from "@cjhyy/code-shell-core";
import { installFixtureNetworkGuard } from "../../../../tests/helpers/network-fixture.js";
const origin = "http://127.0.0.1:34724";
let status = 200;
const authorizations: string[] = [];
const network = installFixtureNetworkGuard((async (input: any, init?: RequestInit) => {
  const request = new Request(input, init);
  expect(request.redirect).toBe("error");
  if (request.method !== "POST") return new Response(null, { status: 405 });
  authorizations.push(request.headers.get("authorization") ?? "");
  if (status !== 200) return new Response("upstream-private-secret", { status });
  const body = await request.json();
  if (body.id === undefined) return new Response(null, { status: 202 });
  return Response.json({
    jsonrpc: "2.0",
    id: body.id,
    result:
      body.method === "initialize"
        ? {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : { tools: [{ name: "run_query", inputSchema: { type: "object", properties: {} } }] },
  });
}) as typeof fetch);
network.allowOrigin(origin);
afterAll(() => network.restore());
const { CredentialStore, PlaintextCipher, setDefaultCredentialCipher } =
  await import("@cjhyy/code-shell-core");
const { probeMcpServer, invalidateMcpProbeCache } = await import("./mcp-probe-service.js");
const { probeHubMcp } = await import("../../../server/src/hub/mcp-probe.js");
let directory: string, oldHome: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "desktop-probe-production-"));
  oldHome = process.env.HOME;
  process.env.HOME = join(directory, "home");
  mkdirSync(process.env.HOME);
  setDefaultCredentialCipher(new PlaintextCipher());
  status = 200;
  authorizations.length = 0;
});
afterEach(() => {
  invalidateMcpProbeCache();
  setDefaultCredentialCipher(null);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(directory, { recursive: true, force: true });
});
const config = () => ({
  name: "fixture",
  url: `${origin}/mcp`,
  headers: { Authorization: "Bearer fixture-secret" },
});
test.each([401, 403])(
  "real HTTP probe retains Desktop auth guidance and bounded detail (%s)",
  async (code) => {
    status = code;
    const result = await probeMcpServer(config(), { cwd: directory });
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain(String(code));
    expect(result.errorMessage).toContain(code === 401 ? "自定义认证 Header" : "权限");
    expect(result.errorDetail).toContain(code === 401 ? "unauthorized" : "forbidden");
    expect(result.errorDetail).not.toBe(result.errorMessage);
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|upstream-private-secret/);
  },
);
test.each(["bearerTokenEnvVar", "envHeaders"] as const)(
  "missing env uses a validated variable name and field from the real path (%s)",
  async (field) => {
    const name = "CODESHELL_FIXTURE_MISSING_MCP_TOKEN";
    delete process.env[name];
    const result = await probeMcpServer(
      {
        name: "missing-env",
        url: `${origin}/mcp`,
        ...(field === "envHeaders"
          ? { envHeaders: { "X-API-Key": name } }
          : { bearerTokenEnvVar: name }),
      },
      { cwd: directory },
    );
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain(name);
    expect(result.errorMessage).toContain(field);
    expect(authorizations).toEqual([]);
  },
);
test("actual missing stdio command receives local wording while Hub retains server wording", async () => {
  const cfg = { name: "missing-command", command: join(directory, "no-command") };
  const desktop = await probeMcpServer(cfg, { cwd: directory });
  const hub = await probeHubMcp(cfg, { cwd: directory, signal: new AbortController().signal });
  expect(desktop.errorMessage).toContain("找不到命令");
  expect(desktop.errorMessage).not.toContain("服务器");
  expect(hub.error?.message).toContain("服务器上");
  expect(hub.error?.code).toBe("command_missing");
  expect(desktop.errorDetail).toContain("command_missing");
});
test.each(["token", "link"] as const)(
  "credentialRef %s is resolved by the real authenticated HTTP probe",
  async (type) => {
    new CredentialStore().save("user", {
      id: "stored",
      type,
      label: "Fixture",
      secret: "stored-secret",
    });
    const result = await probeMcpServer(
      { name: "stored", url: `${origin}/mcp`, credentialRef: "stored" },
      { cwd: directory },
    );
    expect(result.status).toBe("ok");
    expect(authorizations).toContain("Bearer stored-secret");
  },
);
test("OAuth callback uses the stored account and reports expiry without reflecting secrets", async () => {
  new CredentialStore().save("user", {
    id: "oauth",
    type: "oauth",
    label: "Fixture",
    secret: JSON.stringify({ accessToken: "access-secret", expiresAt: "2030-01-01T00:00:00.000Z" }),
  });
  const cfg = { name: "oauth", url: `${origin}/mcp`, credentialRef: "oauth" };
  const result = await probeMcpServer(cfg, {
    cwd: directory,
    oauthService: { resolveAccessToken: async () => ({ accessToken: "access-secret" }) },
  });
  expect(result.status).toBe("ok");
  expect(authorizations).toContain("Bearer access-secret");
  const expired = await probeMcpServer(cfg, {
    cwd: directory,
    oauthService: {
      resolveAccessToken: async () => {
        throw new Error("oauth credential access token expired access-secret");
      },
    },
  });
  expect(expired.errorMessage).toContain("OAuth");
  expect(expired.errorMessage).toContain("刷新");
  expect(JSON.stringify(expired)).not.toContain("access-secret");
});
class UnavailableSafeCipher implements EncryptionCipher {
  encrypt(value: string) {
    return `enc:safeStorage:${Buffer.from(value).toString("base64")}`;
  }
  decrypt() {
    throw new Error("safeStorage unavailable");
  }
  canDecrypt(value: string) {
    return !value.startsWith("enc:");
  }
}
test("foreign safeStorage ciphertext never reaches an Authorization header or error detail", async () => {
  setDefaultCredentialCipher(new UnavailableSafeCipher());
  new CredentialStore().save("user", {
    id: "foreign",
    type: "token",
    label: "Foreign",
    secret: "secret-value",
  });
  const result = await probeMcpServer(
    { name: "foreign", url: `${origin}/mcp`, credentialRef: "foreign" },
    { cwd: directory },
  );
  expect(result.status).toBe("error");
  expect(authorizations).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/enc:safeStorage|secret-value/);
});
