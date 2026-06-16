/**
 * Cookie jar 工具(凭证模块第二期):core 侧的纯函数,把存进 CredentialStore 的
 * cookie 凭证(序列化的 jar)转成 yt-dlp/curl/wget/aria2 都吃的 Netscape cookies.txt。
 *
 * 形态与 desktop/src/main/credentials-service.ts 的 `formatNetscapeCookies` 一致
 * (desktop 在拓取那一刻用,core 在取用那一刻用)。core 不能 import desktop,故各持一份
 * 同语义的纯实现 —— 都无 Electron 依赖、可单测。
 */

/** 与 Electron Cookie 对齐的最小子集(jar 里存的就是这个)。 */
export interface CookieLike {
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  expirationDate?: number;
  name: string;
  value: string;
}

function bad(s: string): boolean {
  return s.includes("\t") || s.includes("\n") || s.includes("\r");
}

/** Cookie[] → Netscape cookies.txt 字符串。跳过含 TAB/换行的脏 cookie。 */
export function formatNetscapeCookies(cookies: CookieLike[]): string {
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

/**
 * 解析 cookie 凭证的 `secret`(序列化 jar)。容错:非数组/坏 JSON → 空数组。
 */
export function parseCookieJar(secret: string | undefined): CookieLike[] {
  if (!secret) return [];
  try {
    const parsed = JSON.parse(secret);
    return Array.isArray(parsed) ? (parsed as CookieLike[]) : [];
  } catch {
    return [];
  }
}
