/**
 * Built-in full-screen routes. The union is intentionally open: registered
 * pages (renderer/pages/PageRegistry.ts) contribute additional string keys,
 * so persisted state and setViewMode accept both.
 */
export const BUILTIN_VIEW_MODES = [
  "chat",
  "pet", // first-class Pet workspace; never layered over chat
  "pet_settings", // Mimi-only settings, separate from the global settings center
  "digital_humans", // market, installed digital humans, and Pet-led teams
  "sessions",
  "approvals",
  "runs",
  "automation", // scheduled automation jobs (cron) — list + detail + create
  "settings_page", // full-screen Settings page
  "project_config", // full-screen settings for one tracked project
  "credentials", // full-screen 凭证 (cookie + token + link) view
  "logs",
] as const;

export type BuiltinViewMode = (typeof BUILTIN_VIEW_MODES)[number];
/** Builtin literals keep autocomplete; registry page keys ride the open half. */
export type ViewMode = BuiltinViewMode | (string & {});

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

const BUILTIN_MODES: ReadonlySet<string> = new Set(BUILTIN_VIEW_MODES);

export function loadView(isRegisteredPage?: (mode: string) => boolean): ViewState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const merged = { ...DEFAULT, ...(JSON.parse(raw) as Partial<ViewState>) };
    // Legacy routes: the standalone 扩展 view ("customize") and the old
    // settings modal route ("settings") both merged into the full-screen
    // Settings page. Keep these as quoted literals — the settings contract
    // test asserts view.ts still contains '"customize"'.
    if (merged.viewMode === "customize" || merged.viewMode === "settings") {
      merged.viewMode = "settings_page";
    }
    // Old builds persisted panel kinds (files/browser/review/terminal) as
    // ViewModes; those are now dock tabs, not full-screen views. Anything that
    // is neither builtin nor a registered page falls back to chat so a stale
    // value doesn't leave the user on a blank/unknown view.
    if (!BUILTIN_MODES.has(merged.viewMode) && !isRegisteredPage?.(merged.viewMode)) {
      merged.viewMode = "chat";
    }
    return merged;
  } catch {
    return DEFAULT;
  }
}

export function saveView(v: ViewState): void {
  localStorage.setItem(KEY, JSON.stringify(v));
}
