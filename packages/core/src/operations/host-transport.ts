import type { OperationLedger } from "./ledger.js";

export const operationMethods = [
  "prepare",
  "hasUnverifiedWrites",
  "claim",
  "settle",
  "sealPending",
  "captureRecovery",
  "sealForFinalization",
] as const;
export type OperationMethod = (typeof operationMethods)[number];
export interface OperationLedgerRequest {
  sessionId: string;
  runId: string;
  ephemeral?: true;
  method: OperationMethod;
  args: unknown[];
}
export type OperationLedgerTransport = (request: OperationLedgerRequest) => Promise<unknown>;
export type RunLedger = {
  [K in OperationMethod]: (
    ...args: Parameters<OperationLedger[K]>
  ) => ReturnType<OperationLedger[K]> | Promise<ReturnType<OperationLedger[K]>>;
};

export function remoteRunLedger(
  sessionId: string,
  runId: string,
  transport: OperationLedgerTransport,
  ephemeral = false,
): RunLedger {
  function send<K extends OperationMethod>(method: K, args: Parameters<OperationLedger[K]>) {
    return transport({
      sessionId,
      runId,
      method,
      ...(ephemeral && { ephemeral: true }),
      args: args.map((value) => value ?? null),
    }) as Promise<ReturnType<OperationLedger[K]>>;
  }
  return {
    prepare: (...args) => send("prepare", args),
    hasUnverifiedWrites: (...args) => send("hasUnverifiedWrites", args),
    claim: (...args) => send("claim", args),
    settle: (...args) => send("settle", args),
    sealPending: (...args) => send("sealPending", args),
    captureRecovery: (...args) => send("captureRecovery", args),
    sealForFinalization: (...args) => send("sealForFinalization", args),
  };
}
export function isOperationLedgerRequest(raw: unknown): raw is OperationLedgerRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const v = raw as OperationLedgerRequest;
  return (
    Object.keys(v).every((key) =>
      ["sessionId", "runId", "method", "args", "ephemeral"].includes(key),
    ) &&
    typeof v.sessionId === "string" &&
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(v.sessionId) &&
    !v.sessionId.includes("..") &&
    typeof v.runId === "string" &&
    v.runId.length > 0 &&
    v.runId.length <= 256 &&
    (v.ephemeral === undefined || v.ephemeral === true) &&
    operationMethods.includes(v.method) &&
    Array.isArray(v.args) &&
    v.args.length <= 4
  );
}
