/** One panel the active host can present to the user. */
export interface AgentPanelDescriptor {
  id: string;
  title: string;
  source: "builtin" | "builtin-panel-app" | "panel-app";
}

export interface PanelOpenResult {
  ok: boolean;
  panelId: string;
  detail?: string;
}

export interface AgentPanelToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface PanelInvokeResult {
  ok: boolean;
  panelId: string;
  toolName: string;
  result?: unknown;
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
  tools?(panelId: string): Promise<AgentPanelToolDescriptor[]>;
  invoke?(
    panelId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PanelInvokeResult>;
}
