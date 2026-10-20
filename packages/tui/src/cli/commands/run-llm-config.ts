import type { LLMConfig } from "@cjhyy/code-shell-core";

export interface RunLlmFlags {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Apply `code-shell run` --provider/--model/--base-url/--api-key on top of the
 * catalog-resolved connection. The result is an explicit config with no
 * ModelPool binding: a `modelKey` would make the session Engine re-resolve the
 * saved connection at the next run boundary and silently drop the flags.
 */
export function applyRunLlmOverrides(base: LLMConfig, flags: RunLlmFlags): LLMConfig {
  const { provider, model, baseUrl, apiKey } = flags;
  if (!provider && !model && !baseUrl && !apiKey) return base;
  const { modelKey: _modelKey, ...llm } = base;
  if (model) {
    // Limits and capabilities of the saved model don't describe another model.
    delete llm.maxTokens;
    delete llm.maxContextTokens;
    delete llm.supportsVision;
    delete llm.reasoning;
    llm.model = model;
  }
  if (provider) llm.provider = provider;
  if (baseUrl) llm.baseUrl = baseUrl;
  if (apiKey) llm.apiKey = apiKey;
  return llm;
}
