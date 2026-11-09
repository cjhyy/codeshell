import type {
  ProtocolObserverHost,
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import {
  NOTICE_CHANNEL_MAX_LENGTH,
  NOTICE_EVENTS,
  NOTICE_NOTE_MAX_LENGTH,
  PET_RULE_UPSERT_ACTION,
  parseNoticeEvents,
  parseNoticeRuleUpsertReply,
  type BoundChannel,
  type NoticeChannelReadiness,
  type NoticeRuleUpsert,
  type RuleEffect,
} from "./notice-rule.js";
import { isReportableSessionId } from "./report-to-mimi.js";
import { hasOnlyDeclaredToolArguments } from "./tool-arguments.js";

export const NOTIFY_ME_TOOL_NAME = "NotifyMe";

/** The attached observer host's `requestHostAction`, resolved per Session. */
export type NoticeRuleHostRequester = NonNullable<ProtocolObserverHost["requestHostAction"]>;

const DECLARED_ARGUMENTS = ["when", "scope", "channel", "attention", "note"] as const;

export const notifyMeToolDef: ToolDefinition = {
  name: NOTIFY_ME_TOOL_NAME,
  description:
    "Use when the owner asks to be told when this Session is done, fails or gets blocked. " +
    "If they name an IM (WeChat/weixin, Feishu/Lark, Telegram, Slack…), set channel to that " +
    "gateway channel id (wechat, lark, telegram, slack…); omit it when they don't name one; " +
    "if the id is wrong the host replies with the bound channels. " +
    "Call once; the host tracks completion — do not call RequestMimiDelivery at the end.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      when: {
        type: "array",
        minItems: 1,
        maxItems: NOTICE_EVENTS.length,
        uniqueItems: true,
        items: { type: "string", enum: [...NOTICE_EVENTS] },
        description: "Events to be told about. Default: all three.",
      },
      scope: {
        type: "string",
        enum: ["turn", "goal"],
        description:
          "turn = when the current piece of work ends; goal = when the Session's Goal ends. " +
          "Default: goal while a Goal is active, otherwise turn.",
      },
      channel: {
        type: "string",
        minLength: 1,
        maxLength: NOTICE_CHANNEL_MAX_LENGTH,
        description:
          'Gateway channel id the owner named (e.g. wechat, lark, telegram, slack), "desktop", ' +
          'or "auto" (default) to let the host pick.',
      },
      attention: {
        type: "string",
        enum: ["always", "important"],
        description: "always (default) or important = only when it needs the owner.",
      },
      note: {
        type: "string",
        minLength: 1,
        maxLength: NOTICE_NOTE_MAX_LENGTH,
        description: "Owner's extra ask for the notice, recorded as data only.",
      },
    },
  },
};

export function notifyMeAvailability(ctx: ToolVisibilityContext): boolean {
  // Sub-agents stay hidden: their tool context carries no parent Session id,
  // and the host loopback only serves live top-level Sessions.
  return (
    isReportableSessionId(ctx.sessionId) && ctx.isSubAgent !== true && ctx.behaviorProfile !== "pet"
  );
}

export async function notifyMeTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
  requestHostAction?: NoticeRuleHostRequester,
): Promise<string> {
  if (!isReportableSessionId(ctx?.sessionId))
    return "Error: NotifyMe requires a valid current Session.";
  if (ctx.isSubAgent === true) return "Error: NotifyMe is not available in a sub-agent.";
  if (!requestHostAction) return "Error: the host rule channel is unavailable.";
  const parsed = parseArguments(args);
  if (typeof parsed === "string") return parsed;
  const upsert: NoticeRuleUpsert = {
    sessionId: ctx.sessionId,
    createdBy: "notify-me",
    events: parsed.events,
    scope: parsed.scope ?? (hasActiveGoal(ctx, ctx.sessionId) ? "goal" : "turn"),
    channel: parsed.channel,
    attention: parsed.attention,
    ...(parsed.note ? { note: parsed.note } : {}),
  };
  let raw: unknown;
  try {
    raw = await requestHostAction(
      ctx.sessionId,
      PET_RULE_UPSERT_ACTION,
      upsert as unknown as Record<string, unknown>,
    );
  } catch (error) {
    return notSaved(error instanceof Error ? error.message : String(error));
  }
  const reply = parseNoticeRuleUpsertReply(raw);
  if (!reply) return notSaved("malformed host reply");
  if (reply.status === "unknown_channel") return unknownChannelText(upsert.channel, reply.channels);
  return savedText(reply.effect);
}

interface ParsedArguments {
  events: NoticeRuleUpsert["events"];
  scope?: NoticeRuleUpsert["scope"];
  channel: string;
  attention: NoticeRuleUpsert["attention"];
  note?: string;
}

function parseArguments(args: Record<string, unknown>): ParsedArguments | string {
  if (!hasOnlyDeclaredToolArguments(args, DECLARED_ARGUMENTS)) {
    return "Error: NotifyMe accepts only when, scope, channel, attention, and note.";
  }
  const events = args.when === undefined ? [...NOTICE_EVENTS] : parseNoticeEvents(args.when);
  if (!events) {
    return "Error: when must be a non-empty list of distinct events from done, failed, blocked.";
  }
  if (args.scope !== undefined && args.scope !== "turn" && args.scope !== "goal") {
    return "Error: scope must be turn or goal.";
  }
  if (
    args.attention !== undefined &&
    args.attention !== "always" &&
    args.attention !== "important"
  ) {
    return "Error: attention must be always or important.";
  }
  let channel = "auto";
  if (args.channel !== undefined) {
    channel = typeof args.channel === "string" ? args.channel.trim().toLowerCase() : "";
    if (
      !channel ||
      channel.length > NOTICE_CHANNEL_MAX_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(channel)
    ) {
      return `Error: channel must be auto, desktop, or a gateway channel id of 1 to ${NOTICE_CHANNEL_MAX_LENGTH} characters.`;
    }
  }
  let note: string | undefined;
  if (args.note !== undefined) {
    if (typeof args.note !== "string" || args.note.trim().length > NOTICE_NOTE_MAX_LENGTH) {
      return `Error: note must be text of at most ${NOTICE_NOTE_MAX_LENGTH} characters.`;
    }
    note = args.note.trim() || undefined;
  }
  return {
    events,
    ...(args.scope !== undefined ? { scope: args.scope as NoticeRuleUpsert["scope"] } : {}),
    channel,
    attention: (args.attention as NoticeRuleUpsert["attention"] | undefined) ?? "always",
    ...(note ? { note } : {}),
  };
}

/**
 * Tool contexts carry no `hasGoal`; read the Session's persisted Goal with
 * the same "active and not paused" rule the Engine uses for tool visibility.
 */
function hasActiveGoal(ctx: ToolContext, sessionId: string): boolean {
  try {
    const goal = ctx.engine?.getSessionManager?.()?.readActiveGoal?.(sessionId);
    return goal !== undefined && goal.paused !== true;
  } catch {
    return false;
  }
}

function notSaved(reason: string): string {
  return `Error: the notice rule was not saved (${reason}). Tell the owner it is not set up.`;
}

function readinessText(ready: NoticeChannelReadiness): string {
  if (ready === "ready") return "ready";
  if (ready === "unknown") return "readiness unknown until the first send";
  return "currently unavailable";
}

function unknownChannelText(requested: string, channels: readonly BoundChannel[]): string {
  const list = channels.length
    ? channels
        .map((channel) => `- ${channel.id}: ${channel.label} (${readinessText(channel.ready)})`)
        .join("\n")
    : "- none (no IM channel is bound; auto and desktop still work)";
  return [
    `Error: "${requested}" is not a bound gateway channel, so no notice rule was saved. Bound channels:`,
    list,
    "Pick one of these ids, or tell the owner which channels are bound.",
  ].join("\n");
}

function savedText(effect: RuleEffect): string {
  const via = effect.im
    ? `${effect.im.label} (${effect.im.channel}, ${readinessText(effect.im.ready)})`
    : "a desktop notification";
  return [
    `Notice rule ${effect.ruleId} saved: the owner will be told ${effect.fires}, via ${via}.`,
    ...(effect.quietHours ? [`Quiet hours: ${effect.quietHours}.`] : []),
    "Tell the owner exactly this; do not claim anything was sent.",
    "The host tracks completion; do not call RequestMimiDelivery for it.",
  ].join(" ");
}
