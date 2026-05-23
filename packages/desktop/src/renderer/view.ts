export type ViewMode =
  | "chat"
  | "sessions"
  | "approvals"
  | "runs"
  | "settings"
  | "mcp"
  | "logs";

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

export function loadView(): ViewState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    return { ...DEFAULT, ...(JSON.parse(raw) as Partial<ViewState>) };
  } catch {
    return DEFAULT;
  }
}

export function saveView(v: ViewState): void {
  localStorage.setItem(KEY, JSON.stringify(v));
}
