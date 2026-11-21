import type { DesktopAgentMethod } from "../../shared/desktop-agent-methods.js";
import type { DesktopHostIdentity } from "../../shared/desktop-host-protocol.js";
import type { RendererRunFacts } from "./renderer-run-facts.js";

export interface WorkbenchRequest {
  identity: DesktopHostIdentity;
  id: string;
  method: DesktopAgentMethod;
  params: Record<string, unknown>;
}
export type WorkbenchAdmission =
  | { type: "dispatch"; id: string; generation: number; facts?: RendererRunFacts }
  | { type: "reply"; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export interface WorkbenchIngressAdapter {
  prepare(request: WorkbenchRequest, assertCurrent: () => void): Promise<WorkbenchAdmission>;
  settled(line: string): Promise<void>;
}
