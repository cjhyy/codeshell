/** Convert a Host deadline once at receipt. Legacy Hosts without clock metadata
 * retain their existing behavior; the Host remains the expiry authority. */
export function localDeadline(
  expiresAt: number,
  serverTime: unknown,
  localNow = Date.now(),
): number {
  return typeof serverTime === "number" && Number.isFinite(serverTime)
    ? localNow + Math.max(0, expiresAt - serverTime)
    : expiresAt;
}
