export type AgentPanelSource = "builtin" | "code" | "plugin";

export interface AgentPanelDescriptorWire {
  id: string;
  title: string;
  source: AgentPanelSource;
}

export interface AgentPanelHostRequest {
  requestId: string;
  sessionId: string;
  bucket: string;
  action: "list" | "open";
  panelId?: string;
}

export type AgentPanelHostResult =
  | { ok: true; panels: AgentPanelDescriptorWire[] }
  | { ok: true; panelId: string }
  | { ok: false; panelId?: string; detail: string };

export interface AgentPanelHostResponse {
  requestId: string;
  result: AgentPanelHostResult;
}
