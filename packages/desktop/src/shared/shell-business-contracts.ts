import type { MimiReplyOperations } from "./mimi-gateway-turn.js";
import type { ProjectMigrationOperations } from "./project-migration.js";
import type { MimiProjectionOperations } from "./mimi-projection.js";
import type { MimiFollowUpOperations } from "./mimi-follow-ups.js";
import type { GitOperations } from "./git-operations.js";
import type { LabFileOperations } from "./optimization-lab-project.js";
import type { PendingApprovalOperations } from "./pending-approvals.js";
import type { RoomHistoryOperations } from "./room-history.js";
import type { MarketplaceOperations, PluginPackageOperations } from "./plugin-library.js";
import type { ProfileLibraryOperations } from "./profile-library.js";
import type { ConfiguredMcpProbe } from "./configured-mcp-probe.js";
import type { SkillOperations } from "./skill-operations.js";
import type { WechatLoginOperations } from "./wechat-login.js";
import type { NativeCcRoomReads } from "./cc-room-reads.js";
import type { MediaProtocolOperations } from "./media-protocol-operations.js";
import type { AttachmentOperations } from "./attachment-operations.js";
import type { ActivityOperations } from "./activity-history-contracts.js";
import type { PrivateMemoryReads, MemoryOperations } from "./memory-contracts.js";
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
export interface ShellBusinessOperations extends ProjectMigrationOperations, MimiReplyOperations, MimiProjectionOperations, MimiFollowUpOperations, MarketplaceOperations, PluginPackageOperations, GitOperations, PendingApprovalOperations, LabFileOperations, ConfiguredMcpProbe, RoomHistoryOperations, SkillOperations, MediaProtocolOperations, AttachmentOperations, WechatLoginOperations, ActivityOperations, NativeCcRoomReads, MemoryOperations, PrivateMemoryReads, ProjectRegistryOperations, CatalogEdits, ProfileLibraryOperations {
  "files/turnHistory": {
    input: { sessionId: string; action: "state" | "undo" | "redo" };
    result: import("../main/file-history-service.js").TurnUndoState | import("../main/file-history-service.js").TurnUndoResult[];
  };
  "sessions/archive": { input: { sessionId: string; archivedAt?: number }; result: void };
  "sessions/deleteFiles": { input: { sessionId: string }; result: void };
  "startup/workspaces": { input: Record<string, never>; result: string[] };
  "startup/settingsSchema": { input: Record<string, never>; result: void };
  "startup/quickChats": { input: Record<string, never>; result: string[] };
  "startup/cleanupAttachments": { input: { sessionId?: string }; result: void };
  "terminal/command": { input: import("./pty.js").NativeTerminalCommand; result: unknown };
  "mimi/ruleScheduler": {input:"prepare"|"start"|"reconcile"|"stop";result:void};
  "mimi/rules": { input: import("./mimi-rules.js").MimiRuleCall; result: import("./mimi-rules.js").MimiRuleReply };
  "mimi/turnStorage":{input:import("./mimi-turn-storage.js").MimiTurnStorageCommand;result:unknown};
  "mimi/tasks": {input: import("./mimi-tasks.js").MimiTaskCommand;result:unknown};
  "mimi/extractionAllowed": { input: Record<string,never>; result:boolean };
  "mimi/closeSegment": Operation<import("../main/pet/pet-segment-closure-service.js").PetSegmentClosureService["close"]>;
  "mimi/backfillSegments": {input:{segments:readonly import("../main/pet/pet-segment-closure-service.js").ClosedSegmentDescriptor[];now:number};result:void};
  "mimi/segmentMessages": Operation<import("../main/pet/pet-segment-closure-service.js").PetSegmentClosureService["readSegmentMessages"]>;
  "mimi/workMemory": {
    input: import("./mimi-work-memory.js").MimiWorkCommand;
    result: import("./mimi-work-memory.js").MimiWorkSnapshot;
  };
  "mimi/records": { input: import("./mimi-records.js").MimiRecordCall; result: unknown };
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
