/**
 * Pure helpers for intercepting __browser_action__ requests on the worker→main
 * line stream and building the reply line. Kept pure (no Electron) so the
 * agent-bridge glue is a thin call and the parsing is unit-tested.
 *
 * Flow: the worker's AgentServer emits an `agent/approvalRequest` notification
 * whose request.toolName is "__browser_action__" (see protocol/server.ts
 * makeBrowserBridge). Main intercepts it (does NOT forward to renderer), drives
 * the webview, then writes back an `agent/approve` line resolving that
 * requestId with the JSON result string.
 */

import type { BrowserActionRequest } from "./automation-host.js";

export interface ParsedBrowserAction {
  sessionId?: string;
  requestId: string;
  request: BrowserActionRequest;
}

/**
 * If `line` is a __browser_action__ approval request, return its
 * {sessionId, requestId, request}; otherwise null (the caller forwards the line
 * normally). Tolerates malformed JSON.
 */
export function parseBrowserActionLine(line: string): ParsedBrowserAction | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || msg.method !== "agent/approvalRequest") return null;
  const p = msg.params;
  if (!p || typeof p.requestId !== "string") return null;
  const r = p.request;
  if (!r || r.toolName !== "__browser_action__" || !r.args) return null;
  const a = r.args as Record<string, unknown>;
  if (typeof a.action !== "string") return null;
  return {
    sessionId: typeof p.sessionId === "string" ? p.sessionId : undefined,
    requestId: p.requestId,
    request: {
      action: a.action as BrowserActionRequest["action"],
      ref: a.ref as string | undefined,
      text: a.text as string | undefined,
      url: a.url as string | undefined,
      dir: a.dir as "up" | "down" | undefined,
      amount: a.amount as number | undefined,
      timeoutMs: a.timeoutMs as number | undefined,
      // These four were dropped here, so selectOption(value) / pressKey(key) /
      // fetchImages(refs) / switchTab(tabId) silently no-op'd even though
      // automation-host's handler consumes them. Forward with light type guards.
      value: typeof a.value === "string" ? a.value : undefined,
      key: typeof a.key === "string" ? a.key : undefined,
      refs: Array.isArray(a.refs)
        ? (a.refs.filter((x) => typeof x === "string") as string[])
        : undefined,
      tabId: typeof a.tabId === "string" ? a.tabId : undefined,
    },
  };
}

/**
 * Build the `agent/approve` reply line that resolves a browser action's
 * requestId with its JSON result string (wrapped in the ApprovalResult shape
 * the server's pendingApprovals handler expects: {approved:true, answer}).
 */
export function buildBrowserActionReply(parsed: ParsedBrowserAction, resultJson: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: replyId(),
    method: "agent/approve",
    params: {
      sessionId: parsed.sessionId,
      requestId: parsed.requestId,
      decision: { approved: true, answer: resultJson },
    },
  });
}

// Monotonic-ish id for the reply RPC. The worker only matches on requestId
// inside params, so this id just needs to be present/unique-enough.
let n = 0;
function replyId(): number {
  n = (n + 1) % 1_000_000;
  return 900_000_000 + n;
}

// ── __credential_action__ (InjectCredential tool) ─────────────────────────
// Same worker→main approval-request channel as browser actions, but the action
// is "injectCookie" (restore a cookie credential's jar into the built-in
// browser). Kept here next to the browser-action parser so the agent-bridge
// glue stays a thin call and parsing is unit-tested.

export interface ParsedCredentialAction {
  sessionId?: string;
  requestId: string;
  /** Currently only "injectCookie". */
  action: string;
  credentialId: string;
  credentialScope: "full" | "project";
}

/**
 * If `line` is a __credential_action__ approval request, return its parsed
 * shape; otherwise null. Tolerates malformed JSON.
 */
export function parseCredentialActionLine(line: string): ParsedCredentialAction | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || msg.method !== "agent/approvalRequest") return null;
  const p = msg.params;
  if (!p || typeof p.requestId !== "string") return null;
  const r = p.request;
  if (!r || r.toolName !== "__credential_action__" || !r.args) return null;
  const a = r.args as Record<string, unknown>;
  if (typeof a.action !== "string" || typeof a.credentialId !== "string") return null;
  return {
    sessionId: typeof p.sessionId === "string" ? p.sessionId : undefined,
    requestId: p.requestId,
    action: a.action,
    credentialId: a.credentialId,
    credentialScope: a.credentialScope === "project" ? "project" : "full",
  };
}

/** Build the `agent/approve` reply that resolves a credential action's
 *  requestId with its JSON result string (same ApprovalResult shape). */
export function buildCredentialActionReply(
  parsed: ParsedCredentialAction,
  resultJson: string,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: replyId(),
    method: "agent/approve",
    params: {
      sessionId: parsed.sessionId,
      requestId: parsed.requestId,
      decision: { approved: true, answer: resultJson },
    },
  });
}

// ── __workspace_action__ (SwitchSessionWorkspace tool) ─────────────────────
// Same worker→main approval-request channel. Main performs the switch through
// session-workspace-service so the model path matches the UI path.

export interface ParsedWorkspaceAction {
  sessionId?: string;
  requestId: string;
  /** Currently only "switch". */
  action: string;
  target: string;
}

export function parseWorkspaceActionLine(line: string): ParsedWorkspaceAction | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || msg.method !== "agent/approvalRequest") return null;
  const p = msg.params;
  if (!p || typeof p.requestId !== "string") return null;
  const r = p.request;
  if (!r || r.toolName !== "__workspace_action__" || !r.args) return null;
  const a = r.args as Record<string, unknown>;
  if (typeof a.action !== "string" || typeof a.target !== "string") return null;
  return {
    sessionId: typeof p.sessionId === "string" ? p.sessionId : undefined,
    requestId: p.requestId,
    action: a.action,
    target: a.target,
  };
}

export function buildWorkspaceActionReply(
  parsed: ParsedWorkspaceAction,
  resultJson: string,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: replyId(),
    method: "agent/approve",
    params: {
      sessionId: parsed.sessionId,
      requestId: parsed.requestId,
      decision: { approved: true, answer: resultJson },
    },
  });
}
