import type { TFunction } from "../i18n";
import { describeActivity, summarizeLiveActivity } from "../topbar/liveActivity";
import { parsedArgs, truncate } from "../tool-cards/utils";
import type { Message, ToolMessage } from "../types";

export type PetChatActivityPhase =
  | "understanding"
  | "thinking"
  | "replying"
  | "working"
  | "continuing"
  | "adjusting";

export interface PetChatActivity {
  text: string;
  phase: PetChatActivityPhase;
  toolName?: string;
}

const GENERIC_DESCRIBED_TOOLS = new Set([
  "Bash",
  "Edit",
  "Write",
  "Read",
  "NotebookEdit",
  "Grep",
  "Glob",
  "Skill",
  "Agent",
  "WebFetch",
  "WebSearch",
]);

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function detail(value: string): string {
  return truncate(value, 64);
}

function genericToolActivity(tool: ToolMessage): string {
  return describeActivity({
    lastToolName: tool.toolName,
    lastTool: tool,
    toolCount: 1,
    turnStartedAt: tool.startedAt,
    toolInFlight: tool.status === "running",
  });
}

function safeToolName(name: string): string {
  const safe = name
    .replace(/[^\p{L}\p{N}_.:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncate(safe, 40);
}

function runningPetToolActivity(tool: ToolMessage, t: TFunction): string {
  const args = parsedArgs(tool);
  const query = detail(stringArg(args, "query"));
  switch (tool.toolName) {
    case "DelegateWork": {
      const objective = detail(stringArg(args, "objective"));
      const resuming = Boolean(stringArg(args, "session_id"));
      if (objective) {
        return t(
          resuming
            ? "pet.chat.activity.resumingSessionDetail"
            : "pet.chat.activity.delegatingSessionDetail",
          { detail: objective },
        );
      }
      return t(
        resuming ? "pet.chat.activity.resumingSession" : "pet.chat.activity.delegatingSession",
      );
    }
    case "Sessions": {
      const action = stringArg(args, "action");
      if (action === "search" && query) {
        return t("pet.chat.activity.searchingSessionsDetail", { detail: query });
      }
      if (action === "describe") return t("pet.chat.activity.readingSession");
      return t("pet.chat.activity.checkingSessions");
    }
    case "FollowUps": {
      const action = stringArg(args, "action");
      if (action === "search" && query) {
        return t("pet.chat.activity.searchingFollowUpsDetail", { detail: query });
      }
      return action === "get"
        ? t("pet.chat.activity.readingFollowUp")
        : t("pet.chat.activity.checkingFollowUps");
    }
    case "ManageFollowUp":
      return t("pet.chat.activity.updatingFollowUp");
    case "Gateway":
      return stringArg(args, "action") === "describe"
        ? t("pet.chat.activity.checkingChannel")
        : t("pet.chat.activity.searchingChannels");
    case "GatewayReply":
      return t("pet.chat.activity.replyingToChannel");
    case "SendMessage":
      return t("pet.chat.activity.sendingMessage");
    case "Memory":
      return t("pet.chat.activity.updatingMemory");
    case "ControlLongTask":
      return t("pet.chat.activity.controllingLongTask");
    case "WatchSession":
      return t("pet.chat.activity.watchingSession");
    case "ManageSessions":
      return t("pet.chat.activity.archivingSessions");
    case "MobileRemote":
      return stringArg(args, "action") === "close"
        ? t("pet.chat.activity.closingMobileRemote")
        : t("pet.chat.activity.openingMobileRemote");
    case "CurrentTime":
      return t("pet.chat.activity.checkingTime");
    default:
      if (GENERIC_DESCRIBED_TOOLS.has(tool.toolName)) return genericToolActivity(tool);
      return t("pet.chat.activity.runningTool", {
        tool: safeToolName(tool.toolName) || t("pet.chat.activity.unknownTool"),
      });
  }
}

function petToolStepLabel(tool: ToolMessage, t: TFunction): string {
  const args = parsedArgs(tool);
  const objective = detail(stringArg(args, "objective"));
  const query = detail(stringArg(args, "query"));
  switch (tool.toolName) {
    case "DelegateWork":
      return objective
        ? t("pet.chat.activity.step.sessionDelegationDetail", { detail: objective })
        : t("pet.chat.activity.step.sessionDelegation");
    case "Sessions":
      return query
        ? t("pet.chat.activity.step.sessionSearchDetail", { detail: query })
        : t("pet.chat.activity.step.sessionLookup");
    case "FollowUps":
      return query
        ? t("pet.chat.activity.step.followUpSearchDetail", { detail: query })
        : t("pet.chat.activity.step.followUpLookup");
    case "ManageFollowUp":
      return t("pet.chat.activity.step.followUpUpdate");
    case "Gateway":
      return t("pet.chat.activity.step.channelLookup");
    case "GatewayReply":
      return t("pet.chat.activity.step.channelReply");
    case "SendMessage":
      return t("pet.chat.activity.step.messageSend");
    case "Memory":
      return t("pet.chat.activity.step.memoryUpdate");
    case "ControlLongTask":
      return t("pet.chat.activity.step.longTaskControl");
    case "WatchSession":
      return t("pet.chat.activity.step.sessionWatch");
    case "ManageSessions":
      return t("pet.chat.activity.step.sessionArchive");
    case "MobileRemote":
      return t("pet.chat.activity.step.mobileRemote");
    case "CurrentTime":
      return t("pet.chat.activity.step.timeLookup");
    default:
      if (GENERIC_DESCRIBED_TOOLS.has(tool.toolName)) return genericToolActivity(tool);
      return safeToolName(tool.toolName) || t("pet.chat.activity.unknownTool");
  }
}

/**
 * Turn Mimi's hidden thinking/tool stream into one truthful, user-facing live
 * status. The manager transcript stays uncluttered, while the busy bubble says
 * which concrete step is running instead of showing a fixed catch-all label.
 */
export function describePetChatActivity(
  messages: readonly Message[],
  t: TFunction,
): PetChatActivity {
  const activity = summarizeLiveActivity(messages as Message[]);
  if (activity.toolInFlight && activity.lastTool) {
    return {
      text: runningPetToolActivity(activity.lastTool, t),
      phase: "working",
      toolName: safeToolName(activity.lastTool.toolName),
    };
  }

  const latest = messages.at(-1);
  if (latest?.kind === "assistant" && latest.text.trim()) {
    return { text: t("pet.chat.activity.replying"), phase: "replying" };
  }
  if (latest?.kind === "thinking") {
    return { text: t("pet.chat.activity.thinking"), phase: "thinking" };
  }

  if (activity.lastTool) {
    const step = petToolStepLabel(activity.lastTool, t);
    if (
      activity.lastTool.status === "failed" ||
      activity.lastTool.status === "denied" ||
      activity.lastTool.status === "cancelled"
    ) {
      return {
        text: t("pet.chat.activity.adjustingAfterStep", { step }),
        phase: "adjusting",
        toolName: safeToolName(activity.lastTool.toolName),
      };
    }
    return {
      text: t("pet.chat.activity.continuingAfterStep", { step }),
      phase: "continuing",
      toolName: safeToolName(activity.lastTool.toolName),
    };
  }

  return { text: t("pet.chat.activity.understanding"), phase: "understanding" };
}
