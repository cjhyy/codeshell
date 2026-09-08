import React from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./AuthGate.js";
import { takeSetupToken } from "./auth.js";
import { registerServiceWorker } from "./register-service-worker.js";
import "./app.css";

const setupToken = takeSetupToken(window.location, window.history);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate setupToken={setupToken} />
  </React.StrictMode>,
);

registerServiceWorker(import.meta.env.BASE_URL);
