import { describe, expect, test } from "bun:test";
import {
  buildMcpToolPolicies,
  isMcpToolNameAllowed,
  isRegisteredMcpToolAllowed,
} from "./mcp-tool-policy.js";

describe("MCP per-tool policy", () => {
  test("undefined policy allows every tool", () => {
    expect(isMcpToolNameAllowed(undefined, "srv", "read")).toBe(true);
  });

  test("allowlist restricts and denylist wins", () => {
    const policies = buildMcpToolPolicies({
      srv: {
        name: "srv",
        command: "mcp",
        allowedTools: ["read", "write"],
        disabledTools: ["write"],
      },
    });
    expect(isMcpToolNameAllowed(policies, "srv", "read")).toBe(true);
    expect(isMcpToolNameAllowed(policies, "srv", "write")).toBe(false);
    expect(isMcpToolNameAllowed(policies, "srv", "delete")).toBe(false);
  });

  test("empty allowlist exposes no tools and disabled servers create no policy", () => {
    const policies = buildMcpToolPolicies({
      none: { name: "none", command: "mcp", allowedTools: [] },
      off: { name: "off", command: "mcp", enabled: false, allowedTools: ["read"] },
    });
    expect(isMcpToolNameAllowed(policies, "none", "read")).toBe(false);
    expect(policies.has("off")).toBe(false);
  });

  test("restricted registered tools fail closed without their original MCP name", () => {
    const policies = buildMcpToolPolicies({
      srv: { name: "srv", command: "mcp", allowedTools: ["read"] },
    });
    expect(
      isRegisteredMcpToolAllowed(
        { source: "mcp", serverName: "srv", mcpToolName: "read" },
        policies,
      ),
    ).toBe(true);
    expect(isRegisteredMcpToolAllowed({ source: "mcp", serverName: "srv" }, policies)).toBe(false);
  });
});
