export type ViewMode =
  | "chat"
  | "pet" // first-class Pet workspace; never layered over chat
  | "digital_humans" // market, installed digital humans, and Pet-led teams
  | "sessions"
  | "approvals"
  | "runs"
  | "automation" // scheduled automation jobs (cron) — list + detail + create
  | "settings" // legacy modal route — kept for routing back-compat
  | "settings_page" // full-screen Settings page (new in batch E)
  | "project_config" // full-screen settings for one tracked project
  | "credentials" // full-screen 凭证 (cookie + token + link) view
  | "logs";

/**
 * The side panel area lives alongside chat (not a full-screen ViewMode). It's
 * a Codex-style dock on the right: a tab strip switches between these panels,
 * and a top-bar button toggles the whole area open/closed.
 */
/** Open registry id. Built-ins keep their historical ids; plugins are namespaced. */
export type PanelId = string;
/** @deprecated Compatibility alias for existing dock callers. */
export type PanelTab = PanelId;

const KEY = "codeshell.view";

export interface ViewState {
  viewMode: ViewMode;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
}

const DEFAULT: ViewState = {
  viewMode: "chat",
  sidebarCollapsed: false,
  inspectorCollapsed: false,
};

const VALID_MODES: ReadonlySet<ViewMode> = new Set([
  "chat",
  "pet",
  "digital_humans",
  "sessions",
  "approvals",
  "runs",
  "automation",
  "settings",
  "settings_page",
  "project_config",
  "credentials",
  "logs",
]);

export function loadView(): ViewState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const merged = { ...DEFAULT, ...(JSON.parse(raw) as Partial<ViewState>) };
    // Legacy route: the standalone 扩展 view merged into Settings (双门收口).
    if ((merged.viewMode as string) === "customize") merged.viewMode = "settings_page";
    // Old builds persisted panel kinds (files/browser/review/terminal) as
    // ViewModes; those are now dock tabs, not full-screen views. Fall back to
    // chat so a stale value doesn't leave the user on a blank/unknown view.
    if (!VALID_MODES.has(merged.viewMode)) merged.viewMode = "chat";
    return merged;
  } catch {
    return DEFAULT;
  }
}

export function saveView(v: ViewState): void {
  localStorage.setItem(KEY, JSON.stringify(v));
}
