import { app, ipcMain } from "electron";
import { showSystemNotification } from "./system-notification.js";
import { ExternalRuntimeService } from "./external-runtime-service.js";
import { setProjectTrustWithRevocation } from "./project-trust-lifecycle.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { loadRecents } from "./recents-store.js";
import { updateHostedProjectTrust } from "./hosted-project-trust.js";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import type { IpcMainInvokeEvent } from "electron";
import { getTrust, summarizeProjectTrustRisks, type TrustLevel } from "./trust-store.js";

export interface TrustNotificationIpcDeps {
  host: { callBusiness: CallShellBusiness; documentSignal(event: IpcMainInvokeEvent): AbortSignal };
  externalRuntimeService: () => ExternalRuntimeService | null;
}

/** Project trust, recents, native notification and dock-badge routes. */
export function registerTrustNotificationIpc(deps: TrustNotificationIpcDeps) {
  ipcMain.handle("trust:get", async (_e, p: string) => {
    if (typeof p !== "string") throw new Error("trust:get requires path");
    return getTrust(await requireRendererProjectPath(p));
  });

  ipcMain.handle("trust:set", async (event, p: string, level: TrustLevel) => {
    const signal = deps.host.documentSignal(event);
    if (typeof p !== "string") throw new Error("trust:set requires path");
    if (level !== "trusted" && level !== "untrusted") throw new Error("invalid level");
    await setProjectTrustWithRevocation(await requireRendererProjectPath(p), level, {
      setTrust: (path, level) =>
        updateHostedProjectTrust(deps.host.callBusiness, path, level, signal),
      revokeExternalRuntimeTrust: async (cwd) =>
        deps.externalRuntimeService()?.revokeProjectTrust(cwd),
    });
  });

  ipcMain.handle("trust:risks", async (_e, p: string) => {
    if (typeof p !== "string") throw new Error("trust:risks requires path");
    return summarizeProjectTrustRisks(await requireRendererProjectPath(p));
  });

  ipcMain.handle("recents:list", async () => loadRecents());

  ipcMain.handle(
    "notify:show",
    async (_e, opts: { title: string; body?: string; subtitle?: string }) => {
      if (
        !opts ||
        typeof opts.title !== "string" ||
        !opts.title ||
        opts.title.length > 512 ||
        (opts.body !== undefined && (typeof opts.body !== "string" || opts.body.length > 4_096)) ||
        (opts.subtitle !== undefined &&
          (typeof opts.subtitle !== "string" || opts.subtitle.length > 1_024))
      ) {
        throw new Error("notify:show requires bounded text");
      }
      showSystemNotification(opts);
    },
  );

  ipcMain.handle("badge:set", async (_e, count: number) => {
    if (typeof count !== "number") throw new Error("badge:set requires number");
    if (process.platform === "darwin") {
      app.dock?.setBadge(count > 0 ? String(count) : "");
    } else {
      app.setBadgeCount?.(count);
    }
  });
}
