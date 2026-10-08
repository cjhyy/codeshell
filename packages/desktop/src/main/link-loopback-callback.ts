import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface LinkLoopbackRegistration {
  redirectUri: string;
  state: string;
  expiresAt: number;
  signal?: AbortSignal;
  onCallback(url: string): boolean | void | Promise<boolean | void>;
  onCancel(): void;
}
interface PendingCallback extends LinkLoopbackRegistration {
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
}

/** Receives authorization responses. Only the owning Host validates and saves the connection. */
export function createLinkLoopbackCallbackBroker(
  options: { port?: number; now?: () => number } = {},
) {
  const port = options.port ?? 43827;
  const redirectUri = `http://127.0.0.1:${port}/link/callback`;
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingCallback>();
  let server: Server | undefined;
  let opening: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let processing = 0;
  const processingEntries = new Set<PendingCallback>();
  const connections = new Set<Socket>();
  let closed = false;
  function stopIfUnused(force = false) {
    if (force) for (const connection of connections) connection.destroy();
    if ((!force && (pending.size || processing)) || !server) return;
    if (opening) {
      void opening.then(
        () => stopIfUnused(force),
        () => {},
      );
      return;
    }
    const current = server;
    server = undefined;
    closing = new Promise<void>((resolve) => current.close(() => resolve())).finally(() => {
      closing = undefined;
    });
    current.closeIdleConnections();
    if (force) current.closeAllConnections();
  }
  function remove(state: string, entry: PendingCallback) {
    if (pending.get(state) !== entry) return;
    pending.delete(state);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    stopIfUnused();
  }
  function reply(response: ServerResponse, status: number, message: string) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CodeShell</title><style>body{font:16px system-ui;margin:15vh auto;padding:24px;max-width:480px;line-height:1.7;color:#18181b}h1{font-size:24px}p{color:#52525b}</style><h1>${message}</h1><p>请返回 CodeShell 查看连接状态。可以关闭此页面。</p></html>`,
    );
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "GET") return reply(response, 405, "不支持此请求");
    if (request.headers.host !== `127.0.0.1:${port}`)
      return reply(response, 400, "授权回调地址无效");
    const target = request.url ?? "";
    if (target.length > 16_384 || !target.startsWith("/") || target.startsWith("//"))
      return reply(response, 400, "授权回调地址无效");
    let url: URL;
    try {
      url = new URL(target, redirectUri);
    } catch {
      return reply(response, 400, "授权回调地址无效");
    }
    if (url.origin !== new URL(redirectUri).origin || url.pathname !== "/link/callback")
      return reply(response, 404, "找不到此页面");
    const state = url.searchParams.get("state");
    const code = url.searchParams.getAll("code");
    const error = url.searchParams.getAll("error");
    if (
      url.hash ||
      url.username ||
      url.password ||
      url.searchParams.getAll("state").length !== 1 ||
      !state ||
      !(
        (code.length === 1 && !!code[0].trim() && error.length === 0) ||
        (error.length === 1 && !!error[0].trim() && code.length === 0)
      )
    )
      return reply(response, 400, "授权回调无效");
    const entry = pending.get(state);
    if (!entry) return reply(response, 400, "此授权已结束或无效");
    if (entry.signal?.aborted || entry.expiresAt <= now()) {
      remove(state, entry);
      return reply(response, 410, "此授权已过期");
    }
    // Consume before calling the Host, including while its token exchange is still pending.
    processing++;
    processingEntries.add(entry);
    remove(state, entry);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const connected = await Promise.race([
        entry.onCallback(url.href),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("expired")),
            Math.max(1, entry.expiresAt - now()),
          );
          timeout.unref?.();
        }),
      ]);
      reply(response, 200, connected === true ? "连接已完成" : "授权响应已处理");
    } catch {
      reply(response, 500, "连接未完成");
    } finally {
      clearTimeout(timeout);
      processingEntries.delete(entry);
      processing--;
      stopIfUnused();
    }
  }
  async function listen() {
    if (closing) await closing;
    if (closed || !pending.size) throw new Error("Link 授权已取消或过期。");
    if (server?.listening) return;
    if (opening) return opening;
    const current = createServer({ maxHeaderSize: 20_480 }, (request, response) => {
      void handle(request, response).catch(() => reply(response, 500, "连接未完成"));
    });
    current.on("connection", (connection) => {
      connections.add(connection);
      connection.once("close", () => connections.delete(connection));
    });
    current.requestTimeout = 15_000;
    current.headersTimeout = 10_000;
    current.keepAliveTimeout = 1_000;
    server = current;
    opening = new Promise<void>((resolve, reject) => {
      const failed = () => {
        if (server === current) server = undefined;
        reject(
          new Error(
            "无法启动 Link 授权回调：本机端口被占用或不可用，请关闭其他 CodeShell 后重试。",
          ),
        );
      };
      current.once("error", failed);
      current.listen(port, "127.0.0.1", () => {
        current.removeListener("error", failed);
        resolve();
      });
    }).finally(() => {
      opening = undefined;
    });
    return opening;
  }
  return {
    async register(input: LinkLoopbackRegistration) {
      if (closed) throw new Error("Link 授权接收器已关闭。");
      if (input.redirectUri !== redirectUri || !/^[a-zA-Z0-9_-]{32,512}$/.test(input.state))
        throw new Error("Link 授权回调配置无效。");
      if (input.signal?.aborted || !Number.isFinite(input.expiresAt) || input.expiresAt <= now())
        throw new Error("Link 授权已取消或过期。");
      if (pending.has(input.state)) throw new Error("此 Link 授权已在等待回调。");
      const entry: PendingCallback = {
        ...input,
        timer: setTimeout(() => remove(input.state, entry), Math.max(1, input.expiresAt - now())),
        abort: () => remove(input.state, entry),
      };
      entry.timer.unref?.();
      pending.set(input.state, entry);
      input.signal?.addEventListener("abort", entry.abort, { once: true });
      try {
        await listen();
        if (pending.get(input.state) !== entry) throw new Error("Link 授权已取消或过期。");
      } catch (error) {
        remove(input.state, entry);
        stopIfUnused();
        throw error;
      }
      return { close: () => remove(input.state, entry) };
    },
    close() {
      closed = true;
      for (const [state, entry] of [...pending]) {
        remove(state, entry);
        entry.onCancel();
      }
      for (const entry of processingEntries) entry.onCancel();
      stopIfUnused(true);
    },
  };
}
