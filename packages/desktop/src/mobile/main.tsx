import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const el = document.getElementById("app");
if (!el) throw new Error("#app mount node missing");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
