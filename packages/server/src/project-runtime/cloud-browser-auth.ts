import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isCloudAccountOrigin } from "./account-binding.js";
import { cloudManagementSessionView } from "./cloud-account-auth.js";
import type {
  CloudAccountAuthority,
  CloudAccountPrincipal,
  CloudManagementSession,
  ProjectControlAuthority,
  ProjectControlSession,
} from "./control-authority.js";
import { ProjectRegistryError } from "./registry.js";

/** Browser bootstrap is separate from the native, single-operator v2 API. */
export const CLOUD_BROWSER_AUTHORITY_VERSION = 1;
export const CLOUD_BROWSER_COOKIE = "cs_cloud_browser";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function principalValid(value: CloudAccountPrincipal): boolean {
  return (
    value &&
    Object.keys(value).sort().join() ===
      ["accountOrigin", "accountId", "sessionId", "rootSessionId", "authorityEpoch", "expiresAt"]
        .sort()
        .join() &&
    isCloudAccountOrigin(value.accountOrigin) &&
    UUID.test(value.accountId) &&
    UUID.test(value.sessionId) &&
    value.sessionId === value.rootSessionId &&
    UUID.test(value.authorityEpoch) &&
    Number.isSafeInteger(value.expiresAt)
  );
}

interface Entry {
  hash: string;
  session: CloudManagementSession;
  principal: CloudAccountPrincipal;
  revoked: boolean;
}

/** Every principal is independently scoped; a login never claims legacy projects. */
export function createCloudBrowserAuth(options: {
  accountOrigin: string;
  managementEpoch: string;
  installationId: string;
  publicOrigin: string;
  authority: CloudAccountAuthority;
  ownerForAccount(accountOrigin: string, accountId: string): string;
  onRevoke(sessionId: string, ownerId: string): void;
  now?: () => number;
}): ProjectControlAuthority {
  if (
    !isCloudAccountOrigin(options.publicOrigin) ||
    !isCloudAccountOrigin(options.accountOrigin) ||
    options.authority.accountOrigin !== options.accountOrigin ||
    !UUID.test(options.installationId) ||
    !UUID.test(options.managementEpoch)
  )
    throw new Error("Cloud browser authority requires a fixed installation and Account origin.");
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const reading = new Set<IncomingMessage>();
  let closed = false,
    exchanging = 0,
    attempts = { until: now() + 60_000, count: 0 };

  function revoke(entry: Entry) {
    if (entry.revoked) return;
    entry.revoked = true;
    if (entries.get(entry.session.id) === entry) entries.delete(entry.session.id);
    options.onRevoke(entry.session.id, entry.session.ownerId);
  }
  function entryFor(session: ProjectControlSession): Entry | undefined {
    if (closed || !("kind" in session)) return;
    const entry = entries.get(session.id);
    if (!entry || entry.revoked || entry.session.expiresAt <= now()) {
      if (entry) revoke(entry);
      return;
    }
    // A same-root renewal may extend the deadline while a lifecycle operation
    // still holds an older safe session snapshot. Every identity field is fixed.
    if (
      Object.keys(entry.session).some(
        (key) =>
          key !== "expiresAt" &&
          entry.session[key as keyof CloudManagementSession] !==
            session[key as keyof CloudManagementSession],
      ) ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt <= 0 ||
      session.expiresAt > entry.session.expiresAt
    )
      return;
    return entry;
  }
  async function revalidate(session: ProjectControlSession, attempt = 0): Promise<void> {
    const entry = entryFor(session);
    if (!entry) throw new ProjectRegistryError(401, "Cloud 工作台登录已失效。");
    try {
      const current = await options.authority.validate(
        { ...entry.principal },
        options.installationId,
      );
      if (entries.get(session.id) !== entry) {
        if (attempt === 0) return revalidate(session, 1);
        throw new Error("Cloud browser authority changed while validating.");
      }
      if (
        !principalValid(current) ||
        current.expiresAt <= now() ||
        Object.keys(current).some(
          (key) =>
            current[key as keyof CloudAccountPrincipal] !==
            entry.principal[key as keyof CloudAccountPrincipal],
        ) ||
        !entryFor(session)
      )
        throw new Error("Cloud browser authority changed.");
    } catch {
      // A delayed validation of the preceding token/root deadline must never
      // revoke a newer, independently redeemed cookie for the same scope.
      if (entries.get(session.id) !== entry) {
        if (attempt === 0) return revalidate(session, 1);
      } else revoke(entry);
      throw new ProjectRegistryError(401, "Cloud 工作台授权已失效，请重新登录。");
    }
  }
  function uniqueHeader(req: IncomingMessage, name: string): boolean {
    return (
      req.rawHeaders.filter((key, index) => index % 2 === 0 && key.toLowerCase() === name).length <=
      1
    );
  }
  function isOriginAllowed(req: IncomingMessage): boolean {
    if (
      !uniqueHeader(req, "host") ||
      !uniqueHeader(req, "origin") ||
      !uniqueHeader(req, "cookie") ||
      !uniqueHeader(req, "sec-fetch-site") ||
      !uniqueHeader(req, "content-type") ||
      req.headers.host !== new URL(options.publicOrigin).host ||
      req.headers.authorization !== undefined ||
      (req.headers.origin !== undefined && req.headers.origin !== options.publicOrigin) ||
      ![undefined, "same-origin", "none"].includes(req.headers["sec-fetch-site"] as string)
    )
      return false;
    if (
      (req.headers.cookie
        ?.split(";")
        .filter((part) => part.trim().startsWith(`${CLOUD_BROWSER_COOKIE}=`)).length ?? 0) > 1
    )
      return false;
    // Unsafe browser requests require both independently supplied browser checks.
    // JSON alone is not the CSRF boundary and no CORS exception is installed.
    return (
      ["GET", "HEAD"].includes(req.method ?? "") ||
      (req.headers.origin === options.publicOrigin &&
        req.headers["sec-fetch-site"] === "same-origin")
    );
  }
  function cookieToken(req: IncomingMessage): string | undefined {
    const cookies = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${CLOUD_BROWSER_COOKIE}=`));
    if (cookies?.length === 1 && TOKEN.test(cookies[0]!.slice(CLOUD_BROWSER_COOKIE.length + 1)))
      return cookies[0]!.slice(CLOUD_BROWSER_COOKIE.length + 1);
  }
  function entryFromRequest(req: IncomingMessage): Entry | undefined {
    const token = cookieToken(req);
    if (token) return [...entries.values()].find((row) => row.hash === hash(token));
  }
  async function authenticate(req: IncomingMessage): Promise<ProjectControlSession | null> {
    if (!isOriginAllowed(req)) return null;
    const entry = entryFromRequest(req);
    if (!entry || !entryFor(entry.session)) return null;
    await revalidate(entry.session);
    return { ...entry.session };
  }
  function json(res: ServerResponse, status: number, value: unknown) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "frame-ancestors 'none'",
    });
    res.end(JSON.stringify(value));
  }
  function setCookie(res: ServerResponse, token: string, expiresAt: number) {
    res.setHeader(
      "Set-Cookie",
      `${CLOUD_BROWSER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt - now()) / 1000))}${options.publicOrigin.startsWith("https:") ? "; Secure" : ""}`,
    );
  }
  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? ""))
      throw new ProjectRegistryError(415, "请使用 JSON 提交。");
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => req.destroy(), 5000);
    timer.unref();
    reading.add(req);
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw new ProjectRegistryError(413, "请求过大。");
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      clearTimeout(timer);
      reading.delete(req);
    }
    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body && typeof body === "object" && !Array.isArray(body))
        return body as Record<string, unknown>;
    } catch {
      /* Only the fixed public error below is returned. */
    }
    throw new ProjectRegistryError(400, "请求格式无效。");
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? "/").split("?", 1)[0]!;
    if (
      !path.startsWith("/api/v1/cloud-browser/") &&
      !path.startsWith("/api/v1/cloud-management/") &&
      !path.startsWith("/api/v1/auth/")
    )
      return false;
    if (!isOriginAllowed(req)) throw new ProjectRegistryError(403, "请求来源无效。");
    if (closed) throw new ProjectRegistryError(503, "Cloud 工作台正在关闭。");
    if (req.url !== path) throw new ProjectRegistryError(400, "请求参数无效。");
    if (
      ["GET", "HEAD"].includes(req.method ?? "") &&
      (Number(req.headers["content-length"] ?? 0) !== 0 ||
        req.headers["transfer-encoding"] !== undefined)
    )
      throw new ProjectRegistryError(400, "读取请求不接受额外内容。");
    if (path === "/api/v1/cloud-browser/capabilities" && req.method === "GET") {
      json(res, 200, {
        version: CLOUD_BROWSER_AUTHORITY_VERSION,
        mode: "cloud-browser",
        cloudOrigin: options.publicOrigin,
        installationId: options.installationId,
        accountOrigin: options.accountOrigin,
      });
      return true;
    }
    if (path === "/api/v1/cloud-browser/session" && req.method === "POST") {
      if (now() >= attempts.until) attempts = { until: now() + 60_000, count: 0 };
      if (++attempts.count > 60 || exchanging >= 4)
        throw new ProjectRegistryError(429, "Cloud 登录请求过多。");
      // Capture before either request-body or private redemption awaits. A
      // logout/account switch must fence the old request's eventual Set-Cookie.
      const previous = entryFromRequest(req);
      const wasRevoked = previous?.revoked;
      exchanging++;
      try {
        const body = await readBody(req);
        if (
          Object.keys(body).join() !== "ticket" ||
          typeof body.ticket !== "string" ||
          !TOKEN.test(body.ticket)
        )
          throw new ProjectRegistryError(400, "Cloud 登录票据格式无效。");
        let principal: CloudAccountPrincipal;
        try {
          principal = await options.authority.redeem(body.ticket, options.installationId);
        } catch {
          throw new ProjectRegistryError(401, "云账号验证失败。");
        }
        if (
          closed ||
          res.destroyed ||
          res.writableEnded ||
          !principalValid(principal) ||
          principal.accountOrigin !== options.accountOrigin ||
          principal.expiresAt <= now()
        )
          throw new ProjectRegistryError(401, "云账号验证失败。");
        if (
          previous &&
          (entries.get(previous.session.id) !== previous || previous.revoked !== wasRevoked)
        )
          throw new ProjectRegistryError(401, "Cloud 登录状态已改变，请重新进入工作台。");
        for (const [id, entry] of entries)
          if (entry.session.expiresAt <= now()) {
            revoke(entry);
            entries.delete(id);
          }
        const renewal =
          previous &&
          entryFor(previous.session) &&
          previous.principal.accountOrigin === principal.accountOrigin &&
          previous.principal.accountId === principal.accountId &&
          previous.principal.rootSessionId === principal.rootSessionId &&
          previous.principal.authorityEpoch === principal.authorityEpoch &&
          principal.expiresAt >= previous.principal.expiresAt;
        const active = [...entries.values()].filter((entry) => !entry.revoked);
        if (
          entries.size - (renewal ? 1 : 0) >= 256 ||
          active.filter(
            (entry) => entry.session.accountId === principal.accountId && entry !== previous,
          ).length >= 8
        )
          throw new ProjectRegistryError(429, "Cloud 登录会话数量已达上限。");
        const ownerId = options.ownerForAccount(principal.accountOrigin, principal.accountId);
        if (!UUID.test(ownerId)) throw new ProjectRegistryError(503, "Cloud 工作区暂不可用。");
        const token = randomBytes(32).toString("base64url");
        const session: CloudManagementSession = {
          id: renewal ? previous.session.id : randomUUID(),
          kind: "cloud-management",
          audience: options.publicOrigin,
          installationId: options.installationId,
          accountOrigin: principal.accountOrigin,
          accountId: principal.accountId,
          managementEpoch: options.managementEpoch,
          expiresAt: Math.min(now() + 600_000, principal.expiresAt),
          ownerId,
        };
        entries.set(session.id, {
          hash: hash(token),
          session,
          principal: { ...principal },
          revoked: false,
        });
        if (renewal) previous.revoked = true;
        else if (previous) revoke(previous);
        setCookie(res, token, session.expiresAt);
        json(res, 201, {
          authenticated: true,
          mode: "cloud-account",
          session: cloudManagementSessionView(session),
        });
      } finally {
        exchanging--;
      }
      return true;
    }
    if (path === "/api/v1/auth/status" && req.method === "GET") {
      const session = await authenticate(req);
      json(res, 200, {
        initialized: true,
        mode: "cloud-account",
        authenticated: !!session,
        ...(session && "kind" in session ? { session: cloudManagementSessionView(session) } : {}),
      });
      return true;
    }
    if (
      ["/api/v1/cloud-browser/logout", "/api/v1/auth/logout"].includes(path) &&
      req.method === "POST"
    ) {
      const entry = entryFromRequest(req);
      const body = await readBody(req);
      if (Object.keys(body).length) throw new ProjectRegistryError(400, "退出不接受额外参数。");
      if (closed) throw new ProjectRegistryError(503, "Cloud 工作台正在关闭。");
      if (!entry || entry.revoked || entries.get(entry.session.id) !== entry)
        throw new ProjectRegistryError(401, "Cloud 工作台登录已失效。");
      revoke(entry);
      setCookie(res, "", now());
      json(res, 200, { revoked: true });
      return true;
    }
    throw new ProjectRegistryError(403, "此 Cloud 使用独立账号的浏览器工作台登录。");
  }
  return {
    cookieName: CLOUD_BROWSER_COOKIE,
    store: {
      listSessions: () =>
        [...entries.values()]
          .filter((row) => entryFor(row.session))
          .map((row) => ({ ...row.session })),
    },
    handle,
    authenticate,
    isOriginAllowed,
    isActive: (session) => !!entryFor(session),
    revalidate,
    close() {
      closed = true;
      for (const request of reading) request.destroy();
      reading.clear();
      for (const entry of entries.values()) revoke(entry);
      entries.clear();
    },
  };
}
