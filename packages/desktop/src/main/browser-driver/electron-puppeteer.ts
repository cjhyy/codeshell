import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  connect,
  ExtensionTransport,
  type Browser,
  type ConnectionTransport,
} from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import { PuppeteerBrowserDriver } from "../../browser-library/puppeteer-browser-driver.js";
import { captureElectronPage } from "./electron-screenshot.js";

const CONNECT_TIMEOUT_MS = 10_000;
const PAUSED =
  "Browser control is paused. After the user finishes, explicitly resume control and take a new snapshot.";
type DebuggerEventListener = (
  source: { tabId: number; sessionId?: string },
  method: string,
  params?: object,
) => void;
interface TargetConnection {
  wc: WebContents;
  token: number;
  active: boolean;
  ownsAttachment: boolean;
  childSessions: Set<string>;
  transport?: ConnectionTransport;
  browser?: Browser;
  driver?: PuppeteerBrowserDriver;
  pending?: Promise<PuppeteerBrowserDriver>;
  cancel?: (error: Error) => void;
  onMessage: (...args: any[]) => void;
  onDetach: (...args: any[]) => void;
  onDevTools: () => void;
  onDestroyed: () => void;
}

// A token identifies a connection generation, not a reusable webContents id.
let nextToken = 1;
const routes = new Map<number, TargetConnection>();
const targets = new WeakMap<WebContents, TargetConnection>();
const paused = new WeakSet<WebContents>();
const listeners = new Set<DebuggerEventListener>();
function route(token: number): TargetConnection {
  const target = routes.get(token);
  if (!target?.active || target.wc.isDestroyed()) throw new Error(PAUSED);
  return target;
}

/** Stable single facade for the official ExtensionTransport. This is our
 * Electron adapter, not an official upstream Electron integration. */
const debuggerFacade = {
  async attach({ tabId }: { tabId: number }, version: string) {
    const target = route(tabId);
    if (target.wc.isDevToolsOpened?.() || target.wc.debugger.isAttached()) {
      throw new Error(
        "Browser debugger is already controlled; close DevTools before explicitly resuming.",
      );
    }
    target.wc.debugger.attach(version);
    target.ownsAttachment = true;
  },
  async detach({ tabId }: { tabId: number }) {
    const target = routes.get(tabId);
    if (target?.active) invalidate(target, true);
  },
  async sendCommand(
    { tabId, sessionId }: { tabId: number; sessionId?: string },
    method: string,
    params?: object,
  ) {
    const target = route(tabId);
    if (
      method.startsWith("Browser.") ||
      (method.startsWith("Target.") && method !== "Target.setAutoAttach")
    ) {
      throw new Error(`Browser-wide command is outside this target's grant: ${method}`);
    }
    if (sessionId && !target.childSessions.has(sessionId)) {
      // Also rejects the upstream synthetic tab resume, which Puppeteer
      // tolerates. No private synthetic session names enter our routing table.
      throw new Error("Unknown child debugger session");
    }
    return target.wc.debugger.sendCommand(method, params, sessionId);
  },
  onEvent: {
    addListener(listener: DebuggerEventListener) {
      listeners.add(listener);
    },
    removeListener(listener: DebuggerEventListener) {
      listeners.delete(listener);
    },
  },
};
function installFacade(): void {
  const globals = globalThis as typeof globalThis & { chrome?: { debugger?: unknown } };
  if (globals.chrome?.debugger === debuggerFacade) return;
  if (globals.chrome?.debugger)
    throw new Error("An incompatible chrome.debugger facade is already installed");
  if (globals.chrome) Object.defineProperty(globals.chrome, "debugger", { value: debuggerFacade });
  else Object.defineProperty(globals, "chrome", { value: { debugger: debuggerFacade } });
}
function invalidate(target: TargetConnection, detach: boolean): void {
  if (!target.active) return;
  target.active = false;
  paused.add(target.wc);
  routes.delete(target.token);
  target.wc.debugger.removeListener("message", target.onMessage);
  target.wc.debugger.removeListener("detach", target.onDetach);
  target.wc.removeListener("destroyed", target.onDestroyed);
  target.wc.removeListener("devtools-opened", target.onDevTools);
  target.cancel?.(new Error(PAUSED));
  target.driver?.dispose();
  // Cancel protocol waits synchronously. The old token has already been
  // removed, so a late transport.close cannot detach a new connection.
  target.transport?.onclose?.();
  target.transport?.close();
  void target.browser?.disconnect().catch(() => undefined);
  if (detach && target.ownsAttachment && !target.wc.isDestroyed()) {
    try {
      if (target.wc.debugger.isAttached()) target.wc.debugger.detach();
    } catch {
      /* target gone */
    }
  }
  target.childSessions.clear();
}
/** Release automation without closing or navigating the exact target. */
export function releaseElectronBrowser(wc: WebContents): void {
  paused.add(wc);
  const target = targets.get(wc);
  if (target) invalidate(target, true);
}
/** Explicit authorization; ordinary repeated tool calls must use get instead. */
export function acquireElectronBrowser(wc: WebContents): Promise<PuppeteerBrowserDriver> {
  releaseElectronBrowser(wc);
  paused.delete(wc);
  return getElectronBrowser(wc);
}
/** Record a new explicit grant without attaching until its first operation. */
export function authorizeElectronBrowser(wc: WebContents): void {
  releaseElectronBrowser(wc);
  paused.delete(wc);
}
/** First use connects lazily. A released/detached target never reconnects here. */
export function getElectronBrowser(wc: WebContents): Promise<PuppeteerBrowserDriver> {
  if (wc.isDestroyed()) return Promise.reject(new Error("Browser target is closed"));
  if (paused.has(wc)) return Promise.reject(new Error(PAUSED));
  const previous = targets.get(wc);
  if (previous?.active && previous.pending) return previous.pending;
  installFacade();
  const target: TargetConnection = {
    wc,
    token: nextToken++,
    active: true,
    ownsAttachment: false,
    childSessions: new Set(),
    onMessage: (_event, method, params, sessionId) => {
      if (!target.active) return;
      if (method === "Target.attachedToTarget" && params?.sessionId)
        target.childSessions.add(params.sessionId);
      if (method === "Target.detachedFromTarget" && params?.sessionId)
        target.childSessions.delete(params.sessionId);
      // Official ExtensionTransport filters each event by its connection token.
      for (const listener of listeners)
        listener({ tabId: target.token, sessionId: sessionId || undefined }, method, params);
    },
    onDetach: () => invalidate(target, false),
    onDevTools: () => invalidate(target, true),
    onDestroyed: () => invalidate(target, false),
  };
  targets.set(wc, target);
  routes.set(target.token, target);
  wc.debugger.on("message", target.onMessage);
  wc.debugger.on("detach", target.onDetach);
  wc.once("destroyed", target.onDestroyed);
  wc.on("devtools-opened", target.onDevTools);
  const cancelled = new Promise<never>((_resolve, reject) => {
    target.cancel = reject;
  });
  const timer = setTimeout(() => invalidate(target, true), CONNECT_TIMEOUT_MS);
  const opening = (async () => {
    const transport = await ExtensionTransport.connectTab(target.token);
    if (!target.active) {
      transport.close();
      throw new Error(PAUSED);
    }
    target.transport = transport;
    const browser = await connect({ transport, defaultViewport: null, protocolTimeout: 5000 });
    if (!target.active) {
      await browser.disconnect();
      throw new Error(PAUSED);
    }
    target.browser = browser;
    const pages = await browser.pages();
    if (!target.active) throw new Error(PAUSED);
    if (pages.length !== 1)
      throw new Error("Single-target browser connection returned an invalid page set");
    target.driver = new PuppeteerBrowserDriver(pages[0], {
      documentNamespace: `electron:${randomUUID()}`,
      captureScreenshot: (request) => captureElectronPage(wc, request),
      isActive: () => target.active,
    });
    return target.driver;
  })();
  target.pending = Promise.race([opening, cancelled])
    .catch((error) => {
      invalidate(target, true);
      throw error;
    })
    .finally(() => clearTimeout(timer));
  return target.pending;
}
