import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createConfigurationReads } from "./configuration-reads.js";

test("plugin commands send scoped reads to the Host and retain native change notifications", async () => {
  const readBusiness = mock(async (..._args: unknown[]): Promise<never> => {
    throw Error("observed");
  });
  const invoke = mock();
  const api = createConfigurationReads({ invoke }, { readBusiness });
  const target = { sessionId: "owned" };
  await expect(api.listPluginCommands(target)).rejects.toThrow("observed");
  await expect(api.expandPluginCommand(target, "summary", "文件 A")).rejects.toThrow("observed");
  expect(readBusiness.mock.calls).toEqual([
    ["plugins/commands", { target }, undefined],
    ["plugins/expandCommand", { target, name: "summary", rawArguments: "文件 A" }, undefined],
  ]);
  expect(invoke).not.toHaveBeenCalled();
  const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const main = readFileSync(join(import.meta.dir, "..", "main", "index.ts"), "utf8");
  expect(preload).toContain('ipcRenderer.on("plugin-commands:changed"');
  expect(main).toContain('webContents.send("plugin-commands:changed"');
});
