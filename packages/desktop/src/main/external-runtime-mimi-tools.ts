import type { GoalConfig, RegisteredTool, ToolRegistry } from "@cjhyy/code-shell-core";
import type { BuiltinToolExposure } from "@cjhyy/code-shell-core/extension";
import {
  NOTIFY_ME_TOOL_NAME,
  REPORT_TO_MIMI_TOOL_NAME,
  notifyMeAvailability,
  notifyMeTool,
  notifyMeToolDef,
  reportToMimiAvailability,
  reportToMimiTool,
  reportToMimiToolDef,
  type PetReportToMimiEvent,
} from "@cjhyy/code-shell-pet";
import { PET_RULE_UPSERT_ACTION } from "@cjhyy/code-shell-pet/protocol";
import type { HostActionHandler } from "./host-action-dispatch.js";

/**
 * Mimi's handlers in Desktop Main, called in-process for an external runtime
 * (there is no worker or protocol observer between them). Either may be absent.
 */
export interface ExternalRuntimeMimiHost {
  /** The NotifyMe host action (`PET_RULE_UPSERT_ACTION`, `PetNoticeWiring.upsertRule`). */
  upsertRule?: HostActionHandler;
  /** The one-way ReportToMimi event (`AgentBridge.publishPetReport`). */
  report?: (event: PetReportToMimiEvent) => void;
}

/** Main's handlers as they exist now; undefined when neither is available. */
export function externalRuntimeMimiHost(
  notices: { upsertRule: HostActionHandler } | null | undefined,
  bridge: { publishPetReport(params: unknown): void } | null | undefined,
): ExternalRuntimeMimiHost | undefined {
  if (!notices && !bridge) return undefined;
  return {
    ...(notices ? { upsertRule: (sid, args) => notices.upsertRule(sid, args) } : {}),
    ...(bridge ? { report: (event) => bridge.publishPetReport(event) } : {}),
  };
}

const EXTERNAL_MIMI_REASON =
  "Host-loopback to Mimi's handlers in Desktop Main for the Host-bound Session only. " +
  "NotifyMe arms an owner notice rule for this Session (no message is sent); ReportToMimi " +
  "starts a Mimi turn with the report. Both target only the owner and Mimi and are allowed " +
  "without approval, like the native registration; registered only when Main provides the handler.";

function mimiTool(
  definition: typeof notifyMeToolDef,
  availability: BuiltinToolExposure["availability"],
): { definition: RegisteredTool; exposure: BuiltinToolExposure } {
  return {
    definition: {
      ...definition,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: false,
      isConcurrencySafe: false,
      // Talking to the owner or Mimi is not work on the task.
      bookkeeping: true,
    },
    exposure: {
      presetTags: [],
      defaultPermissionRules: [{ tool: definition.name, decision: "allow" }],
      availability,
      external: {
        kind: "host-loopback",
        status: "exposed",
        requires: "mimi-host",
        reason: EXTERNAL_MIMI_REASON,
      },
    },
  };
}

/** The reviewed external declarations of the pet's NotifyMe and ReportToMimi. */
export const EXTERNAL_MIMI_TOOL_CATALOG: readonly {
  definition: RegisteredTool;
  exposure: BuiltinToolExposure;
}[] = [
  mimiTool(notifyMeToolDef, notifyMeAvailability),
  mimiTool(reportToMimiToolDef, reportToMimiAvailability),
];

export interface ExternalMimiToolBinding {
  /** The Host-bound business Session; never taken from the tool call. */
  sessionId: string;
  host: ExternalRuntimeMimiHost;
  /** This Session's persisted Goal (`ExternalRuntimeGoals.read`). */
  readGoal(): GoalConfig | undefined;
  /** Throws once this runtime has been replaced or stopped. */
  assertActive(): void;
}

/**
 * Register the live executors for the handlers Main provides and return
 * their names (what the exposure, preset rules and instructions add).
 */
export function registerExternalMimiTools(
  registry: Pick<ToolRegistry, "registerTool" | "unregisterTool">,
  binding: ExternalMimiToolBinding,
): string[] {
  const { host } = binding;
  const registered: string[] = [];
  for (const { definition, exposure } of EXTERNAL_MIMI_TOOL_CATALOG) {
    const name = definition.name;
    const execute =
      name === NOTIFY_ME_TOOL_NAME && host.upsertRule
        ? notifyMeExecutor(binding, host.upsertRule)
        : name === REPORT_TO_MIMI_TOOL_NAME && host.report
          ? reportExecutor(binding, host.report)
          : undefined;
    if (!execute) continue;
    registry.unregisterTool(name);
    registry.registerTool(definition, execute, exposure);
    registered.push(name);
  }
  return registered;
}

type Executor = Parameters<ToolRegistry["registerTool"]>[1] & {};

function notifyMeExecutor(
  binding: ExternalMimiToolBinding,
  upsertRule: HostActionHandler,
): Executor {
  return async (args, ctx) => {
    binding.assertActive();
    // The pet tool reads the Goal through a native Engine, which an external
    // runtime has none of: default the scope from this Session's own Goal.
    const goal = binding.readGoal();
    const scoped =
      args.scope === undefined
        ? { ...args, scope: goal !== undefined && goal.paused !== true ? "goal" : "turn" }
        : args;
    return notifyMeTool(scoped, ctx, async (_target, action, payload) => {
      if (action !== PET_RULE_UPSERT_ACTION) throw new Error(`unsupported host action: ${action}`);
      // The caller is the Host-bound Session: a rule for any other Session is refused.
      return upsertRule(binding.sessionId, payload);
    });
  };
}

function reportExecutor(
  binding: ExternalMimiToolBinding,
  report: (event: PetReportToMimiEvent) => void,
): Executor {
  return async (args, ctx) => {
    binding.assertActive();
    if (ctx?.sessionId !== binding.sessionId)
      return "Error: ReportToMimi requires a valid current Session.";
    return reportToMimiTool(args, ctx, report);
  };
}

/** One line of runtime guidance per Mimi tool actually registered. */
export function externalMimiToolInstructions(names: readonly string[]): string | undefined {
  const lines = [
    names.includes(NOTIFY_ME_TOOL_NAME) &&
      "When the owner asks to be told when this work is done, fails or gets stuck " +
        '(for example "微信告诉我" / "tell me on WeChat when done"), call NotifyMe once and ' +
        "tell them exactly what it returned; CodeShell sends the notice itself when the " +
        "turn or Goal ends, so do not send one yourself.",
    names.includes(REPORT_TO_MIMI_TOOL_NAME) &&
      "Use ReportToMimi to hand Mimi (the owner's assistant) a result, status or question " +
        "from this Session, for example for work Mimi delegated here.",
  ].filter((line): line is string => typeof line === "string");
  return lines.length > 0 ? lines.join(" ") : undefined;
}
