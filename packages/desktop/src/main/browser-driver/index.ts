/** BrowserBridge hosts. Production Electron actions use Puppeteer. */

export {
  driverFor,
  acquireElectronBrowser,
  authorizeElectronBrowser,
  releaseElectronBrowser,
} from "./electron-cdp.js";
export { handleBrowserAction } from "./automation-host.js";
export type { BrowserActionRequest, AutomationDeps } from "./automation-host.js";
export { isDomainAllowed, isSensitiveAction, DEFAULT_POLICY } from "./policy.js";
export type { BrowserAutomationPolicy } from "./policy.js";
export { parseBrowserActionLine, buildBrowserActionReply } from "./intercept.js";
export { activeGuest, registerGuest } from "./active-guest.js";
export { loadBrowserAutomationPolicy } from "./load-policy.js";
export {
  BackgroundBrowserRuntime,
  backgroundBrowserRuntime,
  backgroundBrowserPartition,
} from "./background-runtime.js";
export type {
  BackgroundBrowserAcquireOptions,
  BackgroundBrowserLease,
  BackgroundBrowserRuntimeLike,
  BackgroundBrowserRuntimeOptions,
} from "./background-runtime.js";
