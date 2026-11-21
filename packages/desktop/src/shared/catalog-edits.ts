import type { CodeshellApi } from "../preload/types.js";
import type { SourceDefinition, WorkspaceSourceBinding } from "@cjhyy/code-shell-core";
export interface CatalogEdits {
  "models/saveEntry": {
    input: { entry: unknown };
    result: Awaited<ReturnType<CodeshellApi["saveCatalogEntry"]>>;
  };
  "models/deleteEntry": {
    input: { id: string };
    result: Awaited<ReturnType<CodeshellApi["deleteCatalogEntry"]>>;
  };
  "sources/save": { input: { definition: SourceDefinition }; result: void };
  "sources/delete": { input: { id: string }; result: void };
  "sources/bind": { input: { projectId: string; binding: WorkspaceSourceBinding }; result: void };
  "sources/unbind": { input: { projectId: string; sourceId: string }; result: void };
  "sources/uploadPicked": { input: { projectId: string; files: string[] }; result: string[] };
  "sources/deleteUpload": { input: { projectId: string; name: string }; result: void };
}
export type CatalogEdit = keyof CatalogEdits;
export type StoredCatalogEdit = Exclude<CatalogEdit, "sources/uploadPicked">;
const commands: ReadonlySet<string> = new Set([
  "models/saveEntry",
  "models/deleteEntry",
  "sources/save",
  "sources/delete",
  "sources/bind",
  "sources/unbind",
  "sources/deleteUpload",
] satisfies CatalogEdit[]);
export function isCatalogEdit(value: string): value is StoredCatalogEdit {
  return commands.has(value);
}
