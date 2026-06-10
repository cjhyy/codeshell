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

export const deviceStore = {
  getId: (): string => localStorage.getItem(K.deviceId) ?? "",
  setId: (v: string): void => localStorage.setItem(K.deviceId, v),
  clearId: (): void => localStorage.removeItem(K.deviceId),

  /** Get the stable per-browser secret, minting+persisting one on first use.
   *  Mirrors the old getSecret() so existing devices keep the same secret. */
  getOrCreateSecret: (mint: () => string): string => {
    let s = localStorage.getItem(K.deviceSecret);
    if (!s) {
      s = mint();
      localStorage.setItem(K.deviceSecret, s);
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
      localStorage.setItem(K.deviceName, n);
    }
    return n;
  },
} as const;
