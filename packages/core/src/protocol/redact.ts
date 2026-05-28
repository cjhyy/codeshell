import { redactSecrets } from "../logging/sanitize-messages.js";

/**
 * Redaction helpers for protocol query responses.
 *
 * The protocol exposes config snapshots to any connected client. Raw API keys,
 * provider credentials, and authorization headers must never leave this
 * boundary verbatim — the client can use derived fields (`hasApiKey`,
 * `apiKeyPreview`) to render provider/model status without holding the secret.
 *
 * Two entry points:
 *   - redactConfigForResponse: rewrites the LLM section of the config-query
 *     payload, removing `apiKey` and adding derived presence/preview fields.
 *   - maskSecretValue: scrubs a single (key, value) pair returned by
 *     config_get, where the client picks the key — including `llm.apiKey`.
 */

/** Match dotted/camel/snake variants of obviously secret keys. */
const SECRET_KEY_RE =
  /(^|[._-])(api[_-]?key|authorization|x[_-]api[_-]key|bearer[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|client[_-]?secret)($|[._-])/i;

/** Produce a short preview (`sk-…abcd`) so UIs can render presence without revealing the secret. */
export function makeApiKeyPreview(apiKey: string | undefined | null): string | undefined {
  if (typeof apiKey !== "string" || apiKey.length === 0) return undefined;
  if (apiKey.length <= 8) return "…";
  return `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`;
}

/**
 * Return true when a dotted setting key path points at a secret field.
 * Used to decide whether `config_get`'s response should redact the value.
 */
export function isSecretKeyPath(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * Redact a single value returned by config_get.
 *
 * Two-stage rule:
 *   1. If the caller-supplied key path itself looks secret
 *      ("llm.apiKey", "headers.authorization", …) → collapse to "[redacted]".
 *   2. Otherwise, if the value is an object/array (e.g. config_get("llm") or
 *      config_get("providers")), walk it with the shared secret redactor
 *      from logging/sanitize-messages so nested apiKey / token / Bearer
 *      fields don't slip through verbatim. Primitives pass unchanged.
 *
 * Pre-fix this only inspected the top-level key string, so
 * config_get("providers") returned an array of provider objects with raw
 * apiKey values intact. That defeated the purpose of the boundary.
 */
export function maskSecretValue<T>(key: string, value: T): T | "[redacted]" {
  if (isSecretKeyPath(key)) return "[redacted]";
  if (value && typeof value === "object") {
    return redactSecrets(value) as T;
  }
  return value;
}

/**
 * Shape of the LLM block returned to clients. We deliberately omit `apiKey`
 * and surface presence/preview instead. Callers that need the raw key already
 * have it server-side; clients should never see it.
 */
export interface RedactedLlmConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  enableStreaming?: boolean;
  /** True when an apiKey is configured. */
  hasApiKey: boolean;
  /** Short preview when an apiKey is configured; omitted otherwise. */
  apiKeyPreview?: string;
}

/**
 * Rewrite the LLM section of a config snapshot for transport. We only forward
 * fields the client legitimately needs to render status; secrets become
 * derived flags.
 */
export function redactLlmConfig(llm: {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  enableStreaming?: boolean;
}): RedactedLlmConfig {
  const preview = makeApiKeyPreview(llm.apiKey);
  return {
    provider: llm.provider,
    model: llm.model,
    baseUrl: llm.baseUrl,
    temperature: llm.temperature,
    maxTokens: llm.maxTokens,
    enableStreaming: llm.enableStreaming,
    hasApiKey: typeof llm.apiKey === "string" && llm.apiKey.length > 0,
    ...(preview ? { apiKeyPreview: preview } : {}),
  };
}
