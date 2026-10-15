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
      // Legacy readiness/cancellation notifications have no JSON-RPC response.
      if (message?.id === undefined && message?.method === "desktop/operationBatch")
        return handlers.operationBatch(line);
      if (message?.method === "desktop/localOAuthLinkActionCancel")
        return handlers.credentials(line);
      return interceptHostRequest(message, line, {
        runtime,
        sendLine: handlers.sendLine,
        approve: (params) =>
          handlers.sendLine(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "agent/approve",
              params,
            }),
          ),
      });
    },
  };
}
