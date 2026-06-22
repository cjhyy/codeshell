import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    let now = 1_000_000;
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
    // must preserve the pairing token so submitting the passcode keeps it
    expect(res.body).toContain("tok123");
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
