import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LinkAuthorization } from "@cjhyy/code-shell-link";

interface Binding {
  check(): Promise<void>;
  complete(callbackUrl: string): Promise<LinkAuthorization>;
  cancel(): Promise<unknown>;
}
interface Attempt {
  ticket: string;
  state: string;
  authorizationUrl: string;
  callback: URL;
  expiresAt: number;
  launched: boolean;
  completing: boolean;
  binding: Binding;
}

/** An external browser carries only OAuth state. The original Host keeps its owner and PKCE. */
export function createLinkBrowserHandoff(now = Date.now) {
  const tickets = new Map<string, Attempt>();
  const states = new Map<string, Attempt>();
  let closed = false;
  const forget = (attempt: Attempt) => {
    tickets.delete(attempt.ticket);
    states.delete(attempt.state);
  };
  const prune = () => {
    for (const attempt of states.values()) if (attempt.expiresAt <= now()) forget(attempt);
  };
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  const result = (res: ServerResponse) => {
    res.writeHead(303, { ...headers, Location: "/link/authorization-result" });
    res.end();
  };
  return {
    close() {
      closed = true;
      tickets.clear();
      states.clear();
    },
    create(job: LinkAuthorization, binding: Binding, origin: string): { launchUrl: string } {
      prune();
      const redirect = job.step?.kind === "redirect" ? job.step : job.redirect;
      if (closed || job.state !== "pending" || !redirect || states.size >= 128)
        throw new Error("Browser authorization is unavailable");
      const authorization = new URL(redirect.authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
      const state = authorization.searchParams.get("state");
      const expiresAt = Math.min(Date.parse(redirect.expiresAt), now() + 600_000);
      if (
        !state ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(state) ||
        authorization.username ||
        authorization.password ||
        authorization.hash ||
        authorization.pathname !== "/oauth/authorize" ||
        (authorization.protocol !== "https:" &&
          !(
            authorization.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(authorization.hostname)
          )) ||
        authorization.searchParams.getAll("state").length !== 1 ||
        authorization.searchParams.getAll("redirect_uri").length !== 1 ||
        authorization.searchParams.get("redirect_uri") !== callback.href ||
        callback.origin !== origin ||
        callback.pathname !== "/link/callback" ||
        callback.search ||
        callback.hash ||
        callback.username ||
        callback.password ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now() ||
        states.has(state)
      )
        throw new Error("Invalid browser authorization");
      const ticket = randomBytes(32).toString("base64url");
      const attempt: Attempt = {
        ticket,
        state,
        authorizationUrl: authorization.href,
        callback,
        expiresAt,
        launched: false,
        completing: false,
        binding,
      };
      tickets.set(ticket, attempt);
      states.set(state, attempt);
      return { launchUrl: `${callback.origin}/link/authorize?ticket=${ticket}` };
    },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (
        !["/link/authorize", "/link/callback", "/link/authorization-result"].includes(url.pathname)
      )
        return false;
      if (req.method !== "GET") return false;
      prune();
      if (url.pathname === "/link/authorization-result") {
        res.writeHead(200, {
          ...headers,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(
          '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Link 授权</title><main><h1>Link 授权</h1><p>授权已处理。请返回原工作台查看连接结果；可以关闭此页面。</p></main></html>',
        );
        return true;
      }
      if (url.pathname === "/link/authorize") {
        const ticket = url.searchParams.get("ticket");
        const attempt = ticket && tickets.get(ticket);
        if (!attempt || closed || url.searchParams.size !== 1) {
          res.writeHead(410, headers).end("Authorization expired. Return to the workbench.");
          return true;
        }
        tickets.delete(attempt.ticket);
        try {
          await attempt.binding.check();
          if (closed || states.get(attempt.state) !== attempt || attempt.expiresAt <= now())
            throw new Error("Authorization expired");
          attempt.launched = true;
          res.writeHead(303, { ...headers, Location: attempt.authorizationUrl });
          res.end();
        } catch {
          forget(attempt);
          result(res);
        }
        return true;
      }
      const state = url.searchParams.get("state");
      const attempt = state && states.get(state);
      // Unregistered callbacks belong to the existing same-browser flow.
      if (!attempt) return false;
      if (
        closed ||
        !attempt.launched ||
        attempt.completing ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.has("code") === url.searchParams.has("error") ||
        url.searchParams.getAll("code").length > 1 ||
        url.searchParams.getAll("error").length > 1
      ) {
        res.writeHead(400, headers).end("Invalid authorization callback.");
        return true;
      }
      attempt.completing = true;
      try {
        await attempt.binding.check();
        if (closed || states.get(attempt.state) !== attempt || attempt.expiresAt <= now())
          throw new Error("Authorization expired");
        if (url.searchParams.has("error")) await attempt.binding.cancel();
        else {
          const callback = new URL(attempt.callback);
          callback.search = url.search;
          await attempt.binding.complete(callback.href);
        }
      } catch {
        // A token exchange is never replayed. The original owner's polling reconciles the result.
      } finally {
        forget(attempt);
      }
      result(res);
      return true;
    },
  };
}
