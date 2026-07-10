import { ipcRenderer } from "electron";
import { BROWSER_GUEST_LINK_CHANNEL, guestLinkRequestFromClick } from "../browser-guest-link.js";

function forwardTrustedLink(event: MouseEvent): void {
  const request = guestLinkRequestFromClick(event);
  if (request) ipcRenderer.sendToHost(BROWSER_GUEST_LINK_CHANNEL, request);
}

// Preload runs at document-start in an isolated world. Page scripts cannot read
// ipcRenderer or this closure, even if they replace console before DOM ready.
document.addEventListener("click", forwardTrustedLink, true);
document.addEventListener("auxclick", forwardTrustedLink, true);
