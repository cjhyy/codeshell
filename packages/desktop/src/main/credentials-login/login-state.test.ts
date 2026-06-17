import { describe, test, expect } from "bun:test";
import {
  evaluateLoginState,
  usernameScriptFor,
  sanitizeUsername,
} from "./login-state.js";
import type { ElectronCookieLike } from "../credentials-service.js";

const ck = (name: string, extra: Partial<ElectronCookieLike> = {}): ElectronCookieLike => ({
  name,
  value: "x".repeat(20),
  domain: ".youtube.com",
  ...extra,
});

describe("evaluateLoginState — known sites", () => {
  test("youtube: all required present → ok", () => {
    const jar = [ck("LOGIN_INFO"), ck("SID"), ck("HSID"), ck("VISITOR_INFO1_LIVE")];
    expect(evaluateLoginState(jar, "youtube.com")).toEqual({ ok: true });
  });

  test("youtube: missing some required → ok=false + missing list", () => {
    const jar = [ck("LOGIN_INFO"), ck("VISITOR_INFO1_LIVE"), ck("PREF")];
    const r = evaluateLoginState(jar, ".youtube.com");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["SID", "HSID"]);
  });

  test("youtube: guest-only cookies → ok=false (the original 5-cookie trap)", () => {
    const jar = ["VISITOR_INFO1_LIVE", "PREF", "VISITOR_PRIVACY_METADATA", "__Secure-YNID", "YSC"].map(
      (n) => ck(n),
    );
    expect(evaluateLoginState(jar, "youtube.com").ok).toBe(false);
  });

  test("subdomain matches the pattern (www.bilibili.com)", () => {
    const jar = [ck("SESSDATA"), ck("bili_jct"), ck("DedeUserID")];
    expect(evaluateLoginState(jar, "www.bilibili.com").ok).toBe(true);
  });
});

describe("evaluateLoginState — unknown sites (heuristic)", () => {
  test("a session-ish HttpOnly+Secure cookie → ok", () => {
    const jar = [ck("web_session", { domain: ".xiaohongshu.com", httpOnly: true, secure: true })];
    expect(evaluateLoginState(jar, "xiaohongshu.com").ok).toBe(true);
  });

  test("two long-valued non-noise cookies → ok", () => {
    const jar = [
      ck("a1", { domain: ".xiaohongshu.com" }),
      ck("gid", { domain: ".xiaohongshu.com" }),
    ];
    expect(evaluateLoginState(jar, "xiaohongshu.com").ok).toBe(true);
  });

  test("only noise/analytics cookies → ok=false", () => {
    const jar = [
      ck("_ga", { domain: ".xiaohongshu.com" }),
      ck("_gid", { domain: ".xiaohongshu.com" }),
    ];
    expect(evaluateLoginState(jar, "xiaohongshu.com").ok).toBe(false);
  });

  test("empty jar → ok=false", () => {
    expect(evaluateLoginState([], "xiaohongshu.com").ok).toBe(false);
  });
});

describe("usernameScriptFor / sanitizeUsername", () => {
  test("known site returns a script; unknown returns undefined", () => {
    expect(usernameScriptFor("youtube.com")).toContain("avatar-btn");
    expect(usernameScriptFor("xiaohongshu.com")).toBeUndefined();
  });

  test("sanitizeUsername: trims valid; rejects empty/non-string/too-long", () => {
    expect(sanitizeUsername("  Alice  ")).toBe("Alice");
    expect(sanitizeUsername("")).toBeUndefined();
    expect(sanitizeUsername(null)).toBeUndefined();
    expect(sanitizeUsername(123)).toBeUndefined();
    expect(sanitizeUsername("x".repeat(61))).toBeUndefined();
  });
});
