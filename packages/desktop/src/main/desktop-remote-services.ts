import type { BrowserWindow, IpcMain, SafeStorage, WebContents } from "electron";
import { resolve } from "node:path";
import type {
  AccessPasscode,
  CloudflaredBinary,
  RemoteHostManager,
  TunnelManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import { AccountDeviceService } from "./account-device-service.js";
import { registerAccountDeviceIpc } from "./account-device-ipc.js";
import { CloudAccountManager } from "./cloud-account-manager.js";
import { CloudAccountStore } from "./cloud-account-store.js";
import { DeviceRelayStore, type RelaySecretCipher } from "./device-relay-store.js";
import { MobileRemoteController } from "./mobile-remote-controller.js";
import { registerCloudAccountIpc } from "./cloud-account-ipc.js";
import { registerDeviceRelayIpc } from "./device-relay-ipc.js";
import { registerCloudWorkbenchIpc } from "./cloud-workbench-ipc.js";
import type { PrepareAccountGitHubLink } from "./account-github-link.js";
import { CloudManagementManager, type ManagedCloudWindows } from "./cloud-management-manager.js";

/** Compose optional cloud identity and its remote-access lifecycle without starting either. */
export function createDesktopRemoteServices(options: {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
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
  listProjects?: () => Promise<Array<{ id: string; name: string; path: string }>>;
  openLegacyCloud: (address: unknown) => Promise<{ address: string }>;
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
    activateRelay: (identity, authorized) =>
      mobileRemoteController.activateAccountRelay(identity, authorized),
    retireRelay: async (identity) => {
      accountDeviceService.retireIdentity();
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
    listProjects: options.listProjects,
    store: new DeviceRelayStore(resolve(options.userDataDir, "mobile-remote", "relay.enc"), cipher),
    changed: (status) => {
      for (const window of options.windows()) {
        if (!window.isDestroyed())
          window.webContents.send("mobileRemote:relayStatusChanged", status);
      }
    },
  });
  const accountDeviceService = new AccountDeviceService({
    identity: () => {
      const status = cloudAccountManager.status();
      return status.state === "signed-in" && status.origin && status.account
        ? { origin: status.origin, accountId: status.account.id }
        : undefined;
    },
    credential: (identity, signal) =>
      cloudAccountManager.getCredential(identity.origin, identity.accountId, signal),
    sourceProof: (identity, signal) => mobileRemoteController.accountRelaySource(identity, signal),
    relayOrigin: async (identity) => {
      const capabilities = await cloudAccountManager.capabilities(identity.origin);
      if (!capabilities.relay?.enabled || capabilities.relay.directoryOrigin !== identity.origin)
        throw new Error("当前账号服务不支持设备协作，请升级服务。");
      return capabilities.relay.directoryOrigin;
    },
  });
  registerAccountDeviceIpc({
    ipcMain: options.ipcMain,
    service: accountDeviceService,
    windows: options.windows,
  });
  const isMainWindow = (contents: WebContents) =>
    [...options.windows()].some(
      (window) => !window.isDestroyed() && window.webContents === contents,
    );
  registerCloudAccountIpc({
    ipcMain: options.ipcMain,
    manager: cloudAccountManager,
    isMainWindow,
    focusMainWindow: (contents) => {
      const window = [...options.windows()].find(
        (candidate) => !candidate.isDestroyed() && candidate.webContents === contents,
      );
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
  });
  registerCloudWorkbenchIpc({
    ipcMain: options.ipcMain,
    manager: cloudManagementManager,
    isMainWindow,
    openLegacy: options.openLegacyCloud,
  });
  registerDeviceRelayIpc({
    ipcMain: options.ipcMain,
    controller: mobileRemoteController,
    isMainWindow,
  });
  return {
    cloudAccountManager,
    mobileRemoteController,
    cloudManagementManager,
    accountDeviceService,
  };
}
