import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeshellApi } from "./types";

type SourceMethods = Pick<
  CodeshellApi,
  | "listSourceCatalog"
  | "saveSourceCatalog"
  | "deleteSourceCatalog"
  | "projectSourceAccess"
  | "bindProjectSource"
  | "unbindProjectSource"
  | "listSourceScopes"
  | "pickAndUploadProjectSources"
  | "deleteProjectUpload"
>;

const methodChannels = {
  listSourceCatalog: "sources:catalogList",
  saveSourceCatalog: "sources:catalogSave",
  deleteSourceCatalog: "sources:catalogDelete",
  projectSourceAccess: "sources:projectAccess",
  bindProjectSource: "sources:bindProject",
  unbindProjectSource: "sources:unbindProject",
  listSourceScopes: "sources:listScopes",
  pickAndUploadProjectSources: "sources:pickAndUploadProject",
  deleteProjectUpload: "sources:deleteProjectUpload",
} satisfies Record<keyof SourceMethods, string>;

describe("preload sources contract", () => {
  test("keeps all nine renderer methods wired to project-id main IPC channels", () => {
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
