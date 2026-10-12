import type { BrowserWindow, IpcMain, SafeStorage, WebContents } from "electron";
import { resolve } from "node:path";
import type {
  AccessPasscode,
  CloudflaredBinary,
  RemoteHostManager,
  TunnelManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import { CloudAccountManager } from "./cloud-account-manager.js";
import { CloudAccountStore } from "./cloud-account-store.js";
import { DeviceRelayStore, type RelaySecretCipher } from "./device-relay-store.js";
import { MobileRemoteController } from "./mobile-remote-controller.js";
import { registerCloudAccountIpc } from "./cloud-account-ipc.js";
import { registerDeviceRelayIpc } from "./device-relay-ipc.js";
import type { PrepareAccountGitHubLink } from "./account-github-link.js";
import { CloudManagementManager, type ManagedCloudWindows } from "./cloud-management-manager.js";

/** Compose optional cloud identity and its remote-access lifecycle without starting either. */
export function createDesktopRemoteServices(options: {
  ipcMain: Pick<IpcMain, "handle">;
  userDataDir: string;
  environmentDir: string;
  safeStorage: Pick<
    SafeStorage,
    "isEncryptionAvailable" | "getSelectedStorageBackend" | "encryptString" | "decryptString"
  >;
  windows: () => Iterable<BrowserWindow>;
  openExternal: (url: string) => Promise<void>;
  prepareGitHubLink?: PrepareAccountGitHubLink;
  host: RemoteHostManager;
  tunnel: TunnelManager;
  binary: CloudflaredBinary;
  passcode: AccessPasscode;
  cloudWindows: ManagedCloudWindows;
}) {
  const cipher: RelaySecretCipher = {
    available: () =>
      options.safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" ||
        options.safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: (value) => options.safeStorage.encryptString(value),
    decrypt: (value) => options.safeStorage.decryptString(value),
  };
  const cloudAccountManager = new CloudAccountManager({
    store: new CloudAccountStore(
      resolve(options.userDataDir, "cloud-account", "session.enc"),
      cipher,
    ),
    openExternal: options.openExternal,
    prepareGitHubLink: options.prepareGitHubLink,
    retireRelay: async (identity) => {
      const results = await Promise.allSettled([
        mobileRemoteController.retireAccountRelay(identity),
        cloudManagementManager.retireAccount(identity),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
    changed: (status) => {
      for (const window of options.windows())
        if (!window.isDestroyed()) window.webContents.send("cloudAccount:statusChanged", status);
    },
  });
  const cloudManagementManager = new CloudManagementManager({
    account: cloudAccountManager,
    windows: options.cloudWindows,
  });
  const mobileRemoteController = new MobileRemoteController({
    account: cloudAccountManager,
    host: options.host,
    tunnel: options.tunnel,
    binary: options.binary,
    passcode: options.passcode,
    environmentDir: options.environmentDir,
    store: new DeviceRelayStore(resolve(options.userDataDir, "mobile-remote", "relay.enc"), cipher),
    changed: (status) => {
      for (const window of options.windows()) {
        if (!window.isDestroyed())
          window.webContents.send("mobileRemote:relayStatusChanged", status);
      }
    },
  });
  const isMainWindow = (contents: WebContents) =>
    [...options.windows()].some(
      (window) => !window.isDestroyed() && window.webContents === contents,
    );
  registerCloudAccountIpc({ ipcMain: options.ipcMain, manager: cloudAccountManager, isMainWindow });
  registerDeviceRelayIpc({
    ipcMain: options.ipcMain,
    controller: mobileRemoteController,
    isMainWindow,
  });
  return { cloudAccountManager, mobileRemoteController, cloudManagementManager };
}
