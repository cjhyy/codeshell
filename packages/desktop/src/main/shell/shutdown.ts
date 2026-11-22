import { app, dialog } from "electron";
import { registerDesktopShutdown } from "../desktop-shutdown.js";
import { cancelPendingUpdateInstall } from "../updater.js";
import { disposeWorkbenchTray } from "../workbench-tray.js";
import { dlog } from "../desktop-logger.js";
import { cookieCredentialAutoRefresh } from "../cookie-credential-auto-refresh.js";
import { getCuaDriverHost } from "../computer-use/service.js";
import { closeComputerUse } from "../computer-use/desktop-setup.js";
import { chromeExtensionRuntimeService } from "../browser-runtime/index.js";

type Stop = () => void | Promise<unknown>;
export function registerNativeShutdown(options: {
  ownsDesktopInstance: boolean;
  restoreMainWindow(): Promise<unknown>;
  flushRenderers(): Promise<unknown>;
  disposeOperationBatchHost: Stop;
  disposeOperationResolutionHost: Stop;
  stopIngress(): void;
  desktopHost: { dispose: Stop };
  desktopModules: { dispose: Stop };
  withdrawWindows(): void;
  stopMimi(): readonly unknown[];
  history: Stop;
  mimiShell: { dispose: Stop };
  mobileShell: { stop: Stop; disposeUploads(): Promise<void> };
  panelAppBridge: { shutdownMedia: Stop };
  finalize(): Promise<unknown>;
}) {
  const { desktopHost, desktopModules } = options;
  registerDesktopShutdown(app, {
    ownsInstance: () => options.ownsDesktopInstance,
    flushRenderers: options.flushRenderers,
    disposeOperationResolution: async () => {
      disposeWorkbenchTray();
      await options.disposeOperationBatchHost();
      await options.disposeOperationResolutionHost();
    },
    onError: (phase, error) => dlog("main", phase, { error: String(error) }),
    cancelQuit: cancelPendingUpdateInstall,
    showFailureDialog: (request) => dialog.showMessageBox(request),
    restoreMainWindow: options.restoreMainWindow,
    async cleanup() {
      options.stopIngress();
      const desktopHostShutdown = desktopHost.dispose();
      const cookieRefreshShutdown = cookieCredentialAutoRefresh.shutdown();
      options.withdrawWindows();
      const mimiFlushes = options.stopMimi();
      // Captured providers and the embedded native CUA child may outlive their windows.
      const externalRuntimeShutdown = desktopModules.dispose();
      const cuaDriverShutdown = getCuaDriverHost()?.stop();
      const mimiPresenceShutdown = options.mimiShell.dispose();
      await Promise.allSettled([
        desktopHostShutdown,
        options.history(),
        mimiPresenceShutdown,
        options.mobileShell.stop(),
        ...mimiFlushes,
        externalRuntimeShutdown,
        cookieRefreshShutdown,
        options.panelAppBridge.shutdownMedia(),
        chromeExtensionRuntimeService.stop(),
        cuaDriverShutdown,
        closeComputerUse(),
      ]);
      await options.mobileShell.disposeUploads();
    },
    finalize: options.finalize,
  });
}
