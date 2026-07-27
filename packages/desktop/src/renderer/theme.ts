import { DEFAULT_PACK_ID, THEME_PACKS, type ThemePack } from "./theme-packs";
import { refreshInstalledThemes, resolveThemePack } from "./installedThemes";

export type Theme = "light" | "dark" | "system";

const KEY = "codeshell.theme";
const PACK_KEY = "codeshell.theme-pack";
/** id of the managed <style> holding the active pack's variable overrides. */
const PACK_STYLE_ID = "cs-theme-pack";

export function loadTheme(): Theme {
  const raw = localStorage.getItem(KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

export function saveTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
}

export function applyTheme(t: Theme): void {
  const resolved =
    t === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : t;
  // shadcn/Tailwind reads dark mode from a `.dark` class (see tailwind.css).
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function loadThemePackId(): string {
  // Tolerate environments without Storage (SSR / mini-DOM component tests).
  let raw: string | null = null;
  try {
    raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PACK_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return DEFAULT_PACK_ID;
  // Accept a builtin id, or any id resolveThemePack can satisfy (installed).
  if (THEME_PACKS.some((pack) => pack.id === raw)) return raw;
  return resolveThemePack(raw).id === raw ? raw : DEFAULT_PACK_ID;
}

export function saveThemePackId(id: string): void {
  localStorage.setItem(PACK_KEY, id);
}

function renderVars(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
}

/**
 * Apply a theme pack by rewriting a managed <style> that overrides the base
 * `--cs-*` variables for both modes. The rules mirror the base sheet's
 * :root / .dark selectors and are appended after it, so equal-specificity
 * overrides win while the `.dark` class keeps deciding the active mode. The
 * default pack overrides nothing, writing empty rules (= the base palette).
 */
export function applyThemePack(
  id: string,
  resolvePack: (id: string) => ThemePack = resolveThemePack,
): void {
  const pack = resolvePack(id);
  let style = document.getElementById(PACK_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("id", PACK_STYLE_ID);
    document.head.appendChild(style);
  }
  const light = renderVars({ ...pack.colors.light, ...wallpaperVars(pack, "light") });
  const dark = renderVars({ ...pack.colors.dark, ...wallpaperVars(pack, "dark") });
  const next = `:root {\n${light}\n}\n.dark {\n${dark}\n}\n`;
  // No-op when nothing changed. A cross-window `storage` event re-applies the
  // same pack in every window; rewriting identical CSS would still trigger a
  // style recalc/repaint (visible flicker in a window mid-animation).
  if (style.textContent === next) return;
  style.textContent = next;
}

/**
 * Wallpaper CSS variables for a mode. `--cs-wallpaper` is a CSS `image` value
 * (`url("…")` or `none`) consumed by the body's fixed `::before` layer (see
 * tailwind.css); `--cs-wallpaper-opacity` blends it over the base color. Absent
 * wallpaper writes `none`/`0` so the default pack cleanly clears any prior image.
 */
function wallpaperVars(pack: ThemePack, mode: "light" | "dark"): Record<string, string> {
  const url = pack.wallpaper?.[mode] ?? pack.wallpaper?.light;
  if (!url) return { "--cs-wallpaper": "none", "--cs-wallpaper-opacity": "0" };
  const opacity = pack.wallpaper?.opacity;
  return {
    "--cs-wallpaper": `url("${cssUrlEscape(url)}")`,
    "--cs-wallpaper-opacity": String(typeof opacity === "number" ? opacity : 1),
  };
}

/** Escape a url for safe embedding inside a CSS url("…") token. */
function cssUrlEscape(url: string): string {
  // Backslash-escape the quote/backslash that would close the token, and strip
  // control chars (newlines, CR, and stray `)` handled by the surrounding
  // quotes) that could break out of the declaration.
  return url.replace(/["\\]/g, "\\$&").replace(/[\n\r]/g, "");
}

export function initTheme(): Theme {
  const t = loadTheme();
  applyTheme(t);
  // Apply synchronously with whatever is cached (builtin default on first paint),
  // then load installed packs and re-apply so an installed active pack lands
  // without a flash of the base palette.
  applyThemePack(loadThemePackId());
  void refreshInstalledThemes().then(() => applyThemePack(loadThemePackId()));
  if (t === "system") {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => applyTheme("system"));
  }
  // Same-origin windows (the pet popout) share this localStorage; a `storage`
  // event fires in the OTHER windows when one writes. Re-apply so switching the
  // theme or pack in the main window updates the widget window live too.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) applyTheme(loadTheme());
    else if (event.key === PACK_KEY) applyThemePack(loadThemePackId());
  });
  // A pack install/uninstall in any window refreshes the cache and re-applies.
  const shell = globalThis.window?.codeshell as
    | { onThemesChanged?: (cb: () => void) => void }
    | undefined;
  shell?.onThemesChanged?.(() => {
    void refreshInstalledThemes().then(() => applyThemePack(loadThemePackId()));
  });
  return t;
}
