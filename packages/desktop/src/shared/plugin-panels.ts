export const PLUGIN_PANEL_API_VERSION = 1 as const;

export type PluginPanelPermission =
  | "context.session"
  | "context.workspace"
  | "storage"
  | "external.open"
  | "agent.submitPrompt";

export type PluginPanelIconName = "panel" | "chart" | "table" | "activity" | "plug";

export interface PluginPanelDescriptor {
  /** Registry id. The host creates it; manifests only control panelId. */
  id: string;
  installKey: string;
  pluginName: string;
  panelId: string;
  title: string;
  icon: PluginPanelIconName;
  singleton: boolean;
  permissions: PluginPanelPermission[];
  /** Opaque protocol authority. Never an install path. */
  hostId: string;
  /** Changes whenever an installed panel revision changes and forces a fresh guest. */
  revision: string;
}

/** Extensions-page view of a panel contribution, distinct from plugin packages. */
export interface PluginPanelExtensionSummary extends PluginPanelDescriptor {
  kind: "panel";
  enabled: boolean;
  disabledByPackage: boolean;
}

export interface PreparedPluginPanel {
  id: string;
  src: string;
  partition: string;
  revision: string;
}

export interface PluginPanelBindInput {
  guestId: number;
  panelId: string;
  tabId: string;
  bucket: string;
  sessionId?: string | null;
  cwd?: string | null;
  visible: boolean;
  busy?: boolean;
  theme: "light" | "dark" | "system";
  locale: string;
}

export interface PluginPanelHostContext {
  panelId: string;
  pluginId: string;
  visible: boolean;
  theme: "light" | "dark" | "system";
  locale: string;
  sessionId?: string;
  busy?: boolean;
  cwd?: string;
  trusted?: boolean;
  apiVersion: typeof PLUGIN_PANEL_API_VERSION;
}
