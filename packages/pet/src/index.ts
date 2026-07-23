/**
 * @cjhyy/code-shell-pet — Pet (top-level personal assistant) capability.
 *
 * Owns the Pet domain that used to live inside core: projection domain model,
 * owner-scoped session/pending-decision read models, and the DelegateWork
 * delegation contract. Composed by hosts (desktop worker via
 * CODE_SHELL_CAPABILITY_MODULES, future packages/server) — core stays
 * pet-free and only provides the generic extension seams.
 */

export * from "./types.js";
export * from "./delegation.js";
export * from "./team.js";
export * from "./protocol.js";
export {
  REPORT_TO_MIMI_TOOL_NAME,
  reportToMimiToolDef,
  reportToMimiTool,
  reportToMimiAvailability,
  type PetReportToMimiSink,
} from "./report-to-mimi.js";
export { petRunOptionsFrom, validatePetRunParams, type PetRunOptions } from "./run-params.js";
export { SessionIndex } from "./session-index.js";
export { PendingDecisionIndex, safePendingTitle } from "./pending-decision-index.js";
export {
  PET_BEHAVIOR_PROFILE,
  PET_SYSTEM_PROMPT,
  PET_ALLOWED_TOOL_NAMES,
  type PetRunScopedServices,
} from "./profile.js";
export { createPetProjectionObserver, PET_HIDDEN_SESSION_KINDS } from "./projection-extension.js";
export {
  delegateWorkToolDef,
  delegateWorkToolDefFor,
  delegateWorkTool,
  delegateWorkAvailability,
  rewriteDelegateWorkDef,
} from "./delegate-work.js";
export {
  MOBILE_REMOTE_TOOL_NAME,
  mobileRemoteToolDef,
  mobileRemoteTool,
  mobileRemoteAvailability,
  type PetMobileRemoteAction,
  type PetMobileRemoteRequest,
  type PetMobileRemoteDecision,
} from "./mobile-remote.js";
export {
  GATEWAY_TOOL_NAME,
  gatewayToolDef,
  gatewayTool,
  gatewayAvailability,
  parsePetGatewayCatalog,
  type PetGatewayAttachmentKind,
  type PetGatewayChannelCapabilities,
  type PetGatewayChannel,
  type PetGatewayCatalog,
} from "./gateway.js";
export {
  PET_HOST_ACTION_KINDS,
  isPetHostActionKind,
  isPetHostActionRequest,
  CONTROL_LONG_TASK_TOOL_NAME,
  GATEWAY_REPLY_TOOL_NAME,
  MEMORY_TOOL_NAME,
  controlLongTaskToolDef,
  controlLongTaskTool,
  controlLongTaskAvailability,
  memoryToolDef,
  memoryTool,
  memoryAvailability,
  gatewayReplyToolDef,
  gatewayReplyTool,
  gatewayReplyAvailability,
  rewriteGatewayReplyDef,
  type PetGatewayReplyAttachmentKind,
  type PetGatewayReplyCapability,
  type PetHostActionKind,
  type PetHostActionRequest,
  type PetHostActionDecision,
} from "./host-actions.js";
export { createPetCapability } from "./capability.js";
export * from "./topic-segment.js";
export * from "./long-task.js";
