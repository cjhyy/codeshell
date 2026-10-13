import { randomUUID } from "node:crypto";
import type { Transport } from "../protocol/transport.js";

export const DESKTOP_OPERATION_BATCH_METHOD = "desktop/operationBatch";
export const OPERATION_BATCH_AUTHORITY_ID_PREFIX = "operation-batch-authority-";

const MAX_DATA_BYTES = 256 * 1024;
const MAX_DATA_NODES = 10_000;
const MAX_BATCH_ITEMS = 8;

export interface DesktopOperationBatchAuthorityInput {
  sessionId: string;
  runId: string;
  originIntent: string;
  connectionId: string;
  parameters: Record<string, unknown>;
  phase: "resolve" | "check" | "finish" | "cancel";
  token?: string;
  batchId?: string;
  index?: number;
}

export type DesktopOperationBatchAuthorityResult =
  | { kind: "single" }
  | {
      kind: "batch";
      batchId: string;
      index: number;
      count: number;
      allVerified?: boolean;
      previousVerifiedId?: string;
    };

export interface DesktopOperationBatchAuthorityClient {
  request(
    input: DesktopOperationBatchAuthorityInput,
    options?: { signal?: AbortSignal },
  ): Promise<DesktopOperationBatchAuthorityResult>;
  dispose(): void;
}

/** Frontends must reject these frames before forwarding anything to worker stdin. */
export function isOperationBatchAuthorityFrame(line: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return false;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  return (
    record.method === DESKTOP_OPERATION_BATCH_METHOD ||
    (typeof record.id === "string" && record.id.startsWith(OPERATION_BATCH_AUTHORITY_ID_PREFIX))
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Bounded data-only copy. Accessors, sparse arrays and custom serialization are refused. */
function copyData(value: unknown): unknown {
  let bytes = 0;
  let nodes = 0;
  const active = new Set<object>();
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > MAX_DATA_BYTES) throw new Error("Operation batch data exceeds bounds");
  };
  const stringBytes = (input: string) => {
    if (input.length > MAX_DATA_BYTES) throw new Error("Operation batch data exceeds bounds");
    return Buffer.byteLength(JSON.stringify(input));
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > MAX_DATA_NODES || depth > 20)
      throw new Error("Operation batch data exceeds bounds");
    if (input === null || typeof input === "boolean") {
      charge(input === null ? 4 : input ? 4 : 5);
      return input;
    }
    if (typeof input === "string") {
      charge(stringBytes(input));
      return input;
    }
    if (typeof input === "number" && Number.isFinite(input)) {
      charge(JSON.stringify(input).length);
      return input;
    }
    if (!input || typeof input !== "object" || active.has(input))
      throw new Error("Operation batch requires plain JSON data");
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (
          Object.getPrototypeOf(input) !== Array.prototype ||
          input.length > MAX_DATA_NODES ||
          Reflect.ownKeys(input).length !== input.length + 1
        )
          throw new Error("Operation batch requires plain JSON arrays");
        charge(2 + Math.max(0, input.length - 1));
        const result: unknown[] = [];
        for (let index = 0; index < input.length; index++) {
          const property = Object.getOwnPropertyDescriptor(input, String(index));
          if (!property?.enumerable || !Object.hasOwn(property, "value"))
            throw new Error("Operation batch requires plain JSON arrays");
          result.push(visit(property.value, depth + 1));
        }
        return result;
      }
      if (!plainRecord(input)) throw new Error("Operation batch requires plain JSON objects");
      const keys = Reflect.ownKeys(input);
      if (keys.length > MAX_DATA_NODES || keys.some((key) => typeof key !== "string"))
        throw new Error("Operation batch requires plain JSON objects");
      charge(2 + Math.max(0, keys.length - 1));
      const result: Record<string, unknown> = Object.create(null);
      for (const key of (keys as string[]).sort()) {
        const property = Object.getOwnPropertyDescriptor(input, key)!;
        if (!property.enumerable || !Object.hasOwn(property, "value"))
          throw new Error("Operation batch requires plain JSON objects");
        charge(stringBytes(key) + 1);
        result[key] = visit(property.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(input);
    }
  };
  return visit(value, 0);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}

function itemIndex(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < MAX_BATCH_ITEMS
  );
}

function requestData(
  input: DesktopOperationBatchAuthorityInput,
): DesktopOperationBatchAuthorityInput {
  const data = copyData(input);
  if (
    !plainRecord(data) ||
    !hasOnlyKeys(data, [
      "sessionId",
      "runId",
      "originIntent",
      "connectionId",
      "parameters",
      "phase",
      "token",
      "batchId",
      "index",
    ]) ||
    ![data.sessionId, data.runId, data.originIntent, data.connectionId].every(identity) ||
    !plainRecord(data.parameters) ||
    !["resolve", "check", "finish", "cancel"].includes(data.phase as string) ||
    (Object.hasOwn(data, "token") &&
      (typeof data.token !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          data.token,
        ))) ||
    (Object.hasOwn(data, "batchId") && !identity(data.batchId)) ||
    (Object.hasOwn(data, "index") && (!itemIndex(data.index) || !identity(data.batchId)))
  )
    throw new Error("Invalid operation batch authority request");
  return data as unknown as DesktopOperationBatchAuthorityInput;
}

function responseData(value: unknown): DesktopOperationBatchAuthorityResult {
  if (!plainRecord(value)) throw new Error("Invalid operation batch authority response");
  if (value.kind === "single" && Object.keys(value).length === 1) return { kind: "single" };
  if (
    value.kind !== "batch" ||
    !hasOnlyKeys(value, [
      "kind",
      "batchId",
      "index",
      "count",
      "allVerified",
      "previousVerifiedId",
    ]) ||
    !identity(value.batchId) ||
    !itemIndex(value.index) ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 1 ||
    (value.count as number) > MAX_BATCH_ITEMS ||
    value.index >= (value.count as number) ||
    (Object.hasOwn(value, "allVerified") && typeof value.allVerified !== "boolean") ||
    (Object.hasOwn(value, "previousVerifiedId") &&
      (typeof value.previousVerifiedId !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.previousVerifiedId)))
  )
    throw new Error("Invalid operation batch authority response");
  return {
    kind: "batch",
    batchId: value.batchId,
    index: value.index,
    count: value.count as number,
    ...(Object.hasOwn(value, "allVerified") ? { allVerified: value.allVerified as boolean } : {}),
    ...(Object.hasOwn(value, "previousVerifiedId")
      ? { previousVerifiedId: value.previousVerifiedId as string }
      : {}),
  };
}

/**
 * Main-only reverse RPC. The Host must fence its namespace at every frontend
 * ingress; a correlation id is not authorization. This client owns its pending
 * calls, while the shared transport owns the registered listener and connection.
 */
export function createDesktopOperationBatchAuthorityClient(
  transport: Pick<Transport, "send" | "onMessage">,
  options: { timeoutMs?: number; maxPending?: number } = {},
): DesktopOperationBatchAuthorityClient {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxPending = options.maxPending ?? 32;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 64
  )
    throw new Error("Invalid operation batch authority client bounds");
  let disposed = false;
  type Pending = {
    resolve(value: DesktopOperationBatchAuthorityResult): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    removeAbort?(): void;
  };
  const pending = new Map<string, Pending>();
  const take = (id: string): Pending | undefined => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.removeAbort?.();
    return entry;
  };
  transport.onMessage((message) => {
    if (disposed || !plainRecord(message)) return;
    const property = Object.getOwnPropertyDescriptor(message, "id");
    if (!property || !Object.hasOwn(property, "value") || typeof property.value !== "string")
      return;
    const id = property.value;
    if (!pending.has(id)) return;
    const entry = take(id)!;
    try {
      const data = copyData(message) as Record<string, unknown>;
      if (
        data.jsonrpc !== "2.0" ||
        data.id !== id ||
        !hasOnlyKeys(data, ["jsonrpc", "id", "result"]) ||
        !Object.hasOwn(data, "result")
      )
        throw new Error("Operation batch authority denied or returned an invalid response");
      entry.resolve(responseData(data.result));
    } catch {
      entry.reject(new Error("Operation batch authority denied or returned an invalid response"));
    }
  });

  return {
    async request(input, callOptions) {
      if (disposed) throw new Error("Operation batch authority client is closed");
      const data = requestData(input);
      if (pending.size >= maxPending)
        throw new Error("Operation batch authority pending limit reached");
      const signal = callOptions?.signal;
      if (signal?.aborted)
        throw new DOMException("Operation batch authority cancelled", "AbortError");
      const id = `${OPERATION_BATCH_AUTHORITY_ID_PREFIX}${randomUUID()}`;
      return new Promise<DesktopOperationBatchAuthorityResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          take(id)?.reject(new Error("Operation batch authority timed out"));
        }, timeoutMs);
        const entry: Pending = { resolve, reject, timer };
        pending.set(id, entry);
        try {
          if (signal) {
            const abort = () => {
              take(id)?.reject(
                new DOMException("Operation batch authority cancelled", "AbortError"),
              );
            };
            entry.removeAbort = () => signal.removeEventListener("abort", abort);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }
          if (!pending.has(id)) return;
          transport.send({
            jsonrpc: "2.0",
            id,
            method: DESKTOP_OPERATION_BATCH_METHOD,
            params: data as unknown as Record<string, unknown>,
          });
        } catch {
          take(id)?.reject(new Error("Operation batch authority unavailable"));
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of pending.keys())
        take(id)?.reject(new Error("Operation batch authority client is closed"));
    },
  };
}
