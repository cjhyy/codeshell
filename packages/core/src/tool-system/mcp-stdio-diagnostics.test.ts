import { describe, expect, test } from "bun:test";
import {
  classifyMcpStdioMissingCommand,
  isBareCommand,
  isMissingCommandError,
} from "./mcp-stdio-diagnostics.js";

describe("MCP stdio missing-command diagnostics", () => {
  test("classifies installed-but-not-on-PATH commands", () => {
    const message = classifyMcpStdioMissingCommand("node", ["/opt/homebrew/bin/node"]);

    expect(message).toContain("detected node at /opt/homebrew/bin/node");
    expect(message).toContain("not available on PATH");
    expect(message).toContain("PATH injection may have failed");
  });

  test("classifies missing node as not installed", () => {
    const message = classifyMcpStdioMissingCommand("node", []);

    expect(message).toContain("node was not found on PATH or in common install locations");
    expect(message).toContain("Please install Node.js");
  });

  test("only bare command ENOENT-style errors are eligible for diagnostics", () => {
    expect(isBareCommand("node")).toBe(true);
    expect(isBareCommand("/opt/homebrew/bin/node")).toBe(false);
    expect(
      isMissingCommandError(Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" })),
    ).toBe(true);
    expect(isMissingCommandError(new Error("permission denied"))).toBe(false);
  });
});
