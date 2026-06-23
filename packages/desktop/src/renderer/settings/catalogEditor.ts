/**
 * Pure logic helpers for the manual catalog entry editor.
 * No side-effects, no IPC — safe to unit-test in bun directly.
 */
import type { CatalogEntry } from "../../preload/types";

export type CatalogEntryOrigin = "builtin" | "user" | "user-override-of-builtin";

/** Adapter kinds the engine knows about (mirror of core's switch). adapterKind
 *  stays typed `string` on CatalogEntry — this list only seeds the dropdown. */
export const ADAPTER_KINDS = [
  "openai",
  "anthropic",
  "deepseek",
  "zai",
  "xai",
  "mistral",
  "groq",
  "google",
  "openrouter",
  "ollama",
  "custom",
] as const;

/** Fresh minimal entry for "新建 provider". id/displayName/baseUrl filled by user. */
export function blankCatalogEntry(tag: CatalogEntry["tag"]): CatalogEntry {
  return {
    id: "",
    tag,
    adapterKind: "openai",
    protocol: "openai-compat",
    displayName: "",
    description: "",
    defaultBaseUrl: "",
    needsKey: true,
    modelPresets: [],
  };
}

/** Which destructive button an entry shows, based on its origin. */
export function deleteAction(origin: CatalogEntryOrigin): "delete" | "reset" | "none" {
  if (origin === "user") return "delete";
  if (origin === "user-override-of-builtin") return "reset";
  return "none";
}

/**
 * Required-field check for instant UI feedback (zod runs server-side on save).
 * Returns the *field name tokens* of the missing fields (not human strings) so
 * the calling component can map them to localized labels via t() — this module
 * stays pure and i18n-free (no circular dep on the renderer's t).
 */
export function validateEntry(e: CatalogEntry): string[] {
  const missing: string[] = [];
  if (!e.id?.trim()) missing.push("id");
  if (!e.displayName?.trim()) missing.push("displayName");
  if (!e.defaultBaseUrl?.trim()) missing.push("defaultBaseUrl");
  if (!e.adapterKind?.trim()) missing.push("adapterKind");
  return missing;
}
