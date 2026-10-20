/** These local schemes are registered by Main's registerPanelAppSchemePrivileges.
 * Their production handlers still enforce package, project and resource access.
 * Keep this preimport fixture free of Host imports. */
const localProtocols = new Set([
  "file:",
  "data:",
  "blob:",
  "devtools:",
  "cspanel:",
  "csmedia:",
  "cstheme:",
]);

export function installPackagedChromiumGuard(app, origin) {
  const seenSessions = new WeakSet();
  app.on("web-contents-created", (_event, contents) => {
    const session = contents.session;
    if (seenSessions.has(session)) return;
    seenSessions.add(session);
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        allowed = localProtocols.has(url.protocol) || url.origin === origin;
      } catch {
        // Malformed requests must be canceled without leaving the callback open.
      }
      callback({ cancel: !allowed });
    });
  });
}
