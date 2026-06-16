import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/** Subset of Electron's Cookie we rely on (keeps the formatter unit-testable). */
export interface ElectronCookieLike {
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  expirationDate?: number;
  name: string;
  value: string;
}

const BROWSER_PARTITION = "persist:browser";
const LEASE_DIR = join(tmpdir(), "codeshell-cookie-leases");
const LEASE_MAX_AGE_MS = 5 * 60 * 1000;

function bad(s: string): boolean {
  return s.includes("\t") || s.includes("\n") || s.includes("\r");
}

/**
 * Electron Cookie[] → Netscape cookies.txt string. Pure (no Electron import) so
 * it's unit-testable in bun. yt-dlp / curl / wget / aria2 all eat this format.
 */
export function formatNetscapeCookies(cookies: ElectronCookieLike[]): string {
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of cookies) {
    if (bad(c.name) || bad(c.value) || (c.domain && bad(c.domain))) continue;
    const domain = c.domain ?? "";
    const includeSub = c.hostOnly === true ? "FALSE" : "TRUE";
    const path = c.path ?? "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry =
      typeof c.expirationDate === "number" ? String(Math.floor(c.expirationDate)) : "0";
    lines.push([domain, includeSub, path, secure, expiry, c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

/** Lazily import Electron's session so the pure formatter stays test-friendly. */
async function browserSession(): Promise<Electron.Session> {
  const { session } = await import("electron");
  return session.fromPartition(BROWSER_PARTITION);
}

/** List distinct (leading-dot-stripped) domains that have cookies in the partition. */
export async function listCookieDomains(): Promise<string[]> {
  const all = await (await browserSession()).cookies.get({});
  const set = new Set<string>();
  for (const c of all) if (c.domain) set.add(c.domain.replace(/^\./, ""));
  return [...set].sort();
}

/** Read cookies for a domain (Electron's domain filter does suffix matching). */
export async function getCookiesForDomain(domain: string): Promise<ElectronCookieLike[]> {
  return (await (await browserSession()).cookies.get({ domain })) as ElectronCookieLike[];
}

/** Materialize a temporary cookies.txt for `domain`; returns its path. Caller cleans up. */
export async function createCookieLease(
  domain: string,
): Promise<{ filePath: string; count: number }> {
  const cookies = await getCookiesForDomain(domain);
  mkdirSync(LEASE_DIR, { recursive: true });
  // randomUUID (not just Date.now()+pid): two leases created in the same
  // millisecond would otherwise collide, so one overwrites the other's cookie
  // file and the first cleanupLease deletes a file still in use.
  const filePath = join(LEASE_DIR, `lease-${Date.now()}-${randomUUID()}.txt`);
  writeFileSync(filePath, formatNetscapeCookies(cookies), { mode: 0o600 });
  return { filePath, count: cookies.length };
}

export function cleanupLease(filePath: string): void {
  try {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Startup sweep: remove stale lease files older than LEASE_MAX_AGE_MS. */
export function sweepStaleLeases(now = Date.now()): void {
  try {
    if (!existsSync(LEASE_DIR)) return;
    for (const f of readdirSync(LEASE_DIR)) {
      const p = join(LEASE_DIR, f);
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
