import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HubAuthError,
  HubAuthStore,
  type HubLoginInput,
  type HubSession,
  type HubSessionGrant,
} from "./auth-store.js";

export const HUB_SESSION_COOKIE = "cs_hub_session";
const MAX_BODY_BYTES = 8 * 1024;
const LOGIN_WINDOW_MS = 60_000;
const MAX_ATTEMPT_SOURCES = 1_024;

export interface HubAuthOptions {
  dataDir: string;
  /** Trusted external URL, also used behind a TLS-terminating reverse proxy. */
  publicOrigin?: string;
  onRevoke?: (sessionId: string) => void;
  now?: () => number;
  sessionTtlMs?: number;
  maxLoginAttempts?: number;
}

export interface HubAuth {
  bootstrapToken?: string;
  store: HubAuthStore;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  authenticate(req: IncomingMessage): Promise<HubSession | null>;
  isOriginAllowed(req: IncomingMessage): boolean;
}

/** Shared single-user HTTP authentication; no Electron or worker dependency. */
export async function createHubAuth(options: HubAuthOptions): Promise<HubAuth> {
  const now = options.now ?? Date.now;
  const origin = options.publicOrigin ? normalizeOrigin(options.publicOrigin) : undefined;
  const secureCookie = origin?.startsWith("https:") ?? false;
  const maxLoginAttempts = options.maxLoginAttempts ?? 10;
  if (!Number.isSafeInteger(maxLoginAttempts) || maxLoginAttempts < 1) {
    throw new Error("Hub login attempt limit must be positive");
  }
  const store = new HubAuthStore(options);
  const bootstrapToken = store.initialize();
  const attempts = new Map<string, { count: number; resetAt: number }>();
  let activeLogins = 0;
  let globalAttempts = { count: 0, resetAt: now() + LOGIN_WINDOW_MS };

  function isOriginAllowed(req: IncomingMessage): boolean {
    const requestOrigin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") return false;
    const expected = origin ?? requestOriginFromHost(req);
    if (expected === undefined) return false;
    // Address-bar navigation and noreferrer links omit Origin and report "none".
    // Permit only read-only top-level navigation; writes, fetches and socket
    // upgrades still use the existing same-origin/native-client checks.
    if (requestOrigin === undefined)
      return (
        fetchSite === undefined ||
        fetchSite === "same-origin" ||
        (fetchSite === "none" &&
          (req.method === "GET" || req.method === "HEAD") &&
          req.headers["sec-fetch-mode"] === "navigate" &&
          req.headers["sec-fetch-dest"] === "document")
      );
    if (typeof requestOrigin !== "string" || requestOrigin === "null") return false;
    return requestOrigin === expected;
  }

  function takeAttempt(req: IncomingMessage): string {
    const time = now();
    for (const [key, bucket] of attempts) {
      if (bucket.resetAt <= time) attempts.delete(key);
    }
    if (globalAttempts.resetAt <= time)
      globalAttempts = { count: 0, resetAt: time + LOGIN_WINDOW_MS };
    // Proxy forwarding headers are intentionally not trusted for rate limits.
    const key = req.socket.remoteAddress ?? "unknown";
    let bucket = attempts.get(key);
    if (!bucket) {
      if (attempts.size >= MAX_ATTEMPT_SOURCES)
        throw new HubAuthError(429, "Too many login attempts; retry in one minute");
      bucket = { count: 0, resetAt: time + LOGIN_WINDOW_MS };
      attempts.set(key, bucket);
    }
    if (bucket.count >= maxLoginAttempts || globalAttempts.count >= 100 || activeLogins >= 4) {
      throw new HubAuthError(429, "Too many login attempts; retry in one minute");
    }
    bucket.count += 1;
    globalAttempts.count += 1;
    return key;
  }

  function setSessionCookie(res: ServerResponse, token: string, maxAge: number): void {
    res.setHeader(
      "Set-Cookie",
      `${HUB_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? "; Secure" : ""}`,
    );
  }

  function completeLogin(res: ServerResponse, grant: HubSessionGrant): void {
    for (const sessionId of grant.revokedSessionIds) options.onRevoke?.(sessionId);
    setSessionCookie(res, grant.token, Math.floor(store.sessionTtlMs / 1_000));
    json(res, 200, { authenticated: true, session: grant.session });
  }

  async function authenticate(req: IncomingMessage): Promise<HubSession | null> {
    return store.authenticate(readHubSessionToken(req));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? "/").split("?", 1)[0];
    if (path !== "/api/v1/auth" && !path.startsWith("/api/v1/auth/")) return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD" && !isOriginAllowed(req)) {
        throw new HubAuthError(403, "Request origin is not allowed");
      }
      if (path === "/api/v1/auth/status" && method === "GET") {
        const session = await authenticate(req);
        json(res, 200, {
          initialized: store.isInitialized(),
          authenticated: !!session,
          ...(session ? { session } : {}),
        });
        return true;
      }
      if ((path === "/api/v1/auth/setup" || path === "/api/v1/auth/login") && method === "POST") {
        const key = takeAttempt(req);
        activeLogins += 1;
        try {
          const body = await readJsonBody(req);
          const input = body as unknown as HubLoginInput & { token: string };
          const grant = path.endsWith("/setup")
            ? await store.setup(input)
            : await store.login(input, readHubSessionToken(req));
          attempts.delete(key);
          completeLogin(res, grant);
        } finally {
          activeLogins -= 1;
        }
        return true;
      }
      const session = await authenticate(req);
      if (!session) throw new HubAuthError(401, "Authentication required");
      if (path === "/api/v1/auth/sessions" && method === "GET") {
        json(res, 200, {
          sessions: store.listSessions().map((row) => ({ ...row, current: row.id === session.id })),
        });
        return true;
      }
      if (path === "/api/v1/auth/logout" && method === "POST") {
        await readJsonBody(req);
        store.revoke(session.id);
        options.onRevoke?.(session.id);
        setSessionCookie(res, "", 0);
        json(res, 200, { ok: true });
        return true;
      }
      const revokeMatch = /^\/api\/v1\/auth\/sessions\/([a-f0-9-]{36})$/.exec(path);
      if (revokeMatch && method === "DELETE") {
        if (!store.revoke(revokeMatch[1]!)) throw new HubAuthError(404, "Session not found");
        options.onRevoke?.(revokeMatch[1]!);
        if (revokeMatch[1] === session.id) setSessionCookie(res, "", 0);
        json(res, 200, { ok: true });
        return true;
      }
      throw new HubAuthError(404, "Auth endpoint not found");
    } catch (error) {
      const status = error instanceof HubAuthError ? error.statusCode : 503;
      if (status === 429) res.setHeader("Retry-After", "60");
      json(res, status, {
        error: error instanceof HubAuthError ? error.message : "Authentication service unavailable",
      });
    }
    return true;
  }

  return { bootstrapToken, store, handle, authenticate, isOriginAllowed };
}

/** Authorization wins over cookies; malformed bearer headers fail closed. */
export function readHubSessionToken(req: Pick<IncomingMessage, "headers">): string | undefined {
  if (req.headers.authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization);
    return match?.[1];
  }
  const entries = req.headers.cookie
    ?.split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${HUB_SESSION_COOKIE}=`));
  if (!entries || entries.length !== 1) return undefined;
  const token = entries[0]!.slice(HUB_SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

function normalizeOrigin(input: string): string {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Hub public origin must use HTTPS (HTTP allowed only on loopback) without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

function requestOriginFromHost(req: IncomingMessage): string | undefined {
  const host = req.headers.host;
  if (!host || /[\s/\\@?#]/.test(host)) return undefined;
  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  try {
    return normalizeOrigin(`${protocol}://${host}`);
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json")
    throw new HubAuthError(415, "Content-Type must be application/json");
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES)
    throw new HubAuthError(413, "Auth request is too large");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => fail(new HubAuthError(408, "Auth request timed out")), 10_000);
    timer.unref();
    function cleanup(): void {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    }
    function fail(error: Error): void {
      cleanup();
      // Aborting a Node request can emit error after aborted. Keep a listener
      // after detaching body readers so a disconnected client cannot crash the host.
      req.once("error", () => {});
      req.resume();
      reject(error);
    }
    function onData(chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(new HubAuthError(413, "Auth request is too large"));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd(): void {
      cleanup();
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("not an object");
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new HubAuthError(400, "Request body must be a JSON object"));
      }
    }
    function onAborted(): void {
      fail(new HubAuthError(400, "Auth request aborted"));
    }
    function onError(): void {
      fail(new HubAuthError(400, "Unable to read auth request"));
    }
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });
}
