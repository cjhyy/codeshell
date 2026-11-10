import { parseWorkerLine, type ParsedWorkerLine } from "./worker-line.js";
import { randomUUID } from "node:crypto";
import { HostRuntime, interceptHostRequest } from "@cjhyy/code-shell-host";

export interface DesktopWorkerHostHandlers {
  operationBatch(line: string, parsedLine: ParsedWorkerLine): boolean;
  credentials(line: string, parsedLine: ParsedWorkerLine): boolean;
  browser(line: string, parsedLine: ParsedWorkerLine): boolean;
  credentialCookie(line: string, parsedLine: ParsedWorkerLine): boolean;
  workspace(line: string, parsedLine: ParsedWorkerLine): boolean;
  panel(line: string, parsedLine: ParsedWorkerLine): boolean;
  /** Generic `__host_action__` loopback (ProtocolObserverHost.requestHostAction). */
  hostAction(line: string, parsedLine: ParsedWorkerLine): boolean;
  automation(line: string, parsedLine: ParsedWorkerLine): boolean;
  sendLine(line: string): void;
}

/** Electron supplies mechanisms; the shared dispatcher owns private request routing. */
export function createDesktopWorkerHost(handlers: DesktopWorkerHostHandlers) {
  const routes: Record<string, (line: string, parsedLine: ParsedWorkerLine) => boolean> = {
    browser: handlers.browser,
    "credential.browserCookie": handlers.credentialCookie,
    "workspace.switch": handlers.workspace,
    panel: handlers.panel,
    __host_action__: handlers.hostAction,
    "desktop/operationBatch": handlers.operationBatch,
    "desktop/automationCreate": handlers.automation,
  };
  for (const method of [
    "credentialResolve",
    "credentialMaterializeCookie",
    "oauthAccessResolve",
    "remoteLinkAction",
    "localOAuthLinkAction",
    "mcpLinkAction",
    "modelRequestSign",
  ])
    routes[`desktop/${method}`] = handlers.credentials;
  const runtime = new HostRuntime({ kind: "electron", label: "Desktop" }, [
    {
      id: "desktop-adapter",
      capabilities: Object.keys(routes),
      hostRequests: Object.fromEntries(
        Object.entries(routes).map(([capability, handler]) => [
          capability,
          (request) => handler(request.line, { line: request.line, message: request.message }),
        ]),
      ),
    },
  ]);
  runtime.start();
  return {
    runtime,
    intercept(line: string, parsedLine: ParsedWorkerLine = parseWorkerLine(line)): boolean {
      const message = parsedLine.message as { id?: unknown; method?: unknown };
      // Preserve the authorities' legacy handling of known notifications: batch
      // readiness is meaningful, while credential/automation frames without an
      // id are consumed privately without executing or replying.
      if (
        message?.id === undefined &&
        typeof message?.method === "string" &&
        message.method.startsWith("desktop/") &&
        Object.hasOwn(routes, message.method)
      )
        return routes[message.method](line, parsedLine);
      if (message?.method === "desktop/localOAuthLinkActionCancel")
        return handlers.credentials(line, parsedLine);
      return interceptHostRequest(message, line, {
        runtime,
        sendLine: handlers.sendLine,
        approve: (params) =>
          handlers.sendLine(
            JSON.stringify({
              jsonrpc: "2.0",
              id: `desktop-host-approve-${randomUUID()}`,
              method: "agent/approve",
              params,
            }),
          ),
      });
    },
  };
}
