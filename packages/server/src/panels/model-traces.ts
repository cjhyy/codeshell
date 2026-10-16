import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  recordExternalModelTrace,
  type ExternalModelTraceInput,
} from "@cjhyy/code-shell-core/internal";
import type { TokenUsage } from "@cjhyy/code-shell-core";
import { PanelBridgeError } from "./bridge-contract.js";

export const panelModelTraceMethods = ["modelTraces.start", "modelTraces.finish"];
export const panelModelTraceLimits = Object.freeze({
  maxParamsBytes: 256 * 1024,
  maxActivePerOwner: 64,
  maxActive: 2048,
  maxCallsPerMinute: 240,
  maxLifetimeMs: 24 * 60 * 60 * 1000,
});
/** Supplied by a verified Host binding; no field is taken from an observation. */
export interface PanelModelTraceOwner {
  ownerKey: string;
  appId: string;
  revision: string;
  workspacePath: string;
  sessionId?: string;
  traceId?: string;
  taskId?: string;
}
interface Observation {
  ownerKey: string;
  ownerIdentity: string;
  input: ExternalModelTraceInput;
  recordId?: string;
  startedAt: number;
}
function invalid(message = "Invalid Panel model observation"): never {
  throw new PanelBridgeError("INVALID_ARGUMENT", message);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function label(value: unknown, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value))
    invalid();
  return value;
}
function usage(value: unknown): TokenUsage | undefined {
  if (value === undefined) return undefined;
  const input = object(value, [
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
  ]);
  for (const key of ["promptTokens", "completionTokens", "totalTokens"])
    if (input[key] === undefined) invalid("Model usage requires token counts");
  for (const number of Object.values(input))
    if (!Number.isSafeInteger(number) || Number(number) < 0) invalid("Invalid model usage");
  return input as unknown as TokenUsage;
}
/** Write-only Panel observations share the Host's policy, sanitization and history store. */
export class PanelModelTraceService {
  private readonly active = new Map<string, Observation>();
  private readonly calls = new Map<string, number[]>();
  constructor(private readonly options: { storageDir?: string; now?: () => number } = {}) {}

  call(
    owner: PanelModelTraceOwner,
    method: string,
    params: unknown,
  ): { id: string; recorded: boolean } | { recorded: boolean } {
    if (
      !owner.ownerKey ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(owner.appId) ||
      !owner.revision ||
      !isAbsolute(owner.workspacePath)
    )
      invalid("Invalid Host model observation owner");
    if (!panelModelTraceMethods.includes(method)) invalid("Unsupported model observation method");
    const encoded = JSON.stringify(params);
    if (!encoded || Buffer.byteLength(encoded) > panelModelTraceLimits.maxParamsBytes)
      throw new PanelBridgeError("PARAMS_TOO_LARGE", "Panel model observation exceeds the limit");
    const now = this.now();
    this.prune(now);
    const calls = (this.calls.get(owner.ownerKey) ?? []).filter((time) => now - time < 60_000);
    if (calls.length >= panelModelTraceLimits.maxCallsPerMinute)
      throw new PanelBridgeError("RATE_LIMITED", "Panel model observation rate limit exceeded");
    calls.push(now);
    this.calls.set(owner.ownerKey, calls);
    if (method === "modelTraces.start") {
      const value = object(params, [
        "provider",
        "model",
        "purpose",
        "input",
        "inputState",
        "stream",
      ]);
      const provider = label(value.provider)!;
      const model = label(value.model)!;
      const purpose = label(value.purpose, true) ?? "model";
      if (value.stream !== undefined && typeof value.stream !== "boolean") invalid();
      if (value.inputState !== undefined && value.inputState !== "truncated") invalid();
      const body = object(value.input, ["systemPrompt", "messages", "tools", "parameters"]);
      if (body.systemPrompt !== undefined && typeof body.systemPrompt !== "string") invalid();
      for (const key of ["messages", "tools"])
        if (body[key] !== undefined && !Array.isArray(body[key])) invalid();
      if (
        body.parameters !== undefined &&
        (!body.parameters || typeof body.parameters !== "object" || Array.isArray(body.parameters))
      )
        invalid();
      if (
        this.active.size >= panelModelTraceLimits.maxActive ||
        [...this.active.values()].filter((item) => item.ownerKey === owner.ownerKey).length >=
          panelModelTraceLimits.maxActivePerOwner
      )
        throw new PanelBridgeError("RATE_LIMITED", "Too many active Panel model observations");
      const input: ExternalModelTraceInput = {
        storageDir: this.options.storageDir,
        workspacePath: owner.workspacePath,
        ephemeral: false,
        sessionId: owner.sessionId,
        parentSessionId: undefined,
        runId: owner.traceId,
        source: `panel:${owner.appId}`,
        purpose: `panel/${purpose}`,
        provider,
        model,
        startedAt: now,
        status: "running",
        stream: value.stream as boolean | undefined,
        coverage: "logical-input",
        inputState: value.inputState as "truncated" | undefined,
        input: {
          systemPrompt: (body.systemPrompt as string | undefined) ?? "",
          messages: (body.messages as unknown[] | undefined) ?? [],
          tools: (body.tools as unknown[] | undefined) ?? [],
          parameters: {
            ...(body.parameters as Record<string, unknown> | undefined),
            codeshellPanel: {
              appId: owner.appId,
              revision: owner.revision,
              ...(owner.taskId ? { taskId: owner.taskId } : {}),
            },
          },
        },
      };
      const record = recordExternalModelTrace(input);
      const id = record?.id ?? randomUUID();
      // Retain only already-sanitized content. Disabled recording never resumes mid-call.
      this.active.set(id, {
        ownerKey: owner.ownerKey,
        ownerIdentity: JSON.stringify([
          owner.appId,
          owner.revision,
          owner.workspacePath,
          owner.sessionId,
        ]),
        recordId: record?.id,
        startedAt: now,
        input: { ...input, input: undefined },
      });
      return { id, recorded: !!record };
    }
    const value = object(params, ["id", "status", "output", "outputState", "error", "usage"]);
    if (typeof value.id !== "string" || !/^[a-f0-9-]{36}$/i.test(value.id)) invalid();
    const observation = this.active.get(value.id);
    if (
      !observation ||
      observation.ownerKey !== owner.ownerKey ||
      observation.ownerIdentity !==
        JSON.stringify([owner.appId, owner.revision, owner.workspacePath, owner.sessionId])
    )
      throw new PanelBridgeError(
        "REVOKED",
        "Model observation is unavailable for this Panel owner",
      );
    if (!["completed", "failed", "cancelled"].includes(String(value.status))) invalid();
    if (value.outputState !== undefined && value.outputState !== "truncated") invalid();
    const output =
      value.output === undefined
        ? undefined
        : object(value.output, ["text", "thinking", "toolCalls", "stopReason", "data"]);
    for (const key of ["text", "thinking", "stopReason"])
      if (output?.[key] !== undefined && typeof output[key] !== "string") invalid();
    if (output?.toolCalls !== undefined && !Array.isArray(output.toolCalls)) invalid();
    if (value.error !== undefined && typeof value.error !== "string") invalid();
    const tokens = usage(value.usage);
    this.active.delete(value.id);
    const record = observation.recordId
      ? recordExternalModelTrace({
          ...observation.input,
          id: observation.recordId,
          endedAt: now,
          status: value.status as "completed" | "failed" | "cancelled",
          output,
          outputState: value.outputState as "truncated" | undefined,
          error: value.error as string | undefined,
          usage: tokens,
        })
      : null;
    return { recorded: !!record };
  }
  cancelOwner(ownerKey: string, status: "cancelled" | "failed" = "cancelled"): void {
    for (const [id, observation] of this.active)
      if (observation.ownerKey === ownerKey) this.close(id, observation, status);
    this.calls.delete(ownerKey);
  }
  closeAll(): void {
    for (const [id, observation] of this.active) this.close(id, observation, "cancelled");
    this.calls.clear();
  }
  private close(id: string, observation: Observation, status: "cancelled" | "failed") {
    this.active.delete(id);
    if (observation.recordId)
      recordExternalModelTrace({
        ...observation.input,
        id: observation.recordId,
        endedAt: this.now(),
        status,
        error:
          status === "failed" ? "Panel process exited before the model call finished" : undefined,
      });
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private prune(now: number) {
    for (const [id, observation] of this.active)
      if (now - observation.startedAt > panelModelTraceLimits.maxLifetimeMs)
        this.close(id, observation, "cancelled");
    for (const [owner, calls] of this.calls)
      if (calls.every((time) => now - time >= 60_000)) this.calls.delete(owner);
  }
}
