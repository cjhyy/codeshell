export type ViewMode =
  | "chat"
  | "pet" // first-class Pet workspace; never layered over chat
  | "sessions"
  | "approvals"
  | "runs"
  | "automation" // scheduled automation jobs (cron) — list + detail + create
  | "settings" // legacy modal route — kept for routing back-compat
  | "settings_page" // full-screen Settings page (new in batch E)
  | "customize" // full-screen 扩展 (plugins + skills + MCP + market) view
  | "credentials" // full-screen 凭证 (cookie + token + link) view
  | "logs";

/**
 * The side panel area lives alongside chat (not a full-screen ViewMode). It's
 * a Codex-style dock on the right: a tab strip switches between these panels,
 * and a top-bar button toggles the whole area open/closed.
 */
export type PanelTab =
  | "files"
  | "browser"
  | "review"
  | "terminal"
  | "shells"
  | "ccRoom"
  | "quickChat";

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
  "sessions",
  "approvals",
  "runs",
  "automation",
  "settings",
  "settings_page",
  "customize",
  "credentials",
  "logs",
]);

export function loadView(): ViewState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const merged = { ...DEFAULT, ...(JSON.parse(raw) as Partial<ViewState>) };
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
