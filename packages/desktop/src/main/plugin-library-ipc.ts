import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { NativeAutomationClient } from "./desktop-host/main-automation.js";
import { reviewedLocalPlugins } from "./reviewed-local-plugins.js";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";

/** Native mutation adapters bind each request and each local package review to its document. */
export function registerPluginLibraryIpc(
  desktopHost: {
    callBusiness: CallShellBusiness;
    documentSignal(event: IpcMainInvokeEvent): AbortSignal;
  },
  cron: Pick<NativeAutomationClient, "call">,
) {
  ipcMain.handle(
    "plugins:createAutomationFromTemplate",
    async (_e, installKey: string, templateId: string, expectedRevision: string, cwd?: string) => {
      if (
        typeof installKey !== "string" ||
        typeof templateId !== "string" ||
        typeof expectedRevision !== "string"
      ) {
        throw new Error("installKey, templateId and expectedRevision are required");
      }
      if (installKey.length > 512 || templateId.length > 512 || expectedRevision.length > 512) {
        throw new Error("plugin automation identifiers are too long");
      }
      return cron.call(
        "template",
        { installKey, templateId, expectedRevision, workspace: { cwd } },
        desktopHost.documentSignal(_e),
      );
    },
  );
  ipcMain.handle("plugins:uninstall", (event, pluginName, marketplaceName) =>
    desktopHost.callBusiness(
      "marketplace/uninstall",
      { pluginName, marketplaceName },
      desktopHost.documentSignal(event),
    ),
  );
  ipcMain.handle("plugins:uninstallLocal", (event, name: string) =>
    desktopHost.callBusiness("plugins/uninstallLocal", { name }, desktopHost.documentSignal(event)),
  );
  ipcMain.handle("plugins:update", (event, installKey) =>
    desktopHost.callBusiness(
      "marketplace/updatePlugin",
      { installKey },
      desktopHost.documentSignal(event),
    ),
  );
  ipcMain.handle("plugins:checkUpdate", (event, name: string) =>
    desktopHost.callBusiness("plugins/checkUpdate", { name }, desktopHost.documentSignal(event)),
  );
  ipcMain.handle("marketplace:add", (event, source) =>
    desktopHost.callBusiness("marketplace/add", { source }, desktopHost.documentSignal(event)),
  );
  ipcMain.handle("marketplace:addRecommended", (event, id) =>
    desktopHost.callBusiness(
      "marketplace/addRecommended",
      { id },
      desktopHost.documentSignal(event),
    ),
  );
  ipcMain.handle("marketplace:remove", (event, name) =>
    desktopHost.callBusiness("marketplace/remove", { name }, desktopHost.documentSignal(event)),
  );
  ipcMain.handle("marketplace:refresh", (event, name) =>
    desktopHost.callBusiness("marketplace/refresh", { name }, desktopHost.documentSignal(event)),
  );
  ipcMain.handle("plugins:install", (event, pluginName, marketplaceName) =>
    desktopHost.callBusiness(
      "marketplace/install",
      { pluginName, marketplaceName },
      desktopHost.documentSignal(event),
    ),
  );
  ipcMain.handle("plugins:retryInstallJob", (event, id) =>
    desktopHost.callBusiness("marketplace/retry", { id }, desktopHost.documentSignal(event)),
  );
  const localPluginReviews = reviewedLocalPlugins(desktopHost.callBusiness);
  ipcMain.handle("plugins:previewLocal", (event, input) =>
    localPluginReviews.preview(input, desktopHost.documentSignal(event)),
  );
  ipcMain.handle("plugins:installLocal", (event, input) =>
    localPluginReviews.install(input, desktopHost.documentSignal(event)),
  );
  // One approval for the whole plugin: its native entry, hooks and MCP servers.
  ipcMain.handle("plugins:approval", async (event, action: unknown, installKey: unknown) => {
    if (typeof installKey !== "string" || !installKey) {
      throw new Error("plugins:approval requires installKey");
    }
    if (action === "approve") {
      return desktopHost.callBusiness(
        "plugins/approve",
        { installKey },
        desktopHost.documentSignal(event),
      );
    }
    if (action === "revoke") {
      return desktopHost.callBusiness(
        "plugins/revoke",
        { installKey },
        desktopHost.documentSignal(event),
      );
    }
    throw new Error("plugins:approval requires approve or revoke");
  });
  ipcMain.handle("hooks:approvePlugin", async (event, installKey: string) => {
    if (typeof installKey !== "string" || !installKey) {
      throw new Error("hooks:approvePlugin requires installKey");
    }
    return desktopHost.callBusiness(
      "plugins/approveHooks",
      { installKey },
      desktopHost.documentSignal(event),
    );
  });
  ipcMain.handle("hooks:revokePlugin", async (event, installKey: string) => {
    if (typeof installKey !== "string" || !installKey) {
      throw new Error("hooks:revokePlugin requires installKey");
    }
    return desktopHost.callBusiness(
      "plugins/revokeHooks",
      { installKey },
      desktopHost.documentSignal(event),
    );
  });
  ipcMain.handle("mcp:approvePlugin", async (event, installKey: string) => {
    if (typeof installKey !== "string" || !installKey) {
      throw new Error("mcp:approvePlugin requires installKey");
    }
    return desktopHost.callBusiness(
      "plugins/approveMcp",
      { installKey },
      desktopHost.documentSignal(event),
    );
  });
  ipcMain.handle("mcp:revokePlugin", async (event, installKey: string) => {
    if (typeof installKey !== "string" || !installKey) {
      throw new Error("mcp:revokePlugin requires installKey");
    }
    return desktopHost.callBusiness(
      "plugins/revokeMcp",
      { installKey },
      desktopHost.documentSignal(event),
    );
  });
}
