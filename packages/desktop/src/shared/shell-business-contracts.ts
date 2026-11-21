import type { CronJob, CronRunResult } from "@cjhyy/code-shell-core/internal";
import type {
  ExternalRuntimeModelEntry,
  ExternalRuntimeModelKind,
} from "./external-runtime-models.js";
import type { DesktopHostIdentity } from "./desktop-host-protocol.js";
import type { SessionCatalogApi } from "./session-catalog.js";

type Operation<F extends (...args: any[]) => Promise<unknown>> = {
  input: Parameters<F>[0];
  result: Awaited<ReturnType<F>>;
};

/** Private calls from authenticated Electron adapters. These methods are never
 * registered on a renderer port or exposed by the window preload. */
export interface ShellBusinessOperations {
  "automation/run": { input: { job: CronJob; searchPath: string }; result: CronRunResult };
  "external-runtime/available": {
    input: { searchPath: string };
    result: ExternalRuntimeModelKind[];
  };
  "external-runtime/models": { input: { searchPath: string }; result: ExternalRuntimeModelEntry[] };
  "transcripts/read": Operation<SessionCatalogApi["readTranscript"]>;
  "transcripts/write": Operation<SessionCatalogApi["writeTranscript"]>;
  "transcripts/delete": Operation<SessionCatalogApi["deleteTranscript"]>;
  "operations/ledger": {
    input: { action: string; caller: DesktopHostIdentity; payload: Record<string, unknown> };
    result: unknown;
  };
  "catalog/load": Operation<SessionCatalogApi["load"]>;
  "catalog/importLegacy": Operation<SessionCatalogApi["importLegacy"]>;
  "catalog/apply": Operation<SessionCatalogApi["apply"]>;
}

export type CallShellBusiness = <K extends keyof ShellBusinessOperations>(
  method: K,
  input: ShellBusinessOperations[K]["input"],
  signal?: AbortSignal,
) => Promise<ShellBusinessOperations[K]["result"]>;
