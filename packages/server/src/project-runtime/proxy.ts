import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { Transform, type Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { HUB_SESSION_COOKIE, type HubAuth } from "../hub/auth-http.js";
import type { HubSession } from "../hub/auth-store.js";
import type { ProjectRuntimeConnection } from "./types.js";

export type RuntimeTarget = ProjectRuntimeConnection;

export interface ProjectRuntimeProxyOptions {
  auth: HubAuth;
  resolveTarget(projectId: string, session: HubSession): Promise<RuntimeTarget>;
  publicOrigin: () => string;
  /** Stop this runtime if its private logout cannot acknowledge revocation.
   * Dispatched after retirement settles; may call back into revokeProject. */
  onRevocationFailure?: (projectId: string) => void | Promise<void>;
}

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const PROJECT_PATH = new RegExp(`^/p/(${UUID})(/.*)$`);
const API_PATH =
  /^\/api\/v1\/(?:configuration|mcp|skills|links|panels|panel-assets|files|sessions|uploads)(?:\/|$)/;
const ASSET_PATH = /^\/api\/v1\/panel-assets\/([A-Za-z0-9_-]{43})\//;
const PREPARE_PATH = "/api/v1/panels/runtime/prepare";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PREPARE_BYTES = 1024 * 1024;
// Match Hub's existing 32 MiB transcript / 64 MiB response contract. Following
// frames are independently bounded, and paused until the previous write drains.
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_FRAME_BYTES = 128 * 1024 * 1024;
const MAX_LEASES = 1024;
const MAX_ASSETS = 4096;
const MAX_ASSETS_PER_LEASE = 128;
const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "content-length",
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "x-file-name",
];
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "content-security-policy",
  "permissions-policy",
  "cross-origin-resource-policy",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "referrer-policy",
  "x-content-type-options",
];

class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Route {
  projectId: string;
  path: string;
  pathname: string;
}
interface Lease {
  key: string;
  projectId: string;
  sessionId: string;
  projectRevision: number;
  target: RuntimeTarget;
  cookie?: string;
  login: Promise<string>;
  revoked: boolean;
  retirement?: Promise<void>;
  active: Set<() => void>;
  assets: Set<string>;
}
interface AssetGrant {
  lease: Lease;
  instanceId: string;
  expiresAt: number;
}

/** Private runtime credentials and cookies never cross this control-plane boundary. */
export function createProjectRuntimeProxy(options: ProjectRuntimeProxyOptions) {
  const leases = new Map<string, Lease>();
  const assets = new Map<string, AssetGrant>();
  const revokedOwners = new Set<string>();
  const projectRevisions = new Map<string, number>();
  const retirements = new Set<Promise<void>>();
  const failedLogouts = new Set<Lease>();
  const upgrades = new Set<() => void>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  let closed = false;
  let sweeping = false;
  let queuedFrameBytes = 0;

  function liveSession(id: string): HubSession {
    if (closed || revokedOwners.has(id)) throw new ProxyError(401, "Project session expired");
    const session = options.auth.store.listSessions().find((item) => item.id === id);
    if (!session || session.expiresAt <= Date.now())
      throw new ProxyError(401, "Project session expired");
    return session;
  }

  function assertLease(lease: Lease): HubSession {
    const session = liveSession(lease.sessionId);
    if (lease.revoked || (projectRevisions.get(lease.projectId) ?? 0) !== lease.projectRevision)
      throw new ProxyError(410, "Project runtime changed; reopen the project");
    return session;
  }

  async function validate(lease: Lease): Promise<void> {
    const session = assertLease(lease);
    const current = checkedTarget(await options.resolveTarget(lease.projectId, session));
    assertLease(lease);
    if (!sameTarget(current, lease.target)) {
      void retire(lease);
      throw new ProxyError(410, "Project runtime changed; reopen the project");
    }
  }

  function forgetAssets(lease: Lease, instanceId?: string) {
    for (const key of lease.assets) {
      if (instanceId && assets.get(key)?.instanceId !== instanceId) continue;
      assets.delete(key);
      lease.assets.delete(key);
    }
  }

  function retire(lease: Lease): Promise<void> {
    if (lease.retirement) return lease.retirement;
    lease.revoked = true;
    if (leases.get(lease.key) === lease) leases.delete(lease.key);
    forgetAssets(lease);
    for (const cancel of [...lease.active]) cancel();
    lease.active.clear();
    // A login already accepted by the runtime may finish after revocation. Its
    // resulting cookie must be logged out too, and must never start a request.
    const retirement = (async () => {
      const cookie = lease.cookie ?? (await lease.login.catch(() => undefined));
      if (cookie) await innerJson(lease.target, "/api/v1/auth/logout", "{}", cookie, 3_000);
    })();
    lease.retirement = retirement;
    retirements.add(retirement);
    void retirement.then(
      () => {
        retirements.delete(retirement);
        failedLogouts.delete(lease);
      },
      () => {
        retirements.delete(retirement);
        failedLogouts.add(lease);
        void Promise.resolve()
          .then(() => options.onRevocationFailure?.(lease.projectId))
          .catch(() => {});
      },
    );
    return retirement;
  }

  async function acquire(req: IncomingMessage, projectId: string): Promise<Lease> {
    if (!options.auth.isOriginAllowed(req))
      throw new ProxyError(403, "Request origin is not allowed");
    const session = await options.auth.authenticate(req);
    if (!session) throw new ProxyError(401, "Authentication required");
    liveSession(session.id);
    const projectRevision = projectRevisions.get(projectId) ?? 0;
    const target = checkedTarget(await options.resolveTarget(projectId, session));
    liveSession(session.id);
    if (projectRevision !== (projectRevisions.get(projectId) ?? 0))
      throw new ProxyError(410, "Project runtime changed; reopen the project");
    const key = `${session.id}:${projectId}:${target.generation}`;
    let lease = leases.get(key);
    if (lease && !sameTarget(lease.target, target)) {
      await retire(lease);
      throw new ProxyError(410, "Project runtime changed; reopen the project");
    }
    if (!lease) {
      for (const previous of leases.values()) {
        if (previous.sessionId === session.id && previous.projectId === projectId)
          void retire(previous);
      }
      if (leases.size + retirements.size + failedLogouts.size >= MAX_LEASES)
        throw new ProxyError(503, "Too many project connections");
      lease = {
        key,
        projectId,
        sessionId: session.id,
        projectRevision,
        target,
        login: Promise.resolve(""),
        revoked: false,
        active: new Set(),
        assets: new Set(),
      };
      const created = lease;
      leases.set(key, created);
      created.login = innerJson(
        target,
        "/api/v1/auth/login",
        JSON.stringify({
          username: target.username,
          password: target.password,
          deviceName: `project-proxy:${session.id}`,
        }),
      ).then(({ response, bytes }) => {
        const body = JSON.parse(bytes.toString("utf8"));
        const cookies = response.headers["set-cookie"] ?? [];
        const cookie = cookies
          .map((value) => value.split(";", 1)[0]!)
          .find((value) => new RegExp(`^${HUB_SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`).test(value));
        if (!cookie || body.authenticated !== true)
          throw new ProxyError(502, "Runtime login failed");
        created.cookie = cookie;
        return cookie;
      });
    }
    try {
      await lease.login;
      await validate(lease);
      return lease;
    } catch (error) {
      void retire(lease);
      throw error;
    }
  }

  async function acquireAsset(req: IncomingMessage, route: Route): Promise<Lease> {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? ""))
      throw new ProxyError(405, "Panel assets are read-only");
    const token = ASSET_PATH.exec(route.pathname)?.[1];
    const key = `${route.projectId}:${token}`;
    const grant = token && assets.get(key);
    if (!grant || grant.expiresAt <= Date.now()) {
      if (grant) {
        assets.delete(key);
        grant.lease.assets.delete(key);
      }
      throw new ProxyError(410, "Panel asset grant expired");
    }
    // An opaque iframe has no cookie and Origin:null. Only its already issued
    // random capability takes this path; another signed-in owner cannot borrow it.
    if (
      req.headers.authorization !== undefined ||
      req.headers.cookie?.includes(`${HUB_SESSION_COOKIE}=`)
    ) {
      const session = await options.auth.authenticate(req);
      if (!session || session.id !== grant.lease.sessionId)
        throw new ProxyError(403, "Panel asset belongs to another session");
    }
    await validate(grant.lease);
    if (assets.get(key) !== grant) throw new ProxyError(410, "Panel asset grant expired");
    return grant.lease;
  }

  function rememberPrepare(lease: Lease, bytes: Buffer) {
    const value = JSON.parse(bytes.toString("utf8"));
    const match = typeof value.src === "string" && ASSET_PATH.exec(value.src);
    if (
      !match ||
      typeof value.instanceId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(value.instanceId) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now()
    )
      throw new ProxyError(502, "Runtime returned an invalid panel grant");
    if (assets.size >= MAX_ASSETS || lease.assets.size >= MAX_ASSETS_PER_LEASE)
      throw new ProxyError(503, "Too many panel resource grants");
    const key = `${lease.projectId}:${match[1]}`;
    if (assets.has(key)) throw new ProxyError(502, "Runtime returned a duplicate panel grant");
    assets.set(key, { lease, instanceId: value.instanceId, expiresAt: value.expiresAt });
    lease.assets.add(key);
  }

  function headers(lease: Lease, req?: IncomingMessage): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {
      origin: options.publicOrigin(),
      cookie: lease.cookie!,
    };
    for (const name of REQUEST_HEADERS) {
      const value = req?.headers[name];
      if (value !== undefined) result[name] = value;
    }
    return result;
  }

  async function innerJson(
    target: RuntimeTarget,
    path: string,
    body: string,
    cookie?: string,
    timeout = 10_000,
  ) {
    return await new Promise<{ response: IncomingMessage; bytes: Buffer }>((resolve, reject) => {
      const request = httpRequest(
        new URL(path, target.url),
        {
          method: "POST",
          headers: {
            origin: options.publicOrigin(),
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...(cookie ? { cookie } : {}),
          },
        },
        (response) => {
          if (
            response.statusCode !== 200 &&
            !(path === "/api/v1/auth/logout" && response.statusCode === 401)
          ) {
            response.resume();
            reject(new ProxyError(502, "Runtime authentication unavailable"));
            return;
          }
          void readBounded(response, 32 * 1024).then(
            (bytes) => resolve({ response, bytes }),
            reject,
          );
        },
      );
      const timer = setTimeout(
        () => request.destroy(new ProxyError(504, "Runtime authentication timed out")),
        timeout,
      );
      timer.unref();
      request.on("error", reject);
      request.on("close", () => clearTimeout(timer));
      request.end(body);
    });
  }

  async function forwardHttp(
    req: IncomingMessage,
    res: ServerResponse,
    route: Route,
    lease: Lease,
  ): Promise<void> {
    assertLease(lease);
    if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES)
      throw new ProxyError(413, "Project request is too large");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let response: IncomingMessage | undefined;
      let received = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          callback(
            received > MAX_REQUEST_BYTES
              ? new ProxyError(413, "Project request is too large")
              : null,
            chunk,
          );
        },
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        lease.active.delete(cancel);
        req.off("aborted", cancel);
        res.off("close", disconnected);
        res.off("finish", finished);
        req.unpipe(limit);
        limit.unpipe(upstream);
        if (error) {
          upstream.destroy();
          response?.destroy();
          limit.destroy();
          reject(error);
        } else resolve();
      };
      const cancel = () => finish(new ProxyError(410, "Project connection closed"));
      const disconnected = () => {
        if (!res.writableFinished) cancel();
      };
      const finished = () => finish();
      const upstream = httpRequest(new URL(route.path, lease.target.url), {
        method: req.method,
        headers: headers(lease, req),
      });
      upstream.setTimeout(120_000, () => finish(new ProxyError(504, "Runtime request timed out")));
      upstream.on("error", () => finish(new ProxyError(502, "Project runtime unavailable")));
      limit.on("error", (error) => finish(error));
      upstream.on("response", (incoming) => {
        response = incoming;
        incoming.on("error", () => finish(new ProxyError(502, "Runtime response interrupted")));
        void (async () => {
          await validate(lease);
          if (settled) return;
          if (
            (incoming.statusCode ?? 502) >= 300 &&
            (incoming.statusCode ?? 502) < 400 &&
            incoming.statusCode !== 304
          )
            throw new ProxyError(502, "Runtime redirect is not allowed");
          const prepare =
            req.method === "POST" && route.pathname === PREPARE_PATH && incoming.statusCode === 200;
          const renew =
            req.method === "POST" &&
            incoming.statusCode === 200 &&
            /^\/api\/v1\/panels\/runtime\/([A-Za-z0-9_-]+)\/renew$/.exec(route.pathname);
          const bytes =
            prepare || renew ? await readBounded(incoming, MAX_PREPARE_BYTES) : undefined;
          if (bytes) {
            await validate(lease);
            if (settled) return;
            if (prepare) rememberPrepare(lease, bytes);
            else if (renew) {
              const { expiresAt } = JSON.parse(bytes.toString("utf8"));
              if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
                throw new ProxyError(502, "Runtime returned an invalid panel renewal");
              for (const key of lease.assets) {
                const grant = assets.get(key);
                if (grant?.instanceId === renew[1]) grant.expiresAt = expiresAt;
              }
            }
          }
          if (
            req.method === "DELETE" &&
            /^\/api\/v1\/panels\/runtime\/[A-Za-z0-9_-]+$/.test(route.pathname) &&
            (incoming.statusCode ?? 500) < 300
          )
            forgetAssets(lease, route.pathname.split("/").at(-1));
          for (const name of RESPONSE_HEADERS) {
            const value = incoming.headers[name];
            if (value !== undefined) res.setHeader(name, value);
          }
          res.setHeader("Cache-Control", "no-store");
          res.writeHead(incoming.statusCode ?? 502);
          if (bytes) res.end(bytes);
          else incoming.pipe(res);
        })().catch((error) =>
          finish(
            error instanceof ProxyError ? error : new ProxyError(502, "Invalid runtime response"),
          ),
        );
      });
      lease.active.add(cancel);
      req.once("aborted", cancel);
      req.once("error", cancel);
      res.once("error", cancel);
      res.once("close", disconnected);
      res.once("finish", finished);
      req.pipe(limit).pipe(upstream);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!(req.url ?? "").startsWith("/p/")) return false;
    try {
      const route = parseRoute(req.url!);
      if (route.pathname === "/ws") throw new ProxyError(426, "WebSocket upgrade required");
      const lease = route.pathname.startsWith("/api/v1/panel-assets/")
        ? await acquireAsset(req, route)
        : await acquire(req, route.projectId);
      if (req.aborted || res.destroyed) return true;
      await forwardHttp(req, res, route, lease);
    } catch (error) {
      httpError(res, error);
    }
    return true;
  }

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    if (!(req.url ?? "").startsWith("/p/")) return false;
    let cancelled = false;
    let peer: WebSocket | undefined;
    const cancel = () => {
      cancelled = true;
      peer?.terminate();
      socket.destroy();
    };
    upgrades.add(cancel);
    socket.once("close", cancel);
    socket.once("error", cancel);
    let lease: Lease | undefined;
    try {
      const route = parseRoute(req.url!);
      if (req.method !== "GET" || route.pathname !== "/ws")
        throw new ProxyError(404, "Project endpoint not found");
      lease = await acquire(req, route.projectId);
      if (cancelled) return true;
      lease.active.add(cancel);
      const url = new URL("/ws", lease.target.url);
      url.protocol = "ws:";
      peer = new WebSocket(url, {
        headers: headers(lease),
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
        handshakeTimeout: 10_000,
      });
      peer.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        peer!.once("open", () => {
          peer!.pause();
          resolve();
        });
        peer!.once("error", () => reject(new ProxyError(502, "Project socket unavailable")));
        peer!.once("close", () => reject(new ProxyError(502, "Project socket closed")));
      });
      await validate(lease);
      if (cancelled) return true;
      const owned = lease;
      const upstream = peer;
      wss.handleUpgrade(req, socket, head, (client) => {
        lease!.active.delete(cancel);
        socket.off("close", cancel);
        upgrades.delete(cancel);
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          owned.active.delete(stop);
          client.terminate();
          upstream.terminate();
        };
        owned.active.add(stop);
        client.on("close", stop);
        upstream.on("close", stop);
        client.on("error", stop);
        upstream.on("error", stop);
        const bridge = (source: WebSocket, destination: WebSocket) => {
          let chain = Promise.resolve();
          let bytesQueued = 0;
          const frameSizes: number[] = [];
          source.on("message", (data: RawData, binary: boolean) => {
            if (stopped) return;
            const bytes = rawSize(data);
            if (
              bytes > MAX_FRAME_BYTES ||
              (frameSizes.length > 0 &&
                bytesQueued - frameSizes[0]! + bytes > MAX_FRAME_TAIL_BYTES) ||
              frameSizes.length >= 128 ||
              queuedFrameBytes + bytes > MAX_TOTAL_FRAME_BYTES
            ) {
              stop();
              return;
            }
            // Native Node/ws exposes flow control; Bun's server-side ws shim
            // does not. The same queue bounds still fail closed on that host.
            source.pause?.();
            bytesQueued += bytes;
            frameSizes.push(bytes);
            queuedFrameBytes += bytes;
            chain = chain
              .then(async () => {
                if (stopped) return;
                await validate(owned);
                if (stopped) return;
                await new Promise<void>((resolve, reject) =>
                  destination.send(data, { binary }, (error) =>
                    error ? reject(error) : resolve(),
                  ),
                );
              })
              .catch(stop)
              .finally(() => {
                bytesQueued -= bytes;
                frameSizes.shift();
                queuedFrameBytes -= bytes;
                if (!stopped && frameSizes.length === 0) source.resume?.();
              });
          });
        };
        bridge(client, upstream);
        bridge(upstream, client);
        upstream.resume();
      });
    } catch (error) {
      peer?.terminate();
      if (!cancelled && !socket.destroyed) upgradeError(socket, error);
    } finally {
      upgrades.delete(cancel);
      socket.off("close", cancel);
      socket.off("error", cancel);
      lease?.active.delete(cancel);
    }
    return true;
  }

  async function revokeOwner(sessionId: string): Promise<void> {
    revokedOwners.add(sessionId);
    await Promise.all(
      [...new Set([...leases.values(), ...failedLogouts])]
        .filter((lease) => lease.sessionId === sessionId)
        .map(retire),
    );
  }
  async function revokeProject(projectId: string): Promise<void> {
    projectRevisions.set(projectId, (projectRevisions.get(projectId) ?? 0) + 1);
    await Promise.all(
      [...new Set([...leases.values(), ...failedLogouts])]
        .filter((lease) => lease.projectId === projectId)
        .map(retire),
    );
  }
  const timer = setInterval(() => {
    if (closed) return;
    let current: Set<string>;
    try {
      current = new Set(options.auth.store.listSessions().map((session) => session.id));
    } catch {
      current = new Set();
    }
    // Logout retries or a slow Docker status check must not delay the next
    // authentication sweep: retire all invalid outer owners synchronously.
    for (const lease of [...leases.values()])
      if (!current.has(lease.sessionId)) void revokeOwner(lease.sessionId).catch(() => {});
    if (sweeping) return;
    sweeping = true;
    void (async () => {
      for (const [key, grant] of assets)
        if (grant.expiresAt <= Date.now()) {
          assets.delete(key);
          grant.lease.assets.delete(key);
        }
      // Failed revocations never restore browser access. Retry only the fixed
      // private logout endpoint until the runtime acknowledges invalidation.
      await Promise.allSettled([
        ...[...leases.values()].map(async (lease) => {
          try {
            await validate(lease);
          } catch {
            await retire(lease);
          }
        }),
        ...[...failedLogouts].map(async (lease) => {
          if (lease.cookie)
            await innerJson(lease.target, "/api/v1/auth/logout", "{}", lease.cookie, 3_000);
          failedLogouts.delete(lease);
        }),
      ]);
    })().finally(() => {
      sweeping = false;
    });
  }, 2_000);
  timer.unref();

  return {
    handle,
    handleUpgrade,
    revokeOwner,
    revokeProject,
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      for (const cancel of upgrades) cancel();
      const results = await Promise.allSettled([
        ...[...leases.values()].map(retire),
        ...retirements,
        ...[...failedLogouts].map(async (lease) => {
          if (lease.cookie)
            await innerJson(lease.target, "/api/v1/auth/logout", "{}", lease.cookie, 3_000);
        }),
      ]);
      wss.close();
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}

function checkedTarget(target: RuntimeTarget): RuntimeTarget {
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new ProxyError(503, "Project runtime unavailable");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !Number.isSafeInteger(target.generation) ||
    target.generation < 1 ||
    !target.username ||
    !target.password
  )
    throw new ProxyError(503, "Invalid project runtime target");
  return {
    url: url.origin,
    username: target.username,
    password: target.password,
    generation: target.generation,
  };
}

function sameTarget(left: RuntimeTarget, right: RuntimeTarget): boolean {
  return (
    left.url === right.url &&
    left.generation === right.generation &&
    left.username === right.username &&
    left.password === right.password
  );
}

function parseRoute(raw: string): Route {
  if (raw.includes("#") || raw.includes("\\") || /[\u0000-\u0020\u007f]/.test(raw))
    throw new ProxyError(400, "Invalid project path");
  const match = PROJECT_PATH.exec(raw);
  if (!match) throw new ProxyError(404, "Project endpoint not found");
  const pathname = match[2]!.split("?", 1)[0]!;
  try {
    for (const segment of pathname.split("/")) {
      const decoded = decodeURIComponent(segment);
      if (
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        /[\\\u0000-\u001f\u007f]/.test(decoded)
      )
        throw new Error("invalid segment");
    }
  } catch {
    throw new ProxyError(400, "Invalid project path");
  }
  if (pathname !== "/ws" && !API_PATH.test(pathname))
    throw new ProxyError(404, "Project endpoint not found");
  const url = new URL(match[2]!, "http://runtime.invalid");
  // The private host owns exactly one workspace. Browser-selected paths never
  // select a host filesystem or override the project's environment.
  url.searchParams.delete("workspace");
  return { projectId: match[1]!, pathname, path: url.pathname + url.search };
}

async function readBounded(response: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) {
      response.destroy();
      throw new ProxyError(502, "Runtime response is too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function rawSize(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((size, buffer) => size + buffer.byteLength, 0)
    : data.byteLength;
}

function httpError(res: ServerResponse, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = error instanceof ProxyError ? error.status : 503;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(
    JSON.stringify({
      error: error instanceof ProxyError ? error.message : "Project runtime unavailable",
    }),
  );
}

function upgradeError(socket: Duplex, error: unknown): void {
  const status = error instanceof ProxyError ? error.status : 503;
  socket.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
