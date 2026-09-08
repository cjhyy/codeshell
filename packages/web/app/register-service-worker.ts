export function registerServiceWorker(base = "/"): void {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    void navigator.serviceWorker.register(`${base}sw.js`).catch(() => {
      // The online application remains usable when installation is unavailable.
    });
  }
}
