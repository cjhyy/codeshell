import type { NativeCcRoomReads } from "./cc-room-reads.js";
import type { CronCommand } from "../host/automation/commands.js";
import type {
  ExternalRuntimeModelEntry,
  ExternalRuntimeModelKind,
} from "./external-runtime-models.js";
import type { DesktopHostIdentity } from "./desktop-host-protocol.js";
import type { CatalogEdits } from "./catalog-edits.js";
import type { ProjectRegistryOperations } from "./project-registry-operations.js";
import type { RendererConfigurationTarget } from "./renderer-configuration.js";
import type { SessionCatalogApi } from "./session-catalog.js";

type Operation<F extends (...args: any[]) => Promise<unknown>> = {
  input: Parameters<F>[0];
  result: Awaited<ReturnType<F>>;
};

/** Private calls from authenticated Electron adapters. These methods are never
 * registered on a renderer port or exposed by the window preload. */
export interface ShellBusinessOperations extends ProjectRegistryOperations, CatalogEdits, NativeCcRoomReads {
  "automation/command": { input: CronCommand; result: unknown };
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
  "trust/set": { input: { path: string; level: "trusted" | "untrusted" }; result: void };
  "trust/readProjection": { input: string; result: "trusted" | "untrusted" | "unknown" };
  "settings/patch": {
    input: ({ scope: "user" } | { scope: "project"; target: RendererConfigurationTarget }) & {
      patch: Record<string, unknown>;
    };
    result: void;
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
