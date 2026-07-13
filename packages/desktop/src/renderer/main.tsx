import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DialogProvider } from "./ui/DialogProvider";
import { ToastProvider } from "./ui/ToastProvider";
import { I18nProvider } from "./i18n";
import "./styles/tailwind.css";
import { initTheme } from "./theme";
import { BrowserPanel } from "./panels/BrowserPanel";
import type { Anchor } from "./chat/anchors";
import { PetStateProvider } from "./pet/PetStateProvider";
import { PetDesktopWindow } from "./pet/PetDesktopWindow";

initTheme();

const root = createRoot(document.getElementById("root")!);

// The browser popout window loads the same renderer with `?popout=browser`. In
// that mode we mount just a full-window browser (no sidebar/chat). Element-pick
// anchors are sent over IPC to the parent window's composer; the annotation
// set itself arrives back via the hub broadcast (state-down pipe), so the
// popout echoes exactly what the main window / other popouts show — and clears
// together with them when a message sends (圈选统一架构).
function PopoutBrowser({ initialUrl }: { initialUrl?: string }) {
  const [anchors, setAnchors] = React.useState<Anchor[]>([]);
  React.useEffect(
    () =>
      window.codeshell.onBrowserAnchorsState((raw) => {
        setAnchors(Array.isArray(raw) ? (raw as Anchor[]) : []);
      }),
    [],
  );
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <BrowserPanel
        cwd={null}
        initialUrl={initialUrl}
        showPopout={false}
        anchors={anchors}
        onAnchor={(a) => window.codeshell.sendBrowserAnchor(a)}
        onRemoveAnchor={(id) => window.codeshell.sendBrowserAnchorRemove(id)}
        onUpdateAnchor={(id, comment) => window.codeshell.sendBrowserAnchorUpdate({ id, comment })}
      />
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
if (params.get("popout") === "pet") {
  document.documentElement.classList.add("pet-widget-window");
  root.render(
    <React.StrictMode>
      <I18nProvider>
        <PetStateProvider>
          <PetDesktopWindow />
        </PetStateProvider>
      </I18nProvider>
    </React.StrictMode>,
  );
} else if (params.get("popout") === "browser") {
  const initialUrl = params.get("url") ?? undefined;
  root.render(
    <React.StrictMode>
      <PopoutBrowser initialUrl={initialUrl} />
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <I18nProvider>
        <DialogProvider>
          <ToastProvider>
            {/* Process-shell owner: stays mounted while App swaps chat/settings/overview content. */}
            <PetStateProvider>
              <App />
            </PetStateProvider>
          </ToastProvider>
        </DialogProvider>
      </I18nProvider>
    </React.StrictMode>,
  );
}
