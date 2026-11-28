import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeshellApi } from "./types";

type ApprovalMethods = Pick<CodeshellApi, "approvePluginHooks" | "revokePluginHooks">;

describe("preload plugin hook approval contract", () => {
  test("wires explicit approve and revoke IPC methods", () => {
    const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const main = readFileSync(join(import.meta.dir, "..", "main", "plugin-library-ipc.ts"), "utf-8");
    const methods: Array<keyof ApprovalMethods> = ["approvePluginHooks", "revokePluginHooks"];

    for (const method of methods) expect(preload).toContain(`${method}:`);
    expect(preload).toContain('ipcRenderer.invoke("hooks:approvePlugin"');
    expect(preload).toContain('ipcRenderer.invoke("hooks:revokePlugin"');
    expect(main).toContain('ipcMain.handle("hooks:approvePlugin"');
    expect(main).toContain('ipcMain.handle("hooks:revokePlugin"');
  });

  test("wires the whole-plugin approval and the native runtime through two channels", async () => {
    const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const library = readFileSync(join(import.meta.dir, "..", "main", "plugin-library-ipc.ts"), "utf-8");
    const native = readFileSync(join(import.meta.dir, "..", "main", "native-plugins-ipc.ts"), "utf-8");
    expect(preload).toContain("...createNativePluginsApi(ipcRenderer)");
    expect(library).toContain('ipcMain.handle("plugins:approval"');
    expect(native).toContain('ipcMain.handle("plugins:native"');

    const { createNativePluginsApi } = await import("./native-plugins-api");
    const calls: unknown[][] = [];
    const api: Pick<CodeshellApi, "approvePlugin" | "revokePlugin" | "nativePluginRuntime" | "nativePluginLog"> =
      createNativePluginsApi({ invoke: async (...args: unknown[]) => calls.push(args) });
    await api.approvePlugin("demo@local");
    await api.revokePlugin("demo@local");
    await api.nativePluginRuntime("status");
    await api.nativePluginRuntime("restart", "demo@local");
    await api.nativePluginLog("demo@local");
    expect(calls).toEqual([
      ["plugins:approval", "approve", "demo@local"],
      ["plugins:approval", "revoke", "demo@local"],
      ["plugins:native", "status", undefined],
      ["plugins:native", "restart", "demo@local"],
      ["plugins:native", "log", "demo@local"],
    ]);
  });
});
