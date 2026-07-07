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

export const BROWSER_PARTITION = "persist:browser";
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

export function sanitizeBrowserPartition(partition?: string): string {
  if (partition === BROWSER_PARTITION || partition?.startsWith(`${BROWSER_PARTITION}:`)) {
    return partition;
  }
  return BROWSER_PARTITION;
}

/**
 * Lazily import Electron's session so the pure formatter stays test-friendly.
 * Accepts a browser partition string OR a live Electron.Session (the latter for
 * callers that only hold a webContents.session, e.g. AI-driven cookie inject
 * targeting the active guest — Electron exposes no partition string on Session).
 */
async function browserSession(target?: string | Electron.Session): Promise<Electron.Session> {
  if (target && typeof target !== "string") return target;
  const { session } = await import("electron");
  return session.fromPartition(sanitizeBrowserPartition(target));
}

/** List distinct (leading-dot-stripped) domains that have cookies in the partition. */
export async function listCookieDomains(partition?: string): Promise<string[]> {
  const all = await (await browserSession(partition)).cookies.get({});
  const set = new Set<string>();
  for (const c of all) if (c.domain) set.add(c.domain.replace(/^\./, ""));
  return [...set].sort();
}

/** Read cookies for a domain (Electron's domain filter does suffix matching). */
export async function getCookiesForDomain(
  domain: string,
  partition?: string,
): Promise<ElectronCookieLike[]> {
  return (await (await browserSession(partition)).cookies.get({ domain })) as ElectronCookieLike[];
}

/**
 * 拓取某域(含子域)的 cookie jar,供存成具名 cookie 凭证(第二期)。
 * 返回 Electron 原始 cookie 字段(含 hostOnly/secure/expirationDate,导回浏览器要用)。
 * **按域拓取,不取全量分区** —— 避免把别的站(YouTube/百度)混进该账号(设计稿决策)。
 */
export async function captureCookieJar(
  domain: string,
  partition?: string,
): Promise<ElectronCookieLike[]> {
  const cookies = await (await browserSession(partition)).cookies.get({ domain });
  return cookies as ElectronCookieLike[];
}

/**
 * 拓取 persist:browser 分区的**全量** cookie(不按域过滤)。
 * 用于「按域拓不全」的站(如小红书登录态分散在多个域 / 子域,按主域抓会漏)——
 * 把整个分区的 cookie 整包存成一条凭证,切换时整包导回。
 * 代价:jar 里会混入其他站的 cookie(用户主动选「全量」时接受)。
 */
export async function captureAllCookies(partition?: string): Promise<ElectronCookieLike[]> {
  const cookies = await (await browserSession(partition)).cookies.get({});
  return cookies as ElectronCookieLike[];
}

function cookieDedupeKey(c: ElectronCookieLike): string {
  return [c.domain ?? "", c.name, c.path ?? "/"].join("\t");
}

/**
 * Capture all cookies from multiple live browser sessions or known browser
 * partition strings, merging by domain+name+path. First source wins when two
 * sessions have different values for the same cookie key.
 */
export async function captureAllCookiesFromSessions(
  sources: Array<string | Electron.Session>,
): Promise<{ jar: ElectronCookieLike[]; count: number }> {
  const sessions: Electron.Session[] = [];
  const seenSessions = new Set<Electron.Session>();
  const seenPartitions = new Set<string>();

  for (const source of sources) {
    if (typeof source === "string") {
      const partition = sanitizeBrowserPartition(source);
      if (seenPartitions.has(partition)) continue;
      seenPartitions.add(partition);
      const sess = await browserSession(partition);
      if (seenSessions.has(sess)) continue;
      seenSessions.add(sess);
      sessions.push(sess);
      continue;
    }
    if (seenSessions.has(source)) continue;
    seenSessions.add(source);
    sessions.push(source);
  }

  const merged = new Map<string, ElectronCookieLike>();
  for (const sess of sessions) {
    const cookies = (await sess.cookies.get({})) as ElectronCookieLike[];
    for (const cookie of cookies) {
      const key = cookieDedupeKey(cookie);
      if (!merged.has(key)) merged.set(key, cookie);
    }
  }

  const jar = [...merged.values()];
  return { jar, count: jar.length };
}

/**
 * 切换账号:把某账号的 cookie jar 导回 persist:browser 覆盖当前登录态(设计稿 §5.5)。
 * mode="merge"(默认)跳过清空,只逐条 set(覆盖同名、保留分区里其他站的登录态);
 * mode="clear" 先**清空整分区 cookie**(干净换号),再逐条 set。
 * 仅 cookie,不动 localStorage(已知局限)。返回成功写入的条数。
 */
export async function restoreCookiesToBrowser(
  jar: ElectronCookieLike[],
  mode: "clear" | "merge" = "merge",
  partition?: string | Electron.Session,
): Promise<{ count: number }> {
  const sess = await browserSession(partition);
  if (mode !== "merge") await sess.clearStorageData({ storages: ["cookies"] });
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
  partition?: string,
): Promise<{ filePath: string; count: number }> {
  const cookies = await getCookiesForDomain(domain, partition);
  // 0o700: lease files hold live session cookies (0o600). The dir lives under a
  // shared /tmp, so make it owner-only too — co-located users shouldn't even
  // enumerate the lease filenames. (audit Y-4)
  mkdirSync(LEASE_DIR, { recursive: true, mode: 0o700 });
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
