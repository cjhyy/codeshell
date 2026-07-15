import { describe, expect, test } from "bun:test";
import type { SourceDefinition } from "../types.js";
import { createMcpResourceAdapter } from "./mcp-resource.js";

const definition: SourceDefinition = {
  id: "gh",
  kind: "mcp-resource",
  label: "GH",
  adapterConfig: { server: "github" },
  enabled: true,
};

describe("mcp-resource adapter", () => {
  test("exposes one resources scope and maps MCP resource metadata", async () => {
    const adapter = createMcpResourceAdapter(() => ({
      async listResources(server) {
        expect(server).toBe("github");
        return [
          {
            serverName: "github",
            uri: "issue://1",
            name: "issue-1",
            description: "First issue",
          },
          { serverName: "github", uri: "issue://2", name: "issue-2" },
        ];
      },
      async readResource() {
        return "unused";
      },
    }));

    expect(await adapter.listScopes(definition)).toEqual([{ id: "resources", label: "Resources" }]);
    expect(await adapter.listResources(definition, "resources")).toEqual([
      { id: "issue://1", scopeId: "resources", name: "issue-1" },
      { id: "issue://2", scopeId: "resources", name: "issue-2" },
    ]);
    expect(await adapter.listResources(definition, "other")).toEqual([]);
  });

  test("forwards AbortSignal and truncates content by UTF-8 bytes", async () => {
    const controller = new AbortController();
    const adapter = createMcpResourceAdapter(async () => ({
      async listResources() {
        return [];
      },
      async readResource(server, uri, signal) {
        expect(server).toBe("github");
        expect(uri).toBe("issue://1");
        expect(signal).toBe(controller.signal);
        return "A中文";
      },
    }));

    expect(
      await adapter.read(definition, "issue://1", {
        maxBytes: 5,
        signal: controller.signal,
      }),
    ).toEqual({ resourceId: "issue://1", text: "A中", truncated: true });
  });

  test("rejects missing or blank adapterConfig.server", async () => {
    const adapter = createMcpResourceAdapter(() => ({
      async listResources() {
        return [];
      },
      async readResource() {
        return "unused";
      },
    }));

    for (const server of [undefined, "", "   "]) {
      const invalid = {
        ...definition,
        adapterConfig: server === undefined ? {} : { server },
      };
      await expect(adapter.listResources(invalid, "resources")).rejects.toThrow(/server/);
      await expect(adapter.read(invalid, "issue://1", { maxBytes: 10 })).rejects.toThrow(/server/);
    }
  });
});
