/**
 * Worker → host requests that a headless serve host cannot fulfil.
 *
 * Desktop main answers the browser, credential-cookie and workspace-switch
 * loopbacks plus the `desktop/*` authority requests. serve used to broadcast
 * them to Web tabs as ordinary approvals, so the worker waited for its timeout
 * (5 minutes for loopbacks, 30 seconds for automation). Answering at once with
 * a typed `unsupported` result lets the tool fail fast with a reason.
 *
 * Pure and host-neutral on purpose: it moves into packages/host unchanged
 * (architecture ch.16 §3.2 step 1.1). The wire shapes are documented in
 * docs/todo/platform-s0-protocol-inventory.md ("S0 应答格式").
 */

/** What this host can serve itself; Panel actions are only served with a Panel runtime. */
export interface ServeHostCapabilities {
  panels: boolean;
}

const DESKTOP_ONLY_LOOPBACKS: Readonly<Record<string, string>> = Object.freeze({
  __browser_action__: "browser",
  __credential_action__: "credential.browserCookie",
  __workspace_action__: "workspace.switch",
});

const PANEL_LOOPBACK = "__panel_action__";
const PANEL_CAPABILITY = "panel";
const HOST_AUTHORITY_METHOD_PREFIX = "desktop/";
const METHOD_NOT_FOUND = -32601;

function unsupportedText(capability: string): string {
  return `${capability} is not supported by this host (headless serve)`;
}

export function unsupportedLoopbackCapability(
  toolName: unknown,
  host: ServeHostCapabilities,
): string | undefined {
  if (typeof toolName !== "string") return undefined;
  if (toolName === PANEL_LOOPBACK) return host.panels ? undefined : PANEL_CAPABILITY;
  return Object.hasOwn(DESKTOP_ONLY_LOOPBACKS, toolName)
    ? DESKTOP_ONLY_LOOPBACKS[toolName]
    : undefined;
}

/** The `answer` string for an approved loopback decision. */
export function unsupportedLoopbackAnswer(capability: string): string {
  const text = unsupportedText(capability);
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
    message.method.startsWith(HOST_AUTHORITY_METHOD_PREFIX)
  );
}

/** One JSON-RPC response line to write back to the worker. */
export function unsupportedHostRequestResponse(id: string | number, method: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: METHOD_NOT_FOUND,
      message: unsupportedText(method),
      data: { failure: "unsupported", capability: method },
    },
  });
}
