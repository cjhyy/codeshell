/**
 * Thin typed wrapper over localStorage for the mobile remote's persisted
 * device identity. Keys keep the historical `cs.*` names so an already-paired
 * phone (paired against the old inline UI) keeps working after the rebuild.
 */
const K = {
  deviceId: "cs.deviceId",
  deviceSecret: "cs.deviceSecret",
  deviceName: "cs.deviceName",
} as const;

/**
 * Best-effort localStorage write. On a quota-constrained mobile browser
 * (iOS/Android default ~5MB) setItem throws QuotaExceededError; since these
 * calls run synchronously inside ws.onopen (the auth handshake), an uncaught
 * throw aborts onopen mid-flight → handshake never sent → blank app, no retry.
 * Swallow the write failure and let the caller proceed with the in-memory value;
 * losing persistence only means a fresh secret/name next session.
 */
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota / disabled storage — best-effort, value still returned to caller */
  }
}

export const deviceStore = {
  getId: (): string => localStorage.getItem(K.deviceId) ?? "",
  setId: (v: string): void => safeSet(K.deviceId, v),
  clearId: (): void => localStorage.removeItem(K.deviceId),

  /** Get the stable per-browser secret, minting+persisting one on first use.
   *  Mirrors the old getSecret() so existing devices keep the same secret. */
  getOrCreateSecret: (mint: () => string): string => {
    let s = localStorage.getItem(K.deviceSecret);
    if (!s) {
      s = mint();
      safeSet(K.deviceSecret, s);
    }
    return s;
  },

  /** Device display name, defaulting to a platform-derived label on first use. */
  getOrCreateName: (): string => {
    let n = localStorage.getItem(K.deviceName);
    if (!n) {
      const platform =
        (typeof navigator !== "undefined" && navigator.platform) || "Phone";
      n = `${platform} 浏览器`;
      safeSet(K.deviceName, n);
    }
    return n;
  },
} as const;
