import { getDomain } from "tldts";
import type { CookieLike } from "./cookie-jar.js";

/** A DNS cookie/account domain, excluding public and private suffixes. */
export function normalizeCookieDomain(raw: unknown): string | undefined {
  if (typeof raw !== "string") return;
  const value = raw.toLowerCase().replace(/^\./, "");
  if (
    value.length > 253 ||
    !value.includes(".") ||
    !value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !getDomain(value, { allowPrivateDomains: true })
  )
    return;
  return value;
}

/**
 * Whether a saved cookie can be sent to a host, without changing its scope.
 * Electron's hostOnly flag is authoritative. Legacy jars without it retain
 * the leading-dot convention also used by formatNetscapeCookies.
 */
export function cookieAppliesToHost(
  cookie: Pick<CookieLike, "domain" | "hostOnly">,
  rawHost: string,
): boolean {
  const host = normalizeCookieDomain(rawHost);
  const cookieDomain = normalizeCookieDomain(cookie.domain);
  if (
    !host ||
    !cookieDomain ||
    (cookie.hostOnly !== undefined && typeof cookie.hostOnly !== "boolean")
  )
    return false;
  if (host === cookieDomain) return true;
  const subdomains =
    cookie.hostOnly === false ||
    (cookie.hostOnly !== true && cookie.domain?.startsWith(".") === true);
  return subdomains && host.endsWith(`.${cookieDomain}`);
}
