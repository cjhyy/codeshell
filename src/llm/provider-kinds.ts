/**
 * Built-in provider kind metadata.
 *
 * Each kind defines how to talk to that provider family: where its
 * model list lives, what auth header to send, which model IDs to keep
 * (chat-completion only — embeddings / TTS / image generation are
 * filtered out so they don't show up in the model picker).
 */

export type ProviderKindName =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "xai"
  | "mistral"
  | "groq"
  | "google"
  | "openrouter"
  | "ollama"
  | "custom";

export type ProviderProtocol = "openai-compat" | "anthropic-style" | "gemini" | "ollama";

export interface ProviderKindMeta {
  label: string;
  defaultBaseUrl: string;
  modelsPath: string;
  protocol: ProviderProtocol;
  authHeader: (apiKey: string) => Record<string, string>;
  chatFilter: (id: string) => boolean;
  authQuery?: (apiKey: string) => Record<string, string>;
}

const NON_CHAT_PATTERNS =
  /(?:^|[-_/])(?:embed(?:ding)?|whisper|tts|audio|image|dall-?e|moderation|rerank|guard|vision-only)(?:$|[-_/])/i;

const isChatLike = (id: string): boolean => !NON_CHAT_PATTERNS.test(id);

const bearer = (k: string): Record<string, string> => (k ? { Authorization: `Bearer ${k}` } : {});

export const PROVIDER_KINDS: Record<ProviderKindName, ProviderKindMeta> = {
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  anthropic: {
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    modelsPath: "/models",
    protocol: "anthropic-style",
    authHeader: (k) =>
      k
        ? { "x-api-key": k, "anthropic-version": "2023-06-01" }
        : { "anthropic-version": "2023-06-01" },
    chatFilter: isChatLike,
  },
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  xai: {
    label: "xAI (Grok)",
    defaultBaseUrl: "https://api.x.ai/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  mistral: {
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  groq: {
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  google: {
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelsPath: "/models",
    protocol: "gemini",
    authHeader: () => ({}),
    authQuery: (k) => (k ? { key: k } : {}),
    chatFilter: (id) => isChatLike(id) && /gemini/i.test(id),
  },
  openrouter: {
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  ollama: {
    label: "Ollama (local)",
    defaultBaseUrl: "http://localhost:11434",
    modelsPath: "/api/tags",
    protocol: "ollama",
    authHeader: () => ({}),
    chatFilter: isChatLike,
  },
  custom: {
    label: "Custom",
    defaultBaseUrl: "",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
};

export function getKindMeta(kind: string): ProviderKindMeta {
  return (PROVIDER_KINDS as Record<string, ProviderKindMeta>)[kind] ?? PROVIDER_KINDS.custom;
}
