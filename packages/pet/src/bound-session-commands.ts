/**
 * The parts of a bound conversation that must never involve a model.
 *
 * Leaving a Session has to work when the model is down, the worker is wedged,
 * or the bound Session itself is unreachable — otherwise a user can get stuck
 * inside a Session with no way out. So /mimi is matched by exact string here
 * and handled before anything else in the pipeline.
 *
 * Likewise, which assistant output reaches the chat is a fixed rule rather
 * than a judgement call: a bound conversation shows the turn's final answer
 * and the things the user must act on, never the intermediate stream.
 */

/** Commands recognized while a conversation is routed to a Work Session. */
export type BoundSessionCommand = "leave" | "status";

/**
 * Exact matches only. A fuzzy match would eventually swallow a real message
 * that merely mentions leaving, and losing user input into a control path is
 * worse than making the user type the command exactly.
 */
const LEAVE_COMMANDS = new Set(["/mimi", "/session leave", "返回 mimi", "退出 session"]);
const STATUS_COMMANDS = new Set(["/session", "/session status"]);

export function parseBoundSessionCommand(message: string): BoundSessionCommand | undefined {
  const normalized = message.trim().toLowerCase().replace(/\s+/gu, " ");
  if (LEAVE_COMMANDS.has(normalized)) return "leave";
  if (STATUS_COMMANDS.has(normalized)) return "status";
  return undefined;
}

/**
 * Assistant output a bound conversation may forward.
 *
 * `final` is the turn's answer. `decision` is an approval or AskUser question,
 * which must reach the user or the Session stalls invisibly. `terminal` is the
 * end-of-Session notice. Everything else — partial text, tool arguments, raw
 * tool results, token stream — stays in the Session.
 */
export type BoundReplyKind = "final" | "decision" | "terminal";

export interface BoundReplyCandidate {
  kind: BoundReplyKind | "partial" | "tool" | "progress";
  text: string;
}

export function shouldForwardBoundReply(candidate: BoundReplyCandidate): boolean {
  if (
    candidate.kind !== "final" &&
    candidate.kind !== "decision" &&
    candidate.kind !== "terminal"
  ) {
    return false;
  }
  return candidate.text.trim().length > 0;
}

/**
 * A normal message must never be read as an approval. Permission decisions
 * carry a signed one-time token; free text like "同意" is ordinary input that
 * happens to look like consent, and treating it as consent would let a chat
 * message authorize a destructive action.
 */
export function isApprovalDecision(_message: string): false {
  return false;
}

export interface StalePromptText {
  title: string;
  hint: string;
}

/**
 * The one-time reminder shown when a long-quiet conversation is still bound,
 * before the message is delivered to the Session.
 */
export function boundSessionStalePrompt(sessionTitle: string): StalePromptText {
  return {
    title: sessionTitle,
    hint: `这条消息会发送到「${sessionTitle}」。发送 /mimi 可以退出。`,
  };
}
