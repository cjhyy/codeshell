import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

/**
 * 拓取某域(含子域)的 cookie jar,供存成具名 cookie 凭证(第二期)。
 * 返回 Electron 原始 cookie 字段(含 hostOnly/secure/expirationDate,导回浏览器要用)。
 * **按域拓取,不取全量分区** —— 避免把别的站(YouTube/百度)混进该账号(设计稿决策)。
 */
export async function captureCookieJar(domain: string): Promise<ElectronCookieLike[]> {
  const cookies = await (await browserSession()).cookies.get({ domain });
  return cookies as ElectronCookieLike[];
}

/**
 * 切换账号:把某账号的 cookie jar 导回 persist:browser 覆盖当前登录态(设计稿 §5.5)。
 * 先**清空整分区 cookie**(切换语义=换成该账号的干净状态),再逐条 set。
 * 仅 cookie,不动 localStorage(已知局限)。返回成功写入的条数。
 */
export async function restoreCookiesToBrowser(
  jar: ElectronCookieLike[],
): Promise<{ count: number }> {
  const sess = await browserSession();
  await sess.clearStorageData({ storages: ["cookies"] });
  let count = 0;
  for (const c of jar) {
    // Electron cookies.set 需要一个 url 推断 secure/domain 上下文。
    const host = (c.domain ?? "").replace(/^\./, "");
    if (!host) continue;
    const scheme = c.secure ? "https" : "http";
    const url = `${scheme}://${host}${c.path ?? "/"}`;
    try {
      await sess.cookies.set({
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? "/",
        secure: c.secure,
        httpOnly: (c as { httpOnly?: boolean }).httpOnly,
        expirationDate: c.expirationDate,
        sameSite: (c as { sameSite?: "unspecified" | "no_restriction" | "lax" | "strict" })
          .sameSite,
      });
      count++;
    } catch {
      // 个别 cookie 因 host/secure 约束 set 失败时跳过,不中断整批导回。
    }
  }
  return { count };
}

/** Materialize a temporary cookies.txt for `domain`; returns its path. Caller cleans up. */
export async function createCookieLease(
  domain: string,
): Promise<{ filePath: string; count: number }> {
  const cookies = await getCookiesForDomain(domain);
  mkdirSync(LEASE_DIR, { recursive: true });
  const filePath = join(LEASE_DIR, `lease-${Date.now()}-${process.pid}.txt`);
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
