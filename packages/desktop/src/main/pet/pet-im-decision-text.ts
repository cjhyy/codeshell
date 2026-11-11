import { recommendedAnswer } from "@cjhyy/code-shell-core/internal";
import type { ImDecision } from "./pet-im-decisions.js";
import { MAX_NOTICE_BODY } from "./pet-notice-compose.js";
import type { ReplyItem } from "./pet-notice-reply-interpreter.js";
import type { NoticeSubmission, NoticeTarget } from "./pet-notice-types.js";

/**
 * What the owner reads about a pending decision: the prompt (plain words,
 * answered in the owner's own words and read by the reply model; no code),
 * the generic text for a chat that cannot answer, the expiry notice, and the
 * item the reply model is shown. Pure: the deadline and clock are passed in.
 */

/** Room left in a prompt for the code, instructions and deadline lines. */
const PROMPT_OVERHEAD = 400;
/** A question longer than this is only reviewable (and answerable) on the desktop. */
const QUESTION_BODY_MAX = MAX_NOTICE_BODY - PROMPT_OVERHEAD;

/** When a prompt is written: its deadline, the clock, and whether its chat may answer. */
export interface PromptMoment {
  end: number;
  now: number;
  answerable: boolean;
}

/** Model questions (AskUserQuestion*) — Core resolves their timeout itself. */
export function skippableEnvelope(envelope: ImDecision["envelope"]): boolean {
  return envelope.request.toolName === "__ask_user__" && envelope.request.args.skippable === true;
}

/** The recommended label(s) a timed-out model question defaults to (Core's rule). */
function recommended(entry: ImDecision): string | undefined {
  const args = entry.envelope.request.args;
  const options = Array.isArray(args.options)
    ? args.options.flatMap((option) =>
        option && typeof option.label === "string"
          ? [
              {
                label: option.label as string,
                description: "",
                recommended: option.recommended === true,
              },
            ]
          : [],
      )
    : [];
  return recommendedAnswer({ options, multiSelect: args.multiSelect === true });
}

export function choices(entry: ImDecision): string[] {
  const args = entry.envelope.request.args;
  return Array.isArray(args.options)
    ? args.options.flatMap((option) =>
        option && typeof option.label === "string" ? [option.label] : [],
      )
    : [];
}

/**
 * Only a private chat with an authenticated sender may answer: a route must be
 * a direct message with a sender; owner prompts go to the owner's own direct
 * chats, recognised by `isOwnerConversation`.
 */
export function canReply(target: NoticeTarget, ownerConversations: boolean): boolean {
  if (target.kind === "owner") return ownerConversations;
  return target.route.isDirectMessage === true && !!target.route.senderId;
}

export function questionBody(entry: ImDecision): string | undefined {
  const { toolName, description, args } = entry.envelope.request;
  const question =
    toolName === "__ask_user__"
      ? String(args.question ?? description ?? "需要你的回答")
      : `${toolName}\n${description ?? "工具请求执行许可"}\n${JSON.stringify(args, null, 2)}`;
  const options =
    toolName !== "__ask_user__"
      ? ["允许本次", "拒绝"]
      : Array.isArray(args.options)
        ? args.options.flatMap((option) =>
            option && typeof option.label === "string"
              ? [
                  `${option.label}${option.recommended === true ? "（推荐）" : ""}${typeof option.description === "string" && option.description ? ` — ${option.description}` : ""}`,
                ]
              : [],
          )
        : [];
  const body = [question, ...options.map((label, index) => `${index + 1}. ${label}`)].join("\n");
  return body.length <= QUESTION_BODY_MAX ? body : undefined;
}

/**
 * The question and options as notice facts (digest lines, replayed context).
 * A conversation that cannot answer gets neither the details nor the code.
 */
function decisionFacts(entry: ImDecision, answerable: boolean): NoticeSubmission["facts"] {
  if (!answerable) return entry.title ? { title: entry.title } : {};
  const { toolName, description, args } = entry.envelope.request;
  const question =
    toolName === "__ask_user__"
      ? String(args.question ?? description ?? "需要你的回答")
      : `${toolName}：${description ?? "工具请求执行许可"}`;
  const options =
    toolName !== "__ask_user__"
      ? [{ label: "允许本次" }, { label: "拒绝" }]
      : Array.isArray(args.options)
        ? args.options.flatMap((option) =>
            option && typeof option.label === "string"
              ? [
                  {
                    label: option.label as string,
                    ...(option.recommended === true ? { recommended: true } : {}),
                  },
                ]
              : [],
          )
        : [];
  return {
    ...(entry.title ? { title: entry.title } : {}),
    question,
    ...(options.length > 0 ? { options } : {}),
  };
}

/** A pending decision as the reply model sees it (its number is the caller's). */
export function decisionItem(
  entry: ImDecision,
  can: { skip: boolean; wait: boolean },
): Omit<ReplyItem, "ordinal" | "ref"> {
  const { toolName, args } = entry.envelope.request;
  const body = questionBody(entry);
  const title = entry.title ? { title: entry.title } : {};
  const decline = can.skip ? "skip" : "deny";
  if (toolName !== "__ask_user__")
    return {
      kind: "approval",
      ...title,
      text: body ?? `${toolName}（内容较长，只能在桌面查看）`,
      actions: body ? ["approve", "deny"] : ["deny"],
    };
  const labels = choices(entry);
  return {
    kind: "question",
    ...title,
    text: body ?? "问题较长，只能在桌面查看",
    // Too long to review in IM: only declining is offered, so no options either.
    ...(body && labels.length > 0 ? { options: labels } : {}),
    ...(args.multiSelect === true ? { multiSelect: true } : {}),
    actions: body ? ["answer", decline, ...(can.wait ? (["wait"] as const) : [])] : [decline],
  };
}

/** Bare replies that address this prompt: its options, 拒绝, and 跳过 for a model question. */
export function shortReplies(entry: ImDecision): string[] {
  return [
    "拒绝",
    // Only a model question can be skipped; a permission request is declined.
    ...(skippableEnvelope(entry.envelope) ? ["跳过"] : []),
    ...(entry.envelope.request.toolName === "__ask_user__" ? choices(entry) : ["允许本次"]),
  ];
}

/** What the "已超时" notice needs to know about its decision. */
export interface ExpirySource {
  code: string;
  sessionId: string;
  requestId: string;
  title?: string;
  ruleIds: string[];
  target: NoticeTarget;
}

export function entrySource(entry: ImDecision): ExpirySource {
  return {
    code: entry.code,
    sessionId: entry.envelope.sessionId,
    requestId: entry.envelope.requestId,
    ...(entry.title ? { title: entry.title } : {}),
    ruleIds: entry.delivery.ruleIds,
    target: entry.delivery.target,
  };
}

/** One P0 blocked notice per request; the router owns quiet hours, presence and caps. */
export function questionNotice(
  entry: ImDecision,
  dedupeKey: string,
  at: PromptMoment,
): NoticeSubmission {
  const { sessionId, requestId } = entry.envelope;
  const { delivery } = entry;
  const { end } = at;
  const facts = decisionFacts(entry, at.answerable);
  return {
    kind: "session.blocked",
    priority: "P0",
    dedupeKey,
    sessionId,
    requestId,
    ...(Number.isFinite(end) ? { expiresAt: end } : {}),
    ruleIds: delivery.ruleIds,
    ...(delivery.requiresAway ? { requiresAway: true } : {}),
    facts:
      delivery.target.kind === "owner"
        ? { ...facts, nonDirectBody: genericPrompt(entry, at) }
        : facts,
    attention: delivery.attention,
    channel: delivery.channel,
    target: delivery.target,
    body: promptText(entry, at),
    ...(delivery.reply ? { reply: true } : {}),
  };
}

/** Tells the conversation that got the prompt that it ended unanswered. */
export function expiredNotice(source: ExpirySource, channel: string): NoticeSubmission {
  const { sessionId, requestId } = source;
  const text = `${source.title ? `「${source.title}」的` : ""}确认已超时，本次操作未获授权。任务将收到阻塞原因；如需继续此操作，请重新发起任务。`;
  return {
    kind: "decision.expired",
    priority: "P1",
    dedupeKey: `${sessionId}:${requestId}:expired`,
    sessionId,
    ruleIds: source.ruleIds,
    facts: {
      ...(source.title ? { title: source.title } : {}),
      ...(source.target.kind === "owner"
        ? { nonDirectBody: "一项确认已超时，本次操作未获授权。" }
        : {}),
    },
    attention: "always",
    // The channel the prompt went out on, so the notice follows it there.
    channel,
    target: source.target,
    body: text,
    reply: true,
  };
}

function deadlineLine(entry: ImDecision, { end, now }: PromptMoment): string {
  const remaining = Math.max(1, Math.ceil((end - now) / 60_000));
  return !skippableEnvelope(entry.envelope)
    ? `剩余约 ${remaining} 分钟；电脑、微信和已连接的手机遥控共用截止时间，超时不会授权本次操作。`
    : !Number.isFinite(end)
      ? "这个问题会一直等你回答。"
      : `剩余约 ${remaining} 分钟；超时未回答将自动按默认处理。`;
}

/** No question, options or code: for chats that cannot answer (groups, unknown senders). */
function genericPrompt(entry: ImDecision, at: PromptMoment): string {
  return `任务正在等待确认，请打开桌面 Session 处理。\n${deadlineLine(entry, at)}`;
}

function promptText(entry: ImDecision, at: PromptMoment): string {
  const question = skippableEnvelope(entry.envelope);
  const { end } = at;
  const remaining = Math.max(1, Math.ceil((end - at.now) / 60_000));
  // Existing tasks lack sender identity; group conversations must not receive
  // private permission details.
  if (!at.answerable) return genericPrompt(entry, at);
  const fallback = question && Number.isFinite(end) ? recommended(entry) : undefined;
  const timeout =
    question && Number.isFinite(end)
      ? `剩余约 ${remaining} 分钟；超时未回答将${fallback !== undefined ? `自动选择推荐项「${fallback}」` : "自动跳过"}。想让它一直等也可以直接说。`
      : deadlineLine(entry, at);
  const who = entry.title ? `「${entry.title}」` : "一个会话";
  const body = questionBody(entry);
  if (!body) return `${who}在等你确认，内容较长，请打开桌面 Session 查看后处理。\n${timeout}`;
  if (entry.envelope.request.toolName !== "__ask_user__")
    return [`${who}想执行下面这一步，只允许这一次吗？直接回我就行。`, body, timeout].join("\n");
  return [
    `${who}问你：`,
    body,
    entry.envelope.request.args.multiSelect === true
      ? "可以选多个，直接回我就行。"
      : "直接回我就行。",
    question ? "不想回答可以说跳过。" : "",
    timeout,
  ]
    .filter(Boolean)
    .join("\n");
}
