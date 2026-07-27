import { DEFAULT_PACK_ID, THEME_PACKS, getThemePack, type ThemeVars } from "./theme-packs";

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
  const raw = localStorage.getItem(PACK_KEY);
  return raw && THEME_PACKS.some((pack) => pack.id === raw) ? raw : DEFAULT_PACK_ID;
}

export function saveThemePackId(id: string): void {
  localStorage.setItem(PACK_KEY, id);
}

function renderVars(vars: ThemeVars): string {
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
export function applyThemePack(id: string): void {
  const pack = getThemePack(id);
  let style = document.getElementById(PACK_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("id", PACK_STYLE_ID);
    document.head.appendChild(style);
  }
  const light = renderVars(pack.colors.light);
  const dark = renderVars(pack.colors.dark);
  style.textContent = `:root {\n${light}\n}\n.dark {\n${dark}\n}\n`;
}

export function initTheme(): Theme {
  const t = loadTheme();
  applyTheme(t);
  applyThemePack(loadThemePackId());
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
  return t;
}
