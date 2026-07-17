/**
 * The Pet domain packaged as a self-contained core extension module.
 *
 * Hosts opt in explicitly:
 *   - desktop injects `CODE_SHELL_CAPABILITY_MODULES=@cjhyy/code-shell-pet#createPetCapability`
 *     into the stdio worker env (loaded by core's agent-server-stdio cli);
 *   - in-process hosts/tests pass `extensionModules: [createPetCapability()]`
 *     to EngineConfig / AgentServer options.
 *
 * Core itself is pet-free: behavior comes from the generic RunBehaviorProfile
 * registry, protocol observation from ProtocolObserver, and the DelegateWork
 * tool joins the composed tool catalog with full exposure metadata.
 */

import type { ExtensionModule } from "@cjhyy/code-shell-core/extension";
import {
  delegateWorkAvailability,
  delegateWorkTool,
  delegateWorkToolDef,
  rewriteDelegateWorkDef,
} from "./delegate-work.js";
import { PET_BEHAVIOR_PROFILE } from "./profile.js";
import { createPetProjectionObserver, PET_HIDDEN_SESSION_KINDS } from "./projection-extension.js";
import { validatePetRunParams } from "./run-params.js";

export function createPetCapability(): ExtensionModule {
  return {
    id: "pet",
    behaviorProfiles: [PET_BEHAVIOR_PROFILE],
    createProtocolObserver: createPetProjectionObserver,
    validateRunParams: validatePetRunParams,
    hiddenSessionKinds: PET_HIDDEN_SESSION_KINDS,
    catalogTools: [
      {
        definition: {
          ...delegateWorkToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: delegateWorkTool,
        exposure: {
          // Byte-identical to the former builtin registration: HARNESS_TAGS
          // preset tags + explicit allow rule + pet-profile availability and
          // the per-turn workspace-enum rewrite.
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: delegateWorkToolDef.name, decision: "allow" }],
          availability: delegateWorkAvailability,
          rewriteDefinition: rewriteDelegateWorkDef,
        },
      },
    ],
  };
}
