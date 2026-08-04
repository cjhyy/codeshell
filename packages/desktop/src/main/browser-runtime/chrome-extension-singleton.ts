import { builtInBrowserHandoffGrants } from "./built-in-handoff.js";
import { ChromeExtensionRuntimeService } from "./chrome-extension-runtime.js";
import { browserRuntime } from "./runtime.js";
import { interactiveBrowserRuntimeOwner } from "./dispatch-owner.js";

export const chromeExtensionRuntimeService = new ChromeExtensionRuntimeService({
  onGranted: (sessionId) => {
    builtInBrowserHandoffGrants.revoke(sessionId);
    browserRuntime.close(interactiveBrowserRuntimeOwner(sessionId));
  },
});
