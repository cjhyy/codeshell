import type { CloudEffects } from "./desktop-host/cloud-effects.js";
import type { NativeRemoteClient } from "./desktop-host/remote-client.js";
import {
  AccountFeatureService,
  accountLocalConditions,
  bindAccountFeatureLifecycle,
  registerAccountFeatureIpc,
} from "./account-features.js";
import type { App, BrowserWindow, IpcMain, SafeStorage, WebContents } from "electron";
import { resolve } from "node:path";
import type {
  AccessPasscode,
  CloudflaredBinary,
  RemoteHostManager,
  TunnelManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import { AccountDeviceService } from "./account-device-service.js";
import { createAccountRemoteAuthorizer } from "./account-device-passkey.js";
import { registerAccountDeviceIpc } from "./account-device-ipc.js";
import { CloudAccountManager } from "./cloud-account-manager.js";
import {
  AsyncEncryptedGrantStore,
  type AsyncGrantCipher,
} from "@cjhyy/code-shell-core/internal/storage";
import { CloudAccountStore } from "./cloud-account-store.js";
import { validRegistration } from "./device-relay-store.js";
import { MobileRemoteController } from "./mobile-remote-controller.js";
import { registerCloudAccountIpc } from "./cloud-account-ipc.js";
import { registerDeviceRelayIpc } from "./device-relay-ipc.js";
import { registerCloudWorkbenchIpc } from "./cloud-workbench-ipc.js";
import type { PrepareAccountGitHubLink } from "./account-github-link.js";
import { CloudManagementManager, type ManagedCloudWindows } from "./cloud-management-manager.js";
import { createLinkAccountAccess } from "./link-account-access.js";
import { bindDesktopAccountLifecycle } from "./desktop-account-lifecycle.js";

/** Compose optional cloud identity and its remote-access lifecycle without starting either. */
export function createDesktopRemoteServices(options: {
  app?: Pick<App, "on" | "once" | "whenReady">;
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  userDataDir: string;
  environmentDir: string;
  remote?: NativeRemoteClient;
  documentSignal?: (event: Electron.IpcMainInvokeEvent) => AbortSignal;
  safeStorage: Pick<
    SafeStorage,
    | "isAsyncEncryptionAvailable"
    | "getSelectedStorageBackend"
    | "encryptStringAsync"
    | "decryptStringAsync"
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
  const cipher: AsyncGrantCipher = {
    available: async () =>
      (await options.safeStorage.isAsyncEncryptionAvailable()) &&
      (process.platform !== "linux" ||
        !["unknown", "basic_text"].includes(options.safeStorage.getSelectedStorageBackend())),
    encrypt: (value) => options.safeStorage.encryptStringAsync(value),
    decrypt: async (value) => (await options.safeStorage.decryptStringAsync(value)).result,
  };
  const grantFile = resolve(options.userDataDir, "cloud-account", "session.enc");
  const effects: Omit<CloudEffects, "custody"> = {
    openExternal: options.openExternal,
    prepareGitHubLink: options.prepareGitHubLink,
    activateRelay: async (identity, authorized) => {
      await accountFeatures.refresh();
      const offered = accountFeatures.snapshot();
      if (
        offered["devices.dispatch"].state === "hidden" &&
        offered["relay.phone"].state === "hidden"
      )
        return;
      accountFeatures.requireEntitled(
        offered["devices.dispatch"].state !== "hidden" ? "devices.dispatch" : "relay.phone",
      );
      if (authorized()) await mobileRemoteController.activateAccountRelay(identity, authorized);
    },
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
  };
  const hosted = options.remote?.createAccount({
    ...effects,
    custody: CloudAccountStore.custody(grantFile, cipher),
  });
  const cloudAccountManager =
    hosted ??
    new CloudAccountManager({
      ...effects,
      store: CloudAccountStore.asynchronous(grantFile, cipher),
    });
  const cloudManagementManager = new CloudManagementManager({
    account: cloudAccountManager,
    windows: options.cloudWindows,
    requireFeature: () => accountFeatures.requireReady("cloud.projects"),
  });
  const mobileRemoteController = new MobileRemoteController({
    account: cloudAccountManager,
    connectorFactory: options.remote?.relay.create,
    host: options.host,
    tunnel: options.tunnel,
    binary: options.binary,
    passcode: options.passcode,
    environmentDir: options.environmentDir,
    listProjects: options.listProjects,
    store: new AsyncEncryptedGrantStore(
      resolve(options.userDataDir, "mobile-remote", "relay.enc"),
      cipher,
      validRegistration,
    ),
    changed: (status) => {
      accountFeatures.localChanged();
      for (const window of options.windows()) {
        if (!window.isDestroyed())
          window.webContents.send("mobileRemote:relayStatusChanged", status);
      }
    },
  });
  if (options.remote)
    options.remote.lostRelay = () => {
      void mobileRemoteController.hostRelayDisconnected().catch(() => {});
    };
  const accountFeatures = new AccountFeatureService({
    account: cloudAccountManager,
    supported: [
      "links.remote",
      "cloud.projects",
      "relay.phone",
      "devices.dispatch",
      "devices.directory",
    ],
    local: (status) => accountLocalConditions(status, mobileRemoteController.relayStatus()),
  });
  registerAccountFeatureIpc({
    ipcMain: options.ipcMain,
    service: accountFeatures,
    windows: options.windows,
  });
  if (options.app) bindAccountFeatureLifecycle(options.app, accountFeatures, options.windows);
  const accountDeviceService = new AccountDeviceService({
    authorizeTarget: createAccountRemoteAuthorizer({ openExternal: options.openExternal }),
    identity: () => {
      const status = cloudAccountManager.status();
      return status.state === "signed-in" && status.origin && status.account
        ? { origin: status.origin, accountId: status.account.id }
        : undefined;
    },
    credential: (identity, signal) =>
      cloudAccountManager.getCredential(identity.origin, identity.accountId, signal),
    sourceProof: (identity, signal) => mobileRemoteController.accountRelaySource(identity, signal),
    relayOrigin: async (identity, scope) => {
      await accountFeatures.refresh();
      accountFeatures.requireReady(
        scope === "directory" ? "devices.directory" : "devices.dispatch",
      );
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
    ...(hosted &&
      options.documentSignal && {
        withDocument: (event, callback) =>
          hosted.withDocument(options.documentSignal!(event), callback),
      }),
    openExternal: options.openExternal,
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
  if (options.app)
    bindDesktopAccountLifecycle(
      options.app,
      cloudAccountManager,
      mobileRemoteController,
      options.windows,
    );
  return {
    captureLinkAccount: createLinkAccountAccess(cloudAccountManager, () =>
      accountFeatures.requireReady("links.remote"),
    ),
    accountFeatures,
    cloudAccountManager,
    mobileRemoteController,
    cloudManagementManager,
    accountDeviceService,
  };
}
