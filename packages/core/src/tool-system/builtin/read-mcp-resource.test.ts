// Direct handler coverage for ReadMcpResource.
//
// Reported by the builtin coverage gate as having no direct test. The handler is
// small but it is the boundary where an MCP server's output becomes model
// context, so what matters is: a string passes through untouched, structured
// content is rendered readably, and a failure surfaces as a message instead of
// throwing out of the tool call.
import { afterEach, describe, expect, test } from "bun:test";
import { readMcpResourceTool } from "./mcp-tools.js";
import { MCPManager } from "../mcp-manager.js";
import { ToolRegistry } from "../registry.js";

// The constructor installs itself as the process singleton, which is what
// getInstance() (and therefore the tool) resolves.
const manager = new MCPManager(new ToolRegistry()) as unknown as {
  readResource: (server: string, uri: string, signal?: AbortSignal) => Promise<unknown>;
};
const original = manager.readResource;

afterEach(() => {
  manager.readResource = original;
});

describe("ReadMcpResource tool", () => {
  test("returns string content verbatim", async () => {
    manager.readResource = async () => "plain text body";
    expect(await readMcpResourceTool({ server: "docs", uri: "file://a" })).toBe("plain text body");
  });

  test("renders structured content as indented JSON", async () => {
    manager.readResource = async () => ({ title: "spec", sections: 2 });
    const out = await readMcpResourceTool({ server: "docs", uri: "file://b" });
    expect(JSON.parse(out)).toEqual({ title: "spec", sections: 2 });
    // Indented, not a single dense line — this lands in the model's context.
    expect(out).toContain("\n");
  });

  test("an unavailable server is reported, not thrown", async () => {
    manager.readResource = async () => {
      throw new Error('MCP server "gone" is not connected.');
    };
    const out = await readMcpResourceTool({ server: "gone", uri: "file://c" });
    expect(out).toBe('Error reading MCP resource: MCP server "gone" is not connected.');
  });

  test("a missing resource is reported, not thrown", async () => {
    manager.readResource = async () => {
      throw new Error("resource not found");
    };
    expect(await readMcpResourceTool({ server: "docs", uri: "file://missing" })).toBe(
      "Error reading MCP resource: resource not found",
    );
  });

  test("the server and uri are passed through unchanged", async () => {
    let seen: { server?: string; uri?: string } = {};
    manager.readResource = async (server, uri) => {
      seen = { server, uri };
      return "ok";
    };
    await readMcpResourceTool({ server: "notes", uri: "note://42" });
    expect(seen).toEqual({ server: "notes", uri: "note://42" });
  });

  test("an abort signal is forwarded so Stop cancels a hung read", async () => {
    let received: AbortSignal | undefined;
    manager.readResource = async (_server, _uri, signal) => {
      received = signal;
      return "ok";
    };
    const controller = new AbortController();
    await readMcpResourceTool({
      server: "docs",
      uri: "file://d",
      __signal: controller.signal,
    });
    expect(received).toBe(controller.signal);
  });
});
