import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Transcript } from "../session/transcript.js";
import { canonicalDigest } from "./canonical.js";
import type { ModelRequestSigner, ModelRequestSubject } from "./types.js";

export class ModelRequestBoundaryError extends Error {
  constructor(readonly reason: "projection" | "custody" | "transcript" | "identity") {
    super(`Model request boundary validation failed (${reason})`);
    this.name = "ModelRequestBoundaryError";
  }
}

export interface ModelRequestBinding {
  subject: ModelRequestSubject;
  signer: ModelRequestSigner;
  transcript: Transcript;
  compositionDigest: string;
  configVersion: number;
  provider: string;
  model: string;
}
interface LogicalCall {
  binding: ModelRequestBinding;
  logicalCallId: string;
  step: number;
  assistantMessageId?: string;
  sourceEventRange: { firstEventId?: string; lastEventId?: string; eventCount: number };
  sourceContextPrehash: string;
  controller: AbortController;
  failure?: ModelRequestBoundaryError;
  boundaryEventId?: string;
  keyId?: string;
  attemptNumber: number;
}
interface ProviderProjection {
  call: LogicalCall;
  kind: "openai-chat" | "anthropic-messages";
  expectedDigest: string;
}
const logicalCalls = new AsyncLocalStorage<LogicalCall>();
const projections = new AsyncLocalStorage<ProviderProjection>();

/** One UUID per main-model invocation; transparent SDK retries remain in this call. */
export async function withModelRequestBoundary<T>(
  binding: ModelRequestBinding | undefined,
  options: { step?: number; assistantMessageId?: string; logicalCallId?: string } | undefined,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!binding) return logicalCalls.exit(() => projections.exit(() => operation(signal)));
  const events = binding.transcript.getEvents();
  const call: LogicalCall = {
    binding,
    logicalCallId: options?.logicalCallId ?? randomUUID(),
    step: options?.step ?? binding.transcript.turnNumber,
    assistantMessageId: options?.assistantMessageId,
    sourceEventRange: {
      firstEventId: events[0]?.id,
      lastEventId: events.at(-1)?.id,
      eventCount: events.length,
    },
    sourceContextPrehash: canonicalDigest(binding.transcript.toMessages()),
    controller: new AbortController(),
    attemptNumber: 0,
  };
  const combinedSignal = signal
    ? AbortSignal.any([signal, call.controller.signal])
    : call.controller.signal;
  return logicalCalls.run(call, async () => {
    try {
      const result = await operation(combinedSignal);
      if (call.failure) throw call.failure;
      return result;
    } catch (error) {
      // SDKs wrap fetch errors. Preserve this fatal classification so neither
      // SDK retry nor the turn's non-streaming fallback can issue another send.
      throw call.failure ?? error;
    }
  });
}

/** Called after provider conversion/cache/reasoning transforms, immediately before SDK entry. */
export function withProviderRequestProjection<T>(
  kind: ProviderProjection["kind"],
  body: unknown,
  operation: () => T,
  invocation?: { logicalCallId?: string },
): T {
  if (invocation && !invocation.logicalCallId)
    return logicalCalls.exit(() => projections.exit(operation));
  const call = logicalCalls.getStore();
  if (!call) return projections.exit(operation);
  if (invocation?.logicalCallId && invocation.logicalCallId !== call.logicalCallId) {
    call.failure = new ModelRequestBoundaryError("identity");
    call.controller.abort(call.failure);
    throw call.failure;
  }
  return projections.run({ call, kind, expectedDigest: canonicalDigest(body) }, operation);
}

/** Internal adapter: the usage layer supplies the identity of this configured fetch attempt. */
export function requestBoundaryFetch(
  underlying: typeof globalThis.fetch,
  currentAttempt: () =>
    | {
        requestId: string;
        accountingSessionId: string;
        sessionId: string;
        runtimeId?: string;
        runId?: string;
      }
    | undefined,
): typeof globalThis.fetch {
  return async (input, init) => {
    const projection = projections.getStore();
    if (!projection) {
      const bound = logicalCalls.getStore();
      if (!bound) return underlying(input, init);
      bound.failure = new ModelRequestBoundaryError("projection");
      bound.controller.abort(bound.failure);
      throw bound.failure;
    }
    const call = projection.call;
    const fail = (reason: ModelRequestBoundaryError["reason"]): never => {
      call.failure = new ModelRequestBoundaryError(reason);
      call.controller.abort(call.failure);
      throw call.failure;
    };
    if (call.failure) throw call.failure;
    const attempt = currentAttempt();
    if (
      !attempt ||
      attempt.accountingSessionId !== call.binding.subject.sessionInstanceId ||
      attempt.sessionId !== call.binding.subject.sessionId
    )
      fail("identity");
    let body: Record<string, unknown>;
    let payload: string;
    try {
      const text =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request && init?.body === undefined
            ? await input.clone().text()
            : undefined;
      if (text === undefined) return fail("projection");
      payload = text;
      body = JSON.parse(text) as Record<string, unknown>;
      if (
        !body ||
        Array.isArray(body) ||
        typeof body !== "object" ||
        body.model !== call.binding.model ||
        !Array.isArray(body.messages) ||
        canonicalDigest(body) !== projection.expectedDigest
      )
        return fail("projection");
    } catch {
      return fail("projection");
    }
    const messages = body.messages as Array<Record<string, unknown>>;
    const system =
      projection.kind === "openai-chat"
        ? messages.filter((message) => message.role === "system" || message.role === "developer")
        : (body.system ?? []);
    const conversation =
      projection.kind === "openai-chat"
        ? messages.filter((message) => message.role !== "system" && message.role !== "developer")
        : messages;
    let signatures;
    try {
      signatures = await call.binding.signer.sign({
        subject: call.binding.subject,
        prehashes: {
          system: canonicalDigest(system),
          messages: canonicalDigest(conversation),
          wire: canonicalDigest(body),
          "source-context": call.sourceContextPrehash,
        },
      });
      if (
        !signatures ||
        signatures.version !== 1 ||
        !(
          call.binding.transcript.isPersistent()
            ? ["host-encrypted", "owner-only-plaintext"]
            : ["ephemeral-memory"]
        ).includes(signatures.custodyMode) ||
        !/^[a-f0-9-]{36}$/.test(signatures.keyId) ||
        ["system", "messages", "wire", "source-context"].some(
          (domain) =>
            !/^[a-f0-9]{64}$/.test(
              signatures.digests[domain as keyof typeof signatures.digests] ?? "",
            ),
        )
      )
        return fail("custody");
      if (call.keyId && signatures.keyId !== call.keyId) return fail("custody");
      call.keyId = signatures.keyId;
    } catch {
      return fail("custody");
    }
    // Cancellation while awaiting the Host must never publish a send anchor.
    if (init?.signal?.aborted || (input instanceof Request && input.signal.aborted))
      throw new DOMException("Request cancelled", "AbortError");
    const metadata = {
      version: 1,
      logicalCallId: call.logicalCallId,
      turn: call.binding.transcript.turnNumber,
      step: call.step,
      ...(call.assistantMessageId ? { assistantMessageId: call.assistantMessageId } : {}),
      provider: call.binding.provider,
      model: call.binding.model,
      projection: projection.kind,
      compositionDigest: call.binding.compositionDigest,
      configVersion: call.binding.configVersion,
      sourceEventRange: call.sourceEventRange,
      sourceContextDigest: signatures.digests["source-context"],
      systemPromptDigest: signatures.digests.system,
      messageDigest: signatures.digests.messages,
      wireDigest: signatures.digests.wire,
      toolCatalogDigest: canonicalDigest(body.tools ?? []),
      keyId: signatures.keyId,
      custodyMode: signatures.custodyMode,
      // Transient run context (hooks/image pruning/etc.) is evidenced by the
      // actual projection, not claimed reconstructible from this source range.
      sourceCoverage: "transcript-plus-runtime-projection",
      persistence: call.binding.transcript.isPersistent() ? "durable" : "memory-only",
    };
    if (!call.boundaryEventId) {
      const boundary = call.binding.transcript.appendModelRequestEvent(
        "model_request_boundary",
        metadata,
      );
      if (!boundary) return fail("transcript");
      call.boundaryEventId = boundary.id;
    }
    const anchor = call.binding.transcript.appendModelRequestEvent("model_request_attempt", {
      ...metadata,
      boundaryEventId: call.boundaryEventId,
      physicalAttemptId: attempt!.requestId,
      accountingSessionId: attempt!.accountingSessionId,
      ...(attempt!.runtimeId ? { runtimeId: attempt!.runtimeId } : {}),
      ...(attempt!.runId ? { runId: attempt!.runId } : {}),
      attemptNumber: ++call.attemptNumber,
      // An anchor proves the validated handoff to fetch, not remote receipt/payment.
      phase: "before-fetch",
    });
    if (!anchor) return fail("transcript");
    // Keep exactly the validated bytes across the asynchronous Host-signing
    // roundtrip, even if a caller later mutates its original RequestInit.
    return underlying(input, { ...init, body: payload });
  };
}
