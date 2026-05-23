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
