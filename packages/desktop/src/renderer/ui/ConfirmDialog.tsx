/**
 * Back-compat shim. The confirm/alert/prompt dialogs were unified into
 * ./DialogProvider (shadcn-based). This file keeps the original public
 * surface — `useConfirm`, `ConfirmOptions`, `truncateTitle` — so existing
 * call sites don't need to change their imports. New code should import the
 * hooks (useConfirm/useAlert/usePrompt) directly from ./DialogProvider.
 */
export { useConfirm } from "./DialogProvider";
export type { ConfirmDialogOptions as ConfirmOptions } from "./dialogState";

/**
 * Truncate a free-form title so it fits in a dialog headline.
 * Cuts on grapheme-like boundary (chars), keeps ASCII-safe.
 */
export function truncateTitle(input: string, max = 28): string {
  const t = input.trim().replace(/\s+/g, " ");
  if ([...t].length <= max) return t;
  return [...t].slice(0, max).join("") + "…";
}
