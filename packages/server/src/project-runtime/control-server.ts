import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createHubAuth } from "../hub/auth-http.js";
import { resolveSafe } from "../mobile-remote/mobile-static.js";
import { contentTypeFor } from "../static-files.js";
import { createDockerProjectProvider } from "./docker-provider.js";
import { ProjectManager } from "./manager.js";
import { createProjectRuntimeProxy } from "./proxy.js";
import { ProjectRegistry, ProjectRegistryError } from "./registry.js";
import type { ProjectRuntimeProvider } from "./types.js";

export interface ProjectControlServerOptions {
  host: string;
  port: number;
  dataDir: string;
  publicOrigin?: string;
  staticRootDir?: string;
  runtimeImage?: string;
  /** Dependency injection for lifecycle/transport integration tests. */
  provider?: ProjectRuntimeProvider;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? ""))
    throw new ProjectRegistryError(415, "请使用 JSON 提交。");
  let size = 0;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(new ProjectRegistryError(400, "请求已中断。"));
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) {
        cleanup();
        request.resume();
        reject(new ProjectRegistryError(413, "请求过大。"));
      } else chunks.push(Buffer.from(chunk));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Invalid JSON is a client error. */
  }
  throw new ProjectRegistryError(400, "请求格式无效。");
}

/** A small account/project gateway. It never creates a worker, executes tools or mounts cwd. */
export async function startProjectControlServer(options: ProjectControlServerOptions) {
  const registry = new ProjectRegistry(options.dataDir);
  let proxy: ReturnType<typeof createProjectRuntimeProxy> | undefined;
  let manager: ProjectManager | undefined;
  let provider: ProjectRuntimeProvider | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let shuttingDown = false;
  try {
    const auth = await createHubAuth({
      dataDir: options.dataDir,
      publicOrigin: options.publicOrigin,
      onRevoke: (sessionId) => {
        if (shuttingDown) return;
        void proxy?.revokeOwner(sessionId).catch(async () => {
          if (shuttingDown) return;
          // The revoked browser's transports are already closed. If its inner
          // session cannot be revoked, stop the single administrator's runtimes.
          try {
            await manager?.stopAll();
          } catch {
            console.error(
              "[project-control] could not confirm project termination after session revocation.",
            );
          }
        });
      },
    });
    let listeningOrigin = "";
    const publicOrigin = () => options.publicOrigin ?? listeningOrigin;
    provider =
      options.provider ??
      createDockerProjectProvider({
        installationId: registry.installationId,
        dataDir: options.dataDir,
        image: options.runtimeImage,
      });
    manager = new ProjectManager({
      registry,
      provider,
      publicOrigin,
      isSessionActive: (session) =>
        auth.store
          .listSessions()
          .some((item) => item.id === session.id && item.username === session.username),
      revokeProject: async (id) => {
        await proxy?.revokeProject(id);
      },
    });
    const projects = manager;
    proxy = createProjectRuntimeProxy({
      auth,
      publicOrigin,
      resolveTarget: (id, session) => projects.resolveTarget(session, id),
      onRevocationFailure: (id) => {
        // Ordered shutdown below owns termination of every runtime. Do not
        // launch background cleanup that could outlive registry ownership.
        if (shuttingDown) return;
        void projects.stopAfterRevocationFailure(id).catch(() => {
          console.error(
            "[project-control] could not confirm project termination after runtime revocation failed.",
          );
        });
      },
    });
    const transport = proxy;
    await projects.reconcile();

    const handle = async (request: IncomingMessage, response: ServerResponse) => {
      if (shuttingDown) throw new ProjectRegistryError(503, "项目服务正在关闭。");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      const url = new URL(request.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      if (pathname === "/health" && request.method === "GET") {
        json(response, 200, { status: "ok", mode: "project-sandbox", runtime: "docker" });
        return;
      }
      if (await auth.handle(request, response)) return;
      if (await transport.handle(request, response)) return;
      if (pathname === "/api/v1/projects" || pathname.startsWith("/api/v1/projects/")) {
        if (!auth.isOriginAllowed(request)) throw new ProjectRegistryError(403, "请求来源无效。");
        const session = await auth.authenticate(request);
        if (!session) throw new ProjectRegistryError(401, "请先登录。");
        if (url.search) throw new ProjectRegistryError(400, "项目请求参数无效。");
        if (pathname === "/api/v1/projects" && request.method === "GET") {
          const availability = await provider!.availability();
          json(response, 200, {
            runtime: "docker",
            ...availability,
            projects: projects.list(session),
          });
          return;
        }
        if (pathname === "/api/v1/projects" && request.method === "POST") {
          const body = await readBody(request);
          if (Object.keys(body).some((key) => key !== "name"))
            throw new ProjectRegistryError(400, "仅支持设置项目名称。");
          json(response, 201, { project: projects.create(session, body.name) });
          return;
        }
        const match = /^\/api\/v1\/projects\/([a-f0-9-]{36})(?:\/(start|stop))?$/.exec(pathname);
        if (match && request.method === "GET" && !match[2]) {
          json(response, 200, { project: projects.get(session, match[1]!) });
          return;
        }
        if (match?.[2] && request.method === "POST") {
          const body = await readBody(request);
          if (Object.keys(body).length)
            throw new ProjectRegistryError(400, "启动和停止不接受额外参数。");
          const project =
            match[2] === "start"
              ? await projects.start(session, match[1]!)
              : await projects.stop(session, match[1]!);
          json(response, 200, { project });
          return;
        }
        throw new ProjectRegistryError(404, "找不到项目接口。");
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/p/") || pathname === "/ws") {
        throw new ProjectRegistryError(404, "请先选择并启动项目。");
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new ProjectRegistryError(405, "仅支持读取网页。");
      const root = options.staticRootDir;
      if (!root) throw new ProjectRegistryError(404, "请先构建 Web 应用。");
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        throw new ProjectRegistryError(400, "地址无效。");
      }
      let file = resolveSafe(root, decoded.replace(/^\//, ""));
      if (!file && request.headers.accept?.includes("text/html"))
        file = resolveSafe(root, "index.html");
      if (!file) throw new ProjectRegistryError(404, "找不到网页资源。");
      const bytes = readFileSync(file);
      response.writeHead(200, {
        "Content-Type": contentTypeFor(extname(file)),
        "Content-Length": bytes.length,
        "Cache-Control": "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    };
    server = createServer((request, response) => {
      void handle(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        json(response, error instanceof ProjectRegistryError ? error.status : 503, {
          error:
            error instanceof ProjectRegistryError
              ? error.message
              : "项目服务暂不可用，请稍后重试。",
        });
      });
    });
    server.requestTimeout = 180000;
    server.headersTimeout = 10000;
    server.on("upgrade", (request, socket, head) => {
      if (shuttingDown) {
        socket.destroy();
        return;
      }
      void transport
        .handleUpgrade(request, socket, head)
        .then((handled) => {
          if (!handled) socket.destroy();
        })
        .catch(() => socket.destroy());
    });
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(options.port, options.host, () => {
        listener.off("error", reject);
        resolve();
      });
    });
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("Missing project listener address");
    const host = ["0.0.0.0", "::"].includes(options.host) ? "127.0.0.1" : options.host;
    listeningOrigin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
    let closing: Promise<void> | undefined;
    return {
      url: listeningOrigin,
      port: address.port,
      bootstrapToken: auth.bootstrapToken,
      generatedPasscode: undefined,
      close(): Promise<void> {
        return (closing ??= (async () => {
          shuttingDown = true;
          const stopped = new Promise<void>((resolve) => listener.close(() => resolve()));
          try {
            // Revoke streams and inner sessions before stopping their servers.
            // If logout is unreachable, confirmed runtime termination is the
            // fallback; a real stop failure must still reject close().
            await transport.close().catch(() => {});
            await projects.close();
          } finally {
            listener.closeAllConnections();
            try {
              await stopped;
            } finally {
              registry.close();
            }
          }
        })());
      },
    };
  } catch (error) {
    shuttingDown = true;
    server?.close();
    server?.closeAllConnections();
    try {
      await proxy?.close().catch(() => {});
      await (manager ? manager.close() : provider?.close())?.catch(() => {});
    } finally {
      registry.close();
    }
    throw error;
  }
}
