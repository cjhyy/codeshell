import { randomUUID } from "node:crypto";
import { HostRuntime, interceptHostRequest } from "@cjhyy/code-shell-host";

export interface DesktopWorkerHostHandlers {
  operationBatch(line: string): boolean;
  credentials(line: string): boolean;
  browser(line: string): boolean;
  credentialCookie(line: string): boolean;
  workspace(line: string): boolean;
  panel(line: string): boolean;
  automation(line: string): boolean;
  sendLine(line: string): void;
}

/** Electron supplies mechanisms; the shared dispatcher owns private request routing. */
export function createDesktopWorkerHost(handlers: DesktopWorkerHostHandlers) {
  const routes: Record<string, (line: string) => boolean> = {
    browser: handlers.browser,
    "credential.browserCookie": handlers.credentialCookie,
    "workspace.switch": handlers.workspace,
    panel: handlers.panel,
    "desktop/operationBatch": handlers.operationBatch,
    "desktop/automationCreate": handlers.automation,
  };
  for (const method of [
    "credentialResolve",
    "credentialMaterializeCookie",
    "oauthAccessResolve",
    "remoteLinkAction",
    "localOAuthLinkAction",
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
          (request) => handler(request.line),
        ]),
      ),
    },
  ]);
  runtime.start();
  return {
    runtime,
    intercept(line: string): boolean {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return false;
      }
      // Preserve the authorities' legacy handling of known notifications: batch
      // readiness is meaningful, while credential/automation frames without an
      // id are consumed privately without executing or replying.
      if (
        message?.id === undefined &&
        typeof message?.method === "string" &&
        message.method.startsWith("desktop/") &&
        Object.hasOwn(routes, message.method)
      )
        return routes[message.method](line);
      if (message?.method === "desktop/localOAuthLinkActionCancel")
        return handlers.credentials(line);
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
