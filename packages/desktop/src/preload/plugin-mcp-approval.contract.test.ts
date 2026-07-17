import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeshellApi } from "./types";

type ApprovalMethods = Pick<
  CodeshellApi,
  "listPluginMcpTrust" | "approvePluginMcp" | "revokePluginMcp"
>;

describe("plugin MCP approval preload contract", () => {
  test("exposes list/approve/revoke through matching IPC channels", () => {
    const methods: Array<keyof ApprovalMethods> = [
      "listPluginMcpTrust",
      "approvePluginMcp",
      "revokePluginMcp",
    ];
    expect(methods).toHaveLength(3);

    const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const main = readFileSync(join(import.meta.dir, "..", "main", "index.ts"), "utf-8");
    for (const channel of ["mcp:listPluginTrust", "mcp:approvePlugin", "mcp:revokePlugin"]) {
      expect(preload).toContain(`ipcRenderer.invoke("${channel}"`);
      expect(main).toContain(`ipcMain.handle("${channel}"`);
    }
  });
});
