import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/index.css";
import "./styles.css"; // legacy; pruned in Task 14
import { initTheme } from "./theme";

initTheme();

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
