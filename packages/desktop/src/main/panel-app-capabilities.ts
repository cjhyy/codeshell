import {
  panelRuntimeCapabilities,
  panelProcessMethods,
  panelResourceMethods,
  panelToolJobMethods,
} from "@cjhyy/code-shell-server/panels";
import { panelAppStorageQuotaBytes } from "@cjhyy/code-shell-server/storage";
import type { PanelAppPermission } from "../shared/panel-apps.js";

const groups: Record<string, string[]> = {
  storage: [
    "storage.get",
    "storage.set",
    "storage.delete",
    "storage.getSnapshot",
    "storage.compareAndSet",
  ],
  "external.open": ["external.open"],
  "agent.submitPrompt": ["agent.submitPrompt"],
  "agent.task": [
    "agent.task.models",
    "agent.task.start",
    "agent.task.list",
    "agent.task.get",
    "agent.task.cancel",
  ],
  "workspace.info": ["workspace.info"],
  "workspace.read": [
    "workspace.list",
    "workspace.readText",
    "workspace.openPath",
    "workspace.revealPath",
  ],
  "workspace.write": ["workspace.writeText", "workspace.exportPdf"],
  "notifications.send": ["notifications.send"],
  "audio.transcribe": ["audio.status", "audio.requestMicrophoneAccess", "audio.transcribe"],
  "credentials.cookies": [
    "credentials.cookies.list",
    "credentials.cookies.loginAndSave",
    "credentials.cookies.restore",
    "credentials.cookies.authorizeProcess",
  ],
  "credentials.connections": [
    "credentials.connections.list",
    "credentials.connections.authorizeProcess",
  ],
  "automations.manage": [
    "automations.list",
    "automations.create",
    "automations.update",
    "automations.pause",
    "automations.resume",
    "automations.delete",
    "automations.runNow",
  ],
  process: [...panelProcessMethods, "filesystem.restoreDirectory"],
  resources: [...panelResourceMethods, "resources.references.pick"],
};
export function desktopPanelCapabilities(
  permissions: readonly PanelAppPermission[],
  options: {
    resources: unknown;
    audio: boolean;
    cookies: boolean;
    taskCookies?: boolean;
    automations: boolean;
    tasks?: unknown;
    mediaMethods: string[];
    limits?: any;
  },
) {
  const permitted = new Set<string>(permissions);
  const taskCookies =
    !!options.taskCookies &&
    !!options.tasks &&
    permitted.has("credentials.cookies") &&
    permitted.has("process") &&
    permitted.has("resources");
  const storageBytes = panelAppStorageQuotaBytes(options.limits?.storageQuotaBytes) + 8192;
  const methods = ["context.get"];
  for (const [permission, entries] of Object.entries(groups)) {
    if (!permitted.has(permission)) continue;
    if (
      (permission === "audio.transcribe" && !options.audio) ||
      (permission === "credentials.cookies" && !options.cookies) ||
      (permission === "automations.manage" && !options.automations)
    )
      continue;
    methods.push(
      ...entries.filter(
        (method) =>
          !(
            method.endsWith("authorizeProcess") ||
            method === "resources.capture" ||
            method === "resources.materialize" ||
            method === "resources.references.create" ||
            method === "resources.references.relink"
          ) || permitted.has("process"),
      ),
    );
  }
  if (permitted.has("media")) methods.push(...options.mediaMethods);
  if (options.tasks && permitted.has("process") && permitted.has("resources"))
    methods.push(...panelToolJobMethods);
  if (taskCookies) methods.push("credentials.cookies.listForTask");
  return {
    host: "desktop" as const,
    availableMethods: methods,
    capabilities: {
      ...panelRuntimeCapabilities({
        process: permitted.has("process"),
        cookieProcess: taskCookies,
        resources: permitted.has("resources")
          ? { ...(options.resources as Record<string, unknown>), pickReferences: true }
          : undefined,
        tasks:
          permitted.has("process") && permitted.has("resources") && options.tasks
            ? { ...(options.tasks as Record<string, unknown>), cookieCredentials: taskCookies }
            : undefined,
        limits: options.limits,
      }),
      methodLimits: {
        "storage.getSnapshot": { maxResultBytes: options.limits?.maxResultBytes ?? storageBytes },
        "storage.compareAndSet": {
          maxParamsBytes: options.limits?.maxParamsBytes ?? storageBytes,
          maxResultBytes: options.limits?.maxResultBytes ?? storageBytes,
        },
        "resources.references.pick": { timeoutMs: 30 * 60 * 1000 },
        "tasks.start": {
          maxParamsBytes: 2 * 1024 * 1024 + 8192,
          maxResultBytes: 5 * 1024 * 1024,
          timeoutMs: 30 * 60 * 1000,
        },
        "tasks.get": { maxResultBytes: 5 * 1024 * 1024 },
        "tasks.find": { maxResultBytes: 5 * 1024 * 1024 },
        "tasks.retry": { maxResultBytes: 5 * 1024 * 1024, timeoutMs: 30 * 60 * 1000 },
        "tasks.cancel": { maxResultBytes: 5 * 1024 * 1024 },
        "process.get": { maxResultBytes: 2 * 1024 * 1024 },
        "process.write": { maxParamsBytes: 128 * 1024 },
        "media.document.set": { maxParamsBytes: 2 * 1024 * 1024 + 8192 },
        "media.document.get": { maxResultBytes: 2 * 1024 * 1024 + 8192 },
      },
    },
    limitations: [] as string[],
  };
}
