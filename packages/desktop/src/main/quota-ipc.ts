import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { QuotaResult } from "@cjhyy/code-shell-capability-coding/orchestration";
import type { UsageProviderService } from "./usage-provider-service.js";

/** Credential-bearing requests are available only to native application main frames. */
export function registerQuotaIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => Iterable<BrowserWindow>,
  service: Pick<UsageProviderService, "listProviders" | "query">,
  getLegacyQuota: (provider: unknown) => Promise<QuotaResult>,
) {
  const trusted = (event: IpcMainInvokeEvent) =>
    Array.from(windows()).some(
      (window) => !window.isDestroyed() && window.webContents === event.sender,
    ) && event.senderFrame === event.sender.mainFrame;
  const channels: string[] = [];
  const handle = (channel: string, action: (input: unknown) => unknown) => {
    channels.push(channel);
    ipc.handle(channel, (event, input: unknown) => {
      if (!trusted(event)) throw new Error("Quota access requires an application window");
      return action(input);
    });
  };
  handle("quota:listProviders", () => service.listProviders());
  handle("quota:query", (providerId) => service.query(providerId));
  handle("quota:get", getLegacyQuota);
  return { dispose: () => channels.forEach((channel) => ipc.removeHandler(channel)) };
}
