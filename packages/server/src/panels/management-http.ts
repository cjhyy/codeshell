import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createPanelManagement,
  PanelManagementError,
  publicPanelError,
  type PanelManagementOptions,
} from "./management.js";
import type { PanelOperationContext } from "./types.js";

const ROOT = "/api/v1/panels";
const MAX_BODY = 16 * 1024;

export interface PanelManagementHttpOptions extends PanelManagementOptions {
  ownerId: (request: IncomingMessage) => Promise<string | undefined>;
  isAuthorized: (request: IncomingMessage) => Promise<boolean>;
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage, allowed: string[]): Promise<Record<string, unknown>> {
  if (
    (request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() !==
    "application/json"
  )
    throw new PanelManagementError(400, "invalid_request", "请发送 JSON 请求。");
  const length = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > MAX_BODY) {
    request.resume();
    throw new PanelManagementError(413, "invalid_request", "请求内容过大。");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > MAX_BODY) {
      request.resume();
      throw new PanelManagementError(413, "invalid_request", "请求内容过大。");
    }
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PanelManagementError(400, "invalid_request", "JSON 请求格式无效。");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new PanelManagementError(400, "invalid_request", "请求参数无效。");
  return value as Record<string, unknown>;
}

/** Call only after the host's same-origin authentication boundary. */
export function createPanelManagementHttp(options: PanelManagementHttpOptions) {
  const service = createPanelManagement(options);
  return {
    service,
    close: service.close,
    cancelOwner: service.cancelOwner,
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== ROOT && !url.pathname.startsWith(ROOT + "/")) return false;
      let abandoned = false;
      const onClose = () => {
        if (!response.writableEnded) abandoned = true;
      };
      response.once("close", onClose);
      try {
        const owner = await options.ownerId(request);
        if (!owner) throw new PanelManagementError(401, "login_required", "请先登录。");
        const context: PanelOperationContext = {
          ownerId: owner,
          authorize: async () =>
            !abandoned &&
            !request.aborted &&
            (await options.isAuthorized(request)) &&
            (await options.ownerId(request)) === owner,
        };
        await service.assertAuthorized(context);
        const method = request.method;
        let result: unknown;
        if (url.pathname === ROOT && method === "GET") result = await service.snapshot();
        else if (url.pathname === ROOT + "/github/discover" && method === "POST")
          result = await service.discover(context, await body(request, ["url", "ref", "subdir"]));
        else if (url.pathname === ROOT + "/preview" && method === "POST")
          result = await service.preview(context, (await body(request, ["source"])).source);
        else if (url.pathname === ROOT + "/install" && method === "POST") {
          const input = await body(request, ["reviewToken", "bind"]);
          result = await service.install(
            context,
            input.reviewToken,
            input.bind as boolean | undefined,
          );
        } else {
          const match = /^\/api\/v1\/panels\/([^/]+)(?:\/(binding|update-preview))?$/.exec(
            url.pathname,
          );
          if (!match) throw new PanelManagementError(404, "not_found", "找不到这个面板操作。");
          const id = decodeURIComponent(match[1]!);
          if (match[2] === "binding" && method === "PATCH") {
            const input = await body(request, ["bound", "expectedRevision"]);
            result = await service.binding(context, id, input.bound, input.expectedRevision);
          } else if (match[2] === "update-preview" && method === "POST")
            result = await service.previewUpdate(
              context,
              id,
              (await body(request, ["expectedRevision"])).expectedRevision,
            );
          else if (!match[2] && method === "DELETE")
            result = await service.remove(
              context,
              id,
              (await body(request, ["expectedRevision"])).expectedRevision,
            );
          else throw new PanelManagementError(404, "not_found", "找不到这个面板操作。");
        }
        await service.assertAuthorized(context);
        if (!response.destroyed) json(response, 200, result);
      } catch (error) {
        const failure =
          error instanceof URIError
            ? new PanelManagementError(400, "invalid_request", "面板标识格式无效。")
            : publicPanelError(error);
        if (!response.destroyed)
          json(response, failure.status, { code: failure.code, error: failure.message });
      } finally {
        response.off("close", onClose);
      }
      return true;
    },
  };
}
