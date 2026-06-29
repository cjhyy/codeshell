/**
 * Model接入 Catalog — declarative provider templates (design doc:
 * docs/superpowers/specs/2026-06-11-model-catalog-design.md).
 *
 * A {@link CatalogEntry} is a *template* the user can pick in the 连接 page to
 * create a configured instance (stored in settings.imageGen/videoGen.providers[]).
 * Catalog = "能配哪些"; providers[] = "配了哪些". The two are decoupled.
 *
 * `adapterKind` reuses the existing adapter selectors ("openai"/"google"/"fal")
 * — the runtime getImageProvider/getVideoProvider switches and adapter classes
 * are unchanged; the catalog only declares which template points at which
 * already-wired adapter. `shape` is documentation/future only.
 */

import { z } from "zod";

/**
 * How the param maps onto the outgoing request body. `field` is the request
 * field this param lands on — same param name can land differently per
 * adapter (reasoning → `reasoning_effort` on OpenAI vs
 * `thinking.budget_tokens` on Anthropic), so the divergence lives in data, not
 * in `if (kind === ...)` branches in the engine. Minimal v1: field only.
 */
export const wireSpecSchema = z.object({
  field: z.string(),
});

/**
 * One **generic** declarative param — no special-casing per param. reasoning
 * is not its own variant: it's `control: "enum"` (OpenAI effort levels) or
 * `control: "number"` (Anthropic token budget), decided by the entry's data.
 * The connection page renders by `switch(control)`; `doc` is woven into the
 * tool description so the agent knows what a configured model accepts.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §3.2.
 */
export const paramSpecSchema = z.object({
  /** Logical name, e.g. "reasoning" / "size" / "quality" / "temperature". */
  name: z.string(),
  /** UI control label (falls back to `name`). */
  label: z.string().optional(),
  control: z.enum(["enum", "number", "toggle", "text"]),
  /** control=enum allowed values, e.g. ["low","medium","high","xhigh"]. */
  options: z.array(z.string()).optional(),
  /** control=number bounds. */
  min: z.number().optional(),
  max: z.number().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Natural-language usage note → injected into the tool description. */
  doc: z.string().optional(),
  /** How this param lands on the request body. */
  wire: wireSpecSchema.optional(),
});

export type ParamSpec = z.infer<typeof paramSpecSchema>;

/**
 * A known model under an entry, carrying its own param schema
 * (per-entry-per-model — the same modelId via OpenRouter vs the official API
 * can expose different params, since gateways normalize differently).
 */
export const modelPresetSchema = z.object({
  value: z.string(),
  label: z.string().optional(),
  maxContextTokens: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  supportsVision: z.boolean().optional(),
  /** Params this model supports; absent → no adjustable knobs. */
  params: z.array(paramSpecSchema).optional(),
});

export type ModelPreset = z.infer<typeof modelPresetSchema>;

export const catalogEntrySchema = z.object({
  /** Template id, e.g. "openai" / "openai-images" / "fal-video". */
  id: z.string(),
  /** Which 连接 page group this lands in. (audio = speech-to-text / voice input.) */
  tag: z.enum(["text", "image", "video", "audio"]),
  /** Runtime adapter selector — reuses existing "openai" | "anthropic" | "google" | "fal". */
  adapterKind: z.string(),
  /** LLM client protocol (text entries). */
  protocol: z.enum(["openai-compat", "anthropic-style"]).optional(),
  /** HTTP shape — documentation/future only; runtime dispatches on adapterKind. */
  shape: z.enum(["generic-sync", "fal-queue"]).optional(),
  displayName: z.string(),
  description: z.string(),
  defaultBaseUrl: z.string(),
  defaultModel: z.string().optional(),
  /** Whether this provider needs an API key (ollama/local = false). */
  needsKey: z.boolean().optional(),
  modelPresets: z.array(modelPresetSchema).optional(),
  signupUrl: z.string().optional(),
  /** Whether the 连接 card offers a "测试" button (image=true, video=false). */
  test: z.boolean().optional(),
  /**
   * Natural-language note on the params/usage this entry supports — surfaced to
   * the agent via the dynamic GenerateImage/GenerateVideo tool description so it
   * knows what a configured model accepts (different models differ).
   */
  paramsDoc: z.string().optional(),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** A user-catalog file is just an array of entries (zod-validated on load). */
export const userCatalogFileSchema = z.array(catalogEntrySchema);
