import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTRACTS } from "@cjhyy/code-shell-core";
import { isCloudAccountOrigin, type CloudAccountBinding } from "./account-binding.js";
import type {
  CloudAccountAuthority,
  CloudAccountPrincipal,
  CloudManagementSession,
  ProjectControlAuthority,
  ProjectControlSession,
} from "./control-authority.js";
import { ProjectRegistryError } from "./registry.js";

export const CLOUD_MANAGEMENT_AUTHORITY_VERSION = CONTRACTS.cloudManagementAuthority;
export const CLOUD_MANAGEMENT_COOKIE = "cs_cloud_management";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
interface RecordEntry {
  hash: string;
  session: CloudManagementSession;
  principal: CloudAccountPrincipal;
  revoked: boolean;
}

export function cloudManagementSessionView(session: CloudManagementSession) {
  const { ownerId: _ownerId, ...view } = session;
  return view;
}

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

/** An explicitly bound Account controls one existing single-operator installation. */
export function createCloudAccountAuth(options: {
  binding: CloudAccountBinding;
  installationId: string;
  publicOrigin: string;
  authority: CloudAccountAuthority;
  onRevoke(sessionId: string): void;
  now?: () => number;
}): ProjectControlAuthority {
  const now = options.now ?? Date.now;
  if (
    !isCloudAccountOrigin(options.publicOrigin) ||
    options.authority.accountOrigin !== options.binding.accountOrigin ||
    !UUID.test(options.installationId)
  )
    throw new Error("Cloud authority configuration does not match explicit ownership.");
  const sessions = new Map<string, RecordEntry>();
  const reading = new Set<IncomingMessage>();
  let closed = false;
  let exchanging = 0;
  let attempts = { until: now() + 60_000, count: 0 };

  function revoke(entry: RecordEntry): void {
    if (entry.revoked) return;
    entry.revoked = true;
    options.onRevoke(entry.session.id);
  }
  function entryFor(session: ProjectControlSession): RecordEntry | undefined {
    if (closed || !("kind" in session)) return;
    const entry = sessions.get(session.id);
    if (!entry || entry.revoked || entry.session.expiresAt <= now()) {
      if (entry) revoke(entry);
      return;
    }
    // Do not let a caller change owner, epoch or deadline using an existing id.
    if (JSON.stringify(entry.session) !== JSON.stringify(session)) return;
    return entry;
  }
  async function revalidate(session: ProjectControlSession): Promise<void> {
    const entry = entryFor(session);
    if (!entry) throw new ProjectRegistryError(401, "Cloud 管理登录已失效。");
    try {
      const current = await options.authority.validate(
        { ...entry.principal },
        options.installationId,
      );
      if (
        !principalValid(current) ||
        Object.keys(current).some(
          (key) =>
            current[key as keyof CloudAccountPrincipal] !==
            entry.principal[key as keyof CloudAccountPrincipal],
        ) ||
        !entryFor(session)
      )
        throw new Error("Cloud Account authority changed.");
    } catch {
      revoke(entry);
      throw new ProjectRegistryError(401, "Cloud 管理授权已失效，请重新登录云账号。");
    }
  }
  function requestToken(req: IncomingMessage): string | undefined {
    let authorizations = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (req.rawHeaders[i]!.toLowerCase() === "authorization") authorizations++;
    if (authorizations > 1) return;
    const bearer = req.headers.authorization;
    const cookie = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${CLOUD_MANAGEMENT_COOKIE}=`));
    if (bearer !== undefined && cookie?.length) return;
    if (bearer !== undefined) return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(bearer)?.[1];
    if (cookie?.length === 1) return cookie[0]!.slice(CLOUD_MANAGEMENT_COOKIE.length + 1);
  }
  function isOriginAllowed(req: IncomingMessage): boolean {
    let hosts = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (req.rawHeaders[i]!.toLowerCase() === "host") hosts++;
    if (
      hosts !== 1 ||
      req.headers.host !== new URL(options.publicOrigin).host ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return false;
    return req.headers.origin === undefined || req.headers.origin === options.publicOrigin;
  }
  async function authenticate(req: IncomingMessage): Promise<ProjectControlSession | null> {
    if (!isOriginAllowed(req)) return null;
    const token = requestToken(req);
    if (!token || !TOKEN.test(token)) return null;
    const entry = [...sessions.values()].find((row) => row.hash === hash(token));
    if (!entry || !entryFor(entry.session)) return null;
    await revalidate(entry.session);
    return { ...entry.session };
  }
  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
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
      /* fixed public error below */
    }
    throw new ProjectRegistryError(400, "请求格式无效。");
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? "/").split("?", 1)[0]!;
    if (!path.startsWith("/api/v1/cloud-management/") && !path.startsWith("/api/v1/auth/"))
      return false;
    if (!isOriginAllowed(req)) throw new ProjectRegistryError(403, "请求来源无效。");
    if (closed) throw new ProjectRegistryError(503, "Cloud 管理服务正在关闭。");
    if (req.url !== path) throw new ProjectRegistryError(400, "请求参数无效。");
    if (path === "/api/v1/cloud-management/capabilities" && req.method === "GET") {
      json(res, 200, {
        version: CLOUD_MANAGEMENT_AUTHORITY_VERSION,
        mode: "cloud-account",
        cloudOrigin: options.publicOrigin,
        installationId: options.installationId,
        accountOrigin: options.binding.accountOrigin,
      });
      return true;
    }
    if (path === "/api/v1/cloud-management/session" && req.method === "POST") {
      // Main sends an Account-issued target-bound single-use ticket, never its root credential.
      if (
        req.headers.origin !== undefined ||
        req.headers.cookie !== undefined ||
        req.headers.authorization !== undefined ||
        req.headers["sec-fetch-site"] !== undefined
      )
        throw new ProjectRegistryError(403, "请从桌面 Cloud 管理器登录。");
      if (now() >= attempts.until) attempts = { until: now() + 60_000, count: 0 };
      if (++attempts.count > 60 || exchanging >= 4)
        throw new ProjectRegistryError(429, "Cloud 管理登录请求过多。");
      exchanging++;
      try {
        const body = await readBody(req);
        if (
          Object.keys(body).join() !== "ticket" ||
          typeof body.ticket !== "string" ||
          !TOKEN.test(body.ticket)
        )
          throw new ProjectRegistryError(400, "Cloud 管理票据格式无效。");
        let principal: CloudAccountPrincipal;
        try {
          principal = await options.authority.redeem(body.ticket, options.installationId);
        } catch {
          throw new ProjectRegistryError(401, "云账号验证失败。");
        }
        if (
          closed ||
          !principalValid(principal) ||
          principal.accountOrigin !== options.binding.accountOrigin ||
          principal.accountId !== options.binding.accountId ||
          principal.expiresAt <= now()
        )
          throw new ProjectRegistryError(403, "此账号没有 Cloud 管理权限。");
        for (const [id, row] of sessions)
          if (row.session.expiresAt + 600_000 <= now()) sessions.delete(id);
        if (sessions.size >= 128)
          throw new ProjectRegistryError(429, "Cloud 管理会话数量已达上限。");
        const token = randomBytes(32).toString("base64url");
        const session: CloudManagementSession = {
          id: randomUUID(),
          kind: "cloud-management",
          audience: options.publicOrigin,
          installationId: options.installationId,
          accountOrigin: principal.accountOrigin,
          accountId: principal.accountId,
          managementEpoch: options.binding.managementEpoch,
          expiresAt: Math.min(now() + 600_000, principal.expiresAt),
          ownerId: options.binding.ownerId,
        };
        sessions.set(session.id, {
          hash: hash(token),
          session,
          principal: { ...principal },
          revoked: false,
        });
        json(res, 201, { token, session: cloudManagementSessionView(session) });
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
      ["/api/v1/cloud-management/logout", "/api/v1/auth/logout"].includes(path) &&
      req.method === "POST"
    ) {
      const body = await readBody(req);
      if (Object.keys(body).length) throw new ProjectRegistryError(400, "退出不接受额外参数。");
      const token = requestToken(req);
      const entry =
        token &&
        TOKEN.test(token) &&
        [...sessions.values()].find((row) => row.hash === hash(token));
      if (!entry) throw new ProjectRegistryError(401, "Cloud 管理登录已失效。");
      revoke(entry);
      res.setHeader(
        "Set-Cookie",
        `${CLOUD_MANAGEMENT_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${options.publicOrigin.startsWith("https:") ? "; Secure" : ""}`,
      );
      json(res, 200, { revoked: true });
      return true;
    }
    throw new ProjectRegistryError(403, "此 Cloud 只接受明确绑定的云账号管理。");
  }
  return {
    cookieName: CLOUD_MANAGEMENT_COOKIE,
    store: {
      listSessions: () =>
        [...sessions.values()]
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
      for (const row of sessions.values()) revoke(row);
      sessions.clear();
    },
  };
}
