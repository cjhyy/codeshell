/** One panel the active host can present to the user. */
export interface AgentPanelDescriptor {
  id: string;
  title: string;
  source: "builtin" | "code" | "plugin";
}

export interface PanelOpenResult {
  ok: boolean;
  panelId: string;
  detail?: string;
}

/**
 * UI-agnostic bridge used by agent tools to discover and focus host panels.
 *
 * Core never imports a renderer. Desktop implements this through its protocol
 * host; headless/TUI engines leave it undefined. Plugin-contributed tools may
 * use the same bridge to open their own panel by stable registry id.
 */
export interface PanelHostBridge {
  list(): Promise<AgentPanelDescriptor[]>;
  open(panelId: string): Promise<PanelOpenResult>;
}
