import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "../../../web/app/register-service-worker.js";
import { DesktopApp } from "../../../web/app/DesktopApp.js";

const element = document.getElementById("app");
if (!element) throw new Error("#app mount node missing");

createRoot(element).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);

registerServiceWorker("/mobile/");
