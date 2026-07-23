import { createHash } from "node:crypto";

/** Same convention as desktop pet-dispatch-service reusableSessionId(). */
export function sessionSelectorId(sessionId: string): string {
  return `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 20)}`;
}
