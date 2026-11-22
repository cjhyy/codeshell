import type { createDesktopTaskInbox } from "./task-inbox.js";
import type { mimiTurnStores } from "../../shared/mimi-turn-storage.js";
import type { createMobileGatewayShell } from "./mobile-gateway.js";
import type { createDesktopHost } from "../desktop-host/main.js";
import type { createExternalRuntimeModule } from "../external-runtime-module.js";
import type { BrowserWindow } from "electron";
import type { AppRendererNavigation } from "../app-renderer-navigation.js";
import type { PetSegmentClosureService } from "../pet/pet-segment-closure-service.js";
import type { PetHostActionReceiptRecorder } from "../pet/pet-host-action-completion.js";
import type { MimiReplyRender } from "../../shared/mimi-gateway-turn.js";
import type { nativeMimiRecords } from "../desktop-host/mimi-records-client.js";
import type { createPetFollowUpRules } from "../pet/pet-follow-up-rules.js";
import type { NativeMimiScheduler } from "../desktop-host/mimi-scheduler-client.js";
import type { nativeMimiWorkMemory } from "../desktop-host/mimi-work-client.js";
import type { MimiDispatchService } from "../../shared/mimi-dispatch.js";
import type { DesktopNotifier } from "../desktop-notifier.js";
import type {
  GatewayControlEventAttachment,
  GatewayControlEventInput,
} from "../im-gateway-control-server.js";
import type { NativeImGateway } from "../desktop-host/im-gateway-client.js";
import type { ShellBusinessOperations } from "../../shared/shell-business-contracts.js";
type Mobile = ReturnType<typeof createMobileGatewayShell>;
type TaskInbox = ReturnType<typeof createDesktopTaskInbox>;
type MobileControls = ReturnType<Mobile["registerIpc"]>;
export interface MimiShellOptions
  extends
    Pick<Mobile, "pendingMobileApprovals" | "mobileOrchestrator">,
    Pick<MobileControls, "startMobileRemote" | "stopMobileRemote" | "getMobileRemoteGatewayStatus">,
    Pick<
      TaskInbox,
      "listAllDiskSessions" | "archiveDiskSession" | "taskInboxService" | "markSessionTaskDirty"
    > {
  externalRuntime: ReturnType<typeof createExternalRuntimeModule>;
  imGatewayService: NativeImGateway;
  nativeMimiScheduler: NativeMimiScheduler;
  mainWindows: Set<BrowserWindow>;
  appRendererNavigation: Pick<AppRendererNavigation, "assertSender">;
  notifier(): DesktopNotifier | null;
  windows(): BrowserWindow[];
  revealSessionWindow(sessionId: string): void;
  publishGatewayControlEvent(event: GatewayControlEventInput): Promise<void>;
  inspectKnownReplyAttachments(paths: readonly string[]): Promise<GatewayControlEventAttachment[]>;
  knownReplyAttachmentCwds(): Promise<string[]>;
}

export type NativeMimiHost = Pick<
  ReturnType<typeof createDesktopHost>,
  | "callBusiness"
  | "documentSignal"
  | "mimiDispatch"
  | "mimiProjection"
  | "mimiRecordListeners"
  | "mimiRules"
  | "mimiTasks"
  | "setStreamView"
>;

export type MimiWorkMemory = ReturnType<typeof nativeMimiWorkMemory>;
export type MimiRecords = ReturnType<typeof nativeMimiRecords>;
export type MimiTurnStores = ReturnType<typeof mimiTurnStores>;
export type MimiBoundTasks = ReturnType<NativeMimiHost["mimiTasks"]["configure"]>;
export type MimiFollowUps = Awaited<ReturnType<typeof createPetFollowUpRules>>;
export interface MimiSegments {
  controller: ReturnType<MimiWorkMemory["controller"]> | null;
  closure: PetSegmentClosureService | null;
}
export interface MimiReportEndpoints {
  readonly dispatcher: MimiDispatchService | null;
  readonly receipts: PetHostActionReceiptRecorder | null;
  windows(): BrowserWindow[];
  render(
    baseText: string,
    executions: MimiReplyRender["executions"],
    options: MimiReplyRender["options"],
  ): Promise<ShellBusinessOperations["mimi/renderReply"]["result"]>;
}
