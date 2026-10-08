import { randomUUID } from "node:crypto";
import { canonicalJson } from "../contracts/canonical-json.js";
import type { OperationLimits } from "../contracts/experiment.js";
import type { ResolvedConnection } from "./connection.js";

export interface ObservedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  reasoningTokens: number | null;
  reportedCostUsd: number | null;
}
export interface HttpObservation {
  attemptId: string;
  responseModel: string | null;
  usage: ObservedUsage | null;
  status: number | null;
  elapsedMs: number;
  outcome: "settled" | "unknown";
}
export interface MeterAccounting {
  admit(attemptId: string): { deadlineAt: number };
  dispatch(attemptId: string): void;
  finish(observation: HttpObservation): void;
  check(): void;
}
export interface MeteredTransport {
  fetch: typeof globalThis.fetch;
  observations: HttpObservation[];
  admissionError: Error | null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function extractUsage(body: any, provider: string): ObservedUsage | null {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = count(provider === "anthropic" ? usage.input_tokens : usage.prompt_tokens);
  const output = count(provider === "anthropic" ? usage.output_tokens : usage.completion_tokens);
  if (input === null || output === null) return null;
  return {
    inputTokens:
      provider === "anthropic"
        ? input +
          (count(usage.cache_read_input_tokens) ?? 0) +
          (count(usage.cache_creation_input_tokens) ?? 0)
        : input,
    outputTokens: output,
    cacheReadTokens: count(
      provider === "anthropic"
        ? usage.cache_read_input_tokens
        : usage.prompt_tokens_details?.cached_tokens,
    ),
    cacheCreationTokens: count(
      provider === "anthropic" ? usage.cache_creation_input_tokens : undefined,
    ),
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
    reportedCostUsd:
      typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
        ? usage.cost
        : null,
  };
}
async function boundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("provider response exceeds experiment bounds");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Every real SDK/compatibility retry passes this gate, including failures. */
export function createMeteredFetch(options: {
  connection: ResolvedConnection;
  limits: OperationLimits;
  maxContextBytes: number;
  accounting: MeterAccounting;
  signal?: AbortSignal;
  upstream?: typeof globalThis.fetch;
  now?: () => number;
}): MeteredTransport {
  const { connection, limits, accounting } = options;
  const now = options.now ?? Date.now;
  const observations: HttpObservation[] = [];
  let admissionError: Error | null = null;
  const transport = async (
    input: string | Request | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const expectedPath =
      connection.config.provider === "anthropic" ? "/v1/messages" : "/chat/completions";
    const expectedUrl = connection.identity.endpoint + expectedPath;
    // Anthropic accepts base URL with /v1 already present, but the SDK appends /v1/messages.
    if (
      url.toString() !== expectedUrl ||
      request.method !== "POST" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("provider request endpoint differs from the frozen plan");
    }
    const text = await request.clone().text();
    if (Buffer.byteLength(text, "utf8") > options.maxContextBytes + 64 * 1024)
      throw new Error("provider request exceeds frozen context bound");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("provider request is not JSON");
    }
    const cap = body.max_completion_tokens ?? body.max_tokens;
    if (
      body.model !== connection.identity.modelId ||
      body.stream === true ||
      cap !== limits.maxOutputTokens
    ) {
      throw new Error(
        "provider request model, streaming mode or output cap differs from the frozen plan",
      );
    }
    const baseKeys = new Set([
      "model",
      "messages",
      "system",
      "max_tokens",
      "max_completion_tokens",
      "stream",
    ]);
    for (const key of Object.keys(connection.wireParameters)) baseKeys.add(key);
    if (Object.keys(body).some((key) => !baseKeys.has(key)))
      throw new Error("provider request contains an unapproved parameter");
    for (const [key, expected] of Object.entries(connection.wireParameters)) {
      if (canonicalJson(body[key]) !== canonicalJson(expected))
        throw new Error("provider compatibility retry changed a frozen request parameter");
    }
    const isText = (value: unknown): boolean =>
      typeof value === "string" ||
      (Array.isArray(value) &&
        value.every(
          (block: any) =>
            block &&
            block.type === "text" &&
            typeof block.text === "string" &&
            Object.keys(block).every((key) => ["type", "text", "cache_control"].includes(key)),
        ));
    if (
      !Array.isArray(body.messages) ||
      body.messages.some(
        (message: any) =>
          !["system", "user"].includes(message?.role) ||
          !isText(message.content) ||
          Object.keys(message).some((key) => !["role", "content"].includes(key)),
      ) ||
      (body.system !== undefined && !isText(body.system))
    ) {
      throw new Error("provider request is not a text-only trial");
    }
    const attemptId = randomUUID();
    let admission: { deadlineAt: number };
    try {
      accounting.check();
      admission = accounting.admit(attemptId);
    } catch (error) {
      admissionError ??= error instanceof Error ? error : new Error("request admission denied");
      throw admissionError;
    }
    const started = now();
    if (admission.deadlineAt <= started) throw new Error("experiment operation deadline exceeded");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), admission.deadlineAt - started);
    const signals = [
      controller.signal,
      request.signal,
      ...(options.signal ? [options.signal] : []),
    ];
    const signal = AbortSignal.any(signals);
    let status: number | null = null;
    let responseModel: string | null = null;
    let usage: ObservedUsage | null = null;
    let outcome: "settled" | "unknown" = "unknown";
    try {
      accounting.check();
      if (signal.aborted) throw new DOMException("experiment cancelled", "AbortError");
      accounting.dispatch(attemptId);
      const response = await (options.upstream ?? globalThis.fetch)(request, {
        signal,
        redirect: "error",
      });
      status = response.status;
      const responseText = await boundedBody(
        response,
        Math.min(16 * 1024 * 1024, limits.maxOutputTokens * 128 + 64 * 1024),
      );
      let parsed: any;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new Error("provider response is not valid JSON");
      }
      responseModel =
        typeof parsed?.model === "string" && parsed.model.length <= 256 ? parsed.model : null;
      usage = response.ok ? extractUsage(parsed, connection.config.provider) : null;
      outcome = response.ok && usage && responseModel ? "settled" : "unknown";
      return new Response(responseText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
      const observation = {
        attemptId,
        responseModel,
        usage,
        status,
        elapsedMs: Math.max(0, now() - started),
        outcome,
      };
      observations.push(observation);
      accounting.finish(observation);
    }
  };
  return {
    fetch: transport as typeof globalThis.fetch,
    observations,
    get admissionError() {
      return admissionError;
    },
  };
}
