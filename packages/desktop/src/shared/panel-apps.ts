export const PANEL_APP_API_VERSION = 2 as const;

export type PanelAppPermission =
  | "context.session"
  | "context.workspace"
  | "storage"
  | "external.open"
  | "agent.submitPrompt"
  | "workspace.info"
  | "workspace.read"
  | "workspace.write"
  | "notifications.send";

/**
 * Mirrors core's PANEL_APP_ICONS. The renderer is isolated from core runtime
 * imports, so parity is checked in a Desktop main-process test.
 */
export const PANEL_APP_ICON_NAMES = [
  "panel",
  "activity",
  "bar-chart-3",
  "chart",
  "file-text",
  "globe",
  "image",
  "layout-dashboard",
  "line-chart",
  "palette",
  "pie-chart",
  "table",
  "terminal",
] as const;

export type PanelAppIconName = (typeof PANEL_APP_ICON_NAMES)[number];

export interface PanelAppDescriptor {
  /** Dock registry key, namespaced by the host as `panel-app:<appId>`. */
  id: string;
  /** Stable app identity from `.codeshell-panel/panel.json`. */
  appId: string;
  title: string;
  version: string;
  description?: string;
  icon: PanelAppIconName;
  singleton: boolean;
  permissions: PanelAppPermission[];
  agent?: {
    tools: PanelAppAgentToolDescriptor[];
    skills: string[];
  };
  /** Opaque asset authority. Never an install path. */
  hostId: string;
  /** Changes whenever installed app bytes change and forces a fresh guest. */
  revision: string;
}

export interface PanelAppAgentToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface PanelAppAgentToolInvocation {
  appDescriptorId: string;
  bucket: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** Extensions-page view of an independently installed Desktop Panel App. */
export interface PanelAppExtensionSummary extends PanelAppDescriptor {
  kind: "panel-app";
  enabled: boolean;
  globalEnabled: boolean;
  /** Explicitly available to the currently selected project. */
  projectBound: boolean;
  /** Legacy migration state, when present in old project settings. */
  projectOverride?: "on" | "off";
  disabledByPolicy: boolean;
  updateSource: {
    kind: "dir" | "zip" | "git";
    label: string;
    available: boolean;
  };
}

export interface PreparedPanelApp {
  id: string;
  src: string;
  partition: string;
  revision: string;
}

export interface PanelAppBindInput {
  guestId: number;
  appDescriptorId: string;
  tabId: string;
  bucket: string;
  sessionId?: string | null;
  projectPath: string;
  cwd?: string | null;
  visible: boolean;
  busy?: boolean;
  theme: "light" | "dark" | "system";
  locale: string;
}

export interface PanelAppHostContext {
  appId: string;
  visible: boolean;
  theme: "light" | "dark" | "system";
  locale: string;
  sessionId?: string;
  busy?: boolean;
  cwd?: string;
  trusted?: boolean;
  apiVersion: typeof PANEL_APP_API_VERSION;
}
