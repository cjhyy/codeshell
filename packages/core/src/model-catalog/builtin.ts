/**
 * Built-in model catalog (source A) — the official provider templates shipped
 * with the app. Migrated from the renderer's hardcoded ProviderMeta[] arrays
 * (ImageGenConnectionsPanel / VideoGenConnectionsPanel) and enriched with
 * `paramsDoc` + `shape`. See docs/superpowers/specs/2026-06-11-model-catalog-design.md.
 *
 * Adding a same-shaped provider = add a CatalogEntry here (or a user entry in
 * ~/.code-shell/model-catalog.user.json) — no UI / adapter changes, as long as
 * its adapterKind points at an already-wired adapter.
 */

import type { CatalogEntry, ModelPreset, ParamSpec } from "./types.js";
import type { ProviderKindName } from "../llm/provider-kinds.js";
import { capabilitiesFor } from "../llm/capabilities/index.js";
import { paramSpecsFromCapability } from "../llm/capabilities/param-specs.js";

/**
 * Build a text model preset, projecting its params from the capability layer
 * (rules.ts) so reasoning knobs aren't re-hand-written. `params` is omitted
 * when the model has none, matching the "absent → no knobs" contract.
 */
function textPreset(
  kind: ProviderKindName,
  value: string,
  label?: string,
  ctx?: number,
): ModelPreset {
  const capability = capabilitiesFor(kind, value);
  const params = paramSpecsFromCapability(kind, value);
  return {
    value,
    ...(label ? { label } : {}),
    ...(ctx !== undefined ? { maxContextTokens: ctx } : {}),
    supportsVision: capability.supportsVision,
    ...(params.length > 0 ? { params } : {}),
  };
}

/**
 * OpenRouter normalizes reasoning to a unified effort enum across providers
 * (xhigh|high|medium|low|minimal|none). We write OpenRouter presets' params
 * EXPLICITLY (not via paramSpecsFromCapability) because the capability layer's
 * OpenRouter catch-all would slap reasoning onto *every* model — including ones
 * that don't support it. A reasoning OpenRouter preset opts in by listing this.
 */
const OPENROUTER_REASONING: ParamSpec = {
  name: "reasoning",
  label: "思考强度",
  control: "enum",
  options: ["minimal", "low", "medium", "high", "xhigh"],
  default: "medium",
  doc: "Reasoning effort — how hard the model thinks before answering.",
  wire: { field: "reasoning.effort" },
};

/**
 * Zhipu GLM params (OpenAI-compatible endpoint, but with GLM-specific wire
 * fields). Promoted from the user catalog after live-verifying glm-5.2 / 5.1 /
 * 5 / 5-turbo / 4.7 / 4.6 against open.bigmodel.cn (2026-06-23). Written
 * explicitly because the capability layer has no GLM rules.
 */
const ZHIPU_PARAMS: ParamSpec[] = [
  {
    name: "reasoning_effort",
    label: "推理强度",
    control: "enum",
    options: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
    default: "max",
    doc: "控制模型推理程度；thinking 开启时生效。GLM-5.2 支持，none/minimal 放弃思考，low/medium 映射为 high，xhigh 映射为 max。",
    wire: { field: "reasoning_effort" },
  },
  {
    name: "thinking_type",
    label: "思维链",
    control: "enum",
    options: ["enabled", "disabled"],
    default: "enabled",
    doc: "控制是否开启思维链；GLM-5.2 开启后为强制思考。",
    wire: { field: "thinking.type" },
  },
  {
    name: "temperature",
    label: "Temperature",
    control: "number",
    min: 0,
    max: 1,
    default: 1,
    doc: "采样温度，控制输出随机性，范围 0.0 到 1.0。",
    wire: { field: "temperature" },
  },
  {
    name: "top_p",
    label: "Top P",
    control: "number",
    min: 0.01,
    max: 1,
    default: 0.95,
    doc: "核采样参数，范围 0.01 到 1.0；官方建议不要与 temperature 同时调整。",
    wire: { field: "top_p" },
  },
  {
    name: "max_tokens",
    label: "最大输出 Tokens",
    control: "number",
    min: 1,
    max: 131072,
    default: 4096,
    doc: "模型输出最大 token 数量，GLM-5.2 最大 131072。",
    wire: { field: "max_tokens" },
  },
];

/** Zhipu GLM preset — shared ZHIPU_PARAMS, with per-model context window. */
function glmPreset(value: string, label: string, ctx: number): ModelPreset {
  return { value, label, maxContextTokens: ctx, supportsVision: false, params: ZHIPU_PARAMS };
}

/** OpenRouter preset with explicit params (no capability-layer projection). */
function orPreset(value: string, label: string, params?: ParamSpec[], ctx?: number): ModelPreset {
  const capability = capabilitiesFor("openrouter", value);
  return {
    value,
    label,
    ...(ctx !== undefined ? { maxContextTokens: ctx } : {}),
    supportsVision: capability.supportsVision,
    ...(params && params.length > 0 ? { params } : {}),
  };
}

export const BUILTIN_CATALOG: CatalogEntry[] = [
  // ─── text (LLM) ───
  {
    id: "openai",
    tag: "text",
    adapterKind: "openai",
    protocol: "openai-compat",
    displayName: "OpenAI",
    description: "OpenAI chat models (GPT-5 系列、GPT-4o 等)。需要 OpenAI key。",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.5",
    signupUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
    // Verified live (2026-06-23) against this account's key: gpt-5.5 / 5.4 /
    // 5.4-mini returned text; o4-mini reachable; o3 reachable (slow). New OpenAI
    // models reject `max_tokens` — must use `max_completion_tokens` (handled by
    // the client). gpt-5.5-pro is 404 on /chat/completions (not a chat model).
    modelPresets: [
      textPreset("openai", "gpt-5.5", "GPT-5.5", 1_050_000),
      textPreset("openai", "gpt-5.4", "GPT-5.4", 1_050_000),
      textPreset("openai", "gpt-5.4-mini", "GPT-5.4 Mini", 400_000),
      textPreset("openai", "gpt-5.4-nano", "GPT-5.4 Nano", 400_000),
      textPreset("openai", "o4-mini", "o4-mini", 200_000),
      textPreset("openai", "o3", "o3", 200_000),
      textPreset("openai", "gpt-4o", "GPT-4o", 128_000),
      textPreset("openai", "gpt-4o-mini", "GPT-4o mini", 128_000),
    ],
  },
  {
    id: "anthropic",
    tag: "text",
    adapterKind: "anthropic",
    protocol: "anthropic-style",
    displayName: "Anthropic",
    description: "Claude 模型(Opus / Sonnet / Haiku)。需要 Anthropic key。",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-opus-4-8",
    signupUrl: "https://console.anthropic.com/settings/keys",
    needsKey: true,
    modelPresets: [
      textPreset("anthropic", "claude-opus-4-8", "Claude Opus 4.8", 1_000_000),
      textPreset("anthropic", "claude-opus-4-7", "Claude Opus 4.7", 1_000_000),
      textPreset("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000),
      textPreset("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", 200_000),
    ],
  },
  {
    id: "openrouter",
    tag: "text",
    adapterKind: "openrouter",
    protocol: "openai-compat",
    displayName: "OpenRouter",
    description: "通过 OpenRouter 路由多家模型;统一 reasoning 配置。需要 OpenRouter key。",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "~anthropic/claude-opus-latest",
    signupUrl: "https://openrouter.ai/keys",
    needsKey: true,
    // Two kinds of entries per family:
    //  - "~vendor/model-latest" router aliases — OpenRouter resolves them
    //    server-side to the newest version, so the slug never goes stale (vs.
    //    dated slugs like anthropic/claude-opus-4.8-20260528). Verified live
    //    2026-07-02: ~anthropic/claude-opus-latest→opus-4.8,
    //    ~anthropic/claude-sonnet-latest→sonnet-5, ~google/gemini-pro-latest→
    //    gemini-3.1-pro. (~openai/gpt-latest is NOT a real alias — it 400s —
    //    so it's dropped; pin a concrete openai slug instead.)
    //  - concrete versioned slugs — so the picker can select a SPECIFIC
    //    version (e.g. Opus 4.7-fast) instead of only "latest". Every concrete
    //    slug + context window below verified live 2026-07-02 against this
    //    account's OpenRouter key.
    // Explicit params (not capability-projected): reasoning models opt into
    // OPENROUTER_REASONING; non-reasoning ones (deepseek-chat V3, llama-4)
    // omit params — no catch-all forcing reasoning onto a model that lacks it.
    modelPresets: [
      // Anthropic (Claude) — alias + concrete versions
      orPreset("~anthropic/claude-opus-latest", "Claude Opus (latest)", [OPENROUTER_REASONING], 1_000_000),
      orPreset("~anthropic/claude-sonnet-latest", "Claude Sonnet (latest)", [OPENROUTER_REASONING], 1_000_000),
      orPreset("anthropic/claude-opus-4.8", "Claude Opus 4.8", [OPENROUTER_REASONING], 1_000_000),
      orPreset("anthropic/claude-opus-4.8-fast", "Claude Opus 4.8 (fast)", [OPENROUTER_REASONING], 1_000_000),
      orPreset("anthropic/claude-opus-4.7", "Claude Opus 4.7", [OPENROUTER_REASONING], 1_000_000),
      orPreset("anthropic/claude-opus-4.7-fast", "Claude Opus 4.7 (fast)", [OPENROUTER_REASONING], 1_000_000),
      orPreset("anthropic/claude-sonnet-5", "Claude Sonnet 5", [OPENROUTER_REASONING], 1_000_000),
      orPreset("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6", [OPENROUTER_REASONING], 1_000_000),
      orPreset("anthropic/claude-fable-5", "Claude Fable 5", [OPENROUTER_REASONING], 1_000_000),
      // OpenAI (GPT) — concrete only (no working ~latest alias). Led by 5.5 to
      // match the direct-OpenAI default (state.json model = gpt-5.5).
      orPreset("openai/gpt-5.5", "GPT-5.5", [OPENROUTER_REASONING], 1_050_000),
      orPreset("openai/gpt-5.5-pro", "GPT-5.5 Pro", [OPENROUTER_REASONING], 1_050_000),
      orPreset("openai/gpt-5.4", "GPT-5.4", [OPENROUTER_REASONING], 1_050_000),
      orPreset("openai/gpt-5.4-mini", "GPT-5.4 Mini", [OPENROUTER_REASONING], 400_000),
      orPreset("openai/gpt-5.1-codex-max", "GPT-5.1 Codex Max", [OPENROUTER_REASONING], 400_000),
      // Google (Gemini) — alias + concrete
      orPreset("~google/gemini-pro-latest", "Gemini Pro (latest)", [OPENROUTER_REASONING], 1_048_576),
      orPreset("google/gemini-3-flash-preview", "Gemini 3 Flash (preview)", [OPENROUTER_REASONING], 1_048_576),
      orPreset("google/gemini-2.5-pro", "Gemini 2.5 Pro", [OPENROUTER_REASONING], 1_048_576),
      orPreset("google/gemini-2.5-flash", "Gemini 2.5 Flash", [OPENROUTER_REASONING], 1_048_576),
      // xAI (Grok)
      orPreset("x-ai/grok-4.3", "Grok 4.3", [OPENROUTER_REASONING], 1_000_000),
      orPreset("x-ai/grok-4.20", "Grok 4.20", [OPENROUTER_REASONING], 2_000_000),
      // DeepSeek — V4 reasoning + V3 chat (non-reasoning)
      orPreset("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", [OPENROUTER_REASONING], 1_048_576),
      orPreset("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", [OPENROUTER_REASONING], 1_048_576),
      orPreset("deepseek/deepseek-chat", "DeepSeek V3 (chat)", undefined, 131_072),
      // Zhipu (GLM) — glm-5.1 (65k ctx) omitted: below the catalog's ≥100k
      // context floor; glm-5.2 (1M) and glm-5 (202k) cover the family.
      orPreset("z-ai/glm-5.2", "GLM 5.2 (Z.ai)", [OPENROUTER_REASONING], 1_048_576),
      orPreset("z-ai/glm-5", "GLM 5 (Z.ai)", [OPENROUTER_REASONING], 202_752),
      // Qwen
      orPreset("qwen/qwen3.7-max", "Qwen3.7 Max", [OPENROUTER_REASONING], 1_000_000),
      orPreset("qwen/qwen3-coder", "Qwen3 Coder", [OPENROUTER_REASONING], 262_144),
      // Meta Llama (non-reasoning)
      orPreset("meta-llama/llama-4-maverick", "Llama 4 Maverick", undefined, 1_048_576),
      orPreset("meta-llama/llama-4-scout", "Llama 4 Scout", undefined, 327_680),
    ],
  },
  {
    id: "deepseek",
    tag: "text",
    adapterKind: "deepseek",
    protocol: "openai-compat",
    displayName: "DeepSeek",
    description: "DeepSeek 模型。需要 DeepSeek key。",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-flash",
    signupUrl: "https://platform.deepseek.com/api_keys",
    needsKey: true,
    modelPresets: [
      textPreset("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000),
      textPreset("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000),
    ],
  },
  {
    id: "zhipu",
    tag: "text",
    adapterKind: "openai",
    protocol: "openai-compat",
    displayName: "Zhipu GLM",
    description: "智谱 GLM 系列(OpenAI 兼容端点)。适合 Coding Agent 与长上下文任务。需要智谱 key。",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.2",
    signupUrl: "https://open.bigmodel.cn/",
    needsKey: true,
    // All slugs verified live (2026-06-23) against open.bigmodel.cn: glm-5.2 /
    // 5.1 / 5 / 5-turbo / 4.7 / 4.6 each returned a successful chat completion.
    modelPresets: [
      glmPreset("glm-5.2", "GLM-5.2", 1_000_000),
      glmPreset("glm-5.1", "GLM-5.1", 1_000_000),
      glmPreset("glm-5", "GLM-5", 1_000_000),
      glmPreset("glm-5-turbo", "GLM-5 Turbo", 1_000_000),
      glmPreset("glm-4.7", "GLM-4.7", 200_000),
      glmPreset("glm-4.6", "GLM-4.6", 200_000),
    ],
  },
  {
    id: "google",
    tag: "text",
    adapterKind: "google",
    protocol: "openai-compat",
    displayName: "Google Gemini",
    description: "Gemini 文本模型(OpenAI-compat 端点)。需要 Google key。",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.5-flash",
    signupUrl: "https://aistudio.google.com/apikey",
    needsKey: true,
    modelPresets: [
      textPreset("google", "gemini-3.5-flash", "Gemini 3.5 Flash", 1_048_576),
      textPreset("google", "gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1_048_576),
      textPreset("google", "gemini-2.5-pro", "Gemini 2.5 Pro", 1_048_576),
      textPreset("google", "gemini-2.5-flash", "Gemini 2.5 Flash", 1_048_576),
    ],
  },
  {
    id: "ollama",
    tag: "text",
    adapterKind: "ollama",
    protocol: "openai-compat",
    displayName: "Ollama",
    description: "本地 Ollama 模型,无需 key。",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    needsKey: false,
    modelPresets: [
      textPreset("ollama", "llama3.1", "Llama 3.1"),
      textPreset("ollama", "qwen2.5-coder", "Qwen Coder"),
      textPreset("ollama", "deepseek-r1", "DeepSeek R1"),
    ],
  },
  {
    id: "custom",
    tag: "text",
    adapterKind: "openai",
    protocol: "openai-compat",
    displayName: "Custom (OpenAI-compatible)",
    description: "任意 OpenAI 兼容端点;baseUrl/model 由连接自带。",
    defaultBaseUrl: "",
    needsKey: true,
    modelPresets: [],
  },
  // ─── image ───
  {
    id: "openai-images",
    tag: "image",
    adapterKind: "openai",
    shape: "generic-sync",
    displayName: "OpenAI Images (gpt-image)",
    description: "OpenAI 图像 API。需要 OpenAI key；baseUrl 默认官方端点。",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-image-2",
    // Live-verified 2026-07-02 against this account's OpenAI key (GET /v1/models):
    // gpt-image-2 (current), gpt-image-1.5, gpt-image-1, gpt-image-1-mini.
    modelPresets: [
      { value: "gpt-image-2", label: "GPT Image 2" },
      { value: "gpt-image-1.5", label: "GPT Image 1.5" },
      { value: "gpt-image-1", label: "GPT Image 1" },
      { value: "gpt-image-1-mini", label: "GPT Image 1 mini" },
    ],
    signupUrl: "https://platform.openai.com/api-keys",
    test: true,
    paramsDoc:
      "OpenAI 图像：支持 size (1024x1024 | 1536x1024 | 1024x1536 | auto)、quality (low | medium | high | auto)。" +
      "支持图生图:传 referenceImages(工作区图片路径,最多 16 张)即按这些图编辑/再创作(走 /images/edits)。",
  },
  {
    id: "google-images",
    tag: "image",
    adapterKind: "google",
    shape: "generic-sync",
    displayName: "Gemini Images (Nano Banana)",
    description:
      "Gemini 图像生成。可直接用你已有的 Google key；OpenAI 兼容 baseUrl（/v1beta/openai）也会被自动规范到原生端点。",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3.1-flash-image",
    modelPresets: [
      { value: "gemini-3.1-flash-image", label: "Nano Banana 2 (3.1)" },
      { value: "gemini-2.5-flash-image", label: "Nano Banana (2.5)" },
    ],
    signupUrl: "https://aistudio.google.com/apikey",
    test: true,
    paramsDoc:
      "Gemini 图像 (Nano Banana)：size 会被映射到最接近的支持比例;quality 参数对该后端无效(忽略)。" +
      "支持图生图/多图融合:传 referenceImages(工作区图片路径)作为参考图一起喂给模型。",
  },
  // ─── video ───
  {
    id: "fal-video",
    tag: "video",
    adapterKind: "fal",
    shape: "fal-queue",
    displayName: "fal.ai (Kling / 即梦 Seedance 等)",
    description:
      "通过 fal.ai 统一 API 调用 Kling、即梦(Seedance,字节同源)等视频模型。需要 fal key；" +
      "「默认模型」决定底层模型与文生/图生(传图自动切图生)。即梦 = fal 上的 bytedance/seedance 模型,选它即可。",
    defaultBaseUrl: "https://queue.fal.run",
    defaultModel: "fal-ai/kling-video/v3/pro/text-to-video",
    signupUrl: "https://fal.ai/dashboard/keys",
    test: false,
    modelPresets: [
      { value: "bytedance/seedance-2.0/text-to-video", label: "即梦 Seedance 2.0 · 文生视频" },
      { value: "bytedance/seedance-2.0/image-to-video", label: "即梦 Seedance 2.0 · 图生视频" },
      { value: "fal-ai/kling-video/v3/pro/text-to-video", label: "Kling v3 Pro · 文生视频" },
      { value: "fal-ai/kling-video/v3/pro/image-to-video", label: "Kling v3 Pro · 图生视频" },
    ],
    paramsDoc:
      "fal 视频:用 model 选底层模型(文生 vs 图生)。传 image/images(本地路径自动上传)→ 用图生视频模型;1 张=图生视频,2+ 张=参考生视频(最多 9,prompt 里用 @Image1/@Image2 引用)。" +
      "续接/参考视频:传 videos(http/https URL,非本地路径;最多 3)续接已有视频,prompt 里用 @Video1/@Video2 引用(如「从 @Video1 结尾继续」);需用 Seedance 模型(走 reference-to-video,Kling 不支持)。异步后台生成。",
  },
  // ─── audio (speech-to-text / 语音输入听写) ───
  {
    id: "openai-transcribe",
    tag: "audio",
    adapterKind: "openai",
    shape: "generic-sync",
    displayName: "OpenAI 语音转写 (Whisper / gpt-4o-transcribe)",
    description: "OpenAI 兼容 /audio/transcriptions,用于语音输入听写。可复用 OpenAI key。",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-transcribe",
    signupUrl: "https://platform.openai.com/api-keys",
    test: false,
    modelPresets: [
      { value: "gpt-4o-transcribe", label: "gpt-4o-transcribe" },
      { value: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe" },
      { value: "whisper-1", label: "Whisper (whisper-1)" },
    ],
    paramsDoc: "语音转写:录音(webm/opus)→ 文字,填进输入框。换 baseUrl+model 可指向 Groq/本地 whisper.cpp。",
  },
  {
    id: "groq-transcribe",
    tag: "audio",
    adapterKind: "openai",
    shape: "generic-sync",
    displayName: "Groq 语音转写 (whisper-large-v3-turbo)",
    description: "Groq 的 OpenAI 兼容 /audio/transcriptions,极快且便宜。需要 Groq key。",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3-turbo",
    signupUrl: "https://console.groq.com/keys",
    test: false,
    modelPresets: [
      { value: "whisper-large-v3-turbo", label: "whisper-large-v3-turbo" },
      { value: "whisper-large-v3", label: "whisper-large-v3" },
    ],
    paramsDoc: "语音转写(Groq):同 OpenAI /audio/transcriptions 形状,换 baseUrl+model。",
  },
];
