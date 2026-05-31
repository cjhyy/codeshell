export type Theme = "light" | "dark" | "system";

const KEY = "codeshell.theme";

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
  // Legacy CSS (styles/tokens.css) still keys off [data-theme]; keep it in sync
  // until the migration's final phase removes the old stylesheets.
  document.documentElement.setAttribute("data-theme", resolved);
}

export function initTheme(): Theme {
  const t = loadTheme();
  applyTheme(t);
  if (t === "system") {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => applyTheme("system"));
  }
  return t;
}
