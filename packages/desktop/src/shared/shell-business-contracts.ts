import type { SessionCatalogApi } from "./session-catalog.js";

type Operation<F extends (...args: any[]) => Promise<unknown>> = {
  input: Parameters<F>[0];
  result: Awaited<ReturnType<F>>;
};

/** Private calls from authenticated Electron adapters. These methods are never
 * registered on a renderer port or exposed by the window preload. */
export interface ShellBusinessOperations {
  "transcripts/read": Operation<SessionCatalogApi["readTranscript"]>;
  "transcripts/write": Operation<SessionCatalogApi["writeTranscript"]>;
  "transcripts/delete": Operation<SessionCatalogApi["deleteTranscript"]>;
  "catalog/load": Operation<SessionCatalogApi["load"]>;
  "catalog/importLegacy": Operation<SessionCatalogApi["importLegacy"]>;
  "catalog/apply": Operation<SessionCatalogApi["apply"]>;
}

export type CallShellBusiness = <K extends keyof ShellBusinessOperations>(
  method: K,
  input: ShellBusinessOperations[K]["input"],
  signal?: AbortSignal,
) => Promise<ShellBusinessOperations[K]["result"]>;
