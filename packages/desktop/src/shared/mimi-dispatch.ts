import type {
  PetDispatchCommand,
  PetDispatchOptions,
  PetDispatchService,
} from "../main/pet/pet-dispatch-service.js";
export type MimiDispatchService = Pick<
  PetDispatchService,
  "getSessionId" | "dispatch" | "reportSessionMessage" | "reportLongTaskClosure" | "wakeFollowUp"
>;
export type NativeMimiServices = Required<
  Pick<
    PetDispatchOptions,
    | "aggregator"
    | "worker"
    | "externalRuntime"
    | "segmentController"
    | "taskInbox"
    | "validateFollowUpContinuation"
    | "recentProactive"
    | "noticeTurns"
    | "hostActions"
    | "listFollowUps"
    | "listOutboundTargets"
    | "replyAttachmentRoots"
    | "listWorkspaces"
  >
> & {
  hostCwd: string;
  remoteContext(): ReturnType<
    typeof import("../main/pet/pet-memory-host.js").petRemoteMemoryContext
  >;
};
export interface DispatchConfiguration {
  hostCwd: string;
  actions: string[];
}
type ChatCommand = Extract<PetDispatchCommand, { type: "chat" }>;
export type WiredMimiCommand =
  | Exclude<PetDispatchCommand, ChatCommand>
  | (Omit<ChatCommand, "pendingNotices"> & { noticeSource?: string });
