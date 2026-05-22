/**
 * LLM provider factory with registry pattern.
 */

import type { LLMConfig } from "../types.js";
import type { LLMClientBase } from "./client-base.js";
import { LLMError } from "../exceptions.js";

type ProviderConstructor = new (config: LLMConfig) => LLMClientBase;

const PROVIDER_REGISTRY = new Map<string, ProviderConstructor>();

export function registerProvider(name: string, cls: ProviderConstructor): void {
  PROVIDER_REGISTRY.set(name, cls);
}

export async function createLLMClient(config: LLMConfig): Promise<LLMClientBase> {
  let Cls = PROVIDER_REGISTRY.get(config.provider);

  if (!Cls) {
    // Auto-register built-in providers on first use
    if (config.provider === "anthropic") {
      const { AnthropicClient } = await import("./providers/anthropic.js");
      registerProvider("anthropic", AnthropicClient);
      Cls = AnthropicClient;
    } else if (config.provider === "openai") {
      const { OpenAIClient } = await import("./providers/openai.js");
      registerProvider("openai", OpenAIClient);
      Cls = OpenAIClient;
    }
  }

  if (!Cls) {
    throw new LLMError(
      `Unknown LLM provider: ${config.provider}. Available: ${[...PROVIDER_REGISTRY.keys()].join(", ")}`,
    );
  }

  return new Cls(config);
}

export { PROVIDER_REGISTRY };
