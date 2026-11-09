import type { NoticeDraftOption } from "./pet-session-rule-watcher.js";

/** Session-derived facts a notice carries; all text is data, never instructions. */
export interface NoticeFacts {
  title?: string;
  summary?: string;
  error?: string;
  question?: string;
  options?: NoticeDraftOption[];
  /** Short reply code for answering a blocked decision over IM (supplied upstream). */
  code?: string;
}

/** One held notice as the digest lists it. */
export interface DigestMember {
  kind: string;
  facts: NoticeFacts;
}

export const MAX_NOTICE_BODY = 4_000;
export const DIGEST_MAX_LINES = 10;
const MAX_TITLE = 80;
const MAX_SUMMARY = 600;
const MAX_ERROR = 300;
const MAX_QUESTION = 400;
const MAX_OPTION = 120;
const MAX_OPTIONS = 10;
const MAX_CODE = 16;
const UNTITLED = "一个会话";

/** Collapse whitespace and control characters, then cap; empty → undefined. */
function line(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function title(facts: NoticeFacts): string {
  return line(facts.title, MAX_TITLE) ?? UNTITLED;
}

function withDetail(head: string, detail: string | undefined): string {
  return detail ? `${head}：${detail}` : head;
}

function blockedBody(facts: NoticeFacts): string {
  const lines = [withDetail(`「${title(facts)}」需要你决定`, line(facts.question, MAX_QUESTION))];
  const options = Array.isArray(facts.options) ? facts.options.slice(0, MAX_OPTIONS) : [];
  options.forEach((option, index) => {
    const label = line(option?.label, MAX_OPTION);
    if (label) lines.push(`${index + 1}. ${label}${option.recommended ? "（推荐）" : ""}`);
  });
  const code = line(facts.code, MAX_CODE);
  if (code) {
    lines.push(
      options.length > 0
        ? `回复：回答 ${code} 序号 / 跳过 ${code} / 等待 ${code}`
        : `回复：回答 ${code} 你的答复 / 跳过 ${code} / 等待 ${code}`,
    );
  }
  return lines.join("\n");
}

function cap(body: string): string {
  return body.length > MAX_NOTICE_BODY ? `${body.slice(0, MAX_NOTICE_BODY - 1)}…` : body;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  "session.done": "做完了",
  "session.failed": "没做完",
  "session.blocked": "等你决定",
};

/**
 * Plain-text body for one notice (no Markdown: IM channels render it
 * verbatim). A pre-written `body` (e.g. Mimi's closure message) wins.
 */
export function composeNoticeBody(kind: string, facts: NoticeFacts, body?: string): string {
  if (typeof body === "string" && body.trim()) return cap(body.trim());
  switch (kind) {
    case "session.blocked":
      return cap(blockedBody(facts));
    case "session.failed":
      return cap(withDetail(`「${title(facts)}」没做完`, line(facts.error, MAX_ERROR)));
    case "session.done":
      return cap(withDetail(`「${title(facts)}」做完了`, line(facts.summary, MAX_SUMMARY)));
    default:
      return cap(withDetail(`「${title(facts)}」`, line(facts.summary, MAX_SUMMARY)));
  }
}

/** "你不在时：" + one line per held notice, at most {@link DIGEST_MAX_LINES}. */
export function composeDigestBody(members: readonly DigestMember[]): string {
  const lines = ["你不在时："];
  for (const member of members.slice(0, DIGEST_MAX_LINES)) {
    const label = KIND_LABELS[member.kind] ?? member.kind;
    lines.push(`- 「${title(member.facts)}」${label}`);
  }
  if (members.length > DIGEST_MAX_LINES)
    lines.push(`…还有 ${members.length - DIGEST_MAX_LINES} 条`);
  return cap(lines.join("\n"));
}
