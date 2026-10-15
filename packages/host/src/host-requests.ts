import type { HostRuntime } from "./runtime.js";

export interface ServeHostCapabilities {
  panels: boolean;
}

const LOOPBACKS: Readonly<Record<string, string>> = Object.freeze({
  __browser_action__: "browser",
  __credential_action__: "credential.browserCookie",
  __workspace_action__: "workspace.switch",
  __panel_action__: "panel",
});

function loopbackCapability(toolName: unknown): string | undefined {
  if (typeof toolName !== "string" || toolName === "__ask_user__") return undefined;
  if (Object.hasOwn(LOOPBACKS, toolName)) return LOOPBACKS[toolName];
  return toolName.startsWith("__") ? toolName : undefined;
}

function unsupportedText(capability: string, hostLabel: string): string {
  return `${capability} is not supported by this host (${hostLabel})`;
}

/** Compatibility surface for S0 callers. */
export function unsupportedLoopbackCapability(
  toolName: unknown,
  host: ServeHostCapabilities,
): string | undefined {
  const capability = loopbackCapability(toolName);
  return capability === "panel" && host.panels ? undefined : capability;
}

export function unsupportedLoopbackAnswer(
  capability: string,
  hostLabel = "headless serve",
): string {
  const text = unsupportedText(capability, hostLabel);
  return JSON.stringify({
    ok: false,
    failure: "unsupported",
    capability,
    error: text,
    detail: text,
  });
}

export function isHostAuthorityRequest(message: {
  id?: unknown;
  method?: unknown;
}): message is { id: string | number; method: string } {
  return (
    (typeof message.id === "string" || typeof message.id === "number") &&
    typeof message.method === "string" &&
    message.method.startsWith("desktop/")
  );
}

export function unsupportedHostRequestResponse(
  id: string | number,
  method: string,
  hostLabel = "headless serve",
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: unsupportedText(method, hostLabel),
      data: { failure: "unsupported", capability: method },
    },
  });
}

export interface HostApproval {
  sessionId: string;
  requestId: string;
  connectionId?: unknown;
  generation?: unknown;
  request?: { toolName?: unknown; args?: Record<string, unknown> };
  childHost?: { activate?: unknown; release?: unknown };
}

export interface HostRequest {
  kind: "authority" | "loopback";
  capability: string;
  message: Record<string, unknown>;
  line: string;
  approval?: HostApproval;
}

export function classifyHostRequest(message: unknown, line: string): HostRequest | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const frame = message as Record<string, unknown>;
  if (isHostAuthorityRequest(frame))
    return { kind: "authority", capability: frame.method, message: frame, line };
  if (frame.method !== "agent/approvalRequest") return undefined;
  const approval = frame.params as HostApproval | undefined;
  if (!approval || typeof approval.requestId !== "string" || typeof approval.sessionId !== "string")
    return undefined;
  const capability = loopbackCapability(approval.request?.toolName);
  return capability ? { kind: "loopback", capability, message: frame, line, approval } : undefined;
}

/** Consume private worker requests before they enter untrusted client routing. */
export function interceptHostRequest(
  message: unknown,
  line: string,
  options: {
    runtime: HostRuntime;
    sendLine(line: string): void;
    approve(params: Record<string, unknown>): void;
  },
): boolean {
  const request = classifyHostRequest(message, line);
  if (!request) return false;
  if (options.runtime.supports(request.capability)) return options.runtime.dispatch(request);
  if (request.kind === "authority") {
    const frame = request.message as { id: string | number; method: string };
    options.sendLine(
      unsupportedHostRequestResponse(frame.id, frame.method, options.runtime.adapter.label),
    );
  } else {
    const approval = request.approval!;
    // Child browser lifetime frames are one-way; no pending approval exists.
    if (approval.childHost?.activate === true || approval.childHost?.release === true) return true;
    options.approve({
      sessionId: approval.sessionId,
      requestId: approval.requestId,
      connectionId: approval.connectionId,
      generation: approval.generation,
      decision: {
        approved: true,
        answer: unsupportedLoopbackAnswer(request.capability, options.runtime.adapter.label),
      },
    });
  }
  return true;
}
