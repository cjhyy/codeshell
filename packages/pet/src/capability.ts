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
  bindConversationSessionAvailability,
  bindConversationSessionTool,
  bindConversationSessionToolDef,
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
} from "./host-actions.js";
import { PET_ALLOWED_TOOL_NAMES, PET_BEHAVIOR_PROFILE } from "./profile.js";
import { createPetProjectionObserver, PET_HIDDEN_SESSION_KINDS } from "./projection-extension.js";
import { PET_REPORT_TO_MIMI_METHOD, GET_PET_PROJECTION_SNAPSHOT_METHOD } from "./protocol.js";
import {
  requestMimiDeliveryAvailability,
  requestMimiDeliveryTool,
  requestMimiDeliveryToolDef,
  reportToMimiAvailability,
  reportToMimiTool,
  reportToMimiToolDef,
  type PetReportToMimiSink,
} from "./report-to-mimi.js";
import {
  notifyMeAvailability,
  notifyMeTool,
  notifyMeToolDef,
  type NoticeRuleHostRequester,
} from "./notify-me.js";
import {
  manageTriggerTool,
  manageTriggerToolDef,
  noticesTool,
  noticesToolDef,
  noticeToolsAvailability,
  notificationSettingsAvailability,
  notificationSettingsTool,
  notificationSettingsToolDef,
  triggersTool,
  triggersToolDef,
} from "./notice-tools.js";
import { validatePetRunParams } from "./run-params.js";
import { mimiWorldLedgerProviders } from "./world-ledger.js";

const PET_MANAGER_EXTERNAL_REASONS: Readonly<Record<string, string>> = {
  DelegateWork:
    "Records one delegation through the Host-owned per-turn Pet profile services. Workspace ids and reusable Session evidence are validated against that turn's bounded options; reporting a request does not launch work or grant a general execution tool.",
  MobileRemote:
    "Records a mobile-remote request only through the Host-owned per-turn Pet profile services and authorized host action kinds. The Host validates and executes it after the manager turn; the tool does not open a tunnel directly.",
  ControlLongTask:
    "Records a bounded task-control request through the Host-owned per-turn Pet profile services. The Host resolves task identity and validates the operation after the manager turn; acceptance is not execution.",
  Memory:
    "Records a bounded memory request through the Host-owned per-turn Pet profile services. The Host validates and applies it after the manager turn; the tool does not mutate a memory store directly.",
  Gateway:
    "Reads only the current turn's Host-provided Gateway channel catalog from Pet profile services. It cannot select another conversation, connect a channel, or send a message.",
  GatewayReply:
    "Records the current conversation's reply through the Host-owned per-turn Pet profile services. The capability bounds text and attachments, and the Host validates and delivers the final draft after the turn; acceptance is not delivery.",
  Sessions:
    "Reads bounded Session disclosures using only the Host-provided sessions directory and current turn's Pet profile services. It cannot execute, resume, or mutate a Work Session.",
  FollowUps:
    "Reads only the bounded follow-up items supplied by the Host-owned per-turn Pet profile services. It cannot inspect another store or mutate a follow-up.",
  ManageFollowUp:
    "Records a follow-up mutation through the Host-owned per-turn Pet profile services and authorized host action kinds. The Host validates identity and executes it after the manager turn; acceptance is not completion.",
  WatchSession:
    "Records a Session watch request through the Host-owned per-turn Pet profile services and authorized host action kinds. The Host validates the Session and delivery route after the turn; the tool cannot install a watch directly.",
  ManageSessions:
    "Records a Session archive request through the Host-owned per-turn Pet profile services and authorized host action kinds. The Host validates each Session after the turn; the tool cannot mutate the Session store directly.",
  BindConversationSession:
    "Records a conversation-binding request through the Host-owned per-turn Pet profile services and authorized host action kinds. The Host validates the current conversation and exact Session after the turn; the tool cannot reroute messages directly.",
  CurrentTime:
    "Returns the Host's local clock and timezone without input or side effects. The external declaration still requires explicit Mimi host opt-in and Pet profile visibility, so it adds no general manager execution surface.",
  SendMessage:
    "Records an outbound message through the Host-owned per-turn Pet profile services. Exact target ids, text and attachment limits come from that turn's authorized targets; the Host validates and delivers after the turn, and acceptance is not delivery.",
};

/** External compatibility is metadata only; the original executor and guards stay intact. */
function withManagerExternalExposure(tool: BuiltinTool): BuiltinTool {
  if (!PET_ALLOWED_TOOL_NAMES.has(tool.definition.name)) return tool;
  const reason = PET_MANAGER_EXTERNAL_REASONS[tool.definition.name];
  // Future manager tools require their own declaration and independent review.
  if (!reason) return tool;
  return {
    ...tool,
    exposure: {
      ...tool.exposure,
      external: {
        kind: tool.definition.name === "CurrentTime" ? "self-contained" : "host-loopback",
        status: "exposed",
        requires: "mimi-host",
        reason,
      },
    },
  };
}

function withManagerExternalCatalog(tools: BuiltinTool[]): BuiltinTool[] {
  return tools.map(withManagerExternalExposure);
}

/**
 * The Pet domain as a unified AgentModule. Wraps the legacy factory so the
 * report-to-mimi sink closure keeps binding the observer to the tools of the
 * SAME module instance.
 */
/** The preset Mimi's own Session runs with; work Sessions never use it. */
const MIMI_PRESET_NAME = "mimi";
/** Pet tools work Sessions use to reach Mimi; every other pet tool is Mimi's own. */
const MIMI_LINK_TOOL_NAMES = [
  reportToMimiToolDef.name,
  notifyMeToolDef.name,
  requestMimiDeliveryToolDef.name,
];
/** Core tools Mimi uses for her notes-based context. */
const MIMI_CORE_TOOL_NAMES = ["SaveContextNote", "NewContext", "SearchHistory"];

type PetModuleEngine = NonNullable<AgentModule["engine"]>;

/**
 * Mimi's preset: exactly the tools her behavior profile allows, all eager (no
 * ToolSearch). Prompt sections are the general system and tone sections; the
 * coding, orchestration and browser sections describe tools Mimi never has.
 */
function mimiPreset(
  catalogTools: readonly BuiltinTool[],
): NonNullable<PetModuleEngine["presets"]>[number] {
  const builtinTools = [...PET_ALLOWED_TOOL_NAMES];
  const own = new Set(builtinTools);
  return {
    name: MIMI_PRESET_NAME,
    label: "Mimi",
    description: "Mimi, the owner's assistant: delegates work, reports and reminds.",
    promptSections: ["base", "tone"],
    builtinTools,
    defaultPermissionRules: [
      ...catalogTools
        .filter((tool) => own.has(tool.definition.name))
        .flatMap((tool) => [...(tool.exposure.defaultPermissionRules ?? [])]),
      ...MIMI_CORE_TOOL_NAMES.map((tool) => ({ tool, decision: "allow" as const })),
    ],
  };
}

export function createPetModule(): AgentModule {
  const legacy = buildPetParts();
  const catalogTools = legacy.catalogTools ?? [];
  return {
    id: legacy.id,
    engine: {
      tools: catalogTools.map((tool) => ({ kind: "preset-tags" as const, tool })),
      presets: [mimiPreset(catalogTools)],
      // Work Sessions keep the tools that report to Mimi; Mimi's own manager
      // tools stay in her preset.
      presetExtensions: [
        { target: { allExcept: [MIMI_PRESET_NAME] }, tools: MIMI_LINK_TOOL_NAMES },
      ],
      behaviorProfiles: legacy.behaviorProfiles,
      // Mimi's durable lists reach her through the context ledger.
      dynamicContextProviders: mimiWorldLedgerProviders(),
    },
    protocol: {
      queries: {
        ...legacy.queries,
        [GET_PET_PROJECTION_SNAPSHOT_METHOD]: () => {
          throw new Error("Pet projection observer is unavailable");
        },
      },
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
  const reporters = new Map<ProtocolObserverHost, PetReportToMimiSink>();
  const attached = new Map<ProtocolObserverHost, Set<string>>();
  const closedSessions = new Set<string>();
  let sharedAcrossHosts = false;
  const rememberClosed = (sessionId: string) => {
    closedSessions.add(sessionId);
    if (closedSessions.size > 4096) closedSessions.delete(closedSessions.values().next().value!);
  };
  /** The one attached observer host that owns `sessionId`; undefined when absent or ambiguous. */
  const hostFor = (sessionId?: string): ProtocolObserverHost | undefined => {
    if (!sessionId) return undefined;
    const live = [...reporters.keys()].filter((host) => !host.isTransportDisconnected());
    const owners = live.filter((host) => attached.get(host)?.has(sessionId));
    if (owners.length) return owners.length === 1 ? owners[0] : undefined;
    if (closedSessions.has(sessionId)) return undefined;
    const residents = live.filter((host) =>
      host.getLiveSessionSnapshot().some((session) => session.sessionId === sessionId),
    );
    if (residents.length) return residents.length === 1 ? residents[0] : undefined;
    // The single-host path also serves child Sessions without a ChatSession entry.
    return !sharedAcrossHosts && live.length === 1 ? live[0] : undefined;
  };
  const reportFor = (sessionId?: string): PetReportToMimiSink | undefined => {
    const host = hostFor(sessionId);
    return host ? reporters.get(host) : undefined;
  };
  const ruleRequesterFor = (sessionId?: string): NoticeRuleHostRequester | undefined => {
    const host = hostFor(sessionId);
    const request = host?.requestHostAction;
    return request ? (sid, action, args) => request.call(host, sid, action, args) : undefined;
  };
  const createProtocolObserver = (host: ProtocolObserverHost) => {
    reporters.set(host, (event) =>
      host.notify(PET_REPORT_TO_MIMI_METHOD, event as unknown as Record<string, unknown>),
    );
    if (reporters.size > 1) sharedAcrossHosts = true;
    const sessions = new Set<string>();
    attached.set(host, sessions);
    const projection = createPetProjectionObserver(host);
    return {
      ...projection,
      onSessionAttached: (sessionId: string, lastActivityAt: number) => {
        sessions.add(sessionId);
        closedSessions.delete(sessionId);
        projection.onSessionAttached?.(sessionId, lastActivityAt);
      },
      onSessionClosed: (sessionId: string) => {
        sessions.delete(sessionId);
        rememberClosed(sessionId);
        projection.onSessionClosed?.(sessionId);
      },
      onServerClose: () => {
        for (const sessionId of sessions) rememberClosed(sessionId);
        reporters.delete(host);
        attached.delete(host);
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
    catalogTools: withManagerExternalCatalog([
      {
        definition: {
          ...requestMimiDeliveryToolDef,
          source: "builtin",
          permissionDefault: "ask",
          isReadOnly: false,
          isConcurrencySafe: false,
          // Talking to the owner or Mimi is not work on the task.
          bookkeeping: true,
        },
        execute: (args, ctx) => requestMimiDeliveryTool(args, ctx, reportFor(ctx?.sessionId)),
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
          // Talking to the owner or Mimi is not work on the task.
          bookkeeping: true,
        },
        execute: (args, ctx) => reportToMimiTool(args, ctx, reportFor(ctx?.sessionId)),
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: reportToMimiToolDef.name, decision: "allow" }],
          availability: reportToMimiAvailability,
        },
      },
      {
        definition: {
          ...notifyMeToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
          // Talking to the owner or Mimi is not work on the task.
          bookkeeping: true,
        },
        execute: (args, ctx) =>
          notifyMeTool(
            args,
            ctx,
            ruleRequesterFor(ctx?.isSubAgent === true ? ctx.rootSessionId : ctx?.sessionId),
          ),
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: notifyMeToolDef.name, decision: "allow" }],
          availability: notifyMeAvailability,
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
          // HARNESS_TAGS preset tags + explicit allow rule + pet-profile
          // availability. The definition is static: Workspaces and reusable
          // Sessions live in the trusted runtime context, so a frozen tool
          // table never carries a stale list.
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [{ tool: delegateWorkToolDef.name, decision: "allow" }],
          availability: delegateWorkAvailability,
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
          ...bindConversationSessionToolDef,
          source: "builtin",
          permissionDefault: "allow",
          isReadOnly: false,
          isConcurrencySafe: false,
        },
        execute: bindConversationSessionTool,
        exposure: {
          presetTags: ["harness-min", "general"],
          defaultPermissionRules: [
            { tool: bindConversationSessionToolDef.name, decision: "allow" },
          ],
          availability: bindConversationSessionAvailability,
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
        },
      },
      // Mimi's own notice tools (design §4.7). Reads ask the host synchronously;
      // changes are deferred host actions. Not declared for external runtimes.
      noticeTool(noticesToolDef, true, (args, ctx) =>
        noticesTool(args, ctx, ruleRequesterFor(ctx?.sessionId)),
      ),
      noticeTool(triggersToolDef, true, (args, ctx) =>
        triggersTool(args, ctx, ruleRequesterFor(ctx?.sessionId)),
      ),
      noticeTool(manageTriggerToolDef, false, manageTriggerTool),
      noticeTool(
        notificationSettingsToolDef,
        false,
        (args, ctx) => notificationSettingsTool(args, ctx, ruleRequesterFor(ctx?.sessionId)),
        notificationSettingsAvailability,
      ),
    ]),
  };
}

function noticeTool(
  definition: typeof noticesToolDef,
  readOnly: boolean,
  execute: BuiltinTool["execute"],
  availability: NonNullable<BuiltinTool["exposure"]>["availability"] = noticeToolsAvailability,
): BuiltinTool {
  return {
    definition: {
      ...definition,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: readOnly,
      isConcurrencySafe: readOnly,
    },
    execute,
    exposure: {
      presetTags: ["harness-min", "general"],
      defaultPermissionRules: [{ tool: definition.name, decision: "allow" }],
      availability,
    },
  };
}

/**
 * The actual bounded Mimi manager tools, shared by native and external hosts.
 * Hosts supply PET_BEHAVIOR_PROFILE's current visibility and run-scoped services;
 * this catalog does not supply those capabilities or bypass the reviewed gate.
 */
export const PET_MANAGER_TOOL_CATALOG: readonly BuiltinTool[] = Object.freeze(
  // A manager tool without its own reviewed external declaration (Mimi's
  // notice tools) stays native-only: it is never offered to an external runtime.
  buildPetParts().catalogTools.filter(
    (tool) => PET_ALLOWED_TOOL_NAMES.has(tool.definition.name) && tool.exposure.external,
  ),
);
