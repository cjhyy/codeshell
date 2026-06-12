import { describe, test, expect } from "bun:test";
import { humanizeError } from "./mcp-probe-service.js";

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
      expect(msg).toContain("Bearer Token 环境变量");
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
});

describe("cold-start timeout hint (npx/uvx 首次下载)", () => {
  test("timeout + npx command → 提示首次下载稍后重试", () => {
    const msg = humanizeError("connect timed out after 8000ms", "npx -y chrome-devtools-mcp@latest");
    expect(msg).toContain("首次运行需下载包");
  });

  test("timeout without a runner command → 普通超时文案", () => {
    expect(humanizeError("connect timed out after 8000ms", "node server.js")).toBe("连接超时");
    expect(humanizeError("connect timed out after 8000ms")).toBe("连接超时");
  });
});
