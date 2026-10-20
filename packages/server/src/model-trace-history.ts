import {
  ModelTraceStore,
  isModelTraceCallType,
  type ModelTraceConfig,
  type ModelTraceConfigPatch,
  type ModelTraceEvent,
  type ModelTraceListQuery,
  type ModelTracePage,
  type ModelTraceSessionPage,
  type ModelTraceRecord,
} from "@cjhyy/code-shell-core/internal";
import { resolve } from "node:path";

export type ModelTraceDetail = { record: ModelTraceRecord; events: ModelTraceEvent[] };
export type ModelTraceReader = Pick<
  ModelTraceStore,
  "list" | "sessions" | "get" | "events" | "getConfig" | "setConfig"
>;

const QUERY_FIELDS = new Set([
  "limit",
  "cursor",
  "search",
  "traceId",
  "sessionId",
  "withoutSession",
  "model",
  "provider",
  "purpose",
  "callType",
  "source",
  "status",
  "since",
  "until",
]);
const CONFIG_FIELDS = new Set(["enabled", "captureContent", "includeEphemeral", "retentionDays"]);

export class ModelTraceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModelTraceRequestError(400, `Invalid model trace ${label}`);
  return value as Record<string, unknown>;
}

/** Never forward renderer/browser-owned filesystem paths or unknown scan options. */
export function validateModelTraceQuery(input?: unknown): ModelTraceListQuery {
  if (input === undefined) return {};
  const query = record(input, "query");
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!QUERY_FIELDS.has(key))
      throw new ModelTraceRequestError(400, `Unknown model trace query field: ${key}`);
    if (value === undefined) continue;
    if (key === "callType") {
      if (!isModelTraceCallType(value))
        throw new ModelTraceRequestError(400, "Invalid model trace callType");
    } else if (key === "withoutSession") {
      if (typeof value !== "boolean")
        throw new ModelTraceRequestError(400, "Invalid model trace withoutSession");
    } else if (key === "limit") {
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 200)
        throw new ModelTraceRequestError(400, "Model trace limit must be between 1 and 200");
    } else if (key === "since" || key === "until") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        throw new ModelTraceRequestError(400, `Invalid model trace ${key}`);
    } else {
      const max = key === "search" || key === "cursor" ? 2048 : 512;
      if (typeof value !== "string" || value.length > max || value.includes("\0"))
        throw new ModelTraceRequestError(400, `Invalid model trace ${key}`);
      if (key === "status" && !["running", "completed", "failed", "cancelled"].includes(value))
        throw new ModelTraceRequestError(400, "Invalid model trace status");
    }
    result[key] = value;
  }
  if (
    typeof result.since === "number" &&
    typeof result.until === "number" &&
    result.since > result.until
  )
    throw new ModelTraceRequestError(400, "Model trace time range is reversed");
  return result as ModelTraceListQuery;
}

export function validateModelTraceId(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input))
    throw new ModelTraceRequestError(400, "Invalid model trace id");
  return input;
}

export function validateModelTraceConfigPatch(input: unknown): ModelTraceConfigPatch {
  const patch = record(input, "configuration");
  for (const [key, value] of Object.entries(patch)) {
    if (!CONFIG_FIELDS.has(key))
      throw new ModelTraceRequestError(400, `Unknown model trace configuration field: ${key}`);
    if (
      (key === "enabled" || key === "captureContent" || key === "includeEphemeral") &&
      typeof value !== "boolean"
    )
      throw new ModelTraceRequestError(400, `Invalid model trace ${key}`);
    if (
      key === "retentionDays" &&
      (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 365)
    )
      throw new ModelTraceRequestError(400, "Model trace retention must be between 1 and 365 days");
  }
  return { ...patch } as ModelTraceConfigPatch;
}

/** Host fixes storageDir once; no query or request can select a different store. */
export function createModelTraceHistory(options: {
  storageDir: string;
  /** Set only by the authenticated Host, never by list/get arguments. */
  workspacePath?: string;
  /** Additional scopes fixed and authorized by the Host, never by list/get input. */
  workspaceScopes?: ModelTraceListQuery["workspaceScopes"];
  store?: ModelTraceReader;
}) {
  const store = options.store ?? new ModelTraceStore({ storageDir: options.storageDir });
  const workspacePath =
    options.workspacePath === undefined ? undefined : resolve(options.workspacePath);
  if (
    options.workspaceScopes !== undefined &&
    (!Array.isArray(options.workspaceScopes) ||
      options.workspaceScopes.length + (workspacePath === undefined ? 0 : 1) > 8 ||
      options.workspaceScopes.some(
        (scope) =>
          !scope ||
          typeof scope !== "object" ||
          Array.isArray(scope) ||
          Object.keys(scope).some((field) => !["workspacePath", "sourcePrefix"].includes(field)) ||
          typeof scope.workspacePath !== "string" ||
          !scope.workspacePath ||
          scope.workspacePath.length > 4096 ||
          scope.workspacePath.includes("\0") ||
          (scope.sourcePrefix !== undefined &&
            (typeof scope.sourcePrefix !== "string" ||
              !scope.sourcePrefix ||
              scope.sourcePrefix.length > 256 ||
              scope.sourcePrefix.includes("\0"))),
      ))
  )
    throw new ModelTraceRequestError(500, "Invalid Host model trace scopes");
  const scopes: ModelTraceListQuery["workspaceScopes"] = options.workspaceScopes
    ? [
        ...(workspacePath === undefined ? [] : [{ workspacePath }]),
        ...options.workspaceScopes.map((scope) => ({
          ...scope,
          workspacePath: resolve(scope.workspacePath),
        })),
      ]
    : undefined;
  const matchesPath = (entry: { workspacePath?: string }, path: string) =>
    entry.workspacePath !== undefined && resolve(entry.workspacePath) === path;
  const unrestricted = (entry: { workspacePath?: string }) =>
    scopes
      ? scopes.some(
          (scope) => scope.sourcePrefix === undefined && matchesPath(entry, scope.workspacePath),
        )
      : workspacePath === undefined || matchesPath(entry, workspacePath);
  const visible = (entry: { workspacePath?: string; source?: string }) =>
    unrestricted(entry) ||
    !!scopes?.some(
      (scope) =>
        matchesPath(entry, scope.workspacePath) &&
        typeof entry.source === "string" &&
        scope.sourcePrefix !== undefined &&
        entry.source.startsWith(scope.sourcePrefix),
    );
  const visibleEvents = (entry: ModelTraceRecord) => {
    const events = store.events(entry.traceId);
    const accepted = new Set(events.filter(unrestricted).map((event) => event.id));
    // Events do not carry a source. A prefix-limited related scope may only
    // expose the exact selected call's descendants, never another root chat's
    // events merely because they share a trace identifier.
    const children = new Map<string, ModelTraceEvent[]>();
    if (entry.workspacePath !== undefined)
      for (const event of events)
        if (event.parentId && matchesPath(event, resolve(entry.workspacePath))) {
          const siblings = children.get(event.parentId) ?? [];
          siblings.push(event);
          children.set(event.parentId, siblings);
        }
    const queue = [entry.id];
    const visited = new Set(queue);
    for (let index = 0; index < queue.length; index++)
      for (const event of children.get(queue[index]) ?? [])
        if (!visited.has(event.id)) {
          visited.add(event.id);
          accepted.add(event.id);
          queue.push(event.id);
        }
    return events.filter((event) => accepted.has(event.id));
  };
  return {
    list(query?: unknown): ModelTracePage {
      const validated = validateModelTraceQuery(query);
      return store.list({
        ...validated,
        ...(scopes
          ? { workspaceScopes: scopes }
          : workspacePath === undefined
            ? {}
            : { workspacePath }),
      });
    },
    sessions(query?: unknown): ModelTraceSessionPage {
      const validated = validateModelTraceQuery(query);
      try {
        return store.sessions({
          ...validated,
          ...(scopes
            ? { workspaceScopes: scopes }
            : workspacePath === undefined
              ? {}
              : { workspacePath }),
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid model trace session cursor")
          throw new ModelTraceRequestError(400, error.message);
        throw error;
      }
    },
    get(id: unknown): ModelTraceDetail | null {
      const entry = store.get(validateModelTraceId(id));
      return entry && visible(entry) ? { record: entry, events: visibleEvents(entry) } : null;
    },
    getConfig(): ModelTraceConfig {
      return store.getConfig();
    },
    setConfig(patch: unknown): ModelTraceConfig {
      return store.setConfig(validateModelTraceConfigPatch(patch));
    },
  };
}
