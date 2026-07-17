import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeshellApi } from "./types";

type PluginCommandMethods = Pick<
  CodeshellApi,
  "listPluginCommands" | "expandPluginCommand" | "onPluginCommandsChanged"
>;

const methodChannels = {
  listPluginCommands: "plugin-commands:list",
  expandPluginCommand: "plugin-commands:expand",
  onPluginCommandsChanged: "plugin-commands:changed",
} satisfies Record<keyof PluginCommandMethods, string>;

describe("preload plugin command contract", () => {
  test("keeps list, expansion, and refresh channels wired across the boundary", () => {
    const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const main = readFileSync(join(import.meta.dir, "..", "main", "index.ts"), "utf8");

    expect(preload).toContain(`ipcRenderer.invoke("${methodChannels.listPluginCommands}"`);
    expect(preload).toContain(`ipcRenderer.invoke("${methodChannels.expandPluginCommand}"`);
    expect(preload).toContain(`ipcRenderer.on("${methodChannels.onPluginCommandsChanged}"`);
    expect(main).toContain(`ipcMain.handle("${methodChannels.listPluginCommands}"`);
    expect(main).toContain(`"plugin-commands:expand"`);
    expect(main).toContain(`webContents.send("${methodChannels.onPluginCommandsChanged}"`);
  });
});
