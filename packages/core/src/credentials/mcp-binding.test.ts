import { expect, test } from "bun:test";
import { assertMcpOAuthCredentialBinding, normalizeMcpServerUrl } from "./mcp-binding.js";

const credential = {
  id: "oauth",
  type: "oauth" as const,
  meta: {
    mcpServerUrl: "https://mcp.example/mcp",
    resource: "https://mcp.example/",
    issuer: "https://auth.example/",
  },
};
const secret = {
  accessToken: "synthetic",
  resource: credential.meta.resource,
  issuer: credential.meta.issuer,
};

test("MCP OAuth authority binds an exact endpoint and a covering resource", () => {
  expect(
    assertMcpOAuthCredentialBinding(credential, "https://mcp.example:443/mcp", secret),
  ).toEqual({
    serverUrl: "https://mcp.example/mcp",
    resource: "https://mcp.example/",
    issuer: "https://auth.example/",
  });
  expect(normalizeMcpServerUrl("http://127.0.0.1:1234/mcp")).toBe("http://127.0.0.1:1234/mcp");
});

test("MCP binding rejects wrong endpoints, resources and secret authority without exposing tokens", () => {
  for (const value of [
    "http://public.example/mcp",
    "https://user:password@mcp.example/mcp",
    "https://mcp.example/mcp#fragment",
    "data:text/plain,no",
  ]) {
    expect(() => normalizeMcpServerUrl(value)).toThrow();
  }
  expect(() =>
    assertMcpOAuthCredentialBinding(credential, "https://other.example/mcp", secret),
  ).toThrow();
  for (const resource of [
    "https://other.example/",
    "https://mcp.example/another",
    "https://mcp.example/mc",
  ]) {
    expect(() =>
      assertMcpOAuthCredentialBinding(
        { ...credential, meta: { ...credential.meta, resource } },
        credential.meta.mcpServerUrl,
        { ...secret, resource },
      ),
    ).toThrow();
  }
  expect(() =>
    assertMcpOAuthCredentialBinding(credential, credential.meta.mcpServerUrl, {
      ...secret,
      issuer: "https://untrusted.example/",
    }),
  ).toThrow();
  expect(() =>
    assertMcpOAuthCredentialBinding(
      { ...credential, meta: {} },
      credential.meta.mcpServerUrl,
      secret,
    ),
  ).toThrow();
});
