/** Refresh an open catalog when the desktop service comes back after an outage. */
export function onLocalProviderCatalogRecovery(refresh: () => void): (() => void) | undefined {
  let disconnected = false;
  return window.codeshell?.onDesktopHostStatus?.((status) => {
    if (status === "ready" && disconnected) refresh();
    disconnected = status === "reconnecting" || status === "unavailable";
  });
}
