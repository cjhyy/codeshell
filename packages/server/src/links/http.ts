import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createLinkService,
  LinkServiceError,
  publicLinkError,
  type LinkServiceOptions,
} from "./service.js";
import type { LinkConnectionInput, LinkOperationContext, TokenConnectionInput } from "./types.js";

const ROOT = "/api/v1/links";
const MAX_BODY_BYTES = 32 * 1024;

export interface LinkHttpOptions extends LinkServiceOptions {
  ownerId: (request: IncomingMessage) => Promise<string | undefined>;
  isAuthorized: (request: IncomingMessage) => Promise<boolean>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    (request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() !==
    "application/json"
  )
    throw new LinkServiceError(400, "invalid_request");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    request.resume();
    throw new LinkServiceError(413, "invalid_request");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.from(part);
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      request.resume();
      throw new LinkServiceError(413, "invalid_request");
    }
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LinkServiceError(400, "invalid_request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LinkServiceError(400, "invalid_request");
  return value as Record<string, unknown>;
}

function fields(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new LinkServiceError(400, "invalid_request");
}

/** Host authenticates and validates Origin first; writes independently recheck the same owner. */
export function createLinkHttp(options: LinkHttpOptions) {
  const service = createLinkService(options);
  async function context(
    request: IncomingMessage,
    abandoned: () => boolean,
  ): Promise<LinkOperationContext> {
    const ownerId = await options.ownerId(request);
    if (!ownerId || !(await options.isAuthorized(request)))
      throw new LinkServiceError(401, "login_required");
    return {
      ownerId,
      authorize: async () =>
        (await options.isAuthorized(request)) &&
        (await options.ownerId(request)) === ownerId &&
        !abandoned(),
    };
  }
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
        const owner = await context(request, () => abandoned || request.aborted);
        const method = request.method;
        let result: unknown;
        if (url.pathname === ROOT && method === "GET") result = service.snapshot();
        else {
          const cli = /^\/api\/v1\/links\/providers\/([^/]+)\/cli$/.exec(url.pathname);
          const connection = /^\/api\/v1\/links\/connections\/([^/]+)$/.exec(url.pathname);
          const authorization = /^\/api\/v1\/links\/authorizations\/([^/]+)$/.exec(url.pathname);
          if (cli && method === "GET")
            result = await service.cliStatus(owner, decodeURIComponent(cli[1]!));
          else if (authorization && method === "GET")
            result = await service.authorization(owner, decodeURIComponent(authorization[1]!));
          else if (authorization && method === "DELETE") {
            await service.cancelAuthorization(owner, decodeURIComponent(authorization[1]!));
            result = { cancelled: true };
          } else if (
            method === "POST" &&
            [
              ROOT + "/connections/token",
              ROOT + "/connections/cli",
              ROOT + "/authorizations/device",
            ].includes(url.pathname)
          ) {
            const input = await body(request);
            const token = url.pathname.endsWith("/token");
            fields(input, [
              "providerId",
              "methodId",
              "label",
              "connectionId",
              "expectedRevision",
              ...(token ? ["token"] : []),
            ]);
            result = token
              ? await service.connectToken(owner, input as unknown as TokenConnectionInput)
              : url.pathname.endsWith("/cli")
                ? await service.connectCli(owner, input as unknown as LinkConnectionInput)
                : await service.startDeviceAuth(owner, input as unknown as LinkConnectionInput);
          } else if (connection && (method === "PATCH" || method === "DELETE")) {
            const input = await body(request);
            fields(
              input,
              method === "PATCH" ? ["label", "expectedRevision"] : ["expectedRevision"],
            );
            const id = decodeURIComponent(connection[1]!);
            if (method === "PATCH")
              result = await service.rename(
                owner,
                id,
                input.label as string,
                input.expectedRevision as string,
              );
            else {
              await service.disconnect(owner, id, input.expectedRevision as string);
              result = { removed: true };
            }
          } else throw new LinkServiceError(404, "not_found");
        }
        await service.assertAuthorized(owner);
        json(response, 200, result);
      } catch (error) {
        const failure =
          error instanceof URIError
            ? new LinkServiceError(400, "invalid_request")
            : publicLinkError(error);
        if (!response.destroyed)
          json(response, failure.status, { error: failure.message, code: failure.code });
      } finally {
        response.off("close", onClose);
      }
      return true;
    },
  };
}
