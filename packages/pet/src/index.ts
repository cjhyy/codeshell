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
export { SessionIndex } from "./session-index.js";
export { PendingDecisionIndex, safePendingTitle } from "./pending-decision-index.js";
export {
  PET_BEHAVIOR_PROFILE,
  PET_SYSTEM_PROMPT,
  PET_ALLOWED_TOOL_NAMES,
  type PetRunScopedServices,
} from "./profile.js";
export {
  createPetProjectionObserver,
  validatePetRunParams,
  PET_HIDDEN_SESSION_KINDS,
} from "./projection-extension.js";
export {
  delegateWorkToolDef,
  delegateWorkToolDefFor,
  delegateWorkTool,
  delegateWorkAvailability,
  rewriteDelegateWorkDef,
} from "./delegate-work.js";
export { createPetCapability } from "./capability.js";
