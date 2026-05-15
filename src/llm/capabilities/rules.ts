/**
 * Per-(provider kind, model family) capability overrides.
 *
 * Each rule patches the conservative DEFAULT_CAPABILITY. First match per
 * kind wins — order matters for overlapping families.
 *
 * Authority for every entry is the vendor's own docs; the `why` field
 * cites the specific page. When a model 400s on something not captured
 * here, add a rule, don't patch the client.
 *
 * Sources audited 2026-05-15:
 *   OpenAI:    https://platform.openai.com/docs/guides/reasoning
 *              https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning
 *   Anthropic: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 *   DeepSeek:  https://api-docs.deepseek.com/guides/reasoning_model
 *              https://api-docs.deepseek.com/guides/thinking_mode
 *   Z.AI:      https://docs.z.ai/guides/llm/glm-4.6
 *   Gemini:    https://ai.google.dev/gemini-api/docs/openai
 *              https://ai.google.dev/gemini-api/docs/thinking
 *   OpenRouter: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 *   xAI:       https://docs.x.ai/docs/guides/reasoning
 *   Mistral:   https://docs.mistral.ai/api/
 *   Groq:      https://console.groq.com/docs/reasoning
 */

import type { CapabilityRule } from "./types.js";

export const RULES: ReadonlyArray<CapabilityRule> = [
  // ─── OpenAI native ─────────────────────────────────────────────
  {
    kind: "openai",
    // o1/o3/o4-mini + gpt-5/5.1/5.2/5.3/5.4/5.5 + future digits.
    // Anchored to start so OpenRouter-prefixed ids like `openai/gpt-5`
    // never match this rule (OpenRouter rule below handles those).
    match: /^(?:o[1-9]\d*|gpt-[5-9])(?:[-.]|$)/i,
    capability: {
      tokenLimitField: "max_completion_tokens",
      rejectedParams: new Set([
        "temperature", "top_p", "presence_penalty",
        "frequency_penalty", "logit_bias", "logprobs", "top_logprobs",
      ]),
      reasoning: { kind: "openai-effort" },
      echoReasoning: "optional",
    },
    why: "OpenAI o-series + gpt-5+ reject classic sampling params; use max_completion_tokens + reasoning_effort.",
  },

  // ─── DeepSeek ──────────────────────────────────────────────────
  {
    kind: "deepseek",
    match: /^deepseek-v4(?:[-.]|$)/i,
    capability: {
      reasoning: { kind: "deepseek-thinking" },
      // V4 + tools requires reasoning_content echoed; non-tool turns optional.
      // Empty-string echo triggers an endpoint regression where the model
      // returns an empty content. We backfill only when thinking is ON.
      echoReasoning: "when-tools",
    },
    why: "DeepSeek V4 thinking mode — top-level thinking:{type}; echo reasoning_content when tools are present.",
  },
  {
    kind: "deepseek",
    match: /^deepseek-reasoner(?:[-.]|$)/i,
    capability: {
      reasoning: { kind: "none" },
      // Sending reasoning_content back makes deepseek-reasoner 400.
      echoReasoning: "never",
    },
    why: "deepseek-reasoner refuses prior reasoning_content in input; always-on reasoning, no toggle.",
  },

  // ─── Z.AI (GLM) ────────────────────────────────────────────────
  {
    kind: "zai",
    // GLM-4.5, 4.6, 5.1 — same `thinking:{type}` shape as DeepSeek V4.
    match: /^glm-[4-9](?:[-.]|$)/i,
    capability: {
      reasoning: { kind: "deepseek-thinking" },
      echoReasoning: "optional",
    },
    why: "Z.AI GLM-4.5+ thinking shape is identical to DeepSeek V4; default is enabled.",
  },

  // ─── Anthropic direct ─────────────────────────────────────────
  // Older Claude 4.x (≤4.5) accept explicit thinking:{type, budget_tokens}.
  // The newer 4.6+ family (Opus 4.7 included) is adaptive — sending the
  // opt-in field 400s. We check 4.6 boundary numerically below.
  {
    kind: "anthropic",
    match: /^claude-(?:opus|sonnet|haiku)-4-[6-9](?:[-.]|$)/i,
    capability: {
      reasoning: { kind: "anthropic-adaptive" },
      echoReasoning: "when-tools",
      parallelToolCalls: "anthropic-disable-flag",
      streamUsage: "auto",
    },
    why: "Claude 4.6+ thinking is adaptive — no opt-in field. Echo thinking blocks on tool turns.",
  },
  {
    kind: "anthropic",
    match: /^claude-(?:opus|sonnet|haiku)-4(?:[-.]|$)/i,
    capability: {
      reasoning: { kind: "anthropic-budget", minBudgetTokens: 1024 },
      echoReasoning: "when-tools",
      parallelToolCalls: "anthropic-disable-flag",
      streamUsage: "auto",
    },
    why: "Claude 4.x ≤4.5 supports explicit thinking:{type:enabled, budget_tokens≥1024}.",
  },
  // Catch-all for Claude 3.x and earlier — no thinking field, but still
  // needs Anthropic-shape tool_choice.
  {
    kind: "anthropic",
    match: /^claude-/i,
    capability: {
      parallelToolCalls: "anthropic-disable-flag",
      streamUsage: "auto",
    },
    why: "Pre-Claude-4 — no extended thinking; keep Anthropic tool_choice/stream shape.",
  },

  // ─── Gemini (OpenAI-compat endpoint) ───────────────────────────
  {
    kind: "google",
    // 2.5+ all support thinking; OpenAI-compat surface maps reasoning_effort
    // to thinkingConfig. Lite/flash families also accept it.
    match: /^gemini-(?:[2-9]\.\d|[2-9])/i,
    capability: {
      reasoning: { kind: "openai-effort" },
      echoReasoning: "optional",
    },
    why: "Gemini 2.5+ via OpenAI-compat — reasoning_effort is auto-mapped to thinking_level.",
  },

  // ─── OpenRouter ────────────────────────────────────────────────
  // OpenRouter normalizes everything under {reasoning: {...}}. It also
  // accepts max_tokens for every model it routes (internal mapping).
  {
    kind: "openrouter",
    match: /./, // Any model via OpenRouter
    capability: {
      reasoning: { kind: "openrouter-reasoning" },
      // OpenRouter doesn't enforce per-provider echo contracts at its edge.
      echoReasoning: "optional",
    },
    why: "OpenRouter exposes a unified reasoning:{effort,max_tokens,exclude,enabled} field for every backend.",
  },

  // ─── xAI Grok ──────────────────────────────────────────────────
  {
    kind: "xai",
    // grok-4.3 has reasoning_effort: none|low|medium|high (no "minimal").
    // Send "low" when the caller asks to disable — xAI rejects "minimal" 400.
    match: /^grok-4\.3(?:[-.]|$)/i,
    capability: {
      reasoning: { kind: "openai-effort", disabledEffort: "low" },
    },
    why: "xAI grok-4.3 supports reasoning_effort none|low|medium|high — no `minimal`.",
  },

  // ─── Mistral ───────────────────────────────────────────────────
  {
    kind: "mistral",
    // Magistral series exposes reasoning_effort: high|none — no minimal/low/medium.
    match: /^magistral/i,
    capability: {
      reasoning: { kind: "openai-effort", disabledEffort: "none" },
    },
    why: "Mistral magistral models accept only reasoning_effort `high` or `none`.",
  },

  // ─── Groq ──────────────────────────────────────────────────────
  {
    kind: "groq",
    match: /^(?:gpt-oss-(?:20b|120b)|qwen3-)/i,
    capability: {
      reasoning: { kind: "openai-effort" },
      // Groq uses max_completion_tokens canonically (max_tokens is a
      // deprecated alias). Safe to pin to the new field.
      tokenLimitField: "max_completion_tokens",
    },
    why: "Groq reasoning-capable models use max_completion_tokens + reasoning_effort.",
  },
];
