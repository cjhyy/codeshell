import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, TokenUsage } from "../types.js";
import { currentUsageAttempt, currentUsageOwner } from "../cost-ledger/context.js";
import { estimateReceipt } from "../cost-ledger/pricing.js";
import { ModelTraceStore } from "./store.js";
import { sanitizeTraceValue } from "./sanitize.js";
import type {
  ModelTraceAttempt,
  ModelTraceConfig,
  ModelTraceContext,
  ModelTraceEvent,
  ModelTraceEventInput,
  ModelTraceOutput,
  ModelTraceRecord,
  ExternalModelTraceInput,
  ExternalModelCallInput,
} from "./types.js";

const contexts = new AsyncLocalStorage<ModelTraceContext>();
interface TraceCall {
  store: ModelTraceStore;
  record: ModelTraceRecord;
  context: ModelTraceContext;
  redactions?: ReadonlyMap<string, string>;
  latest?: ModelTraceAttempt;
  timer?: ReturnType<typeof setTimeout>;
  initialConfig: ModelTraceConfig;
}
const calls = new AsyncLocalStorage<TraceCall>();
let configured: { store: ModelTraceStore; source: string } | undefined;
const stores = new Map<string, ModelTraceStore>();
// Exact tool IDs, scoped to their execution. Ambiguous reused IDs never guess a parent.
const toolParents = new Map<string, { parentId?: string; at: number }>();
const capturePolicies = new Map<string, ModelTraceConfig>();
const externalCallContexts = new Map<string, ModelTraceContext>();
function attribution(context: ModelTraceContext) {
  const owner = currentUsageOwner();
  return {
    sessionId: Object.hasOwn(context, "sessionId") ? context.sessionId : owner?.sessionId,
    runId: Object.hasOwn(context, "runId") ? context.runId : owner?.runId,
    parentSessionId: Object.hasOwn(context, "parentSessionId")
      ? context.parentSessionId
      : owner?.ancestors[0],
  };
}
function boundedSet<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= 4096) map.delete(map.keys().next().value!);
  map.set(key, value);
}
function toolParentKey(
  store: ModelTraceStore,
  traceId: string,
  sessionId: string | undefined,
  toolCallId: string,
): string {
  return JSON.stringify([store.storageDir, traceId, sessionId ?? null, toolCallId]);
}
function rememberTools(call: TraceCall, tools: unknown): void {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    const id = tool?.id;
    if (typeof id !== "string" || !id || id.length > 1024) continue;
    const key = toolParentKey(call.store, call.record.traceId, call.record.sessionId, id);
    const previous = toolParents.get(key);
    boundedSet(toolParents, key, {
      parentId: previous && previous.parentId !== call.record.id ? undefined : call.record.id,
      at: Date.now(),
    });
  }
}
function policyFor(
  store: ModelTraceStore,
  kind: string,
  id: string,
  settings: ModelTraceConfig,
): ModelTraceConfig {
  const key = JSON.stringify([store.storageDir, kind, id]);
  let policy = capturePolicies.get(key);
  if (!policy) {
    policy = { ...settings };
    boundedSet(capturePolicies, key, policy);
  }
  return policy;
}
function targetForContext(context: ModelTraceContext) {
  if (!context.storageDir) return configured;
  let store = stores.get(context.storageDir);
  if (!store) {
    store = new ModelTraceStore({ storageDir: context.storageDir });
    if (stores.size >= 32) stores.delete(stores.keys().next().value!);
    stores.set(context.storageDir, store);
  }
  return { store, source: context.source ?? configured?.source ?? "host" };
}

/** Explicit Host bootstrap. Content settings live in the store and are reread while running. */
export function configureModelTracing(options: {
  storageDir: string;
  source?: string;
}): ModelTraceStore {
  const store = new ModelTraceStore(options);
  stores.set(options.storageDir, store);
  configured = { store, source: options.source ?? "host" };
  return store;
}
export function withModelTraceContext<T>(context: ModelTraceContext, operation: () => T): T {
  return contexts.run({ ...contexts.getStore(), ...context }, operation);
}
/** Host teardown/test isolation; existing in-flight calls keep their captured owner. */
export function clearModelTracingConfiguration(): void {
  configured = undefined;
  stores.clear();
  toolParents.clear();
  capturePolicies.clear();
  externalCallContexts.clear();
}
function validUsage(usage: TokenUsage | undefined): usage is TokenUsage {
  return (
    !!usage &&
    [
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      usage.cacheReadTokens ?? 0,
      usage.cacheCreationTokens ?? 0,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  );
}
function estimateRecord(record: ModelTraceRecord): void {
  let known = 0,
    priced = 0,
    unknown = 0;
  const usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let measured = false;
  for (const attempt of record.attempts) {
    if (!validUsage(attempt.usage)) {
      attempt.estimatedCostUsd = null;
      attempt.pricing = null;
      unknown++;
      continue;
    }
    const estimate = estimateReceipt(record, attempt.usage);
    Object.assign(attempt, estimate);
    if (estimate.estimatedCostUsd === null) unknown++;
    else {
      known += estimate.estimatedCostUsd;
      priced++;
    }
    measured = true;
    for (const key of [
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "cacheReadTokens",
      "cacheCreationTokens",
    ] as const)
      usage[key] = (usage[key] ?? 0) + (attempt.usage[key] ?? 0);
  }
  if (measured) record.usage = usage;
  record.estimatedCostUsd = priced ? known : null;
  record.unknownCostAttempts = unknown;
  record.pricing = record.attempts.find((attempt) => attempt.pricing)?.pricing ?? null;
}
function config(call: TraceCall): ModelTraceConfig {
  return call.store.getConfig();
}
function canCapture(call: TraceCall): boolean {
  const settings = config(call);
  return call.initialConfig.captureContent && settings.enabled && settings.captureContent;
}
function persist(call: TraceCall, immediate = false): void {
  const write = () => {
    call.timer = undefined;
    try {
      estimateRecord(call.record);
      const settings = call.store.getConfig();
      if (
        settings.enabled &&
        (!call.context.ephemeral ||
          (call.initialConfig.includeEphemeral && settings.includeEphemeral))
      )
        call.store.write(call.record);
    } catch {
      /* Trace IO must never fail, retry, delay, or authorize a model call. */
    }
  };
  if (immediate) {
    clearTimeout(call.timer);
    write();
  } else if (!call.timer) {
    call.timer = setTimeout(write, 200);
    call.timer.unref?.();
  }
}
function capture<T>(
  call: TraceCall,
  value: T,
  allowed = canCapture(call),
): { value?: T; state: ModelTraceRecord["inputState"] } {
  if (!allowed) return { state: "not-recorded" };
  try {
    const safe = sanitizeTraceValue(value, call.redactions);
    return { value: safe.value, state: safe.state };
  } catch {
    return { state: "not-recorded" };
  }
}
function errorText(call: TraceCall, error: unknown): string {
  try {
    if (!call.initialConfig.captureContent || !config(call).captureContent)
      return error instanceof Error ? error.name : "Model request failed";
    return String(
      sanitizeTraceValue(error instanceof Error ? error.message : String(error)).value,
    ).slice(0, 4096);
  } catch {
    return "Model request failed";
  }
}
function cancelled(error: unknown): boolean {
  return error instanceof Error && /abort|cancel/i.test(error.name);
}

/** Covers auxiliary, hidden and billing-disabled calls independently of the cost ledger. */
export async function withModelTrace<T extends LLMResponse>(
  identity: {
    provider: string;
    providerKind?: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    parameters?: Record<string, unknown>;
  },
  options: CreateMessageOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const context = contexts.getStore() ?? {};
  let target: ReturnType<typeof targetForContext>;
  try {
    target = targetForContext(context);
  } catch {
    return calls.exit(operation);
  }
  if (!target) return calls.exit(operation);
  let settings: ModelTraceConfig;
  try {
    settings = target.store.getConfig();
  } catch {
    return calls.exit(operation);
  }
  if (!settings.enabled) return calls.exit(operation);
  const owner = currentUsageOwner();
  const attributed = attribution(context);
  const id = options.requestBoundaryId ?? randomUUID();
  const runId = attributed.runId;
  const record: ModelTraceRecord = {
    version: 1,
    id,
    traceId: runId ?? id,
    sessionId: attributed.sessionId,
    runId,
    parentSessionId: attributed.parentSessionId,
    workspacePath: context.workspacePath,
    source: context.source ?? target.source,
    purpose: options.usagePurpose ?? context.purpose ?? owner?.purpose ?? "unattributed",
    provider: identity.provider,
    providerKind: identity.providerKind,
    model: identity.model,
    startedAt: Date.now(),
    status: "running",
    stream: !!(options.stream && options.onChunk),
    inputState: "not-recorded",
    outputState: "not-recorded",
    attempts: [],
  };
  const call: TraceCall = {
    store: target.store,
    record,
    context,
    redactions: options.diagnosticRedactions,
    initialConfig: { ...settings },
  };
  const input = capture(call, {
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    tools: options.tools ?? [],
    parameters: {
      ...identity.parameters,
      temperature: options.temperature ?? identity.temperature,
      maxTokens: options.maxTokens ?? identity.maxTokens,
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      stream: record.stream,
      promptCache: options.promptCache,
    },
  });
  record.inputState = input.state;
  record.input = input.value;
  persist(call, true);
  return calls.run(call, async () => {
    try {
      const response = await operation();
      rememberTools(call, response.toolCalls);
      const output = capture(call, {
        text: response.text,
        thinking: response.reasoningContent,
        toolCalls: response.toolCalls,
        stopReason: response.stopReason,
      });
      record.outputState = output.state;
      record.output = output.value;
      record.usage = response.usage;
      record.status = "completed";
      if (record.attempts.length === 0) {
        const attempt: ModelTraceAttempt = {
          id: randomUUID(),
          number: 1,
          startedAt: record.startedAt,
          endedAt: Date.now(),
          status: "completed",
          coverage: "logical-input",
          inputState: record.inputState,
          input: record.input,
          outputState: record.outputState,
          output: record.output,
          usage: response.usage,
        };
        record.attempts.push(attempt);
      }
      return response;
    } catch (error) {
      record.status = cancelled(error) || options.signal?.aborted ? "cancelled" : "failed";
      record.error = errorText(call, error);
      recordModelTraceAttemptError(error);
      if (call.latest?.output) {
        record.output = call.latest.output;
        record.outputState = call.latest.outputState;
      }
      if (call.latest?.usage) record.usage = call.latest.usage;
      throw error;
    } finally {
      record.endedAt = Date.now();
      if (record.attempts.length === 0)
        record.attempts.push({
          id: randomUUID(),
          number: 1,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          status: record.status,
          coverage: "logical-input",
          inputState: record.inputState,
          input: record.input,
          outputState: record.outputState,
          output: record.output,
          error: record.error,
          usage: record.usage,
        });
      persist(call, true);
    }
  });
}

/** Provider parsers settle only the latest actual SDK fetch, never earlier retries. */
export function recordModelTraceAttemptResult(response: LLMResponse): void {
  const call = calls.getStore(),
    attempt = call?.latest;
  if (!call || !attempt) return;
  try {
    const output = capture(call, {
      text: response.text,
      thinking: response.reasoningContent,
      toolCalls: response.toolCalls,
      stopReason: response.stopReason,
    });
    attempt.output = output.value;
    attempt.outputState = output.state;
    attempt.usage = response.usage;
    rememberTools(call, response.toolCalls);
    attempt.status = "completed";
    attempt.endedAt ??= Date.now();
    persist(call, true);
  } catch {
    /* Observer only. */
  }
}
export function recordModelTraceAttemptError(error: unknown): void {
  const call = calls.getStore(),
    attempt = call?.latest;
  if (!call || !attempt) return;
  try {
    attempt.status = cancelled(error) ? "cancelled" : "failed";
    attempt.error = errorText(call, error);
    attempt.endedAt ??= Date.now();
    persist(call, true);
  } catch {
    /* Observer only. */
  }
}

function usageOf(value: any, previous?: TokenUsage): TokenUsage | undefined {
  if (!value || typeof value !== "object") return previous;
  const anthropic = "input_tokens" in value || "output_tokens" in value;
  const prompt = anthropic
    ? (value.input_tokens ?? previous?.promptTokens ?? 0) +
      (value.cache_read_input_tokens ?? 0) +
      (value.cache_creation_input_tokens ?? 0)
    : (value.prompt_tokens ?? previous?.promptTokens ?? 0);
  const completion = anthropic
    ? (value.output_tokens ?? previous?.completionTokens ?? 0)
    : (value.completion_tokens ?? previous?.completionTokens ?? 0);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: value.total_tokens ?? prompt + completion,
    ...(value.cache_read_input_tokens !== undefined ||
    value.prompt_tokens_details?.cached_tokens !== undefined
      ? {
          cacheReadTokens:
            value.cache_read_input_tokens ?? value.prompt_tokens_details.cached_tokens,
        }
      : previous?.cacheReadTokens !== undefined
        ? { cacheReadTokens: previous.cacheReadTokens }
        : {}),
    ...(value.cache_creation_input_tokens !== undefined ||
    value.prompt_tokens_details?.cache_write_tokens !== undefined
      ? {
          cacheCreationTokens:
            value.cache_creation_input_tokens ?? value.prompt_tokens_details.cache_write_tokens,
        }
      : previous?.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: previous.cacheCreationTokens }
        : {}),
  };
}

/** Observe response bytes in the consumer's stream; no tee, background drain or retries. */
export function modelTraceFetch(underlying: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input, init) => {
    const call = calls.getStore();
    if (!call || !config(call).enabled) return underlying(input, init);
    let body: any;
    let wireBody = false;
    try {
      const raw =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request && !init?.body
            ? await input.clone().text()
            : undefined;
      wireBody = raw !== undefined && /^\s*[{[]/.test(raw);
      if (wireBody && canCapture(call)) body = JSON.parse(raw!);
    } catch {
      /* Unsupported custom transports retain logical-input coverage. */
    }
    const captured = capture(call, body ?? call.record.input);
    const attempt: ModelTraceAttempt = {
      id: currentUsageAttempt()?.requestId ?? randomUUID(),
      number: call.record.attempts.length + 1,
      startedAt: Date.now(),
      status: "running",
      coverage: wireBody ? "provider-wire" : "logical-input",
      inputState: captured.state,
      input: captured.value,
      outputState: "not-recorded",
    };
    call.record.attempts.push(attempt);
    call.latest = attempt;
    persist(call, true);
    let response: Response;
    try {
      response = await underlying(input, init);
    } catch (error) {
      attempt.status = cancelled(error) ? "cancelled" : "failed";
      attempt.error = errorText(call, error);
      attempt.endedAt = Date.now();
      persist(call, true);
      throw error;
    }
    attempt.httpStatus = response.status;
    if (!response.ok) {
      attempt.status = "failed";
      attempt.endedAt = Date.now();
    }
    if (!response.body) {
      attempt.endedAt = Date.now();
      if (response.ok) attempt.status = "completed";
      persist(call, true);
      return response;
    }
    const stream =
      response.headers.get("content-type")?.includes("text/event-stream") ||
      body?.stream === true ||
      (call.record.stream && response.ok);
    const decoder = new TextDecoder();
    let pending = "",
      json = "";
    const output: ModelTraceOutput = {};
    let contentAllowed = false;
    const toolCalls = new Map<number, any>();
    const markToken = () => {
      attempt.firstTokenAt ??= Date.now();
    };
    const append = (name: "text" | "thinking", text: unknown) => {
      if (typeof text !== "string" || !text) return;
      markToken();
      if (!contentAllowed) return;
      const previous = output[name] ?? "";
      if (previous.length < 64 * 1024) output[name] = (previous + text).slice(0, 64 * 1024);
      if (previous.length + text.length > 64 * 1024) attempt.outputState = "truncated";
    };
    const appendToolArguments = (tool: { args: string }, delta: string) => {
      if (tool.args.length + delta.length > 64 * 1024) attempt.outputState = "truncated";
      tool.args = (tool.args + delta).slice(0, 64 * 1024);
    };
    const accept = (data: any) => {
      if (!data || typeof data !== "object") return;
      contentAllowed = canCapture(call);
      if (data.usage) attempt.usage = usageOf(data.usage, attempt.usage);
      if (data.message?.usage) attempt.usage = usageOf(data.message.usage, attempt.usage);
      const choice = data.choices?.[0],
        delta = choice?.delta ?? choice?.message;
      if (delta) {
        append("text", delta.content);
        append("thinking", delta.reasoning_content ?? delta.reasoning);
        if (Array.isArray(delta.tool_calls))
          for (const tool of delta.tool_calls) {
            markToken();
            rememberTools(call, [tool]);
            if (!contentAllowed || toolCalls.size >= 2048) continue;
            const index = tool.index ?? toolCalls.size,
              old = toolCalls.get(index) ?? { id: "", toolName: "", args: "" };
            old.id ||= tool.id ?? "";
            old.toolName ||= tool.function?.name ?? "";
            appendToolArguments(old, tool.function?.arguments ?? "");
            toolCalls.set(index, old);
          }
        if (choice.finish_reason) output.stopReason = choice.finish_reason;
      }
      if (data.type === "content_block_start") {
        const block = data.content_block;
        if (block?.type === "tool_use") {
          markToken();
          rememberTools(call, [block]);
          if (contentAllowed && toolCalls.size < 2048)
            toolCalls.set(data.index, { id: block.id, toolName: block.name, args: "" });
        }
        if (block?.text) append("text", block.text);
      }
      if (data.type === "content_block_delta") {
        append("text", data.delta?.text);
        append("thinking", data.delta?.thinking);
        if (typeof data.delta?.partial_json === "string") {
          markToken();
          const tool = toolCalls.get(data.index);
          if (tool && contentAllowed) appendToolArguments(tool, data.delta.partial_json);
        }
      }
      if (Array.isArray(data.content))
        for (const block of data.content) {
          append("text", block.text);
          append("thinking", block.thinking);
          if (block.type === "tool_use") {
            markToken();
            rememberTools(call, [block]);
            if (contentAllowed && toolCalls.size < 2048)
              toolCalls.set(toolCalls.size, {
                id: block.id,
                toolName: block.name,
                args: block.input,
              });
          }
        }
      if (data.stop_reason ?? data.delta?.stop_reason)
        output.stopReason = data.stop_reason ?? data.delta.stop_reason;
      if (data.error) {
        attempt.status = "failed";
        attempt.error = errorText(call, data.error.message ?? "Provider error");
      }
      if (contentAllowed) {
        if (toolCalls.size) output.toolCalls = [...toolCalls.values()];
        const safe = capture(call, output, contentAllowed);
        attempt.output = safe.value;
        if (attempt.outputState !== "truncated") attempt.outputState = safe.state;
      }
      persist(call);
    };
    const parse = (text: string) => {
      try {
        accept(JSON.parse(text));
      } catch {
        /* The provider parser owns malformed-response classification. */
      }
    };
    const feed = (chunk: Uint8Array) => {
      const text = decoder.decode(chunk, { stream: true });
      if (!stream) {
        if (canCapture(call) && json.length < 2 * 1024 * 1024)
          json += text.slice(0, 2 * 1024 * 1024 - json.length);
        return;
      }
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.length > 512 * 1024) {
          attempt.outputState = "truncated";
          continue;
        }
        if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
          parse(line.slice(5).trim());
      }
      if (pending.length > 512 * 1024) {
        pending = "";
        attempt.outputState = "truncated";
      }
    };
    const reader = response.body.getReader();
    const observed = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            const tail = decoder.decode();
            if (stream) {
              pending += tail;
              if (pending.startsWith("data:")) parse(pending.slice(5).trim());
            } else parse(json + tail);
            attempt.endedAt = Date.now();
            if (attempt.status === "running") attempt.status = response.ok ? "completed" : "failed";
            persist(call, true);
            controller.close();
          } else {
            try {
              feed(next.value);
            } catch {
              /* Never affect SDK stream delivery. */
            }
            controller.enqueue(next.value);
          }
        } catch (error) {
          attempt.status = cancelled(error) ? "cancelled" : "failed";
          attempt.error = errorText(call, error);
          attempt.endedAt = Date.now();
          persist(call, true);
          controller.error(error);
        }
      },
      async cancel(reason) {
        attempt.status = "cancelled";
        attempt.endedAt = Date.now();
        persist(call, true);
        await reader.cancel(reason);
      },
    });
    const wrapped = new Response(observed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    for (const field of ["url", "redirected", "type"] as const)
      Object.defineProperty(wrapped, field, { value: response[field] });
    return wrapped;
  }) as typeof globalThis.fetch;
}

/** Tool/approval/lifecycle spans share the exact Host context and retention policy. */
export function recordModelTraceEvent(input: ModelTraceEventInput): ModelTraceEvent | null {
  try {
    const target = targetForContext(contexts.getStore() ?? {});
    if (!target) return null;
    const settings = target.store.getConfig();
    const context = contexts.getStore() ?? {},
      call = calls.getStore();
    const attributed = attribution(context);
    const id = input.id ?? randomUUID(),
      runId = input.runId ?? attributed.runId;
    const matchingCall =
      call?.store.storageDir === target.store.storageDir &&
      call.record.sessionId === attributed.sessionId &&
      call.record.runId === attributed.runId;
    const traceId =
      input.traceId ?? runId ?? (matchingCall ? call?.record.traceId : undefined) ?? id;
    const policy = policyFor(target.store, "event", id, settings);
    if (!settings.enabled || !policy.enabled) return null;
    const event: ModelTraceEvent = {
      ...input,
      id,
      traceId,
      runId,
      sessionId: input.sessionId ?? attributed.sessionId,
      workspacePath: input.workspacePath ?? context.workspacePath,
      inputState: "not-recorded",
      outputState: "not-recorded",
    };
    if (!event.parentId && event.kind === "tool") {
      const toolCallId = (input.input as { toolCallId?: unknown } | undefined)?.toolCallId;
      if (typeof toolCallId === "string") {
        const parent = toolParents.get(
          toolParentKey(target.store, traceId, event.sessionId, toolCallId),
        );
        if (parent && Date.now() - parent.at < 86_400_000) event.parentId = parent.parentId;
      }
    }
    delete event.input;
    delete event.output;
    if (policy.captureContent && settings.captureContent) {
      if (input.input !== undefined && input.inputState !== "not-recorded") {
        const safe = sanitizeTraceValue(input.input);
        event.input = safe.value;
        event.inputState = input.inputState ?? safe.state;
      }
      if (input.output !== undefined && input.outputState !== "not-recorded") {
        const safe = sanitizeTraceValue(input.output);
        event.output = safe.value;
        event.outputState = input.outputState ?? safe.state;
      }
      if (event.error) event.error = String(sanitizeTraceValue(event.error).value).slice(0, 4096);
    } else if (event.error) event.error = "Operation failed";
    if (!context.ephemeral || (policy.includeEphemeral && settings.includeEphemeral))
      target.store.writeEvent(event);
    return event;
  } catch {
    return null;
  }
}

export function recordExternalModelTrace(input: ExternalModelTraceInput): ModelTraceRecord | null {
  try {
    const context = { ...contexts.getStore(), ...input };
    const target = targetForContext(context);
    if (!target) return null;
    const settings = target.store.getConfig();
    if (!settings.enabled) return null;
    const attributed = attribution(context);
    const id = input.id ?? randomUUID(),
      runId = attributed.runId;
    const previous = input.id ? target.store.get(input.id) : null;
    const policy = policyFor(target.store, "external", id, settings);
    const record: ModelTraceRecord = {
      version: 1,
      id,
      traceId: runId ?? input.traceId ?? previous?.traceId ?? id,
      sessionId: attributed.sessionId,
      runId,
      workspacePath: context.workspacePath,
      parentSessionId: attributed.parentSessionId,
      source: input.source,
      purpose: input.purpose ?? "external",
      provider: input.provider,
      model: input.model,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      status: input.status,
      stream: input.stream ?? true,
      inputState: "not-recorded",
      outputState: "not-recorded",
      usage: input.usage,
      attempts: [],
    };
    if (policy.captureContent && settings.captureContent) {
      if (input.input) {
        const safe = sanitizeTraceValue({
          systemPrompt: "",
          messages: [],
          tools: [],
          parameters: {},
          ...input.input,
        });
        record.inputState = safe.state;
        record.input = safe.value;
      } else if (previous?.input) {
        record.input = previous.input;
        record.inputState = previous.inputState;
      }
      if (input.output) {
        const safe = sanitizeTraceValue(input.output);
        record.outputState = safe.state;
        record.output = safe.value;
      } else if (previous?.output) {
        record.output = previous.output;
        record.outputState = previous.outputState;
      }
    }
    if (input.error)
      record.error =
        policy.captureContent && settings.captureContent
          ? String(sanitizeTraceValue(input.error).value).slice(0, 4096)
          : "External model request failed";
    record.attempts.push({
      id: previous?.attempts[0]?.id ?? randomUUID(),
      number: 1,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      status: record.status,
      coverage: "external-cli-input",
      inputState: record.inputState,
      input: record.input,
      outputState: record.outputState,
      output: record.output,
      error: record.error,
      usage: record.usage,
    });
    estimateRecord(record);
    if (!context.ephemeral || (policy.includeEphemeral && settings.includeEphemeral))
      target.store.write(record);
    return record;
  } catch {
    return null;
  }
}

/** Narrow capability observer. Caller-supplied scope fields are ignored at runtime too. */
export function recordExternalModelCall(input: ExternalModelCallInput): ModelTraceRecord | null {
  try {
    let context = input.id ? externalCallContexts.get(input.id) : undefined;
    if (input.id && !context) return null;
    if (!context) {
      const inherited = contexts.getStore() ?? {};
      const target = targetForContext(inherited);
      if (!target) return null;
      context = {
        ...attribution(inherited),
        storageDir: target.store.storageDir,
        workspacePath: inherited.workspacePath,
        ephemeral: inherited.ephemeral ?? false,
      };
    }
    const record = recordExternalModelTrace({
      ...context,
      id: input.id,
      traceId: input.traceId,
      source: input.source,
      purpose: input.purpose,
      provider: input.provider,
      model: input.model,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      status: input.status,
      stream: input.stream,
      input: input.input,
      output: input.output,
      error: input.error,
      usage: input.usage,
    });
    if (record && record.status === "running") boundedSet(externalCallContexts, record.id, context);
    else if (input.id) externalCallContexts.delete(input.id);
    return record;
  } catch {
    return null;
  }
}
