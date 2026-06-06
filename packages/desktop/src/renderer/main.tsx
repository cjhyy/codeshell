import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DialogProvider } from "./ui/DialogProvider";
import { ToastProvider } from "./ui/ToastProvider";
import "./styles/tailwind.css"; // shadcn/Tailwind base — imported first so legacy CSS still wins on un-migrated pages
import "./styles/index.css";
import "./styles.css"; // legacy; removed in the final migration phase
import { initTheme } from "./theme";
import { BrowserPanel } from "./panels/BrowserPanel";

initTheme();

const root = createRoot(document.getElementById("root")!);

// The browser popout window loads the same renderer with `?popout=browser`. In
// that mode we mount just a full-window browser (no sidebar/chat). Element-pick
// anchors are sent over IPC to the parent window's composer instead of the
// local add-anchor event.
const params = new URLSearchParams(window.location.search);
if (params.get("popout") === "browser") {
  const initialUrl = params.get("url") ?? undefined;
  root.render(
    <React.StrictMode>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <BrowserPanel
          cwd={null}
          initialUrl={initialUrl}
          showPopout={false}
          onAnchor={(a) => window.codeshell.sendBrowserAnchor(a)}
        />
      </div>
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <DialogProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </DialogProvider>
    </React.StrictMode>,
  );
}
