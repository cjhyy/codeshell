/**
 * Arena model presets — known models with their max output token limits.
 *
 * Used by arena participant resolution to set appropriate maxTokens
 * so that LLM output is not prematurely truncated.
 */

export interface ModelPreset {
  provider: string;
  model: string;
  maxOutputTokens: number;
}

export const MODEL_PRESETS: Record<string, ModelPreset> = {
  claude: { provider: "openai", model: "anthropic/claude-opus-4.6", maxOutputTokens: 32000 },
  "claude-sonnet": { provider: "openai", model: "anthropic/claude-sonnet-4.6", maxOutputTokens: 16000 },
  "claude-haiku": { provider: "openai", model: "anthropic/claude-haiku-4.5", maxOutputTokens: 8192 },
  gpt: { provider: "openai", model: "openai/gpt-5.4", maxOutputTokens: 32000 },
  "gpt4o": { provider: "openai", model: "openai/gpt-4o", maxOutputTokens: 16384 },
  o4: { provider: "openai", model: "openai/o4-mini", maxOutputTokens: 100000 },
  o3: { provider: "openai", model: "openai/o3", maxOutputTokens: 100000 },
  deepseek: { provider: "openai", model: "deepseek/deepseek-v3.2", maxOutputTokens: 8192 },
  "deepseek-r1": { provider: "openai", model: "deepseek/deepseek-r1", maxOutputTokens: 8192 },
  gemini: { provider: "openai", model: "google/gemini-3.1-pro-preview", maxOutputTokens: 65536 },
  "gemini-2.5": { provider: "openai", model: "google/gemini-2.5-pro", maxOutputTokens: 65536 },
  "gemini-flash": { provider: "openai", model: "google/gemini-3-flash-preview", maxOutputTokens: 65536 },
  qwen: { provider: "openai", model: "qwen/qwen3-235b-a22b", maxOutputTokens: 8192 },
  "qwen-coder": { provider: "openai", model: "qwen/qwen3-coder", maxOutputTokens: 16384 },
  llama: { provider: "openai", model: "meta-llama/llama-4-maverick", maxOutputTokens: 32000 },
  devstral: { provider: "openai", model: "mistralai/devstral-medium", maxOutputTokens: 24000 },
};

/** Look up max output tokens for a model string, falling back to a safe default. */
export function getMaxOutputTokens(model: string): number {
  // Check by preset key first
  const byKey = MODEL_PRESETS[model];
  if (byKey) return byKey.maxOutputTokens;

  // Check by full model path
  const byModel = Object.values(MODEL_PRESETS).find((p) => p.model === model);
  return byModel?.maxOutputTokens ?? 8192;
}
