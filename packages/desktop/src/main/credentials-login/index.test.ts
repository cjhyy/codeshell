import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  loginAndCaptureCookies,
  hostnameOf,
  injectionScript,
  extractConsoleMessage,
  tokensFor,
  SENTINEL_SAVE,
  SENTINEL_CANCEL,
} from "./index.js";

/** Fixed nonce + its derived tokens, shared by the driven-login tests. */
const NONCE = "test-nonce-1234";
const TOK = tokensFor(NONCE);
import type { ElectronCookieLike } from "../credentials-service.js";
import type { BrowserHostHandle } from "../browser-host/index.js";

/** Fake handle whose webContents is an EventEmitter we can drive in tests. */
function makeFakeHandle(opts: {
  cookies: ElectronCookieLike[];
  username?: string;
}): { handle: BrowserHostHandle; wc: EventEmitter; closed: () => void; closeCalls: () => number } {
  const wc = new EventEmitter();
  let closeCount = 0;
  let onClosedCb: (() => void) | undefined;
  const handle: BrowserHostHandle = {
    webContents: wc as unknown as Electron.WebContents,
    loadURL: async () => {},
    executeJavaScript: async <T,>(code: string) => {
      // username script returns the configured username; injection returns undefined
      if (code.includes("avatar-btn") || code.includes("UserName") || code.includes("uname")) {
        return opts.username as unknown as T;
      }
      return undefined as unknown as T;
    },
    getCookies: async () => opts.cookies,
    close: () => {
      closeCount++;
    },
    onClosed: (cb) => {
      onClosedCb = cb;
    },
  };
  return {
    handle,
    wc,
    closed: () => onClosedCb?.(),
    closeCalls: () => closeCount,
  };
}

const ytLoggedIn: ElectronCookieLike[] = [
  { name: "LOGIN_INFO", value: "x".repeat(20), domain: ".youtube.com" },
  { name: "SID", value: "x".repeat(20), domain: ".youtube.com" },
  { name: "HSID", value: "x".repeat(20), domain: ".youtube.com" },
];

describe("hostnameOf / injectionScript", () => {
  test("hostnameOf parses, returns '' on garbage", () => {
    expect(hostnameOf("https://www.youtube.com/feed")).toBe("www.youtube.com");
    expect(hostnameOf("not a url")).toBe("");
  });
  test("injectionScript embeds the nonce-bound tokens, not bare prefixes", () => {
    const s = injectionScript(NONCE);
    expect(s).toContain(TOK.save);
    expect(s).toContain(TOK.cancel);
    // The buttons print the full prefix:nonce token (the bare prefix appears
    // only as part of that token, never standalone with a non-nonce suffix).
    expect(s).toContain(`${SENTINEL_SAVE}:${NONCE}`);
    expect(s).toContain(`${SENTINEL_CANCEL}:${NONCE}`);
  });
  test("a different window mints different tokens", () => {
    expect(tokensFor("a").save).not.toBe(tokensFor("b").save);
  });
});

describe("extractConsoleMessage (Electron signature compat)", () => {
  test("Electron ≥33: (event, {message})", () => {
    expect(extractConsoleMessage([{}, { message: SENTINEL_SAVE, versionId: 0 }])).toBe(SENTINEL_SAVE);
  });
  test("Electron <33: (event, level, message)", () => {
    expect(extractConsoleMessage([{}, 0, SENTINEL_SAVE])).toBe(SENTINEL_SAVE);
  });
  test("no message → empty string", () => {
    expect(extractConsoleMessage([{}, 0])).toBe("");
  });
});

describe("loginAndCaptureCookies", () => {
  test("invalid url → error, no window opened", async () => {
    let opened = false;
    const r = await loginAndCaptureCookies(
      { url: "garbage" },
      {
        open: async () => {
          opened = true;
          throw new Error("should not open");
        },
        destroy: async () => {},
      },
    );
    expect(r.ok).toBe(false);
    expect(opened).toBe(false);
  });

  test("SAVE sentinel → captures cookies + username + loginCheck, closes & destroys partition", async () => {
    const fake = makeFakeHandle({ cookies: ytLoggedIn, username: "Alice" });
    let destroyed: string | undefined;
    const p = loginAndCaptureCookies(
      { url: "https://www.youtube.com", platform: "youtube" },
      {
        open: async () => fake.handle,
        nonce: NONCE,
        destroy: async (part) => {
          destroyed = part;
        },
      },
    );
    // drive the save sentinel using the Electron ≥33 signature (event, {message})
    await Promise.resolve();
    fake.wc.emit("console-message", {}, { message: TOK.save, versionId: 0 });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.domain).toBe("www.youtube.com");
      expect(r.jar.map((c) => c.name)).toContain("LOGIN_INFO");
      expect(r.suggestedLabel).toBe("Alice");
      expect(r.loginCheck.ok).toBe(true);
    }
    expect(fake.closeCalls()).toBe(1);
    expect(destroyed).toMatch(/^persist:login-/);
  });

  test("guest-only cookies → ok=true result but loginCheck.ok=false (soft warn)", async () => {
    const guest: ElectronCookieLike[] = [
      { name: "VISITOR_INFO1_LIVE", value: "x".repeat(20), domain: ".youtube.com" },
      { name: "PREF", value: "x".repeat(20), domain: ".youtube.com" },
    ];
    const fake = makeFakeHandle({ cookies: guest });
    const p = loginAndCaptureCookies(
      { url: "https://www.youtube.com" },
      { open: async () => fake.handle, nonce: NONCE, destroy: async () => {} },
    );
    await Promise.resolve();
    fake.wc.emit("console-message", {}, 0, TOK.save);
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.loginCheck.ok).toBe(false);
  });

  test("CANCEL sentinel → cancelled, destroys partition, no capture", async () => {
    const fake = makeFakeHandle({ cookies: ytLoggedIn });
    let destroyed = false;
    const p = loginAndCaptureCookies(
      { url: "https://www.youtube.com" },
      { open: async () => fake.handle, nonce: NONCE, destroy: async () => { destroyed = true; } },
    );
    await Promise.resolve();
    fake.wc.emit("console-message", {}, 0, TOK.cancel);
    const r = await p;
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(destroyed).toBe(true);
  });

  test("user closes window → cancelled", async () => {
    const fake = makeFakeHandle({ cookies: ytLoggedIn });
    const p = loginAndCaptureCookies(
      { url: "https://www.youtube.com" },
      { open: async () => fake.handle, destroy: async () => {} },
    );
    await Promise.resolve();
    fake.closed();
    const r = await p;
    expect(r).toEqual({ ok: false, cancelled: true });
  });

  test("page forging a BARE prefix (no nonce) cannot trigger save/cancel", async () => {
    const fake = makeFakeHandle({ cookies: ytLoggedIn });
    let destroyed = false;
    const p = loginAndCaptureCookies(
      { url: "https://www.youtube.com" },
      { open: async () => fake.handle, nonce: NONCE, destroy: async () => { destroyed = true; } },
    );
    await Promise.resolve();
    // The page's own JS knows the public prefix but NOT this window's nonce.
    fake.wc.emit("console-message", {}, { message: SENTINEL_SAVE, versionId: 0 });
    fake.wc.emit("console-message", {}, { message: SENTINEL_CANCEL, versionId: 0 });
    fake.wc.emit("console-message", {}, { message: `${SENTINEL_SAVE}:wrong-nonce`, versionId: 0 });
    // None of those should settle the promise. The genuine token does.
    expect(destroyed).toBe(false);
    fake.wc.emit("console-message", {}, { message: TOK.save, versionId: 0 });
    const r = await p;
    expect(r.ok).toBe(true);
  });
});
