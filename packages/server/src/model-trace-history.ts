import {
  ModelTraceStore,
  type ModelTraceConfig,
  type ModelTraceConfigPatch,
  type ModelTraceEvent,
  type ModelTraceListQuery,
  type ModelTracePage,
  type ModelTraceRecord,
} from "@cjhyy/code-shell-core/internal";
import { resolve } from "node:path";

export type ModelTraceDetail = { record: ModelTraceRecord; events: ModelTraceEvent[] };
export type ModelTraceReader = Pick<
  ModelTraceStore,
  "list" | "get" | "events" | "getConfig" | "setConfig"
>;

const QUERY_FIELDS = new Set([
  "limit",
  "cursor",
  "search",
  "traceId",
  "sessionId",
  "model",
  "provider",
  "purpose",
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
    if (key === "limit") {
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
  store?: ModelTraceReader;
}) {
  const store = options.store ?? new ModelTraceStore({ storageDir: options.storageDir });
  const workspacePath =
    options.workspacePath === undefined ? undefined : resolve(options.workspacePath);
  const visible = (entry: { workspacePath?: string }) =>
    workspacePath === undefined ||
    (entry.workspacePath !== undefined && resolve(entry.workspacePath) === workspacePath);
  return {
    list(query?: unknown): ModelTracePage {
      const validated = validateModelTraceQuery(query);
      return store.list({
        ...validated,
        ...(workspacePath === undefined ? {} : { workspacePath }),
      });
    },
    get(id: unknown): ModelTraceDetail | null {
      const entry = store.get(validateModelTraceId(id));
      return entry && visible(entry)
        ? { record: entry, events: store.events(entry.traceId).filter(visible) }
        : null;
    },
    getConfig(): ModelTraceConfig {
      return store.getConfig();
    },
    setConfig(patch: unknown): ModelTraceConfig {
      return store.setConfig(validateModelTraceConfigPatch(patch));
    },
  };
}
