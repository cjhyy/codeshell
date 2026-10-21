/**
 * Lock options for the synchronous state.json lease that an output-journal
 * repair or identity migration holds for one operation.
 *
 * Both operations check the lease themselves (same lock directory inode) and
 * deliberately skip release when it was replaced, so they never delete a
 * competitor's lock. proper-lockfile still refreshes that unreleased lease on
 * a timer; once it finds the lease compromised its default handler throws
 * from the timer into whatever runs next. A lost lease is already reported
 * synchronously, so the late signal only lets the library stop its timer.
 */
export const STATE_LEASE_LOCK_OPTIONS = {
  realpath: false,
  retries: 0,
  stale: 120_000,
  update: 60_000,
  onCompromised: () => undefined,
} as const;
