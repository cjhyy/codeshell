import type { SessionSummary } from "./transcripts";

/**
 * Attachments are owned by the engine session, not by the renderer's local
 * sidebar id. Legacy/imported sessions can have different ids, so staging with
 * the UI id makes core correctly reject the attachment as cross-session.
 */
export function resolveAttachmentSessionId(
  uiSessionId: string | null | undefined,
  sessions: readonly SessionSummary[],
): string | undefined {
  if (!uiSessionId) return undefined;
  const summary = sessions.find((session) => session.id === uiSessionId);
  return summary?.engineSessionId ?? uiSessionId;
}
