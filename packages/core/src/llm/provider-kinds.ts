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
  | "zai"
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

// Models we want to hide from the picker — none of these speak the
// vanilla chat-completions protocol the engine uses:
//   embedding / whisper / tts / audio / image / dall-e / moderation
//   rerank / guard / vision-only      — non-text outputs
//   realtime / transcribe             — different endpoints (WS / audio)
//   search-preview / search-api       — web-search wrappers
//   sora / computer-use               — non-chat task APIs
//   deep-research                     — async research API
//   codex                             — IDE-integration specific
//   chat-latest                       — moving alias (we'd rather pin a version)
const NON_CHAT_PATTERNS =
  /(?:^|[-_/])(?:embed(?:ding)?|whisper|tts|audio|image|dall-?e|moderation|rerank|guard|vision-only|realtime|transcribe|search-preview|search-api|sora|computer-use|deep-research|codex|chat-latest)(?:$|[-_/])/i;

// User-specific fine-tuned ids look like "ft:<base>:<org>::<hash>" —
// keeping them out of the default picker; people who want them can
// add manually.
const isFineTunedId = (id: string): boolean => id.startsWith("ft:");

// "Dated snapshot" ids end with -YYYY-MM-DD. They're the immutable
// pin behind the floating alias (`gpt-5.4` ⇨ `gpt-5.4-2026-03-05`).
// Hide them by default — the floating alias covers the same model
// and avoids picker noise.
const isDatedSnapshotId = (id: string): boolean => /-\d{4}-\d{2}-\d{2}$/.test(id);

const isChatLike = (id: string): boolean =>
  !NON_CHAT_PATTERNS.test(id) && !isFineTunedId(id) && !isDatedSnapshotId(id);

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
    authHeader: (k): Record<string, string> =>
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
  zai: {
    label: "Z.AI (GLM)",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
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
    // OpenAI-compat endpoint — chat completions go to `<baseUrl>/chat/completions`.
    // For the model list we override the path to escape back to /v1beta/models,
    // which is where the native (key=...) listing lives.
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    // Absolute URL — escape the /openai segment so /models hits the
    // native listing endpoint (the OpenAI-compat /openai/models exists
    // but returns a thinner response).
    modelsPath: "https://generativelanguage.googleapis.com/v1beta/models",
    protocol: "gemini",
    authHeader: bearer,
    authQuery: (k): Record<string, string> => (k ? { key: k } : {}),
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
