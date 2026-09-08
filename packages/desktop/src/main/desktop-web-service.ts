import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { app } from "electron";
import {
  codeShellHome,
  resolvePanelAppBindingProjectPath,
  sessionsRoot,
} from "@cjhyy/code-shell-core";
import {
  createDesktopWebApi,
  type DesktopWebRequestContext,
} from "@cjhyy/code-shell-server/desktop-web";
import { createLinkHttp } from "@cjhyy/code-shell-server/links";
import { createPanelHttp } from "@cjhyy/code-shell-server/panels";
import type { TrustedDeviceStore } from "@cjhyy/code-shell-server/mobile-remote";
import type { AgentBridge } from "./agent-bridge.js";

/** Host wiring only. Pages and management services live in shared packages. */
export function createDesktopWebService(options: {
  devices: TrustedDeviceStore;
  getBridge: () => AgentBridge | null;
  resolveWorkspace: (input: string | undefined, deviceId: string) => Promise<string | undefined>;
  onSessionsChanged: (cwd: string, sessionId: string) => void;
}) {
  const contexts = new WeakMap<IncomingMessage, DesktopWebRequestContext>();
  const links = new Map<string, { handler: ReturnType<typeof createLinkHttp>; active: number }>();
  const panels = new Map<string, { handler: ReturnType<typeof createPanelHttp>; active: number }>();
  const withMutation = <T>(cwd: string, write: () => Promise<T>): Promise<T> => {
    const bridge = options.getBridge();
    if (!bridge) return Promise.reject(Object.assign(new Error("桌面尚未就绪。"), { status: 503 }));
    return bridge.withWebConfigurationMutation(cwd, write);
  };
  const authorized = async (request: IncomingMessage) =>
    (await contexts.get(request)?.isAuthorized()) ?? false;
  const api = createDesktopWebApi({
    devices: options.devices,
    dataDir: join(codeShellHome(), "desktop"),
    sessionRootDir: sessionsRoot(),
    resolveWorkspace: options.resolveWorkspace,
    withConfigurationMutation: withMutation,
    isRunning: (id) => options.getBridge()?.isSessionRunning(id) ?? false,
    onSessionsChanged: options.onSessionsChanged,
    onSessionRevoked: (owner) => {
      for (const value of links.values()) value.handler.cancelOwner(owner);
      for (const value of panels.values()) value.handler.cancelOwner(owner);
    },
    onClose: async () => {
      const entries = [...links.values(), ...panels.values()];
      links.clear();
      panels.clear();
      await Promise.allSettled(entries.map((entry) => entry.handler.close()));
    },
    async handleExtra(request, response, context) {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/api/v1/panels" || pathname.startsWith("/api/v1/panels/")) {
        contexts.set(request, context);
        let entry = panels.get(context.cwd);
        if (!entry) {
          if (panels.size >= 32) {
            const idle = [...panels].find(([, candidate]) => candidate.active === 0);
            if (!idle) throw Object.assign(new Error("正在访问的工作区过多。"), { status: 503 });
            panels.delete(idle[0]);
            idle[1].handler.close();
          }
          const cwd = context.cwd;
          const bindingCwd = resolvePanelAppBindingProjectPath(cwd);
          if (
            bindingCwd !== cwd &&
            (await options.resolveWorkspace(bindingCwd, context.deviceId)) !== bindingCwd
          ) {
            response.writeHead(403, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            });
            response.end(JSON.stringify({ error: "面板所属项目尚未获得桌面授权。" }));
            return true;
          }
          entry = {
            active: 0,
            handler: createPanelHttp({
              cwd,
              bindingCwd,
              // Match Electron's existing panel storage exactly, including custom profiles.
              dataDir: app.getPath("userData"),
              host: "desktop",
              agentTaskOptions: {
                buildEnv: () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1" }),
              },
              ownerId: async (req) =>
                (await authorized(req)) ? contexts.get(req)?.sessionId : undefined,
              isAuthorized: authorized,
              withMutation: (write) => withMutation(cwd, write),
              onChanged: (id) => {
                for (const value of panels.values()) value.handler.invalidate(id);
                options.getBridge()?.notifyWebConfigurationChanged();
              },
            }),
          };
          panels.set(cwd, entry);
        }
        entry.active++;
        try {
          return await entry.handler.handle(request, response);
        } finally {
          entry.active--;
        }
      }
      if (!(request.url ?? "").startsWith("/api/v1/links")) return false;
      contexts.set(request, context);
      let entry = links.get(context.cwd);
      if (!entry) {
        if (links.size >= 32) {
          const idle = [...links].find(([, candidate]) => candidate.active === 0);
          if (!idle) throw Object.assign(new Error("正在访问的工作区过多。"), { status: 503 });
          links.delete(idle[0]);
          await idle[1].handler.close();
        }
        const cwd = context.cwd;
        entry = {
          active: 0,
          handler: createLinkHttp({
            cwd,
            ownerId: async (req) =>
              (await authorized(req)) ? contexts.get(req)?.sessionId : undefined,
            isAuthorized: authorized,
            withMutation: (write) => withMutation(cwd, write),
            onChanged: () => options.getBridge()?.notifyWebConfigurationChanged(),
          }),
        };
        links.set(cwd, entry);
      }
      entry.active++;
      try {
        return await entry.handler.handle(request, response);
      } finally {
        entry.active--;
      }
    },
  });
  return {
    ...api,
    async handle(request, response, context) {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname.startsWith("/api/v1/panel-assets/")) {
        // Opaque-origin modules cannot send the Desktop cookie. The random asset
        // capability identifies its existing workspace handler; that handler
        // still rechecks the original paired owner and current binding per read.
        const entry = [...panels.values()].find((value) => value.handler.ownsAssets(request));
        if (!entry) {
          response.writeHead(404, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify({ error: "面板资源授权不存在或已失效。" }));
          return true;
        }
        entry.active++;
        try {
          return await entry.handler.handleAssets(request, response);
        } finally {
          entry.active--;
        }
      }
      return api.handle(request, response, context);
    },
  } satisfies ReturnType<typeof createDesktopWebApi>;
}
