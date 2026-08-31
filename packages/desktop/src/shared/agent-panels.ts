export type AgentPanelSource = "builtin" | "builtin-panel-app" | "panel-app";

export interface AgentPanelDescriptorWire {
  id: string;
  title: string;
  source: AgentPanelSource;
}

export interface AgentPanelToolDescriptorWire {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface AgentPanelHostRequest {
  requestId: string;
  routing: "owner" | "broadcast";
  sessionId: string;
  bucket: string;
  action: "list" | "open" | "tools" | "invoke";
  panelId?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
}

export type AgentPanelHostResult =
  | { ok: true; panels: AgentPanelDescriptorWire[] }
  | { ok: true; panelId: string }
  | { ok: true; panelId: string; tools: AgentPanelToolDescriptorWire[] }
  | { ok: true; panelId: string; toolName: string; result: unknown }
  | { ok: false; panelId?: string; detail: string };

export interface AgentPanelHostResponse {
  requestId: string;
  result: AgentPanelHostResult;
}
