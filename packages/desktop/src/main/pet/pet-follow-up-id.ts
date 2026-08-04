import { createHash } from "node:crypto";

/** Stable opaque identity for one exact completion of one Work Session. */
export function petFollowUpId(sessionId: string, terminalAt: number): string {
  if (!sessionId || !Number.isFinite(terminalAt) || terminalAt < 0) {
    throw new Error("invalid follow-up source identity");
  }
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(String(terminalAt))
    .digest("base64url")
    .slice(0, 24);
  return `followup-${digest}`;
}
