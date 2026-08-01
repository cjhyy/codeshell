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
 * A discovery result that can distinguish "the host has none" from "the request
 * never completed".
 *
 * `list` / `tools` used to return a bare array, so every failure — a user Stop, a
 * closed session, a timeout — collapsed to `[]`, which the Panel tool then
 * reported as the factual claim "(no panels available)". That is worse than a
 * refusal: it tells the model panel hosting is unavailable, so it stops trying.
 * `failed` carries the reason instead, and an absent `failed` means the empty
 * list is real.
 */
export interface PanelDiscoveryResult<T> {
  items: T[];
  /** Present only when the request did not complete; `items` is then empty. */
  failed?: string;
}

/**
 * UI-agnostic bridge used by agent tools to discover and focus host panels.
 *
 * Core never imports a renderer. Desktop implements this through its protocol
 * host; headless/TUI engines leave it undefined. Plugin-contributed tools may
 * use the same bridge to open their own panel by stable registry id.
 */
export interface PanelHostBridge {
  list(): Promise<PanelDiscoveryResult<AgentPanelDescriptor>>;
  open(panelId: string): Promise<PanelOpenResult>;
  tools?(panelId: string): Promise<PanelDiscoveryResult<AgentPanelToolDescriptor>>;
  invoke?(
    panelId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PanelInvokeResult>;
}
