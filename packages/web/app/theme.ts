/**
 * Manual light / dark / system appearance, matching Desktop's `theme.ts`
 * semantics ("system" is the default and follows `prefers-color-scheme`).
 *
 * The choice is stored per browser and applied as `data-theme` on <html>;
 * `app.css` keeps the dark palette for both the explicit attribute and the
 * system preference, so "system" needs no attribute at all.
 */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "codeshell.web.theme";
export const THEME_CHANGE_EVENT = "codeshell:theme-change";
/** Browser chrome colours, equal to `--bg` in app.css for each mode. */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#fcfcfd",
  dark: "#151517",
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined; // Storage can throw in sandboxed or privacy modes.
  }
}

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function loadThemePreference(storage = defaultStorage()): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function saveThemePreference(preference: ThemePreference, storage = defaultStorage()): void {
  try {
    if (preference === "system") storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* The choice still applies to this page; it just does not persist. */
  }
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark = systemPrefersDark(),
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/** The theme currently shown on this page (explicit choice, else the system). */
export function currentResolvedTheme(doc: Document | undefined = globalThis.document) {
  const explicit = doc?.documentElement?.dataset?.theme;
  return explicit === "light" || explicit === "dark" ? explicit : resolveTheme("system");
}

export function applyThemePreference(
  preference: ThemePreference,
  doc: Document | undefined = globalThis.document,
): void {
  const root = doc?.documentElement;
  if (!root?.dataset) return; // Minimal DOMs (tests, embedded shells) have nothing to theme.
  if (preference === "system") delete root.dataset.theme;
  else root.dataset.theme = preference;
  // An explicit choice overrides both media-scoped theme-color tags; "system"
  // restores each tag to the colour of the scheme it is scoped to.
  for (const meta of Array.from(
    doc.querySelectorAll?.<HTMLMetaElement>('meta[name="theme-color"]') ?? [],
  )) {
    const scoped = meta.media.includes("dark") ? "dark" : "light";
    meta.content = THEME_COLORS[preference === "system" ? scoped : preference];
  }
}

/** Persist, apply and announce a new choice to every mounted toggle. */
export function setThemePreference(preference: ThemePreference): void {
  saveThemePreference(preference);
  applyThemePreference(preference);
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: preference }));
}

/** Apply the stored choice before first paint and follow other tabs' changes. */
export function initThemePreference(): ThemePreference {
  const preference = loadThemePreference();
  applyThemePreference(preference);
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    const next = loadThemePreference();
    applyThemePreference(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
  });
  return preference;
}
