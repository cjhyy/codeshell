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

import type { CatalogEntry } from "./types.js";

export const BUILTIN_CATALOG: CatalogEntry[] = [
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
      "OpenAI 图像：支持 size (1024x1024 | 1536x1024 | 1024x1536 | auto)、quality (low | medium | high | auto)。文生图,不支持图生图/参考图。",
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
      "Gemini 图像 (Nano Banana)：size 会被映射到最接近的支持比例;quality 参数对该后端无效(忽略)。文生图。",
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
      "fal 视频:用 model 选底层模型(文生 vs 图生)。传 image/images(本地路径自动上传)→ 用图生视频模型;1 张=图生视频,2+ 张=参考生视频(最多 9,prompt 里用 @Image1/@Image2 引用)。异步后台生成。",
  },
];
