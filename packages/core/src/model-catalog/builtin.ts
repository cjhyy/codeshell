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

import type { CatalogEntry, ModelPreset } from "./types.js";
import type { ProviderKindName } from "../llm/provider-kinds.js";
import { paramSpecsFromCapability } from "../llm/capabilities/param-specs.js";

/**
 * Build a text model preset, projecting its params from the capability layer
 * (rules.ts) so reasoning knobs aren't re-hand-written. `params` is omitted
 * when the model has none, matching the "absent → no knobs" contract.
 */
function textPreset(kind: ProviderKindName, value: string, label?: string): ModelPreset {
  const params = paramSpecsFromCapability(kind, value);
  return {
    value,
    ...(label ? { label } : {}),
    ...(params.length > 0 ? { params } : {}),
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
    modelPresets: [
      textPreset("openai", "gpt-5.5", "GPT-5.5"),
      textPreset("openai", "gpt-5", "GPT-5"),
      textPreset("openai", "gpt-5-mini", "GPT-5 Mini"),
      textPreset("openai", "gpt-4o", "GPT-4o"),
      textPreset("openai", "o4-mini", "o4 Mini"),
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
    defaultModel: "claude-opus-4-7",
    signupUrl: "https://console.anthropic.com/settings/keys",
    needsKey: true,
    modelPresets: [
      textPreset("anthropic", "claude-opus-4-7", "Claude Opus 4.7"),
      textPreset("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6"),
      textPreset("anthropic", "claude-opus-4-5", "Claude Opus 4.5"),
      textPreset("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5"),
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
    defaultModel: "anthropic/claude-sonnet-4.6",
    signupUrl: "https://openrouter.ai/keys",
    needsKey: true,
    modelPresets: [
      textPreset("openrouter", "anthropic/claude-sonnet-4.6", "Claude Sonnet"),
      textPreset("openrouter", "openai/gpt-5", "GPT-5"),
      textPreset("openrouter", "google/gemini-2.5-pro", "Gemini 2.5 Pro"),
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
    defaultModel: "deepseek-v4",
    signupUrl: "https://platform.deepseek.com/api_keys",
    needsKey: true,
    modelPresets: [
      textPreset("deepseek", "deepseek-v4", "DeepSeek V4"),
      textPreset("deepseek", "deepseek-chat", "DeepSeek Chat"),
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
    defaultModel: "gemini-2.5-pro",
    signupUrl: "https://aistudio.google.com/apikey",
    needsKey: true,
    modelPresets: [
      textPreset("google", "gemini-2.5-pro", "Gemini 2.5 Pro"),
      textPreset("google", "gemini-2.5-flash", "Gemini 2.5 Flash"),
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
    defaultModel: "gemini-2.5-flash-image",
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
];
