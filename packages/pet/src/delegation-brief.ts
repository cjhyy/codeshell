/**
 * The short brief a Work Session delegated by Mimi receives ahead of the
 * owner's objective in its first message. Pet owns the format so the host
 * that writes it and every reader that shows or summarises the request agree
 * on where the brief ends and the owner's words begin.
 */

export const DELEGATION_BRIEF_OPEN = "[Delegated by Mimi]";
export const DELEGATION_BRIEF_CLOSE = "[/Delegated by Mimi]";

export interface DelegationBriefInput {
  /** Where the owner asked Mimi: an IM conversation or the desktop. */
  origin: "im" | "desktop";
  /** Display name of the IM channel (微信, 飞书, Telegram, …) for an IM origin. */
  channelLabel?: string;
}

function originText(input: DelegationBriefInput): string {
  const label = input.channelLabel?.replace(/\s+/gu, " ").trim().slice(0, 40);
  if (input.origin === "im") return label || "a chat app";
  return "the desktop";
}

export function buildDelegationBrief(input: DelegationBriefInput): string {
  return [
    DELEGATION_BRIEF_OPEN,
    `Mimi started this Session for the owner from ${originText(input)}. The owner may be away from the computer.`,
    "- When you need a decision, use AskUserQuestionAsync with concrete options, mark one recommended, and set skippable.",
    "- The host reports completion automatically; do not call RequestMimiDelivery at the end.",
    "- Use ReportToMimi only for a milestone the owner would want before completion.",
    DELEGATION_BRIEF_CLOSE,
  ].join("\n");
}

/** The same guidance in one line, for an objective too long for the full brief. */
export function buildCompactDelegationBrief(input: DelegationBriefInput): string {
  return [
    DELEGATION_BRIEF_OPEN,
    `Mimi started this Session for the owner from ${originText(input)}; they may be away. Ask decisions with AskUserQuestionAsync (options, one recommended, skippable); the host reports completion.`,
    DELEGATION_BRIEF_CLOSE,
  ].join("\n");
}

/**
 * The owner's request without a leading delegation brief. Only a block at the
 * very start is removed, so an objective that quotes the markers is untouched.
 * A leading block that never closes (cut by a length bound) is all brief.
 */
export function stripDelegationBrief(text: string): string {
  const leading = text.length - text.trimStart().length;
  if (!text.startsWith(DELEGATION_BRIEF_OPEN, leading)) return text;
  const close = text.indexOf(DELEGATION_BRIEF_CLOSE, leading + DELEGATION_BRIEF_OPEN.length);
  if (close < 0) return "";
  return text.slice(close + DELEGATION_BRIEF_CLOSE.length).trimStart();
}
