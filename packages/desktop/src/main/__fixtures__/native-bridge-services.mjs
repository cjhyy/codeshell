/** Native OS services only; bridge ingress, transport and Core stay real. */
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { mock } from "bun:test";

export function installNativeBridgeServices({ stubCredentials = false } = {}) {
  const main = resolve(import.meta.dir, "..");
  mock.module("electron", () => ({
    ipcMain: new EventEmitter(),
    BrowserWindow: { fromWebContents: () => undefined },
    app: { getPath: () => process.env.HOME },
  }));
  mock.module(join(main, "desktop-logger.ts"), () => ({ dlog: () => {} }));
  mock.module(join(main, "browser-runtime/index.ts"), () => ({
    browserRuntime: {},
    builtInBrowserHandoffGrants: {},
    chromeExtensionRuntimeService: {},
    annotateBrowserRuntimeStreamEvent: (event) => event,
    beginBrowserRunForStartedRun: () => false,
    cancelBrowserActionsForStoppedRun: () => false,
    dispatchInteractiveBrowserRuntimeAction: () => {},
    releaseChildBrowserRuntime: () => {},
    activateChildBrowserRuntime: () => {},
    interactiveBrowserRuntimeOwner: () => {},
    replaceStreamEventInLine: (line) => line,
  }));
  mock.module(join(main, "credential-action.ts"), () => ({
    resolveCookieCredentialForBrowser: () => ({ ok: false }),
  }));
  mock.module(join(main, "cookie-credential-browser.ts"), () => ({
    restoreCookieCredentialToBrowser: () => {},
  }));
  mock.module(join(main, "automation-service.ts"), () => ({ reloadAutomations: () => {} }));
  mock.module(join(main, "trust-store.ts"), () => ({ getTrustCachedSync: () => "trusted" }));
  mock.module(join(main, "project-store.ts"), () => ({ getProjectStore: () => {} }));
  mock.module(join(main, "session-cwd-index.ts"), () => ({ getSessionCwdIndex: () => ({}) }));
  mock.module(join(main, "external-runtime-state.ts"), () => ({
    readExternalRuntimeBinding: () => {},
  }));
  mock.module(join(main, "session-workspace-service.ts"), () => ({
    switchSessionWorkspaceForUi: () => {},
  }));

  if (stubCredentials)
    mock.module(join(main, "credential-access-service.ts"), () => ({
      buildCredentialSnapshot: () => ({ revision: 1, entries: [] }),
      materializeCredentialCookieForWorker() {},
      resolveCredentialValueForWorker() {},
    }));
}
