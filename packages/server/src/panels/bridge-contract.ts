import { processLimits } from "./process-state.js";

export const panelRuntimeApiVersion = 14;
export const panelProcessMethods = [
  "process.find",
  "process.info",
  "process.resolveEntry",
  "process.spawn",
  "process.get",
  "process.cancel",
  "process.write",
  "process.end",
  "filesystem.getKnownDirectory",
  "filesystem.pickDirectory",
  "filesystem.openDirectory",
];
export const panelResourceMethods = [
  "resources.list",
  "resources.get",
  "resources.read",
  "resources.upload.begin",
  "resources.upload.write",
  "resources.upload.get",
  "resources.upload.finish",
  "resources.upload.cancel",
  "resources.materialize",
  "resources.capture",
];
export const panelToolJobMethods = [
  "tasks.start",
  "tasks.list",
  "tasks.get",
  "tasks.cancel",
  "tasks.retry",
];

export const panelBridgeLimits = Object.freeze({
  maxParamsBytes: 64 * 1024,
  maxResultBytes: 256 * 1024,
  rateWindowMs: 10000,
  maxCallsPerWindow: 30,
  maxTransferCallsPerWindow: 512,
  callTimeoutMs: 15000,
  consentTimeoutMs: 30 * 60 * 1000,
});
export type PanelBridgeErrorCode =
  | "PERMISSION_DENIED"
  | "REVOKED"
  | "NOT_SUPPORTED"
  | "RATE_LIMITED"
  | "PARAMS_TOO_LARGE"
  | "RESULT_TOO_LARGE"
  | "TIMEOUT"
  | "INVALID_ARGUMENT"
  | "OPERATION_FAILED";
export class PanelBridgeError extends Error {
  constructor(
    readonly code: PanelBridgeErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PanelBridgeError";
  }
}
/** IPC otherwise strips custom Error properties. Only the preload unwraps this envelope. */
export function panelBridgeFailure(error: unknown) {
  return {
    __codeshellPanelError: {
      code: error instanceof PanelBridgeError ? error.code : "OPERATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof PanelBridgeError && error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    },
  };
}
export function panelRuntimeCapabilities(input: {
  process: boolean;
  resources?: unknown;
  tasks?: unknown;
  limits?: Partial<Record<keyof typeof panelBridgeLimits, number>>;
}) {
  return {
    bridge: { ...panelBridgeLimits, ...input.limits, structuredErrors: true },
    errors: [
      "PERMISSION_DENIED",
      "REVOKED",
      "NOT_SUPPORTED",
      "RATE_LIMITED",
      "PARAMS_TOO_LARGE",
      "RESULT_TOO_LARGE",
      "TIMEOUT",
      "INVALID_ARGUMENT",
      "OPERATION_FAILED",
    ],
    ...(input.process ? { process: processLimits } : {}),
    ...(input.resources
      ? {
          resources: {
            ...(input.resources as Record<string, unknown>),
            materialize: input.process,
            capture: input.process,
          },
        }
      : {}),
    ...(input.tasks ? { tasks: input.tasks } : {}),
  };
}
