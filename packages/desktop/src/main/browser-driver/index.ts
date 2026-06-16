/**
 * browser-driver — self-contained module that implements core's BrowserBridge
 * by driving a browser target over CDP. Decoupled from UI: the core driver
 * (cdp-driver.ts) needs only a CdpSender; the Electron adapter (electron-cdp.ts)
 * is the sole Electron touchpoint. Designed to be extractable into its own
 * package later, and reusable for both the visible webview (user-present) and a
 * hidden BrowserWindow (unattended), per the MVP spec.
 *
 * Public surface:
 *  - CdpBrowserDriver: the UI-agnostic BrowserBridge implementation
 *  - driverFor / withAttached / attach·detachDebugger: Electron webContents glue
 */

export { CdpBrowserDriver } from "./cdp-driver.js";
export type { CdpSender, PageInfo } from "./cdp-driver.js";
export { driverFor, withAttached, attachDebugger, detachDebugger } from "./electron-cdp.js";
export { handleBrowserAction } from "./automation-host.js";
export type { BrowserActionRequest, AutomationDeps } from "./automation-host.js";
export { isDomainAllowed, isSensitiveAction, DEFAULT_POLICY } from "./policy.js";
export type { BrowserAutomationPolicy } from "./policy.js";
export { parseBrowserActionLine, buildBrowserActionReply } from "./intercept.js";
export { activeGuest, registerGuest } from "./active-guest.js";
export { loadBrowserAutomationPolicy } from "./load-policy.js";
