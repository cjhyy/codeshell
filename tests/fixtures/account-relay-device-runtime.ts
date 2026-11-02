// Test-only composition. Services is dynamically loaded by the isolated fixture,
// never by production Host or Desktop dependencies.
export { CloudAccountManager } from "../../packages/desktop/src/main/cloud-account-manager.js";
export { CloudAccountStore } from "../../packages/desktop/src/main/cloud-account-store.js";
export { MobileRemoteController } from "../../packages/desktop/src/main/mobile-remote-controller.js";
export { DeviceRelayStore } from "../../packages/desktop/src/main/device-relay-store.js";
export { AccountDeviceService } from "../../packages/desktop/src/main/account-device-service.js";
export {
  AccessPasscode,
  RemoteHostManager,
  TrustedDeviceStore,
} from "@cjhyy/code-shell-server/mobile-remote";
export { createRelayByteStream } from "@cjhyy/code-shell-server/remote-relay";
