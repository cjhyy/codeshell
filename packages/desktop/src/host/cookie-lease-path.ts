import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const browserCookieLeaseDirectory = join(tmpdir(), "codeshell-cookie-leases");
const LEASE_MAX_AGE_MS = 5 * 60 * 1000;

export function cookieLeasePath(token: string) {
  if (typeof token !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token))
    throw Error("Invalid Cookie lease");
  // Preserve the Core startup sweep prefix for interrupted and older clients.
  return join(tmpdir(), `codeshell-cred-cookie-${token}.txt`);
}

/** Startup sweep: remove stale lease files older than LEASE_MAX_AGE_MS. */
export function sweepStaleLeases(now = Date.now()): void {
  try {
    if (!existsSync(browserCookieLeaseDirectory)) return;
    for (const f of readdirSync(browserCookieLeaseDirectory)) {
      const p = join(browserCookieLeaseDirectory, f);
      try {
        if (now - statSync(p).mtimeMs > LEASE_MAX_AGE_MS) rmSync(p, { force: true });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* best-effort */
  }
}
