import type { IncomingMessage, ServerResponse } from "node:http";
import type { ModelTraceListQuery } from "@cjhyy/code-shell-core/internal";
import { resolve } from "node:path";
import {
  createModelTraceHistory,
  ModelTraceRequestError,
  type ModelTraceReader,
} from "./model-trace-history.js";

const ROOT = "/api/v1/model-traces";
function json(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
function queryFromUrl(url: URL) {
  const query: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    if (key === "workspace") continue; // Resolved and authorized by the outer Host route.
    const values = url.searchParams.getAll(key);
    if (values.length !== 1)
      throw new ModelTraceRequestError(400, "Duplicate model trace query field");
    const value = values[0]!;
    if (["limit", "since", "until"].includes(key)) {
      if (!value.trim()) throw new ModelTraceRequestError(400, "Invalid numeric model trace query");
      query[key] = Number(value);
    } else query[key] = value;
  }
  return query;
}

/** Authenticated read-only facade over one Host-owned store and one fixed workspace. */
export function createModelTraceHttp(options: {
  storageDir: string;
  workspacePath: string;
  isAuthorized: (request: IncomingMessage) => boolean | Promise<boolean>;
  /** Recomputed for each authenticated request and immediately before responding. */
  resolveWorkspaceScopes?: (
    request: IncomingMessage,
  ) => ModelTraceListQuery["workspaceScopes"] | Promise<ModelTraceListQuery["workspaceScopes"]>;
  store?: ModelTraceReader;
}) {
  const resolveScopes = async (request: IncomingMessage) => {
    const scopes = await options.resolveWorkspaceScopes?.(request);
    return scopes?.map((scope) => ({ ...scope, workspacePath: resolve(scope.workspacePath) }));
  };
  const fingerprint = (scopes: ModelTraceListQuery["workspaceScopes"]) =>
    JSON.stringify(
      scopes?.map((scope) => [scope.workspacePath, scope.sourcePrefix ?? null]).sort(),
    );
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
      try {
        if (!(await options.isAuthorized(request)))
          throw new ModelTraceRequestError(401, "Model history authorization expired");
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          throw new ModelTraceRequestError(405, "Model history is read-only on remote clients");
        }
        const workspaceScopes = await resolveScopes(request);
        const history = createModelTraceHistory({ ...options, workspaceScopes });
        let result: unknown;
        if (url.pathname === ROOT) result = history.list(queryFromUrl(url));
        else if (url.pathname === `${ROOT}/config`) {
          if (Object.keys(queryFromUrl(url)).length)
            throw new ModelTraceRequestError(400, "Configuration queries are not supported");
          result = history.getConfig();
        } else {
          const match = new RegExp(`^${ROOT}/([^/]+)$`).exec(url.pathname);
          if (!match) throw new ModelTraceRequestError(404, "Model record not found");
          if (Object.keys(queryFromUrl(url)).length)
            throw new ModelTraceRequestError(400, "Record queries are not supported");
          let id: string;
          try {
            id = decodeURIComponent(match[1]!);
          } catch {
            throw new ModelTraceRequestError(400, "Invalid model trace id");
          }
          result = history.get(id);
          if (!result) throw new ModelTraceRequestError(404, "Model record not found");
        }
        // Authentication may have been revoked during asynchronous Host validation.
        if (!(await options.isAuthorized(request)))
          throw new ModelTraceRequestError(401, "Model history authorization expired");
        if (fingerprint(await resolveScopes(request)) !== fingerprint(workspaceScopes))
          throw new ModelTraceRequestError(401, "Model history workspace authorization changed");
        if (!(await options.isAuthorized(request)))
          throw new ModelTraceRequestError(401, "Model history authorization expired");
        json(response, 200, result);
      } catch (error) {
        json(response, error instanceof ModelTraceRequestError ? error.status : 500, {
          error:
            error instanceof ModelTraceRequestError
              ? error.message
              : "Model history is unavailable",
        });
      }
      return true;
    },
  };
}
