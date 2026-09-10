import {
  ExtensionBrowserSessions,
  MAX_NATIVE_COMMAND_BYTES,
  MAX_NATIVE_RESPONSE_BYTES,
} from "./browser-sessions.js";
import { connectGrantedTab } from "./puppeteer-connection.js";

declare const chrome: any;

const NATIVE_HOST = "com.cjhyy.codeshell.browser_runtime";
const REQUEST_TIMEOUT_MS = 15_000;
const GRANT_TTL_MS = 30 * 60 * 1000;
const sessions = new ExtensionBrowserSessions(connectGrantedTab);
const pending = new Map<
  string,
  {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let nativePort: any = null;
let nextRequestId = 1;

// A restarted worker cannot inherit a desktop grant or Puppeteer's old event
// subscriptions. Remove orphaned attachments and require fresh explicit pairing.
const initialized = (async () => {
  const stored = await chrome.storage.session.get("attachedTabs");
  await Promise.all(
    (Array.isArray(stored.attachedTabs) ? stored.attachedTabs : [])
      .filter(Number.isSafeInteger)
      .map((tabId: number) => chrome.debugger.detach({ tabId }).catch(() => undefined)),
  );
  await persistTabs();
})();

async function persistTabs(): Promise<void> {
  await chrome.storage.session.set({ attachedTabs: sessions.ids() });
}

function post(port: any, message: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_NATIVE_RESPONSE_BYTES) {
    throw new Error("Chrome response exceeds native message size limit");
  }
  port.postMessage(message);
}

function nativeConnection(): any {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  port.onMessage.addListener((message: any) => {
    if (message && typeof message.replyTo === "string") {
      const request = pending.get(message.replyTo);
      if (!request) return;
      pending.delete(message.replyTo);
      clearTimeout(request.timer);
      if (message.ok === false)
        request.reject(new Error(message.error || "CodeShell rejected request"));
      else request.resolve(message.result);
    } else {
      void handleNativeCommand(port, message);
    }
  });
  port.onDisconnect.addListener(() => {
    if (nativePort !== port) return;
    const error = chrome.runtime.lastError?.message || "CodeShell native host disconnected";
    nativePort = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(error));
    }
    pending.clear();
    void sessions.revokeAll().then(persistTabs);
  });
  post(port, { type: "hello", extensionId: chrome.runtime.id, protocolVersion: 2 });
  return port;
}

function nativeRequest(type: string, payload: Record<string, unknown> = {}): Promise<any> {
  const id = `ext-${Date.now()}-${nextRequestId++}`;
  const port = nativeConnection();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CodeShell native request timed out"));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    post(port, { id, type, ...payload });
  });
}

async function handleNativeCommand(port: any, message: any): Promise<void> {
  if (!message || typeof message.id !== "string") return;
  try {
    await initialized;
    if (nativePort !== port) throw new Error("native channel disconnected");
    if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_NATIVE_COMMAND_BYTES) {
      throw new Error("Chrome command exceeds native message size limit");
    }
    const tabId = message.tabId;
    const grantId = message.grantId;
    if (
      !Number.isSafeInteger(tabId) ||
      typeof grantId !== "string" ||
      !sessions.has(tabId, grantId)
    ) {
      throw new Error("tab is not granted to this CodeShell task");
    }
    let result: unknown;
    if (message.type === "browser.action") {
      if (!message.request || typeof message.request.action !== "string")
        throw new Error("invalid browser action");
      result = await sessions.action(tabId, grantId, message.request);
      if (message.request.action === "requestTakeover") {
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (Number.isSafeInteger(tab.windowId))
          await chrome.windows.update(tab.windowId, { focused: true });
      }
    } else if (message.type === "tab.get") {
      result = sanitizeTab(await chrome.tabs.get(tabId));
    } else if (message.type === "tab.detach") {
      await sessions.revoke(tabId, grantId);
      await persistTabs();
      result = { detached: true };
    } else {
      throw new Error(`unknown native command: ${message.type}`);
    }
    if (nativePort === port) post(port, { replyTo: message.id, ok: true, result });
  } catch (error) {
    if (nativePort === port) {
      post(port, {
        replyTo: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function attachCurrentTab(code: string): Promise<unknown> {
  await initialized;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !Number.isSafeInteger(tab.id)) throw new Error("No active Chrome tab");
  if (!/^https?:/i.test(tab.url || "")) throw new Error("Only http(s) tabs can be granted");
  const tabId = tab.id as number;
  const grantId = crypto.randomUUID();
  await sessions.grant(tabId, grantId, Date.now() + GRANT_TTL_MS);
  await persistTabs();
  try {
    const result = await nativeRequest("pairing.grant", { code, grantId, tab: sanitizeTab(tab) });
    if (result?.granted?.grantId !== grantId || result?.granted?.tabId !== tabId) {
      throw new Error("CodeShell returned a different browser grant");
    }
    sessions.setExpiry(tabId, grantId, result.granted.expiresAt);
    try {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: "CodeShell Runtime", color: "blue" });
    } catch {
      /* Grouping does not change authorization. */
    }
    return result;
  } catch (error) {
    await sessions.revoke(tabId, grantId);
    await persistTabs();
    throw error;
  }
}

function sanitizeTab(tab: any) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || "",
    title: tab.title || "",
    active: Boolean(tab.active),
  };
}

chrome.runtime.onMessage.addListener(
  (message: any, _sender: unknown, sendResponse: (value: unknown) => void) => {
    let result: Promise<unknown>;
    if (message?.type === "pairing.list") result = nativeRequest("pairing.list");
    else if (message?.type === "pairing.grant")
      result = attachCurrentTab(String(message.code || ""));
    else if (message?.type === "connection.status")
      result = Promise.resolve({ connected: Boolean(nativePort), extensionId: chrome.runtime.id });
    else return false;
    void result.then(sendResponse, (error) =>
      sendResponse({ error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  },
);

async function removed(tabId: number, type: string, reason?: string): Promise<void> {
  const grantId = sessions.grantId(tabId);
  if (!grantId || (type === "tab.detached" && sessions.isPaused(tabId))) return;
  await sessions.revoke(tabId, grantId);
  await persistTabs();
  if (nativePort) post(nativePort, { type, tabId, grantId, reason });
}
chrome.debugger.onDetach.addListener((source: { tabId?: number }, reason: string) => {
  if (Number.isSafeInteger(source.tabId)) void removed(source.tabId!, "tab.detached", reason);
});
chrome.tabs.onRemoved.addListener((tabId: number) => void removed(tabId, "tab.closed"));
