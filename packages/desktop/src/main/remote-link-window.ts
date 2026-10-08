import { app, shell } from "electron";
import { createLinkLoopbackCallbackBroker } from "./link-loopback-callback.js";
import { createSystemBrowserLinkAuthorization } from "./link-system-browser.js";

const callbacks = createLinkLoopbackCallbackBroker();
app.once("will-quit", () => callbacks.close());

/** Compatibility export: the default browser now completes authorization through loopback. */
export const openNativeLinkAuthorization = createSystemBrowserLinkAuthorization({
  callbacks,
  openExternal: (url) => shell.openExternal(url),
});
