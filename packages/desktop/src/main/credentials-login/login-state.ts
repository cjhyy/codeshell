/**
 * 登录态校验 + 用户名抓取(纯逻辑,无 Electron 依赖,可单测)。
 *
 * 用于「独立窗口登录抓 cookie」流程:用户点「我已登录,保存」后,判断 jar 里是不是**真登录态**
 * (而非游客 cookie),防止把 YouTube 没登录也有的 VISITOR_INFO/PREF 等当成登录态存进去。
 *
 * 双层:
 *  - **已知站特征表**(精确):每站列出登录成功必有的 cookie 名,全在 → ok。
 *  - **未知站通用兜底**(启发式):有「会话类」cookie 或多个长随机值 cookie → ok。
 *
 * 校验结果是**软提示**用(ok=false 不硬拒,上层让用户确认是否仍保存),应对已知表过时。
 */

import type { ElectronCookieLike } from "../credentials-service.js";

/** 已知站登录态特征 cookie(子串匹配域名)。集中一处,加站只改这里。 */
export const LOGIN_COOKIE_PATTERNS: Record<string, { required: string[] }> = {
  "youtube.com": { required: ["LOGIN_INFO", "SID", "HSID"] },
  "google.com": { required: ["SID", "HSID", "SAPISID"] },
  "bilibili.com": { required: ["SESSDATA", "bili_jct", "DedeUserID"] },
  "x.com": { required: ["auth_token", "ct0"] },
  "twitter.com": { required: ["auth_token", "ct0"] },
  "instagram.com": { required: ["sessionid", "ds_user_id"] },
  "tiktok.com": { required: ["sessionid"] },
  "douyin.com": { required: ["sessionid", "sessionid_ss"] },
  "weibo.com": { required: ["SUB", "SUBP"] },
};

/** 明显的游客/分析类 cookie 名前缀,通用兜底里不计入「有意义的会话 cookie」。 */
const NOISE_PREFIXES = ["_ga", "_gid", "_gcl", "VISITOR_INFO", "PREF", "YSC", "__utm", "_fbp"];

export interface LoginCheck {
  ok: boolean;
  /** 已知站:缺的 required cookie 名(软提示用)。 */
  missing?: string[];
}

function matchPattern(domain: string): { required: string[] } | undefined {
  const d = domain.replace(/^\./, "").toLowerCase();
  for (const [pat, cfg] of Object.entries(LOGIN_COOKIE_PATTERNS)) {
    // 只用相等 / 后缀匹配,不用 includes(否则 x.com.attacker.net 会误中 x.com 表)。
    if (d === pat || d.endsWith("." + pat)) return cfg;
  }
  return undefined;
}

function isNoise(name: string): boolean {
  return NOISE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * 判断 jar(已按目标域过滤)是否构成真登录态。
 * - 已知站:required cookie 全在 → ok;缺 → ok=false + missing。
 * - 未知站:启发式 —— 有「会话类」cookie(HttpOnly+Secure 且 value 长 >10 非噪声)≥1,
 *   或「长随机值」非噪声 cookie ≥2 → ok。
 */
export function evaluateLoginState(jar: ElectronCookieLike[], domain: string): LoginCheck {
  const names = new Set(jar.map((c) => c.name));
  const pattern = matchPattern(domain);

  if (pattern) {
    const missing = pattern.required.filter((n) => !names.has(n));
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  // 未知站通用兜底
  const sessionish = jar.filter(
    (c) =>
      !isNoise(c.name) &&
      (c as { httpOnly?: boolean }).httpOnly === true &&
      c.secure === true &&
      (c.value?.length ?? 0) > 10,
  );
  if (sessionish.length >= 1) return { ok: true };

  const longValued = jar.filter((c) => !isNoise(c.name) && (c.value?.length ?? 0) > 10);
  if (longValued.length >= 2) return { ok: true };

  return { ok: false };
}

/**
 * 各站抓登录用户名的 in-page JS(自动命名账号用;抓不到不阻塞)。子串匹配域名。
 * 这些脚本在登录页上下文里跑,返回字符串或 null。
 */
export const USERNAME_SCRIPTS: Record<string, string> = {
  "youtube.com": `(function(){try{
    const btn=document.querySelector('button#avatar-btn img');
    if(btn&&btn.alt)return btn.alt;
    const d=window.ytInitialData?.responseContext?.serviceTrackingParams||[];
    for(const p of d)for(const x of (p.params||[]))if(x.key==='logged_in_username')return x.value;
    return null;}catch(e){return null;}})()`,
  "bilibili.com": `(function(){try{
    const el=document.querySelector('.header-entry-mini .nickname')||document.querySelector('.bili-header__username');
    if(el)return el.textContent?.trim()||null;
    if(window.__INITIAL_STATE__?.user?.uname)return window.__INITIAL_STATE__.user.uname;
    return null;}catch(e){return null;}})()`,
  "x.com": `(function(){try{
    const el=document.querySelector('[data-testid="UserName"]');
    return el?el.textContent?.split('@')[0]?.trim()||null:null;}catch(e){return null;}})()`,
  "twitter.com": `(function(){try{
    const el=document.querySelector('[data-testid="UserName"]');
    return el?el.textContent?.split('@')[0]?.trim()||null:null;}catch(e){return null;}})()`,
};

/** 取某域的用户名抓取脚本(无则 undefined)。 */
export function usernameScriptFor(domain: string): string | undefined {
  const d = domain.replace(/^\./, "").toLowerCase();
  for (const [pat, script] of Object.entries(USERNAME_SCRIPTS)) {
    // 只用相等 / 后缀匹配,不用 includes(同 matchPattern,防 x.com.attacker.net 误中)。
    if (d === pat || d.endsWith("." + pat)) return script;
  }
  return undefined;
}

/** 清洗抓到的用户名:剥控制字符、折叠空白、trim、限长;非空字符串才采纳。 */
export function sanitizeUsername(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // 先把空白(含 \t\n\r)折叠成单空格,再剥剩余的非空白控制字符 —— 顺序很关键:
  // \t\n\r 既是控制字符又是空白,先剥控制字符会把 "Alice\tWang" 粘成 "AliceWang"。
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!s || s.length > 60) return undefined;
  return s;
}
