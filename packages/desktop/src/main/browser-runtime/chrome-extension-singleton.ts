import { builtInTabClaimBackend } from "./built-in-handoff.js";
import { ChromeExtensionBackend } from "./chrome-extension-runtime.js";
import { browserRuntime } from "./runtime.js";
import { interactiveBrowserRuntimeOwner } from "./dispatch-owner.js";

export const chromeExtensionBackend = new ChromeExtensionBackend({
  onGranted: (sessionId) => {
    builtInTabClaimBackend.revoke(sessionId);
    browserRuntime.close(interactiveBrowserRuntimeOwner(sessionId));
  },
});

/** @deprecated Use chromeExtensionBackend. */
export const chromeExtensionRuntimeService = chromeExtensionBackend;
