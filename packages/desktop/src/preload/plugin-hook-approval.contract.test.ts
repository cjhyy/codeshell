import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeshellApi } from "./types";

type ApprovalMethods = Pick<CodeshellApi, "approvePluginHooks" | "revokePluginHooks">;

describe("preload plugin hook approval contract", () => {
  test("wires explicit approve and revoke IPC methods", () => {
    const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const main = readFileSync(join(import.meta.dir, "..", "main", "index.ts"), "utf-8");
    const methods: Array<keyof ApprovalMethods> = ["approvePluginHooks", "revokePluginHooks"];

    for (const method of methods) expect(preload).toContain(`${method}:`);
    expect(preload).toContain('ipcRenderer.invoke("hooks:approvePlugin"');
    expect(preload).toContain('ipcRenderer.invoke("hooks:revokePlugin"');
    expect(main).toContain('ipcMain.handle("hooks:approvePlugin"');
    expect(main).toContain('ipcMain.handle("hooks:revokePlugin"');
  });
});
