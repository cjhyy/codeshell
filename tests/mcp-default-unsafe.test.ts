/**
 * B1.x — MCP discovered tool readOnlyHint policy.
 *
 * Verifies that buildRegisteredTool() maps the MCP spec's
 * annotations.readOnlyHint correctly:
 *   - readOnlyHint === true  → isConcurrencySafe=true, isReadOnly=true
 *   - anything else          → isConcurrencySafe=false, isReadOnly=false (safe default)
 *
 * Uses the exported @internal helper so we don't need to spin up a real
 * MCP transport.
 */

import { describe, it, expect } from "bun:test";
import { buildRegisteredTool } from "../packages/core/src/tool-system/mcp-manager.ts";

const SERVER_NAME = "test-server";

describe("buildRegisteredTool — readOnlyHint policy", () => {
  it("sets isConcurrencySafe=true and isReadOnly=true when readOnlyHint is true", () => {
    const tool = {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" as const, properties: {} },
      annotations: { readOnlyHint: true },
    };

    const registered = buildRegisteredTool(SERVER_NAME, tool);

    expect(registered.isConcurrencySafe).toBe(true);
    expect(registered.isReadOnly).toBe(true);
  });

  it("defaults isConcurrencySafe=false and isReadOnly=false when annotations are absent", () => {
    const tool = {
      name: "write_file",
      description: "Write a file",
      inputSchema: { type: "object" as const, properties: {} },
    };

    const registered = buildRegisteredTool(SERVER_NAME, tool);

    expect(registered.isConcurrencySafe).toBe(false);
    expect(registered.isReadOnly).toBe(false);
  });

  it("defaults false when readOnlyHint is explicitly false", () => {
    const tool = {
      name: "delete_file",
      description: "Delete a file",
      inputSchema: { type: "object" as const, properties: {} },
      annotations: { readOnlyHint: false },
    };

    const registered = buildRegisteredTool(SERVER_NAME, tool);

    expect(registered.isConcurrencySafe).toBe(false);
    expect(registered.isReadOnly).toBe(false);
  });

  it("defaults false when readOnlyHint is undefined in annotations object", () => {
    const tool = {
      name: "list_files",
      description: "List files",
      inputSchema: { type: "object" as const, properties: {} },
      annotations: {},
    };

    const registered = buildRegisteredTool(SERVER_NAME, tool);

    expect(registered.isConcurrencySafe).toBe(false);
    expect(registered.isReadOnly).toBe(false);
  });

  it("always sets permissionDefault=ask, source=mcp, and name with server prefix", () => {
    const readOnlyTool = {
      name: "query_db",
      description: "Query the database",
      inputSchema: { type: "object" as const, properties: {} },
      annotations: { readOnlyHint: true },
    };
    const mutableTool = {
      name: "update_db",
      description: "Update the database",
      inputSchema: { type: "object" as const, properties: {} },
    };

    const ro = buildRegisteredTool(SERVER_NAME, readOnlyTool);
    const mut = buildRegisteredTool(SERVER_NAME, mutableTool);

    // Common invariants hold for both read-only and mutable tools
    for (const registered of [ro, mut]) {
      expect(registered.permissionDefault).toBe("ask");
      expect(registered.source).toBe("mcp");
    }

    expect(ro.name).toBe(`mcp_${SERVER_NAME}_query_db`);
    expect(mut.name).toBe(`mcp_${SERVER_NAME}_update_db`);
  });
});
