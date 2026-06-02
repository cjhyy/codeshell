/**
 * Per-(provider, model) capability descriptor.
 *
 * Captures the subset of request-shape divergence we've actually observed
 * cause HTTP 400s or behavior changes. Each rule in `rules.ts` produces
 * one of these; clients spread it into the outgoing request.
 *
 * Sources for every field are documented next to the matching rule in
 * `rules.ts` — vendor docs, not folklore.
 */

import type { ProviderKindName } from "../provider-kinds.js";

/**
 * OpenAI-style reasoning effort levels — shared by several vendors.
 * `xhigh` is gpt-5.5+ only (which also drops `minimal`); see rules.ts.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

/** A binary thinking switch, like DeepSeek V4 and Z.AI GLM use. */
export type ThinkingSwitch = "enabled" | "disabled";

/**
 * How the vendor exposes a "think harder / think less" knob (or none).
 * Each kind has different field names and value shapes — we keep them
 * separate so the engine can't accidentally cross-pollinate.
 */
export type ReasoningShape =
  | { kind: "none" }
  /** DeepSeek V4, Z.AI GLM-4.5+ — `{thinking: {type: "enabled"|"disabled"}}` at top level. */
  | { kind: "deepseek-thinking" }
  /**
   * OpenAI o-series & gpt-5+ — `reasoning_effort: "minimal"|"low"|"medium"|"high"`.
   * `disabledEffort` is the value we send when the caller asks for thinking
   * "disabled" — defaults to `"minimal"` (OpenAI), but vendors with a
   * narrower vocabulary override it (e.g. xAI Grok 4.3 has no `"minimal"`;
   * Mistral Magistral only accepts `"high"` and `"none"`).
   *
   * `supportedEfforts` is the FIRST-CLASS list of levels a UI may offer for
   * this model. Set it whenever the vocabulary differs from the default
   * `["minimal","low","medium","high"]` — e.g. gpt-5.5 is
   * `["low","medium","high","xhigh"]`, Mistral magistral is `["high"]`. The UI
   * (reasoningControlFor) reads this directly instead of inferring the
   * level set from `disabledEffort`, which is a wire-detail, not a
   * capability marker (two unrelated vendors can share `disabledEffort:"none"`).
   */
  | {
      kind: "openai-effort";
      disabledEffort?: ReasoningEffort | "none";
      supportedEfforts?: ReasoningEffort[];
    }
  /** Anthropic Claude 4.x ≤ 4.5 — `{thinking: {type: "enabled", budget_tokens: N}}`. */
  | { kind: "anthropic-budget"; minBudgetTokens: number }
  /** Anthropic Claude 4.6+ — no opt-in, thinking is adaptive. Sending `type: "enabled"` 400s. */
  | { kind: "anthropic-adaptive" }
  /** OpenRouter normalized — `{reasoning: {effort, max_tokens, exclude, enabled}}`. */
  | { kind: "openrouter-reasoning" };

/**
 * How prior `reasoning_content` (or `thinking` blocks) must be threaded
 * back into the next request.
 */
export type EchoReasoning =
  /** DeepSeek `deepseek-reasoner`: 400 if you echo it back at all. */
  | "never"
  /** DeepSeek V4 + tools, Claude 4.x + tools: must echo or 400. */
  | "when-tools"
  /** Optional — echo if you have it, but absence is fine. */
  | "optional";

/**
 * Parallel-tool-call shape. OpenAI exposes `parallel_tool_calls: bool`.
 * Anthropic exposes it inside `tool_choice.disable_parallel_tool_use`.
 * Some endpoints don't support it at all.
 */
export type ParallelToolCallsShape =
  | "openai-flag"
  | "anthropic-disable-flag"
  | "unsupported";

/**
 * Streaming usage signal. OpenAI-compat needs `stream_options:
 * {include_usage: true}`; Anthropic always emits usage in
 * `message_delta`; some endpoints reject the field.
 */
export type StreamUsageShape =
  | "include-usage-flag"
  | "auto"
  | "none";

export interface Capability {
  /**
   * Whether the model accepts image content blocks. UI gates image attachments
   * on this — non-vision models surface a "this model does not accept images"
   * message instead of silently dropping the upload.
   */
  supportsVision: boolean;
  /** Token-limit request field. */
  tokenLimitField: "max_tokens" | "max_completion_tokens";
  /**
   * Request fields the model 400s on (or silently drops). We just don't
   * send them. Names are in OpenAI-compat spelling; clients translate
   * for native protocols.
   */
  rejectedParams: ReadonlySet<
    "temperature" | "top_p" | "presence_penalty" | "frequency_penalty"
    | "logit_bias" | "logprobs" | "top_logprobs"
  >;
  /** How thinking is exposed (or not). */
  reasoning: ReasoningShape;
  /** Echo-back contract for prior reasoning. */
  echoReasoning: EchoReasoning;
  /** Parallel-tool-calls flag shape. */
  parallelToolCalls: ParallelToolCallsShape;
  /** Streaming usage reporting shape. */
  streamUsage: StreamUsageShape;
  /**
   * Known hard ceiling for max-output-tokens, when the vendor publishes one
   * and exceeding it 400s. Used to clamp a requested/inherited max_tokens so
   * a stale catalog value (e.g. 384000 copied from a DeepSeek/OpenRouter
   * entry) can't bleed onto a smaller-cap model after a hot switch. Undefined
   * = no known cap → send the request value unclamped.
   */
  maxOutputTokens?: number;
}

/**
 * Conservative default — used when no rule matches. Picks "send everything
 * the vanilla OpenAI Chat Completions spec accepts," because that's what
 * every OpenAI-compat endpoint at minimum understands.
 */
export const DEFAULT_CAPABILITY: Capability = {
  supportsVision: false,
  tokenLimitField: "max_tokens",
  rejectedParams: new Set(),
  reasoning: { kind: "none" },
  echoReasoning: "optional",
  parallelToolCalls: "openai-flag",
  streamUsage: "include-usage-flag",
};

export interface CapabilityRule {
  /** Which provider kind this rule applies to. */
  kind: ProviderKindName;
  /** Model-id matcher. First matching rule wins (per kind). */
  match: RegExp;
  /** Patch applied on top of DEFAULT_CAPABILITY. */
  capability: Partial<Capability>;
  /** Free-text reason — shown in logs, helps future-you. */
  why: string;
}
