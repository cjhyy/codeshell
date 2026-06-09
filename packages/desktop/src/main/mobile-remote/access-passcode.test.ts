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
    const setCookie = res.headers["set-cookie"] ?? res.headers["Set-Cookie"];
    expect(String(setCookie)).toContain("cs_access=");
  });
});

// ── Minimal fake http req/res ──────────────────────────────────────────────
interface FakeReq {
  url?: string;
  headers: Record<string, string | undefined>;
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

function fakeReqRes(opts: { url?: string; cookie?: string }): {
  req: FakeReq;
  res: FakeRes;
} {
  const req: FakeReq = {
    url: opts.url ?? "/mobile",
    headers: opts.cookie ? { cookie: opts.cookie } : {},
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
