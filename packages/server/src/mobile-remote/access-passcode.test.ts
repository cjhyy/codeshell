import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { AccessPasscode } from "./access-passcode.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function freshFile(): string {
  dir = mkdtempSync(join(tmpdir(), "access-passcode-"));
  return join(dir, "access.json");
}

describe("AccessPasscode", () => {
  test("rejects invalid security limits instead of silently disabling protection", () => {
    const file = freshFile();
    expect(() => new AccessPasscode({ filePath: file, maxAttempts: 0 })).toThrow("maxAttempts");
    expect(() => new AccessPasscode({ filePath: file, maxAttempts: Number.NaN })).toThrow(
      "maxAttempts",
    );
    expect(() => new AccessPasscode({ filePath: file, lockoutMs: -1 })).toThrow("lockoutMs");
    expect(() => new AccessPasscode({ filePath: file, tokenMaxAgeMs: Infinity })).toThrow(
      "tokenMaxAgeMs",
    );
    expect(() => new AccessPasscode({ filePath: "" })).toThrow("filePath");
  });

  test("isSet false before set, true after", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    expect(ap.isSet()).toBe(false);
    ap.set("hunter2");
    expect(ap.isSet()).toBe(true);
  });

  test("stores a hash + salt, never the plaintext passcode", () => {
    const file = freshFile();
    const ap = new AccessPasscode({ filePath: file });
    ap.set("supersecret-passcode");
    const raw = readFileSync(file, "utf-8");
    expect(raw).not.toContain("supersecret-passcode");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.hash).toBeDefined();
    expect(parsed.salt).toBeDefined();
    expect(parsed.passcode).toBeUndefined();
  });

  test("rejects invalid set/verify inputs before expensive hashing", () => {
    const file = freshFile();
    const ap = new AccessPasscode({ filePath: file, maxAttempts: 2 });
    ap.set("valid-passcode");
    const original = readFileSync(file, "utf-8");

    expect(() => ap.set("abc")).toThrow("4-256");
    expect(() => ap.set("x".repeat(257))).toThrow("4-256");
    expect(() => ap.set(123 as unknown as string)).toThrow("4-256");
    expect(readFileSync(file, "utf-8")).toBe(original);

    expect(ap.verify("x".repeat(257))).toBeNull();
    expect(ap.verify(123 as unknown as string)).toBeNull();
    // Malformed input is throttled on its own budget, so a couple of junk
    // submissions must not burn the (much smaller) credential-guess budget.
    expect(ap.verify("valid-passcode")).not.toBeNull();
  });

  test("malformed input cannot lock the owner out on the credential budget", () => {
    // An unauthenticated caller sending `?passcode=1` supplies something that
    // could never be a valid passcode. Charging those to the lockout counter
    // let anyone lock the real user out for the full window, repeatedly, with
    // no credential and without paying for a single hash.
    const ap = new AccessPasscode({ filePath: freshFile(), maxAttempts: 5 });
    ap.set("valid-passcode");

    for (let i = 0; i < 20; i++) expect(ap.verify("1")).toBeNull();

    expect(ap.verify("valid-passcode")).not.toBeNull();
  });

  test("a sustained malformed flood is still throttled", () => {
    const ap = new AccessPasscode({ filePath: freshFile(), maxAttempts: 2 });
    ap.set("valid-passcode");
    // Well past maxAttempts * MALFORMED_ATTEMPT_MULTIPLIER.
    for (let i = 0; i < 41; i++) ap.verify("1");
    expect(ap.verify("valid-passcode")).toBeNull();
  });

  test("rejects oversized or non-string remember tokens without throwing", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("valid-passcode");
    expect(ap.verifyToken("x".repeat(129))).toBe(false);
    expect(ap.verifyToken(null as unknown as string)).toBe(false);
  });

  test("persists the signing secret atomically with owner-only permissions", () => {
    const file = freshFile();
    const ap = new AccessPasscode({ filePath: file });
    ap.set("first");
    chmodSync(file, 0o644);

    ap.set("second");

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir!).filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(ap.verify("second")).toBeString();
  });

  test("malformed records fail closed instead of reaching crypto with invalid types", () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ hash: 1, salt: {}, secret: true }));
    const ap = new AccessPasscode({ filePath: file });

    expect(ap.isSet()).toBe(false);
    expect(ap.verify("anything")).toBeNull();
    expect(ap.verifyToken("payload.signature")).toBe(false);
  });

  test("oversized access records fail closed without being parsed", () => {
    const file = freshFile();
    writeFileSync(file, "x".repeat(5 * 1024));
    const ap = new AccessPasscode({ filePath: file });

    expect(ap.isSet()).toBe(false);
    expect(ap.verify("anything")).toBeNull();
  });

  test("wrong passcode → verify returns null", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    expect(ap.verify("wrong")).toBeNull();
  });

  test("correct passcode → verify returns a token that verifyToken accepts", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const token = ap.verify("correct");
    expect(token).toBeString();
    expect(ap.verifyToken(token!)).toBe(true);
    expect(ap.verifyToken("garbage.token")).toBe(false);
  });

  test("remember-token expires after tokenMaxAgeMs even if the secret never rotates", () => {
    let now = 1_000_000_000_000;
    const ap = new AccessPasscode({
      filePath: freshFile(),
      now: () => now,
      tokenMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
    });
    ap.set("correct");
    const token = ap.verify("correct")!;
    expect(ap.verifyToken(token)).toBe(true);
    now += 29 * 24 * 60 * 60 * 1000;
    expect(ap.verifyToken(token)).toBe(true);
    now += 2 * 24 * 60 * 60 * 1000;
    expect(ap.verifyToken(token)).toBe(false);
  });

  test("a token with a tampered timestamp fails the signature check", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const token = ap.verify("correct")!;
    const [rand, ts, sig] = token.split(".");
    const forged = `${rand}.${Number(ts) + 999_999}.${sig}`;
    expect(ap.verifyToken(forged)).toBe(false);
  });

  test("gate: remember-cookie Max-Age matches the token validity window", () => {
    const now = 1_000_000_000_000;
    const ap = new AccessPasscode({
      filePath: freshFile(),
      now: () => now,
      tokenMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    });
    ap.set("correct");
    const headers: Record<string, string> = {};
    const res = {
      writeHead: () => undefined,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      end: () => undefined,
    };
    const allowed = ap.gate({ url: "/mobile", headers: { "x-access-passcode": "correct" } }, res);
    expect(allowed).toBe(true);
    expect(headers["Set-Cookie"]).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
  });

  test("changing the passcode invalidates previously issued tokens", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("first");
    const token = ap.verify("first")!;
    expect(ap.verifyToken(token)).toBe(true);
    ap.set("second");
    expect(ap.verifyToken(token)).toBe(false);
  });

  test("rate limit: 5 wrong attempts lock out even a correct passcode; recovers after window", () => {
    let now = 1_000_000;
    const ap = new AccessPasscode({
      filePath: freshFile(),
      now: () => now,
      maxAttempts: 5,
      lockoutMs: 60_000,
    });
    ap.set("correct");
    for (let i = 0; i < 5; i++) {
      expect(ap.verify("wrong")).toBeNull();
    }
    // 6th attempt locked even with the right passcode
    expect(ap.verify("correct")).toBeNull();
    // after the lockout window, correct works again
    now += 60_001;
    expect(ap.verify("correct")).toBeString();
  });

  test("a successful verify resets the failure counter", () => {
    const now = 1_000_000;
    const ap = new AccessPasscode({
      filePath: freshFile(),
      now: () => now,
      maxAttempts: 3,
      lockoutMs: 60_000,
    });
    ap.set("correct");
    ap.verify("wrong");
    ap.verify("wrong");
    expect(ap.verify("correct")).toBeString();
    // counter reset → two fresh wrongs do not lock
    ap.verify("wrong");
    ap.verify("wrong");
    expect(ap.verify("correct")).toBeString();
  });

  test("gate: allows a request carrying a valid remember token in cookie", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const token = ap.verify("correct")!;
    const { req, res } = fakeReqRes({ cookie: `cs_access=${token}` });
    expect(ap.gate(req, res)).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  test("gate: rejects a request with no/invalid credential and writes a challenge", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({});
    expect(ap.gate(req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.ended).toBe(true);
  });

  test("gate: a malformed %-sequence in the Cookie header does NOT throw (DoS guard)", () => {
    // Attacker-controlled Cookie on the mobile-remote boundary: `%ZZ` is an
    // invalid percent-escape → decodeURIComponent throws URIError. gate() must
    // tolerate it (treat as a non-matching token), not crash the request handler.
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({ cookie: "cs_access=%ZZ" });
    expect(() => ap.gate(req, res)).not.toThrow();
    expect(ap.gate(req, res)).toBe(false); // bad token → challenged, not allowed
  });

  test("gate: a correct passcode passed as query issues a Set-Cookie and allows", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({ url: "/mobile?passcode=correct" });
    expect(ap.gate(req, res)).toBe(true);
    const setCookie = String(res.headers["set-cookie"] ?? res.headers["Set-Cookie"]);
    expect(setCookie).toContain("cs_access=");
    // The phone reaches the page via a QR-scan launched navigation INTO
    // trycloudflare.com — SameSite=Strict treats that as cross-site and drops
    // the cookie, so the user is re-challenged forever. Lax sends it on
    // top-level navigations; Secure because the tunnel is always https.
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
  });

  test("gate: browser query auth redirects to the same URL without the plaintext passcode", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({
      url: "/mobile?pairing=tok123&passcode=correct",
    });
    req.headers.accept = "text/html";

    expect(ap.gate(req, res)).toBe(false);
    expect(res.statusCode).toBe(303);
    expect(res.headers.Location).toBe("/mobile?pairing=tok123");
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(String(res.headers["set-cookie"] ?? res.headers["Set-Cookie"])).toContain("cs_access=");
    expect(res.ended).toBe(true);
  });

  test("gate: a correct passcode in the x-access-passcode header allows", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({ passcodeHeader: "correct" });
    expect(ap.gate(req, res)).toBe(true);
  });

  test("gate: a correct passcode in a DUPLICATED (array) header still allows", () => {
    // Node represents duplicate headers as string[]; readCookie handled arrays
    // but readPasscodeParam used to reject them and fall through → spurious 401.
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({ passcodeHeader: ["correct", "other"] });
    expect(ap.gate(req, res)).toBe(true);
  });

  test("gate: a browser GET with no credential gets an HTML passcode FORM, not bare text", () => {
    // Regression for "auto shows 访问口令无效或缺失 with no way to enter it":
    // a page-navigation request must receive a challenge page the user can type
    // into, not a dead text/plain 401.
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({ url: "/mobile?pairing=tok123" });
    req.headers.accept = "text/html,application/xhtml+xml";
    expect(ap.gate(req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("text/html");
    // a real input the user can submit
    expect(res.body).toContain("<form");
    expect(res.body).toContain('name="passcode"');
    expect(res.body).toContain('"X-Access-Passcode"');
    // must preserve the pairing token so submitting the passcode keeps it
    expect(res.body).toContain("tok123");
  });

  test("challenge page cannot close its inline script through a crafted request path", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({
      url: '/mobile</script><script id="injected">?pairing=tok123',
    });
    req.headers.accept = "text/html";

    expect(ap.gate(req, res)).toBe(false);
    expect(res.body).not.toContain('</script><script id="injected">');
    expect(res.body).toContain("\\u003c/script>\\u003cscript");
  });

  test("gate: wrong passcode on the challenge form re-renders the form with an error", () => {
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({ url: "/mobile?passcode=nope" });
    req.headers.accept = "text/html";
    expect(ap.gate(req, res)).toBe(false);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<form");
  });

  test("gate: non-browser (no Accept html) still gets text/plain 401", () => {
    // The WS/fetch path is not a navigation; keep the lightweight text response.
    const ap = new AccessPasscode({ filePath: freshFile() });
    ap.set("correct");
    const { req, res } = fakeReqRes({ url: "/ws" });
    expect(ap.gate(req, res)).toBe(false);
    expect(res.headers["content-type"]).toContain("text/plain");
  });
});

// ── Minimal fake http req/res ──────────────────────────────────────────────
interface FakeReq {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface FakeRes {
  statusCode?: number;
  headers: Record<string, string>;
  ended: boolean;
  body: string;
  writeHead(code: number, headers?: Record<string, string>): FakeRes;
  setHeader(k: string, v: string): void;
  end(chunk?: string): void;
}

function fakeReqRes(opts: { url?: string; cookie?: string; passcodeHeader?: string | string[] }): {
  req: FakeReq;
  res: FakeRes;
} {
  const headers: Record<string, string | string[] | undefined> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.passcodeHeader !== undefined) headers["x-access-passcode"] = opts.passcodeHeader;
  const req: FakeReq = {
    url: opts.url ?? "/mobile",
    headers,
  };
  const res: FakeRes = {
    headers: {},
    ended: false,
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) Object.assign(this.headers, headers);
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.ended = true;
    },
  };
  return { req, res };
}
