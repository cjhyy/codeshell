const NATIVE_HOST = "com.cjhyy.codeshell.browser_runtime";
const CDP_VERSION = "1.3";
const REQUEST_TIMEOUT_MS = 15000;

let nativePort = null;
let nextRequestId = 1;
const pending = new Map();
const attachedTabs = new Set();

async function restoreAttachedTabs() {
  const stored = await chrome.storage.session.get("attachedTabs");
  for (const tabId of Array.isArray(stored.attachedTabs) ? stored.attachedTabs : []) {
    if (Number.isFinite(tabId)) attachedTabs.add(tabId);
  }
}

async function persistAttachedTabs() {
  await chrome.storage.session.set({ attachedTabs: [...attachedTabs] });
}

function nativeConnection() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  port.onMessage.addListener((message) => {
    if (message && typeof message.replyTo === "string") {
      const request = pending.get(message.replyTo);
      if (!request) return;
      pending.delete(message.replyTo);
      clearTimeout(request.timer);
      if (message.ok === false) request.reject(new Error(message.error || "CodeShell rejected request"));
      else request.resolve(message.result);
      return;
    }
    void handleNativeCommand(message);
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "CodeShell native host disconnected";
    nativePort = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(error));
    }
    pending.clear();
    // The desktop process owns every grant. If that authenticated channel is
    // gone, fail closed and remove Chrome's debugger attachment/infobar.
    for (const tabId of [...attachedTabs]) void detachTab(tabId);
  });
  port.postMessage({ type: "hello", extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
  return port;
}

function nativeRequest(type, payload = {}) {
  const id = `ext-${Date.now()}-${nextRequestId++}`;
  const port = nativeConnection();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CodeShell native request timed out"));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ id, type, ...payload });
  });
}

async function handleNativeCommand(message) {
  if (!message || typeof message.id !== "string") return;
  try {
    let result;
    if (message.type === "cdp.command") {
      const tabId = Number(message.tabId);
      if (!attachedTabs.has(tabId)) throw new Error("tab is not granted to CodeShell");
      result = await chrome.debugger.sendCommand(
        { tabId },
        String(message.method || ""),
        message.params && typeof message.params === "object" ? message.params : undefined,
      );
    } else if (message.type === "tab.get") {
      const tabId = Number(message.tabId);
      if (!attachedTabs.has(tabId)) throw new Error("tab is not granted to CodeShell");
      result = sanitizeTab(await chrome.tabs.get(tabId));
    } else if (message.type === "tab.detach") {
      const tabId = Number(message.tabId);
      await detachTab(tabId);
      result = { detached: true };
    } else {
      throw new Error(`unknown native command: ${message.type}`);
    }
    nativeConnection().postMessage({ replyTo: message.id, ok: true, result });
  } catch (error) {
    nativeConnection().postMessage({
      replyTo: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function attachCurrentTab(code) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !Number.isFinite(tab.id)) throw new Error("No active Chrome tab");
  if (!/^https?:/i.test(tab.url || "")) throw new Error("Only http(s) tabs can be granted");
  const tabId = tab.id;
  let attachedHere = false;
  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    attachedTabs.add(tabId);
    attachedHere = true;
    await persistAttachedTabs();
  }
  try {
    const result = await nativeRequest("pairing.grant", { code, tab: sanitizeTab(tab) });
    try {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: "CodeShell Runtime", color: "blue" });
    } catch {
      // Grouping is an organizational nicety; the debugger grant is authoritative.
    }
    return result;
  } catch (error) {
    if (attachedHere) await detachTab(tabId);
    throw error;
  }
}

async function detachTab(tabId) {
  if (!Number.isFinite(tabId)) return;
  if (attachedTabs.has(tabId)) {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    attachedTabs.delete(tabId);
    await persistAttachedTabs();
  }
}

function sanitizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || "",
    title: tab.title || "",
    active: Boolean(tab.active),
  };
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "pairing.list") return nativeRequest("pairing.list");
  if (message?.type === "pairing.grant") return attachCurrentTab(String(message.code || ""));
  if (message?.type === "connection.status") {
    return Promise.resolve({ connected: Boolean(nativePort), extensionId: chrome.runtime.id });
  }
  return undefined;
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!Number.isFinite(tabId)) return;
  attachedTabs.delete(tabId);
  void persistAttachedTabs();
  try {
    nativeConnection().postMessage({ type: "tab.detached", tabId, reason });
  } catch {
    // Desktop is not running; local state is already revoked.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!attachedTabs.delete(tabId)) return;
  void persistAttachedTabs();
  try {
    nativeConnection().postMessage({ type: "tab.closed", tabId });
  } catch {
    // Desktop is not running.
  }
});

void restoreAttachedTabs();
