/**
 * The Pet domain packaged as a self-contained core extension module.
 *
 * Hosts opt in explicitly:
 *   - desktop injects `CODE_SHELL_CAPABILITY_MODULES=@cjhyy/code-shell-pet#createPetModule`
 *     into the stdio worker env (loaded by core's agent-server-stdio cli);
 *   - in-process hosts/tests compile `createPetModule()` into their composition.
 *
 * Core itself is pet-free: behavior comes from the generic RunBehaviorProfile
 * registry, protocol observation from ProtocolObserver, and the DelegateWork
 * tool joins the composed tool catalog with full exposure metadata.
 */

import type {
  AgentModule,
  BuiltinTool,
  ProtocolObserver,
  ProtocolObserverHost,
} from "@cjhyy/code-shell-core/extension";
import {
  delegateWorkAvailability,
  delegateWorkTool,
  delegateWorkToolDef,
  rewriteDelegateWorkDef,
} from "./delegate-work.js";
import {
  mobileRemoteAvailability,
  mobileRemoteTool,
  mobileRemoteToolDef,
} from "./mobile-remote.js";
import { gatewayAvailability, gatewayTool, gatewayToolDef } from "./gateway.js";
import { sessionsAvailability, sessionsTool, sessionsToolDef } from "./sessions-tool.js";
import { currentTimeAvailability, currentTimeTool, currentTimeToolDef } from "./current-time.js";
import {
  manageSessionsAvailability,
  manageSessionsTool,
  manageSessionsToolDef,
  watchSessionAvailability,
  watchSessionTool,
  watchSessionToolDef,
} from "./session-control.js";
import {
  followUpsAvailability,
  followUpsTool,
  followUpsToolDef,
  manageFollowUpAvailability,
  manageFollowUpTool,
  manageFollowUpToolDef,
} from "./follow-ups.js";
import {
  rewriteSendMessageDef,
  sendMessageAvailability,
  sendMessageTool,
  sendMessageToolDef,
} from "./outbound-message.js";
import {
  controlLongTaskAvailability,
  controlLongTaskTool,
  controlLongTaskToolDef,
  gatewayReplyAvailability,
  gatewayReplyTool,
  gatewayReplyToolDef,
  memoryAvailability,
  memoryTool,
  memoryToolDef,
  rewriteGatewayReplyDef,
} from "./host-actions.js";
import { PET_BEHAVIOR_PROFILE } from "./profile.js";
import { createPetProjectionObserver, PET_HIDDEN_SESSION_KINDS } from "./projection-extension.js";
import { PET_REPORT_TO_MIMI_METHOD } from "./protocol.js";
import {
  requestMimiDeliveryAvailability,
  requestMimiDeliveryTool,
  requestMimiDeliveryToolDef,
  reportToMimiAvailability,
  reportToMimiTool,
  reportToMimiToolDef,
  type PetReportToMimiSink,
} from "./report-to-mimi.js";
import { validatePetRunParams } from "./run-params.js";

/**
 * The Pet domain as a unified AgentModule. Wraps the legacy factory so the
 * report-to-mimi sink closure keeps binding the observer to the tools of the
 * SAME module instance.
 */
export function createPetModule(): AgentModule {
  const legacy = buildPetParts();
  return {
    id: legacy.id,
    engine: {
      tools: (legacy.catalogTools ?? []).map((tool) => ({ kind: "preset-tags" as const, tool })),
      behaviorProfiles: legacy.behaviorProfiles,
    },
    protocol: {
      queries: legacy.queries,
      createObserver: legacy.createProtocolObserver,
      validateRunParams: legacy.validateRunParams,
      hiddenSessionKinds: legacy.hiddenSessionKinds,
    },
  };
}

interface PetParts {
  id: string;
  behaviorProfiles: NonNullable<AgentModule["engine"]>["behaviorProfiles"];
  createProtocolObserver: (host: ProtocolObserverHost) => ProtocolObserver;
  validateRunParams: (params: Record<string, unknown>) => string | null;
  hiddenSessionKinds: readonly string[];
  catalogTools: BuiltinTool[];
  queries?: Readonly<Record<string, never>>;
}

function buildPetParts(): PetParts {
  let reportToMimi: PetReportToMimiSink | undefined;
  const createProtocolObserver = (host: ProtocolObserverHost) => {
    reportToMimi = (event) =>
      host.notify(PET_REPORT_TO_MIMI_METHOD, event as unknown as Record<string, unknown>);
    const projection = createPetProjectionObserver(host);
    return {
      ...projection,
      onServerClose: () => {
        reportToMimi = undefined;
        projection.onServerClose?.();
      },
    };
  };
  return {
    id: "pet",
    behaviorProfiles: [PET_BEHAVIOR_PROFILE],
    createProtocolObserver,
    validateRunParams: validatePetRunParams,
    hiddenSessionKinds: PET_HIDDEN_SESSION_KINDS,
    catalogTools: [
      {
        definition: {
          ...requestMimiDeliveryToolDef,
          source: "builtin",
          permissionDefault: "ask",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: (args, ctx) => requestMimiDeliveryTool(args, ctx, reportToMimi),
        exposure: {
          presetTags: ["harness-min", "general"],
          availability: requestMimiDeliveryAvailability,
        },
      },
      {
        definition: {
          ...reportToMimiToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: (args, ctx) => reportToMimiTool(args, ctx, reportToMimi),
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: reportToMimiToolDef.name, decision: "allow" }],
          availability: reportToMimiAvailability,
        },
      },
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
      {
        definition: {
          ...mobileRemoteToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: mobileRemoteTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: mobileRemoteToolDef.name, decision: "allow" }],
          availability: mobileRemoteAvailability,
        },
      },
      {
        definition: {
          ...controlLongTaskToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: controlLongTaskTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: controlLongTaskToolDef.name, decision: "allow" }],
          availability: controlLongTaskAvailability,
        },
      },
      {
        definition: {
          ...memoryToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: memoryTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: memoryToolDef.name, decision: "allow" }],
          availability: memoryAvailability,
        },
      },
      {
        definition: {
          ...gatewayToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: true,
          isConcurrencySafe: true,
        },
        execute: gatewayTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: gatewayToolDef.name, decision: "allow" }],
          availability: gatewayAvailability,
        },
      },
      {
        definition: {
          ...gatewayReplyToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: gatewayReplyTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: gatewayReplyToolDef.name, decision: "allow" }],
          availability: gatewayReplyAvailability,
          rewriteDefinition: rewriteGatewayReplyDef,
        },
      },
      {
        definition: {
          ...sessionsToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: true,
          isConcurrencySafe: true,
        },
        execute: sessionsTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: sessionsToolDef.name, decision: "allow" }],
          availability: sessionsAvailability,
        },
      },
      {
        definition: {
          ...followUpsToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: true,
          isConcurrencySafe: true,
        },
        execute: followUpsTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: followUpsToolDef.name, decision: "allow" }],
          availability: followUpsAvailability,
        },
      },
      {
        definition: {
          ...manageFollowUpToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: manageFollowUpTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: manageFollowUpToolDef.name, decision: "allow" }],
          availability: manageFollowUpAvailability,
        },
      },
      {
        definition: {
          ...watchSessionToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: watchSessionTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: watchSessionToolDef.name, decision: "allow" }],
          availability: watchSessionAvailability,
        },
      },
      {
        definition: {
          ...manageSessionsToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: manageSessionsTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: manageSessionsToolDef.name, decision: "allow" }],
          availability: manageSessionsAvailability,
        },
      },
      {
        definition: {
          ...currentTimeToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: true,
          isConcurrencySafe: true,
        },
        execute: currentTimeTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: currentTimeToolDef.name, decision: "allow" }],
          availability: currentTimeAvailability,
        },
      },
      {
        definition: {
          ...sendMessageToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: sendMessageTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: sendMessageToolDef.name, decision: "allow" }],
          availability: sendMessageAvailability,
          rewriteDefinition: rewriteSendMessageDef,
        },
      },
    ],
  };
}
