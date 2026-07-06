import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  loginAndCaptureCookies,
  hostnameOf,
  cookieDomainMatches,
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

  // Regression: the save bar judders on SPA sites (YouTube) because each page
  // navigation swaps out document.body, deleting our bar; the old script then
  // rebuilt it from scratch on did-finish-load → visible delete→recreate flicker.
  // The bar now self-heals via a MutationObserver that re-appends the SAME node,
  // and re-injection is a no-op while the node lives. We exercise the real
  // injected script against a minimal DOM stub to prove that behavior.
  describe("save bar self-heal (no judder on SPA body swap)", () => {
    function makeDomStub() {
      let observerCb: (() => void) | null = null;
      const makeEl = () => {
        const el: any = {
          style: {},
          children: [] as any[],
          parentNode: null as any,
          get isConnected() {
            // connected iff it chains up to documentElement
            let n: any = el;
            while (n) {
              if (n === root.documentElement) return true;
              n = n.parentNode;
            }
            return false;
          },
          appendChild(c: any) {
            if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x: any) => x !== c);
            c.parentNode = el;
            el.children.push(c);
            return c;
          },
          // Minimal stubs so the drag wiring (grip.addEventListener,
          // bar.getBoundingClientRect) doesn't throw when the script runs. Drag
          // *behavior* is verified at the string level + on the real machine.
          addEventListener() {},
          removeEventListener() {},
          getBoundingClientRect() {
            return { left: 0, top: 0, width: 0, height: 0 };
          },
        };
        return el;
      };
      const root: any = {
        documentElement: null as any,
        body: null as any,
        createElement: () => makeEl(),
        getElementById: () => null,
        addEventListener() {},
        removeEventListener() {},
      };
      root.documentElement = makeEl();
      root.documentElement.parentNode = root.documentElement; // root of the tree
      root.body = makeEl();
      root.documentElement.appendChild(root.body);
      const win: any = {
        innerWidth: 1280,
        innerHeight: 800,
        MutationObserver: class {
          constructor(cb: () => void) {
            observerCb = cb;
          }
          observe() {}
        },
      };
      return {
        win,
        document: root,
        // simulate a YouTube-style navigation that throws away the old body
        swapBody() {
          // detach the old body subtree (sever upward links, like real removal)
          for (const c of root.body.children) c.parentNode = null;
          root.body.children = [];
          root.body.parentNode = null;
          root.documentElement.children = [];
          root.body = makeEl();
          root.documentElement.appendChild(root.body);
          observerCb?.(); // mutation fires
        },
      };
    }

    function run(script: string, env: ReturnType<typeof makeDomStub>) {
      // The script reads bare `document`/`window`/`MutationObserver` globals.
      new Function("window", "document", "MutationObserver", script)(
        env.win,
        env.document,
        env.win.MutationObserver,
      );
    }

    const barIn = (env: ReturnType<typeof makeDomStub>) =>
      env.document.body.children.find((c: any) => c.id === "__cs_login_bar__");

    test("bar is appended once on initial inject", () => {
      const env = makeDomStub();
      run(injectionScript(NONCE), env);
      expect(barIn(env)).toBeTruthy();
      expect(env.document.body.children.filter((c: any) => c.id === "__cs_login_bar__").length).toBe(1);
    });

    test("re-injecting (did-finish-load) does NOT create a second bar or a new node", () => {
      const env = makeDomStub();
      run(injectionScript(NONCE), env);
      const first = barIn(env);
      run(injectionScript(NONCE), env); // simulate did-finish-load re-inject
      expect(env.document.body.children.filter((c: any) => c.id === "__cs_login_bar__").length).toBe(1);
      expect(barIn(env)).toBe(first); // SAME node, not rebuilt → no flicker
    });

    test("SPA body swap re-attaches the SAME bar node via observer", () => {
      const env = makeDomStub();
      run(injectionScript(NONCE), env);
      const original = barIn(env);
      env.swapBody(); // YouTube nav nukes our bar from the old body
      const healed = barIn(env);
      expect(healed).toBe(original); // re-appended, never recreated
      expect(healed.isConnected).toBe(true);
    });

    test("running the script with drag wiring present does not throw", () => {
      // Smoke: the pointerdown/move/up wiring + getBoundingClientRect calls run
      // against the stub without exploding. Real drag motion is verified on the
      // machine (pure DOM event handling, not worth a full event simulator).
      const env = makeDomStub();
      expect(() => run(injectionScript(NONCE), env)).not.toThrow();
    });
  });

  // The bar can cover the page's own controls (e.g. a top-right account menu),
  // so it's draggable by its handle. Assert the wiring is in the injected script.
  describe("save bar is draggable (can be moved out of the way)", () => {
    test("script wires a move-cursor drag handle, pointer drag, and viewport clamp", () => {
      const s = injectionScript(NONCE);
      expect(s).toContain("cursor:move");
      expect(s).toContain("pointerdown");
      expect(s).toContain("pointermove");
      expect(s).toContain("pointerup");
      // clamps to the viewport so it can't be dragged fully off-screen
      expect(s).toContain("innerWidth");
      expect(s).toContain("innerHeight");
      // switches off the initial right-anchor once dragged
      expect(s).toContain("right='auto'");
    });
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
    let openedPartition: string | undefined;
    let destroyed: string | undefined;
    const p = loginAndCaptureCookies(
      { url: "https://www.youtube.com", platform: "youtube" },
      {
        open: async (opts) => {
          openedPartition = opts.partition;
          return fake.handle;
        },
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
    expect(openedPartition).toMatch(/^login-/);
    expect(openedPartition?.startsWith("persist:")).toBe(false);
    expect(destroyed).toBe(openedPartition);
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

describe("cookieDomainMatches (capture domain fence)", () => {
  test("exact host match", () => {
    expect(cookieDomainMatches("github.com", "github.com")).toBe(true);
    expect(cookieDomainMatches(".github.com", "github.com")).toBe(true);
  });

  test("registrable parent matches a subdomain target", () => {
    // cookie set for .github.com applies to api.github.com
    expect(cookieDomainMatches(".github.com", "api.github.com")).toBe(true);
  });

  test("REJECTS a bare public-suffix label matching an unrelated host", () => {
    // the bug: "github.com".endsWith(".co") was true → would capture a .co cookie
    expect(cookieDomainMatches(".co", "github.com")).toBe(false);
    expect(cookieDomainMatches("com", "github.com")).toBe(false);
    expect(cookieDomainMatches(".uk", "bbc.co.uk")).toBe(false);
  });

  test("rejects an unrelated sibling domain", () => {
    expect(cookieDomainMatches("evil.com", "github.com")).toBe(false);
    // substring-but-not-suffix must not match (myx.com vs x.com)
    expect(cookieDomainMatches("x.com", "myx.com")).toBe(false);
  });

  test("empty / missing cookie domain never matches", () => {
    expect(cookieDomainMatches(undefined, "github.com")).toBe(false);
    expect(cookieDomainMatches("", "github.com")).toBe(false);
    expect(cookieDomainMatches(".", "github.com")).toBe(false);
  });

  test("real multi-label parent still works (co.uk style)", () => {
    expect(cookieDomainMatches(".bbc.co.uk", "www.bbc.co.uk")).toBe(true);
    expect(cookieDomainMatches("bbc.co.uk", "bbc.co.uk")).toBe(true);
  });
});
