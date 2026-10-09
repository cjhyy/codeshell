import type { BrowserWindow, SafeStorage } from "electron";
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

/** Compose optional cloud identity and its remote-access lifecycle without starting either. */
export function createDesktopRemoteServices(options: {
  userDataDir: string;
  environmentDir: string;
  safeStorage: Pick<
    SafeStorage,
    "isEncryptionAvailable" | "getSelectedStorageBackend" | "encryptString" | "decryptString"
  >;
  windows: () => Iterable<BrowserWindow>;
  openExternal: (url: string) => Promise<void>;
  host: RemoteHostManager;
  tunnel: TunnelManager;
  binary: CloudflaredBinary;
  passcode: AccessPasscode;
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
    retireRelay: (identity) => mobileRemoteController.retireAccountRelay(identity),
    changed: (status) => {
      for (const window of options.windows())
        if (!window.isDestroyed()) window.webContents.send("cloudAccount:statusChanged", status);
    },
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
  return { cloudAccountManager, mobileRemoteController };
}
