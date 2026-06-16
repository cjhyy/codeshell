/**
 * Electron adapter — the ONLY file in browser-driver that touches Electron.
 * Turns a `WebContents` into a `CdpSender` + `PageInfo` provider for
 * CdpBrowserDriver, and owns the debugger attach/detach lifecycle.
 *
 * Per spec §7: attach the debugger only for the duration of an automation
 * action and detach after, so it doesn't permanently occupy the CDP channel
 * (which would break the user opening DevTools / the element picker on a
 * visible panel). `withAttached` wraps a unit of work in attach→work→detach,
 * but reuses an existing attachment if one is already live (idempotent).
 */

import type { WebContents } from "electron";
import { CdpBrowserDriver, type CdpSender, type PageInfo } from "./cdp-driver.js";

/** Build a CdpSender bound to a webContents' debugger. */
function senderFor(wc: WebContents): CdpSender {
  return (method, params) => wc.debugger.sendCommand(method, params ?? {});
}

function pageInfoFor(wc: WebContents): () => PageInfo {
  return () => ({ url: wc.getURL(), title: wc.getTitle() });
}

/**
 * Create a driver for a webContents. The caller is responsible for attaching
 * (via attachDebugger) before use and detaching after — or use withAttached.
 */
export function driverFor(wc: WebContents): CdpBrowserDriver {
  return new CdpBrowserDriver(senderFor(wc), pageInfoFor(wc));
}

/** Attach the debugger if not already attached. Returns true if WE attached it
 *  (so the caller knows whether to detach). Tolerates "already attached". */
export function attachDebugger(wc: WebContents): boolean {
  if (wc.debugger.isAttached()) return false;
  wc.debugger.attach("1.3");
  return true;
}

export function detachDebugger(wc: WebContents): void {
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  } catch {
    /* already detached / target gone — ignore */
  }
}

/**
 * Run `work` with the debugger attached, detaching afterwards if we were the
 * one who attached it. Keeps the CDP channel free outside automation so the
 * user's DevTools / element picker keep working on a visible panel.
 */
export async function withAttached<T>(wc: WebContents, work: (driver: CdpBrowserDriver) => Promise<T>): Promise<T> {
  const weAttached = attachDebugger(wc);
  try {
    return await work(driverFor(wc));
  } finally {
    if (weAttached) detachDebugger(wc);
  }
}
