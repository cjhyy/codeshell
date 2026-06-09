import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MS = 60_000;
const COOKIE_NAME = "cs_access";
const SCRYPT_KEYLEN = 32;

/** On-disk shape. We persist a scrypt hash + salt (never the plaintext) and a
 *  rotating `secret` used to sign remember-tokens — rotating it on every `set`
 *  invalidates all previously-issued tokens (spec: changing passcode forces
 *  re-entry on every device). */
interface AccessRecord {
  hash: string;
  salt: string;
  secret: string;
}

/** Minimal structural views of node:http req/res so `gate` is unit-testable
 *  without a real server. */
interface GateRequest {
  url?: string;
  headers: { cookie?: string | undefined; [k: string]: string | string[] | undefined };
}
interface GateResponse {
  statusCode?: number;
  writeHead(code: number, headers?: Record<string, string>): unknown;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

export interface AccessPasscodeOptions {
  /** `<userData>/mobile-remote/access.json`. */
  filePath: string;
  /** Injectable clock for deterministic rate-limit tests. */
  now?: () => number;
  maxAttempts?: number;
  lockoutMs?: number;
}

/**
 * The public-tunnel access gate. A single shared passcode (set by the desktop
 * user) guards the tunnel; a phone that enters it correctly receives a signed
 * "remember" token stored in a cookie so it is not re-challenged. Security
 * properties this unit guarantees:
 *  - the passcode is only ever stored as a salted scrypt hash (no plaintext);
 *  - remember-tokens are HMACs over a per-passcode secret, so rotating the
 *    passcode invalidates every outstanding token;
 *  - brute-force is rate-limited: N consecutive wrong attempts lock the gate
 *    for a window, during which even the correct passcode is refused.
 * The trusted-device + pairing layers still sit behind this (defense in depth).
 */
export class AccessPasscode {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly lockoutMs: number;
  private failures = 0;
  private lockedUntil = 0;

  constructor(opts: AccessPasscodeOptions) {
    this.filePath = opts.filePath;
    this.now = opts.now ?? Date.now;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.lockoutMs = opts.lockoutMs ?? DEFAULT_LOCKOUT_MS;
  }

  isSet(): boolean {
    return this.read() !== undefined;
  }

  /** Set (or rotate) the passcode. Rotating `secret` invalidates old tokens. */
  set(passcode: string): void {
    const salt = randomBytes(16).toString("hex");
    const hash = this.hashPasscode(passcode, salt);
    const secret = randomBytes(32).toString("hex");
    this.write({ hash, salt, secret });
    this.failures = 0;
    this.lockedUntil = 0;
  }

  /**
   * Verify a passcode. On success returns a fresh remember-token and resets the
   * failure counter; on failure (or while rate-limited) returns null and counts
   * a failure. While locked out, even a correct passcode returns null.
   */
  verify(passcode: string): string | null {
    const record = this.read();
    if (!record) return null;
    if (this.isLocked()) return null;

    const candidate = this.hashPasscode(passcode, record.salt);
    if (!safeEqualHex(candidate, record.hash)) {
      this.failures++;
      if (this.failures >= this.maxAttempts) {
        this.lockedUntil = this.now() + this.lockoutMs;
      }
      return null;
    }
    this.failures = 0;
    this.lockedUntil = 0;
    return this.issueToken(record);
  }

  /** Validate a remember-token: HMAC signature must match AND be over the
   *  current secret (so it dies when the passcode is rotated). */
  verifyToken(token: string): boolean {
    const record = this.read();
    if (!record) return false;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.sign(payload, record.secret);
    return safeEqualHex(sig, expected);
  }

  /**
   * HTTP gate. Returns true (allow) when the request carries a valid remember
   * token (cookie) or the correct passcode (query/header); on a fresh correct
   * passcode it also sets the remember cookie so the phone is not re-challenged.
   * Returns false and writes a 401 challenge otherwise — the caller must stop.
   */
  gate(req: GateRequest, res: GateResponse): boolean {
    if (!this.isSet()) {
      // No passcode configured → tunnel must not be reachable. Refuse.
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("access passcode not configured");
      return false;
    }

    const cookieToken = readCookie(req.headers.cookie, COOKIE_NAME);
    if (cookieToken && this.verifyToken(cookieToken)) return true;

    const supplied = readPasscodeParam(req);
    let wrongAttempt = false;
    if (supplied) {
      const token = this.verify(supplied);
      if (token) {
        res.setHeader(
          "Set-Cookie",
          `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
        );
        return true;
      }
      wrongAttempt = true;
    }

    // A browser navigating to a page needs a form to type the passcode into —
    // a bare text/plain 401 was a dead end (the user saw the error with no way
    // to enter the passcode). Non-navigation requests (WS upgrade, fetch) keep
    // the lightweight text 401.
    if (acceptsHtml(req)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      res.end(challengePage(req.url, wrongAttempt, this.isLocked()));
      return false;
    }

    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("访问口令无效或缺失");
    return false;
  }

  /** True if a WS upgrade carrying these headers/url is allowed (no body to
   *  write). Used by the WS gate which cannot send a challenge page. */
  allows(req: GateRequest): boolean {
    if (!this.isSet()) return false;
    const cookieToken = readCookie(req.headers.cookie, COOKIE_NAME);
    if (cookieToken && this.verifyToken(cookieToken)) return true;
    const supplied = readPasscodeParam(req);
    if (supplied) return this.verify(supplied) !== null;
    return false;
  }

  private isLocked(): boolean {
    if (this.lockedUntil === 0) return false;
    if (this.now() >= this.lockedUntil) {
      this.lockedUntil = 0;
      this.failures = 0;
      return false;
    }
    return true;
  }

  private issueToken(record: AccessRecord): string {
    const payload = `${randomBytes(12).toString("hex")}.${this.now()}`;
    const sig = this.sign(payload, record.secret);
    return `${payload}.${sig}`;
  }

  private sign(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  private hashPasscode(passcode: string, salt: string): string {
    return scryptSync(passcode, salt, SCRYPT_KEYLEN).toString("hex");
  }

  private read(): AccessRecord | undefined {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<AccessRecord>;
      if (parsed.hash && parsed.salt && parsed.secret) {
        return { hash: parsed.hash, salt: parsed.salt, secret: parsed.secret };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private write(record: AccessRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(record, null, 2), "utf-8");
  }
}

function readCookie(cookieHeader: string | string[] | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const header = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return undefined;
}

function readPasscodeParam(req: GateRequest): string | undefined {
  // Header takes precedence (used by the WS/fetch path), then ?passcode= query.
  const headerVal = req.headers["x-access-passcode"];
  if (typeof headerVal === "string" && headerVal) return headerVal;
  if (!req.url) return undefined;
  const qIdx = req.url.indexOf("?");
  if (qIdx < 0) return undefined;
  const params = new URLSearchParams(req.url.slice(qIdx + 1));
  return params.get("passcode") ?? undefined;
}

function acceptsHtml(req: GateRequest): boolean {
  const accept = req.headers.accept;
  const value = Array.isArray(accept) ? accept.join(",") : accept;
  return typeof value === "string" && value.includes("text/html");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The passcode challenge page. Submits via GET back to the SAME path so any
 * existing query (notably `?pairing=<token>`) is preserved — the form re-adds
 * `passcode`, and on success gate() sets the remember cookie and the next load
 * serves the real /mobile page with the pairing token intact.
 */
function challengePage(url: string | undefined, wrong: boolean, locked: boolean): string {
  // Carry forward existing params except a stale passcode.
  const qIdx = (url ?? "").indexOf("?");
  const path = qIdx >= 0 ? url!.slice(0, qIdx) : (url ?? "/mobile");
  const params = new URLSearchParams(qIdx >= 0 ? url!.slice(qIdx + 1) : "");
  params.delete("passcode");
  const hidden = [...params.entries()]
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`,
    )
    .join("");
  const note = locked
    ? "尝试过多,已临时锁定,请稍后再试。"
    : wrong
      ? "口令不正确,请重试。"
      : "请输入访问口令以继续。";
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>访问口令</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:-apple-system,system-ui,sans-serif;margin:0;min-height:100vh;
    display:flex;align-items:center;justify-content:center;background:#0b0b0c;color:#e7e7e9}
  .card{width:min(92vw,360px);padding:28px 24px;border-radius:16px;background:#19191c;
    box-shadow:0 8px 40px rgba(0,0,0,.4)}
  h1{font-size:18px;margin:0 0 6px}
  p{font-size:13px;color:#a1a1aa;margin:0 0 18px}
  p.err{color:#f87171}
  input[type=password]{width:100%;box-sizing:border-box;padding:12px 14px;font-size:16px;
    border-radius:10px;border:1px solid #333;background:#0f0f11;color:#fff;margin-bottom:14px}
  button{width:100%;padding:12px;font-size:15px;border:0;border-radius:10px;
    background:#3b82f6;color:#fff;font-weight:600}
  button:disabled{opacity:.5}
</style></head>
<body><form class="card" method="GET" action="${escapeHtml(path)}">
  <h1>手机遥控</h1>
  <p class="${wrong || locked ? "err" : ""}">${note}</p>
  ${hidden}
  <input type="password" name="passcode" placeholder="访问口令" autofocus required ${locked ? "disabled" : ""}>
  <button type="submit" ${locked ? "disabled" : ""}>进入</button>
</form></body></html>`;
}

/** Constant-time hex comparison that tolerates length mismatch. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
