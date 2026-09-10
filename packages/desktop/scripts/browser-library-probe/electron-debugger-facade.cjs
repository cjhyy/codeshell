/* global module */
/**
 * PROBE ONLY. This is our Electron adapter, not an official Puppeteer integration.
 * The official ExtensionTransport is used unmodified; its chrome.debugger calls
 * are bound to exactly one fixture webContents. Do not install this global in
 * the application or accept arbitrary user commands through it.
 */
function installElectronDebuggerFacade(wc) {
  const listeners = new Map();
  const childSessions = new Set();
  const methods = new Set();
  const checkTarget = (tabId) => {
    if (tabId !== wc.id) throw new Error("Probe transport rejected another target");
  };
  globalThis.chrome = {
    debugger: {
      async attach({ tabId }, version) {
        checkTarget(tabId);
        wc.debugger.attach(version);
      },
      async detach({ tabId }) {
        checkTarget(tabId);
        if (wc.debugger.isAttached()) wc.debugger.detach();
      },
      async sendCommand({ tabId, sessionId }, method, params) {
        checkTarget(tabId);
        methods.add(method);
        // Fail closed for browser-wide operations. This is not a complete
        // production policy; this probe only exercises existing page actions.
        if (
          method.startsWith("Browser.") ||
          (method.startsWith("Target.") && method !== "Target.setAutoAttach")
        ) {
          throw new Error(`Probe transport rejected browser-wide command: ${method}`);
        }
        return wc.debugger.sendCommand(method, params, sessionId);
      },
      onEvent: {
        addListener(listener) {
          const handler = (_event, method, params, sessionId) => {
            if (sessionId) childSessions.add(sessionId);
            // Electron uses "" for the main session; Chrome omits the field.
            listener({ tabId: wc.id, sessionId: sessionId || undefined }, method, params);
          };
          listeners.set(listener, handler);
          wc.debugger.on("message", handler);
        },
        removeListener(listener) {
          const handler = listeners.get(listener);
          if (handler) wc.debugger.removeListener("message", handler);
          listeners.delete(listener);
        },
      },
    },
  };
  return { listeners, childSessions, methods };
}

module.exports = { installElectronDebuggerFacade };
