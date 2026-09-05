// Defined in shared/ and re-exported here: main derives browser partitions from
// the same prefix, so a second literal would let the two processes disagree
// about which buckets are process-local Quick Chats.
export { QUICK_CHAT_REPO_KEY, QUICK_CHAT_BUCKET_PREFIX } from "../shared/browser-partition";
import { QUICK_CHAT_BUCKET_PREFIX } from "../shared/browser-partition";

export type QuickChatContextMode = "full" | "blank";
export type QuickChatCreationStatus = "creating" | "ready" | "error";

export interface QuickChatSessionRef {
  key: string;
  ownerBucket: string;
  tabId: string;
  sessionId: string;
  bucket: string;
  cwd: string | null;
  sourceSessionId: string | null;
  sourceTitle?: string;
  /** Number of completed source events inherited by the side snapshot. */
  copiedEventCount?: number;
  contextMode: QuickChatContextMode;
  status: QuickChatCreationStatus;
  error?: { code?: number; message: string };
  creationNonce: string;
}

export function makeQuickChatSessionId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `qchat-${Date.now().toString(36)}-${rand}`;
}

export function makeQuickChatCreationNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isQuickChatSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === "string" && sessionId.startsWith("qchat-");
}

export function quickChatBucket(sessionId: string): string {
  return `${QUICK_CHAT_BUCKET_PREFIX}${sessionId}`;
}

export function isQuickChatBucket(bucket: string | null | undefined): boolean {
  return typeof bucket === "string" && bucket.startsWith(QUICK_CHAT_BUCKET_PREFIX);
}

export function quickChatSessionIdFromBucket(bucket: string): string | null {
  if (!isQuickChatBucket(bucket)) return null;
  const id = bucket.slice(QUICK_CHAT_BUCKET_PREFIX.length);
  return id || null;
}

export function quickChatTabKey(ownerBucket: string, tabId: string): string {
  return `${ownerBucket}@@${tabId}`;
}
