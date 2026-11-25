import { useSyncExternalStore } from "react";

/** Pierre themes that ship with the library; both follow our light/dark class. */
export const PIERRE_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

/** Row metrics shared by file and diff views, matching our 12px monospace text. */
export const PIERRE_METRICS = { lineHeight: 20 } as const;

/** Keep Pierre's code font aligned with the rest of the renderer. */
export const PIERRE_UNSAFE_CSS = `
:host {
  --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
}
`;

function subscribeDarkClass(onChange: () => void): () => void {
  if (
    typeof MutationObserver === "undefined" ||
    typeof document === "undefined" ||
    !document.documentElement
  )
    return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function readDarkClass(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement?.classList?.contains("dark") ?? false;
}

/** The renderer's resolved theme lives on `<html class="dark">` (see theme.ts). */
export function useDarkClass(): boolean {
  return useSyncExternalStore(subscribeDarkClass, readDarkClass, () => false);
}

/** Display name Pierre uses for its header and language inference. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
