import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeshellApi } from "./types";

type SourceMethods = Pick<
  CodeshellApi,
  | "listSourceCatalog"
  | "saveSourceCatalog"
  | "deleteSourceCatalog"
  | "workspaceSourceAccess"
  | "bindSource"
  | "unbindSource"
  | "listSourceScopes"
  | "pickAndUploadSources"
  | "deleteUpload"
>;

const methodChannels = {
  listSourceCatalog: "sources:catalogList",
  saveSourceCatalog: "sources:catalogSave",
  deleteSourceCatalog: "sources:catalogDelete",
  workspaceSourceAccess: "sources:workspaceAccess",
  bindSource: "sources:bind",
  unbindSource: "sources:unbind",
  listSourceScopes: "sources:listScopes",
  pickAndUploadSources: "sources:pickAndUpload",
  deleteUpload: "sources:deleteUpload",
} satisfies Record<keyof SourceMethods, string>;

describe("preload sources contract", () => {
  test("keeps all nine renderer methods wired to matching main IPC channels", () => {
    const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const main = readFileSync(join(import.meta.dir, "..", "main", "index.ts"), "utf8");

    for (const [method, channel] of Object.entries(methodChannels)) {
      expect(preload).toContain(`${method}:`);
      expect(preload).toContain(`ipcRenderer.invoke("${channel}"`);
      expect(main).toContain(`ipcMain.handle("${channel}"`);
    }
    expect(main).toContain('properties: ["openFile", "multiSelections"]');
  });
});
