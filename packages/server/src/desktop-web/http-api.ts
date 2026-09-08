import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { createHubConfiguration, HubConfigurationError } from "../hub/configuration.js";
import { createHubFiles } from "../hub/files.js";
import { createHubMcpConfiguration } from "../hub/mcp-configuration.js";
import { createHubSessions } from "../hub/session-management.js";
import { createHubSkills } from "../hub/skills-management.js";
import type { TrustedDeviceStore } from "../mobile-remote/trusted-device-store.js";
import type { TrustedDevicePublic } from "../mobile-remote/types.js";

const COOKIE = "cs_desktop_session";
const SESSION_TTL = 30 * 60_000;
const MAX_SESSIONS = 512;
const MAX_WORKSPACES = 32;

export interface DesktopWebRequestContext {
  deviceId: string;
  sessionId: string;
  cwd: string;
  /** Recheck both the paired device and Desktop's authoritative workspace registry. */
  isAuthorized: () => Promise<boolean>;
}

export interface DesktopWebApiOptions {
  devices: TrustedDeviceStore;
  /** Desktop's existing title store directory: codeShellHome()/desktop. */
  dataDir: string;
  sessionRootDir: string;
  /** Input is untrusted. Return only a workspace already known to Desktop. */
  resolveWorkspace: (
    input: string | undefined,
    deviceId: string,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * The existing Desktop AgentBridge owns this run/configuration admission lock.
   * Reject active runs with status 409, hold the lock through write + hot reload,
   * and notify the existing renderer/remote clients after a successful reload.
   */
  withConfigurationMutation: <T>(cwd: string, write: () => Promise<T>) => Promise<T>;
  isRunning: (sessionId: string) => boolean;
  onSessionsChanged?: (cwd: string, sessionId: string) => void;
  /** Release owner-scoped resources contributed by handleExtra (for example Link probes). */
  onSessionRevoked?: (sessionId: string) => void;
  onClose?: () => void | Promise<void>;
  /** Authenticated same-origin composition point, for example the shared Link API. */
  handleExtra?: (
    request: IncomingMessage,
    response: ServerResponse,
    context: DesktopWebRequestContext,
  ) => boolean | Promise<boolean>;
  now?: () => number;
  sessionTtlMs?: number;
}

export interface DesktopWebHttpApi {
  handle: (
    request: IncomingMessage,
    response: ServerResponse,
    context: { baseUrl: string },
  ) => Promise<boolean>;
  /** Reopen after RemoteHostManager.stop(), without reviving previous cookies. */
  start: () => void;
  close: () => Promise<void>;
  revokeDevice: (deviceId: string) => void;
}

interface BrowserSession {
  id: string;
  deviceId: string;
  expiresAt: number;
}

interface RequestIdentity {
  token: string;
  session: BrowserSession;
  input: string | undefined;
  cwd: string;
  generation: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function workspaceInput(request: IncomingMessage, url: URL): string | undefined {
  const raw = request.headers["x-codeshell-workspace"];
  let header: string | undefined;
  try {
    if (Array.isArray(raw)) throw new Error();
    header = raw === undefined ? undefined : decodeURIComponent(raw);
  } catch {
    throw new HubConfigurationError(400, "工作区请求头无效。");
  }
  const queries = url.searchParams.getAll("workspace");
  if (queries.length > 1 || (header !== undefined && queries.length && header !== queries[0]))
    throw new HubConfigurationError(400, "请求中的工作区不一致。");
  // URLSearchParams has already decoded the query; literal percent signs in paths survive.
  const input = header ?? queries[0];
  if (input !== undefined && (!input || input.length > 4096 || input.includes("\0")))
    throw new HubConfigurationError(400, "工作区路径无效。");
  return input;
}

function sameOrigin(request: IncomingMessage, baseUrl: string): URL {
  const expected = new URL(baseUrl);
  if (!["http:", "https:"].includes(expected.protocol))
    throw new HubConfigurationError(503, "桌面远程地址尚未就绪。");
  // The manager supplies its bound/public URL. Never derive trust from Host or forwarded headers.
  if (request.headers.host?.toLowerCase() !== expected.host.toLowerCase())
    throw new HubConfigurationError(403, "请使用桌面显示的远程访问地址。");
  const origin = request.headers.origin;
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (
    (origin !== undefined && origin !== expected.origin) ||
    (!readOnly && origin === undefined) ||
    request.headers["sec-fetch-site"] === "cross-site"
  )
    throw new HubConfigurationError(403, "请求必须来自同一个桌面远程页面。");
  return expected;
}

function cookieToken(request: IncomingMessage): string | undefined {
  const tokens = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE}=`))
    .map((part) => part.slice(COOKIE.length + 1));
  return tokens.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(tokens[0]!) ? tokens[0] : undefined;
}

async function credentials(
  request: IncomingMessage,
): Promise<{ deviceId: string; secretHash: string }> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
    throw new HubConfigurationError(415, "请求必须使用 JSON 格式。");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared > 16 * 1024)
    throw new HubConfigurationError(413, "设备认证内容过大。");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timeout = setTimeout(() => request.destroy(), 10_000);
  timeout.unref();
  try {
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024) throw new HubConfigurationError(413, "设备认证内容过大。");
      chunks.push(Buffer.from(chunk));
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HubConfigurationError(400, "设备认证格式无效。");
    }
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !["deviceId", "secretHash"].includes(key)) ||
      typeof input.deviceId !== "string" ||
      !input.deviceId ||
      input.deviceId.length > 512 ||
      typeof input.secretHash !== "string" ||
      !input.secretHash ||
      input.secretHash.length > 4096
    )
      throw new HubConfigurationError(400, "设备认证格式无效。");
    return { deviceId: input.deviceId, secretHash: input.secretHash };
  } finally {
    clearTimeout(timeout);
  }
}

/** HTTP facade over existing Desktop storage and worker callbacks; never starts a worker. */
export function createDesktopWebApi(options: DesktopWebApiOptions): DesktopWebHttpApi {
  const now = options.now ?? Date.now;
  const ttl = options.sessionTtlMs ?? SESSION_TTL;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 24 * 60 * 60_000)
    throw new Error("Desktop HTTP session lifetime must be between one second and one day");
  const sessions = new Map<string, BrowserSession>();
  const identities = new WeakMap<IncomingMessage, RequestIdentity>();
  const workspaces = new Map<string, ReturnType<typeof createServices>>();
  let generation = 0;
  let closed = false;

  function cancelSession(session: BrowserSession): void {
    for (const services of workspaces.values()) {
      services.configuration.cancelOwner(session.id);
      services.mcp.cancelOwner(session.id);
    }
    // Optional extensions cannot prevent the primary transports from being revoked.
    try {
      options.onSessionRevoked?.(session.id);
    } catch {
      // Their host-wide onClose callback remains a second cleanup opportunity.
    }
  }

  function dropSession(token: string): void {
    const session = sessions.get(token);
    if (session) cancelSession(session);
    sessions.delete(token);
  }

  function principal(
    token: string | undefined,
  ): { session: BrowserSession; device: TrustedDevicePublic } | undefined {
    if (closed || !token) return;
    const session = sessions.get(token);
    if (!session) return;
    if (session.expiresAt <= now()) {
      dropSession(token);
      return;
    }
    // A signed-in cookie never bypasses a later revocation/removal from the on-disk device store.
    const device = options.devices
      .listDevices()
      .find((row) => row.id === session.deviceId && !row.revokedAt);
    if (!device) {
      dropSession(token);
      return;
    }
    return { session, device };
  }

  async function authorized(request: IncomingMessage): Promise<boolean> {
    const identity = identities.get(request);
    if (!identity || closed || identity.generation !== generation) return false;
    try {
      if (principal(identity.token)?.session !== identity.session) return false;
      const resolved = await options.resolveWorkspace(identity.input, identity.session.deviceId);
      // The resolver can yield while a device is revoked or the host is stopped.
      return (
        resolved === identity.cwd &&
        !closed &&
        identity.generation === generation &&
        principal(identity.token)?.session === identity.session
      );
    } catch {
      return false;
    }
  }

  async function owner(request: IncomingMessage): Promise<string | undefined> {
    return (await authorized(request)) ? identities.get(request)?.session.id : undefined;
  }

  function createServices(cwd: string) {
    const shared = {
      cwd,
      isAuthorized: authorized,
      ownerId: owner,
      withMutation: async <T>(write: () => Promise<T>): Promise<T> => {
        try {
          return await options.withConfigurationMutation(cwd, write);
        } catch (error) {
          if (error instanceof HubConfigurationError) throw error;
          const status = (error as { status?: unknown })?.status;
          if (status === 409 || status === 503)
            throw new HubConfigurationError(
              status,
              status === 409
                ? "桌面正在运行任务，请等待任务结束后再保存。"
                : "桌面配置尚未重新载入，请稍后重试。",
            );
          throw error;
        }
      },
    };
    const configuration = createHubConfiguration(shared);
    const skills = createHubSkills({
      ...shared,
      dataDir: options.dataDir,
      owner: async (req) => (await owner(req)) ?? null,
    });
    const mcp = createHubMcpConfiguration(shared);
    const files = createHubFiles(shared);
    const history = createHubSessions({
      ...shared,
      sessionRootDir: options.sessionRootDir,
      dataDir: options.dataDir,
      isRunning: options.isRunning,
      onChanged: (id) => options.onSessionsChanged?.(cwd, id),
    });
    return {
      configuration,
      mcp,
      active: 0,
      async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
        for (const service of [configuration, skills, mcp, files, history])
          if (await service.handle(request, response)) return true;
        return false;
      },
      async close() {
        configuration.close();
        await Promise.allSettled([skills.close(), mcp.close(), files.close()]);
      },
    };
  }

  function servicesFor(cwd: string) {
    let services = workspaces.get(cwd);
    if (services) workspaces.delete(cwd);
    else {
      if (workspaces.size >= MAX_WORKSPACES) {
        const idle = [...workspaces].find(([, entry]) => entry.active === 0);
        if (!idle) throw new HubConfigurationError(429, "同时打开的工作区过多，请稍后重试。");
        workspaces.delete(idle[0]);
        void idle[1].close();
      }
      services = createServices(cwd);
    }
    workspaces.set(cwd, services);
    return services;
  }

  function status(session?: BrowserSession, device?: TrustedDevicePublic) {
    return {
      host: "desktop",
      initialized: true,
      authenticated: !!session,
      ...(session && device
        ? { session: { id: session.id, username: device.name, deviceName: device.name } }
        : {}),
    };
  }

  function setCookie(response: ServerResponse, token: string, secure: boolean): void {
    response.setHeader(
      "set-cookie",
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? Math.floor(ttl / 1000) : 0}${secure ? "; Secure" : ""}`,
    );
  }

  return {
    start() {
      closed = false;
    },
    revokeDevice(deviceId) {
      for (const [token, session] of sessions)
        if (session.deviceId === deviceId) dropSession(token);
    },
    async close() {
      if (closed) return;
      closed = true;
      generation++;
      for (const session of sessions.values()) cancelSession(session);
      sessions.clear();
      const entries = [...workspaces.values()];
      workspaces.clear();
      await Promise.allSettled([...entries.map((entry) => entry.close()), options.onClose?.()]);
    },
    async handle(request, response, context) {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/v1/")) return false;
      try {
        if (closed) throw new HubConfigurationError(503, "桌面远程服务已停止。");
        const requestGeneration = generation;
        const origin = sameOrigin(request, context.baseUrl);
        const secure = origin.protocol === "https:";
        const token = cookieToken(request);
        if (request.method === "POST" && url.pathname === "/api/v1/desktop/session") {
          const input = await credentials(request);
          if (closed || requestGeneration !== generation)
            throw new HubConfigurationError(503, "桌面远程服务已停止。");
          const device = options.devices.authenticate(input.deviceId, input.secretHash);
          if (!device)
            throw new HubConfigurationError(401, "设备未配对或已被撤销，请在桌面重新配对。");
          const existing = principal(token);
          if (token && existing?.session.deviceId === device.id) {
            // Tabs share a cookie and WebSocket reconnects exchange it again.
            // Keep owner-scoped probes and Link authorizations alive across that handshake.
            existing.session.expiresAt = now() + ttl;
            setCookie(response, token, secure);
            json(response, 200, status(existing.session, device));
            return true;
          }
          // Re-exchange replaces only this browser's cookie. Other tabs/devices remain signed in.
          if (token) dropSession(token);
          for (const [key, session] of sessions) if (session.expiresAt <= now()) dropSession(key);
          const own = [...sessions].filter(([, session]) => session.deviceId === device.id);
          while (own.length >= 8) dropSession(own.shift()![0]);
          while (sessions.size >= MAX_SESSIONS) dropSession(sessions.keys().next().value!);
          const nextToken = randomBytes(32).toString("base64url");
          const session = { id: randomUUID(), deviceId: device.id, expiresAt: now() + ttl };
          sessions.set(nextToken, session);
          setCookie(response, nextToken, secure);
          json(response, 200, status(session, device));
          return true;
        }
        const current = principal(token);
        if (
          request.method === "GET" &&
          ["/api/v1/auth/status", "/api/v1/auth"].includes(url.pathname)
        ) {
          json(response, 200, status(current?.session, current?.device));
          return true;
        }
        if (request.method === "POST" && url.pathname === "/api/v1/auth/logout") {
          if (token) dropSession(token);
          setCookie(response, "", secure);
          json(response, 200, { ok: true });
          return true;
        }
        if (!current || !token)
          throw new HubConfigurationError(401, "设备连接已失效，请重新连接桌面。");
        const input = workspaceInput(request, url);
        const cwd = await options.resolveWorkspace(input, current.device.id);
        if (
          closed ||
          generation !== requestGeneration ||
          principal(token)?.session !== current.session
        )
          throw new HubConfigurationError(401, "设备连接已失效，请重新连接桌面。");
        if (!cwd || !isAbsolute(cwd))
          throw new HubConfigurationError(403, "只能访问桌面已知的项目或会话工作区。");
        identities.set(request, { token, session: current.session, input, cwd, generation });
        const services = servicesFor(cwd);
        services.active++;
        try {
          if (await services.handle(request, response)) return true;
          if (
            await options.handleExtra?.(request, response, {
              deviceId: current.device.id,
              sessionId: current.session.id,
              cwd,
              isAuthorized: () => authorized(request),
            })
          )
            return true;
          json(response, 404, { error: "这个接口不适用于桌面远程模式。" });
        } finally {
          services.active--;
        }
      } catch (error) {
        json(response, error instanceof HubConfigurationError ? error.status : 500, {
          error:
            error instanceof HubConfigurationError
              ? error.message
              : "桌面远程请求失败，请稍后重试。",
        });
      }
      return true;
    },
  };
}
