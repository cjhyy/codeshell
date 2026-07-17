export const PLUGIN_PANEL_API_VERSION = 1 as const;

export type PluginPanelPermission =
  | "context.session"
  | "context.workspace"
  | "storage"
  | "external.open"
  | "agent.submitPrompt";

/**
 * Icon allowlist — must stay byte-identical to core's PLUGIN_PANEL_ICONS
 * (packages/core/src/plugins/installer/types.ts). The renderer cannot import
 * core, so the list is mirrored and parity-tested from desktop main
 * (src/main/plugin-panel-icons.test.ts).
 */
export const PLUGIN_PANEL_ICON_NAMES = [
  "panel",
  "chart",
  "table",
  "activity",
  "alarm-clock",
  "archive",
  "bar-chart-3",
  "bell",
  "book-open",
  "bot",
  "box",
  "brain",
  "bug",
  "calendar",
  "camera",
  "check-circle-2",
  "clipboard-list",
  "clock",
  "cloud",
  "code-2",
  "compass",
  "cpu",
  "database",
  "download",
  "file-text",
  "filter",
  "flag",
  "flame",
  "folder-tree",
  "gauge",
  "git-branch",
  "git-compare",
  "globe",
  "graduation-cap",
  "hammer",
  "hard-drive",
  "heart",
  "history",
  "home",
  "image",
  "inbox",
  "key-round",
  "layers",
  "layout-dashboard",
  "library",
  "lightbulb",
  "line-chart",
  "link",
  "list-checks",
  "lock",
  "mail",
  "map",
  "message-square",
  "mic",
  "monitor",
  "moon",
  "music",
  "newspaper",
  "package",
  "palette",
  "panel-top",
  "pie-chart",
  "plug",
  "puzzle",
  "radar",
  "rocket",
  "search",
  "server-cog",
  "settings",
  "shield",
  "shopping-cart",
  "sparkles",
  "square-terminal",
  "star",
  "table-2",
  "tag",
  "target",
  "terminal",
  "timer",
  "trending-up",
  "trophy",
  "users-round",
  "wallet",
  "wand-2",
  "wifi",
  "wrench",
  "zap",
] as const;

export type PluginPanelIconName = (typeof PLUGIN_PANEL_ICON_NAMES)[number];

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
