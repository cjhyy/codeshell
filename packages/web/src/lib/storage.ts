/**
 * Thin typed wrapper over localStorage for the mobile remote's persisted
 * device identity. Keys keep the historical `cs.*` names so an already-paired
 * phone (paired against the old inline UI) keeps working after the rebuild.
 */
import { translate } from "../i18n/translate.js";
import { loadUILanguage } from "./uiLanguage.js";

const K = {
  deviceId: "cs.deviceId",
  deviceSecret: "cs.deviceSecret",
  deviceName: "cs.deviceName",
} as const;

/**
 * Values whose localStorage write failed in this page. Reads prefer them, so
 * one page stays self-consistent even when nothing can be persisted: pairing
 * and the authentication that follows must present the same secret.
 */
const unpersisted = new Map<string, string>();

/**
 * Best-effort localStorage write. On a quota-constrained mobile browser
 * (iOS/Android default ~5MB) setItem throws QuotaExceededError; since these
 * calls run synchronously inside ws.onopen (the auth handshake), an uncaught
 * throw aborts onopen mid-flight → handshake never sent → blank app, no retry.
 * Swallow the write failure and keep the value for this page instead; losing
 * persistence only means a fresh secret/name next session.
 */
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    unpersisted.delete(key);
  } catch {
    /* quota / disabled storage — keep the value for the rest of this page */
    unpersisted.set(key, value);
  }
}

function safeGet(key: string): string | null {
  const local = unpersisted.get(key);
  if (local !== undefined) return local;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const deviceStore = {
  getId: (): string => safeGet(K.deviceId) ?? "",
  setId: (v: string): void => safeSet(K.deviceId, v),
  clearId: (): void => {
    unpersisted.delete(K.deviceId);
    try {
      localStorage.removeItem(K.deviceId);
    } catch {
      /* disabled storage has nothing persisted to remove */
    }
  },

  /** Get the stable per-browser secret, minting+persisting one on first use.
   *  Mirrors the old getSecret() so existing devices keep the same secret. */
  getOrCreateSecret: (mint: () => string): string => {
    let s = safeGet(K.deviceSecret);
    if (!s) {
      s = mint();
      safeSet(K.deviceSecret, s);
    }
    return s;
  },

  /** Device display name, defaulting to a readable device · browser label on first use. */
  getOrCreateName: (): string => {
    let n = safeGet(K.deviceName);
    const platform = typeof navigator !== "undefined" ? navigator.platform : "";
    // Earlier builds stored the raw `navigator.platform` ("MacIntel 浏览器"). That
    // exact generated value is not a name the user chose, so it is replaced.
    const legacy =
      !!platform &&
      (["zh", "en"] as const).some(
        (language) => n === translate(language, "mobile.storage.browserDevice", { platform }),
      );
    if (!n || legacy) {
      n =
        typeof navigator !== "undefined"
          ? describeDevice(navigator.userAgent, platform, navigator.maxTouchPoints)
          : "";
      if (!n)
        n = translate(loadUILanguage(), "mobile.storage.browserDevice", { platform: "Phone" });
      safeSet(K.deviceName, n);
    }
    return n;
  },
} as const;

/** "iPhone · Safari"-style label; empty when the user agent says nothing useful. */
export function describeDevice(userAgent = "", platform = "", maxTouchPoints = 0): string {
  const ua = userAgent;
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Mac/.test(platform) && maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac/.test(platform) || /Macintosh/.test(ua)
          ? "Mac"
          : /Win/.test(platform) || /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(platform) || /Linux/.test(ua)
                ? "Linux"
                : "";
  const browser = /MicroMessenger/.test(ua)
    ? "微信"
    : /EdgA?\//.test(ua)
      ? "Edge"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  return [device, browser].filter(Boolean).join(" · ");
}
