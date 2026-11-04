/** Timestamp at delivery, including reconnect replay, so a phone never compares
 * a worker deadline directly with its own potentially skewed wall clock. */
export function stampApprovalClock(line: string, now = Date.now()): string {
  if (!line.includes("agent/approvalRequest")) return line;
  try {
    const message = JSON.parse(line);
    if (message?.method !== "agent/approvalRequest" || !Number.isFinite(message.params?.expiresAt))
      return line;
    return JSON.stringify({ ...message, serverTime: now });
  } catch {
    return line;
  }
}
