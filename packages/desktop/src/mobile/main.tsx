import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "../../../web/app/register-service-worker.js";
import { DesktopApp } from "../../../web/app/DesktopApp.js";

import { LinkCallbackPage } from "../../../web/app/LinkCallback.js";
import { readBrowserLinkCallback } from "../../../web/app/remote-link-authorization.js";
import { initThemePreference } from "../../../web/app/theme.js";

// The Web workbench appearance toggle (system / light / dark) applies here too.
initThemePreference();

const callback = readBrowserLinkCallback();
const element = document.getElementById("app");
if (!element) throw new Error("#app mount node missing");

createRoot(element).render(
  <StrictMode>{callback ? <LinkCallbackPage callback={callback} /> : <DesktopApp />}</StrictMode>,
);

registerServiceWorker("/mobile/");
