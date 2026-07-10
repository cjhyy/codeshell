import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlaintextCipher,
  setDefaultCredentialCipher,
  type EncryptionCipher,
} from "@cjhyy/code-shell-core";
import { buildProbeHttpHeaders, humanizeError } from "./mcp-probe-service.js";

class UnavailableSafeCipher implements EncryptionCipher {
  encrypt(plaintext: string): string {
    return `enc:safeStorage:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }
  decrypt(_stored: string): string {
    throw new Error("safeStorage unavailable");
  }
  canDecrypt(stored: string): boolean {
    return !stored.startsWith("enc:");
  }
}

/**
 * Auth-error classification (feedback: MCP 鉴权失败报错不友好)。Three
 * distinct situations must produce three distinct, actionable messages:
 * a referenced env var that is missing, credentials rejected (401), and
 * credentials accepted but lacking permission (403).
 */
describe("humanizeError auth classification", () => {
  test("missing env var names the variable and the config field", () => {
    const raw = 'MCP server "synta-mcp": env var "N8N_API_KEY" (from bearerTokenEnvVar) is not set';
    const msg = humanizeError(raw);
    expect(msg).toContain("N8N_API_KEY");
    expect(msg).toContain("bearerTokenEnvVar");
    expect(msg).toContain("环境变量");
  });

  test("401 / Unauthorized / -32001 → guidance to configure auth", () => {
    for (const raw of [
      "Error POSTing to endpoint (HTTP 401): Unauthorized",
      'Streamable HTTP error: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":0}',
    ]) {
      const msg = humanizeError(raw);
      expect(msg).toContain("401");
      expect(msg).toContain("Bearer");
      expect(msg).toContain("自定义认证 Header");
    }
  });

  test("403 / Forbidden → permission message, distinct from 401", () => {
    const msg = humanizeError("Error POSTing to endpoint (HTTP 403): Forbidden");
    expect(msg).toContain("403");
    expect(msg).toContain("权限");
    expect(msg).not.toContain("401");
  });

  test("non-auth errors keep their existing classification", () => {
    expect(humanizeError("spawn npx ENOENT")).toContain("找不到命令");
    expect(humanizeError("connect ECONNREFUSED 127.0.0.1:3000")).toContain("拒绝连接");
    expect(humanizeError("getaddrinfo ENOTFOUND example.com")).toContain("域名解析失败");
  });

  test("plain-number false positives don't trigger auth branches", () => {
    // "401" only matches as a standalone token, not inside e.g. a port/id.
    const msg = humanizeError("server exited with code 14013");
    expect(msg).toBe("server exited with code 14013");
  });

  test("expired OAuth credential points at refresh/login actions", () => {
    const msg = humanizeError(
      'MCP server "figma": oauth credential "figma-oauth" access token expired; refresh data is present, but automatic OAuth refresh is reserved and not wired yet',
    );
    expect(msg).toContain("OAuth");
    expect(msg).toContain("刷新");
    expect(msg).toContain("重新登录");
  });
});

describe("cold-start timeout hint (npx/uvx 首次下载)", () => {
  test("timeout + npx command → 提示首次下载稍后重试", () => {
    const msg = humanizeError(
      "connect timed out after 8000ms",
      "npx -y chrome-devtools-mcp@latest",
    );
    expect(msg).toContain("首次运行需下载包");
  });

  test("timeout without a runner command → 普通超时文案", () => {
    expect(humanizeError("connect timed out after 8000ms", "node server.js")).toBe("连接超时");
    expect(humanizeError("connect timed out after 8000ms")).toBe("连接超时");
  });
});

describe("buildProbeHttpHeaders credentialRef availability", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-mcp-probe-home-"));
    process.env.HOME = home;
    setDefaultCredentialCipher(new UnavailableSafeCipher());
  });

  afterEach(() => {
    setDefaultCredentialCipher(new PlaintextCipher());
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("unreadable safeStorage ciphertext is not used as Authorization", () => {
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [
          {
            id: "figma",
            type: "token",
            label: "Figma",
            secret: "enc:safeStorage:dG9rLTEyMw==",
          },
        ],
      }),
    );

    expect(() =>
      buildProbeHttpHeaders({
        name: "figma",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        credentialRef: "figma",
      }),
    ).toThrow(/not found or empty/);
    try {
      buildProbeHttpHeaders({
        name: "figma",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        credentialRef: "figma",
      });
    } catch (err) {
      expect(String(err)).not.toContain("enc:safeStorage");
    }
  });

  test("oauth credentialRef uses the stored access token", () => {
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [
          {
            id: "figma-oauth",
            type: "oauth",
            label: "Figma OAuth",
            secret: JSON.stringify({
              accessToken: "oauth-access",
              refreshToken: "oauth-refresh",
              expiresAt: "2030-01-01T00:00:00.000Z",
            }),
          },
        ],
      }),
    );

    const headers = buildProbeHttpHeaders({
      name: "figma",
      transport: "streamable-http",
      url: "https://example.com/mcp",
      credentialRef: "figma-oauth",
    });

    expect(headers.Authorization).toBe("Bearer oauth-access");
  });

  test("link credentialRef remains available to the main-process probe", () => {
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [
          {
            id: "saved-link",
            type: "link",
            label: "Saved link",
            secret: "bearer-from-link",
          },
        ],
      }),
    );

    const headers = buildProbeHttpHeaders({
      name: "link-mcp",
      transport: "streamable-http",
      url: "https://example.com/mcp",
      credentialRef: "saved-link",
    });

    expect(headers.Authorization).toBe("Bearer bearer-from-link");
  });
});
