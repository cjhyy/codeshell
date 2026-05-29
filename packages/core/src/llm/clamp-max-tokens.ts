/**
 * Clamp a requested max-output-tokens value to a model's known output cap.
 *
 * Background: model-pool copies a catalog `maxOutputTokens` straight into
 * LLMConfig.maxTokens. For some OpenRouter/DeepSeek entries that value is huge
 * (e.g. 384000) and bleeds onto a model with a much smaller cap after a hot
 * switch, producing `max_tokens is too large` 400s. When the capability layer
 * knows the model's real ceiling we clamp to it; when it doesn't we pass the
 * value through (or omit it entirely when there is no request value).
 */
export function clampMaxTokens(
  requested: number | undefined,
  cap: number | undefined,
): number | undefined {
  if (requested === undefined) return undefined;
  if (cap === undefined) return requested;
  return Math.min(requested, cap);
}
