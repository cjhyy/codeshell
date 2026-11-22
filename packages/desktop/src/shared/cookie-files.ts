import type { CookieExpirySummary } from "@cjhyy/code-shell-core";

export interface CookieLease {
  token: string;
  device: string;
  inode: string;
}

export interface CookieInspection {
  health: "ready" | "corrupted";
  cookieExpiry: CookieExpirySummary;
}

/** Private native-to-Host requests after credential resolution or for startup maintenance. */
export interface CookieFileOperations {
  "cookies/materialize": { input: { lease: CookieLease; secret: string }; result: number };
  "cookies/inspect": { input: { secrets: string[] }; result: CookieInspection[] };
  "cookies/sweep": { input: Record<string, never>; result: true };
}

export type CallCookieFile = <K extends keyof CookieFileOperations>(
  method: K,
  input: CookieFileOperations[K]["input"],
) => Promise<CookieFileOperations[K]["result"]>;
