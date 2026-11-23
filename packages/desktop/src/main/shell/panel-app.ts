import { BrowserWindow, WebContentsView, ipcMain } from "electron";
import { resolve } from "node:path";
import { materializeDesktopCookie } from "../desktop-cookie-lease.js";
import { migrateCredentialStore } from "../credential-migration.js";
import {
  desktopCookieHost,
  readDesktopCookie,
  runDesktopCredentialOperation,
} from "../credential-file-client.js";
import { cookieCredentialAutoRefresh } from "../cookie-credential-auto-refresh.js";
import { loginAndCaptureCookies } from "../credentials-login/index.js";
import { restoreCookieCredentialToBrowser } from "../cookie-credential-browser.js";
import { browserPartitionForBucket } from "../renderer-browser-session-ipc-authority.js";
import { cleanupLease } from "../credentials-service.js";
import { preparePanelApp, validatePanelAppEntryUrl } from "../panel-app-protocol.js";
import { PanelAppWindows } from "../panel-app-windows.js";
import type { PanelAppBridge } from "../panel-app-bridge.js";
import type { PanelAppBridgeOptions } from "../panel-app-bridge-types.js";

export function registerPanelWindowShell(
  panelAppBridge: PanelAppBridge,
  mainWindows: Set<BrowserWindow>,
  mainDirectory: string,
) {
  const panelAppWindows = new PanelAppWindows({
    bridge: panelAppBridge,
    prepare: preparePanelApp,
    validateEntry: validatePanelAppEntryUrl,
    ownerWindow: (id) => BrowserWindow.fromId(id),
    createWindow: (options) => new BrowserWindow(options),
    createView: (options) => new WebContentsView(options),
    preloadPath: resolve(mainDirectory, "..", "preload", "panel-app.cjs"),
  });
  ipcMain.handle("panel-apps:open-window", async (event, target) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || !mainWindows.has(parent) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Panel windows can only be opened from their Desktop tab");
    }
    await panelAppWindows.open(event.sender, target);
  });
}

function reloadBucket(bucket: string | undefined) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("browser:reload", { bucket });
  }
}

/** Bind the native login window and Electron cookie partition to the credential store. */
export function createPanelCookieAdapter(
  onSaved: (cwd: string | undefined) => void,
): NonNullable<PanelAppBridgeOptions["cookieCredentials"]> {
  return {
    taskCredentials: async (cwd) => {
      await migrateCredentialStore(cwd);
      return runDesktopCredentialOperation(cwd, ["user", "project"], undefined, (s) => s.list());
    },
    list: async (cwd) => {
      await migrateCredentialStore(cwd);
      const credentials = await runDesktopCredentialOperation(
        cwd,
        ["user", "project"],
        undefined,
        (store) =>
          store
            .listWithSources("full")
            .credentials.filter(({ credential }) => credential.type === "cookie")
            .map(({ credential, source }) => ({
              credential,
              approvalIdentity: store.approvalIdentity(source, credential),
            })),
      );
      if (!credentials.length) return [];
      const inspections = await desktopCookieHost()("cookies/inspect", {
        secrets: credentials.map(({ credential }) => credential.secret ?? "[]"),
      });
      return credentials.map(({ credential, approvalIdentity }, index) => ({
        id: credential.id,
        label: credential.label,
        domain: credential.meta?.domain,
        platform: credential.meta?.platform,
        appUrl: credential.meta?.appUrl,
        autoUseByAI: credential.autoUseByAI,
        autoInjectByAI: credential.autoInjectByAI,
        approvalIdentity,
        ...inspections[index],
      }));
    },
    loginAndSave: async ({ appId, providerId, providerLabel, url, cwd, bucket }) => {
      const capture = await loginAndCaptureCookies({
        url,
        platform: providerLabel,
        fullCapture: true,
      });
      if (!capture.ok) return capture;
      if (capture.jar.length === 0) {
        return { ok: false, error: "登录窗口没有捕获到 Cookie，请确认登录成功后再保存" };
      }
      const credentialId = `panel-${appId}__${providerId}`;
      const accountLabel =
        typeof capture.suggestedLabel === "string" && capture.suggestedLabel.trim()
          ? `${providerLabel} · ${capture.suggestedLabel.trim().slice(0, 80)}`
          : `${providerLabel} 登录`;
      cookieCredentialAutoRefresh.detachForCredential(cwd, credentialId, "user");
      await runDesktopCredentialOperation(cwd, ["user"], "user", (store) => {
        const previous = store.resolve(credentialId);
        store.save("user", {
          id: credentialId,
          type: "cookie",
          label: accountLabel,
          secret: JSON.stringify(capture.jar),
          meta: {
            ...(previous?.type === "cookie" ? previous.meta : {}),
            appUrl: url,
            platform: providerLabel,
            domain: capture.domain,
            scope: "all",
            switchMode: "merge",
          },
        });
      });
      onSaved(cwd);

      let restoredCount = 0;
      const partition = browserPartitionForBucket(bucket);
      if (partition) {
        // Resolve the user record just saved, without project shadowing.
        const resolved = await readDesktopCookie(undefined, credentialId, "full");
        if (!resolved.ok) throw new Error(resolved.error);
        const restored = await restoreCookieCredentialToBrowser({
          targetSession: partition,
          sessionCwd: cwd,
          credentialId,
          credentialScope: "full",
          resolved,
        });
        restoredCount = restored.count;
        reloadBucket(bucket);
      }
      return {
        ok: true,
        credential: {
          id: credentialId,
          label: accountLabel,
          health: "ready",
          domain: capture.domain,
          platform: providerLabel,
          appUrl: url,
        },
        cookieCount: capture.jar.length,
        restoredCount,
      };
    },
    restore: async ({ credentialId, cwd, bucket }) => {
      const partition = browserPartitionForBucket(bucket);
      if (!partition) throw new Error("Cookie restore requires an active task browser");
      await migrateCredentialStore(cwd);
      const resolved = await readDesktopCookie(cwd, credentialId, "full");
      if (!resolved.ok) return { invalid: true };
      const result = await restoreCookieCredentialToBrowser({
        targetSession: partition,
        sessionCwd: cwd,
        credentialId,
        credentialScope: "full",
        resolved,
      });
      reloadBucket(bucket);
      return { count: result.count };
    },
    materialize: async ({ credentialId, cwd, expectedApprovalIdentity, assertCurrent }) => {
      await migrateCredentialStore(cwd);
      try {
        const materialized = await materializeDesktopCookie(
          cwd,
          credentialId,
          "full",
          expectedApprovalIdentity,
          assertCurrent,
        );
        return {
          filePath: materialized.cookiesFile,
          count: materialized.count,
          cleanup: () => cleanupLease(materialized.cookiesFile),
        };
      } catch {
        return { invalid: true as const };
      }
    },
  };
}
