/**
 * Pure logic helpers for the manual catalog entry editor.
 * No side-effects, no IPC — safe to unit-test in bun directly.
 */
import type { CatalogEntry } from "../../preload/types";

export type CatalogEntryOrigin = "builtin" | "user" | "user-override-of-builtin";

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

/** Required-field check for instant UI feedback (zod runs server-side on save). */
export function validateEntry(e: CatalogEntry): string[] {
  const errs: string[] = [];
  if (!e.id?.trim()) errs.push("id 必填");
  if (!e.displayName?.trim()) errs.push("显示名必填");
  if (!e.defaultBaseUrl?.trim()) errs.push("baseUrl 必填");
  if (!e.adapterKind?.trim()) errs.push("adapterKind 必填");
  return errs;
}
