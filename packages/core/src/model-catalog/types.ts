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

export const catalogEntrySchema = z.object({
  /** Template id, e.g. "openai-images" / "google-images" / "fal-video". */
  id: z.string(),
  /** Which 连接 page group this lands in. (audio reserved, not built this version.) */
  tag: z.enum(["image", "video", "audio"]),
  /** Runtime adapter selector — reuses existing "openai" | "google" | "fal". */
  adapterKind: z.string(),
  /** HTTP shape — documentation/future only; runtime dispatches on adapterKind. */
  shape: z.enum(["generic-sync", "fal-queue"]).optional(),
  displayName: z.string(),
  description: z.string(),
  defaultBaseUrl: z.string(),
  defaultModel: z.string().optional(),
  modelPresets: z
    .array(z.object({ value: z.string(), label: z.string().optional() }))
    .optional(),
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
