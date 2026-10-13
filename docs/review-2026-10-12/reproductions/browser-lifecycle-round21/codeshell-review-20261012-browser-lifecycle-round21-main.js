function assertRendererSessionAccess(sessionId, senderWebContentsId) {
  assertDesktopSessionId(sessionId);
  if (!bridge?.hasKnownSession(sessionId)) {
    throw new Error("browser operation requires a live CodeShell task");
  }
  const ownerId = bridge.panelOwnerWebContentsId(sessionId);
  if (ownerId !== undefined && ownerId !== senderWebContentsId) {
    throw new Error("browser operation belongs to another window");
  }
  return sessionId;
}
ipcMain.handle("browser-runtime:chrome-begin-pairing", (event, payload) => {
  const sessionId = assertRendererSessionAccess(payload?.sessionId, event.sender.id);
  if (payload?.label !== undefined && (typeof payload.label !== "string" || payload.label.length > 200 || payload.label.includes("\x00"))) {
    throw new Error("Chrome pairing label is invalid");
  }
  return chromeExtensionRuntimeService.beginPairing(sessionId, typeof payload.label === "string" ? payload.label : undefined);
});
ipcMain.handle("browser-runtime:chrome-status", (event, rawSessionId) => {
  const sessionId = assertRendererSessionAccess(rawSessionId, event.sender.id);
  return chromeExtensionRuntimeService.status(sessionId);
});
ipcMain.handle("browser-runtime:chrome-revoke", (event, rawSessionId) => {
  const sessionId = assertRendererSessionAccess(rawSessionId, event.sender.id);
  return chromeExtensionRuntimeService.revoke(sessionId);
});
ipcMain.handle("browser-runtime:chrome-installation", () => ({
  ...chromeNativeRegistration ?? {
    installed: false,
    manifestPaths: [],
    extensionPath: app.isPackaged ? join(process.resourcesPath, "packages", "desktop", "resources", "chrome-extension") : join(app.getAppPath(), "resources", "chrome-extension"),
    detail: "Chrome bridge is still starting"
  }
}));
