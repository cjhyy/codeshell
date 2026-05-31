import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ConfirmProvider } from "./ui/ConfirmDialog";
import "./styles/tailwind.css"; // shadcn/Tailwind base — imported first so legacy CSS still wins on un-migrated pages
import "./styles/index.css";
import "./styles.css"; // legacy; removed in the final migration phase
import { initTheme } from "./theme";

initTheme();

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </React.StrictMode>,
);
