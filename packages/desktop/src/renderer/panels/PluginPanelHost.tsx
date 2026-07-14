import { useEffect, useRef, useState, type Ref } from "react";
import type { WebviewElement } from "../browser/types";
import type { PluginPanelDescriptor, PreparedPluginPanel } from "../../shared/plugin-panels";
import { useT } from "../i18n/I18nProvider";

function currentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function usePluginPanelTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() => currentTheme());
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function PluginPanelHost({
  descriptor,
  tabId,
  bucket,
  busy,
  cwd,
  engineSessionId,
  visible,
}: {
  descriptor: PluginPanelDescriptor;
  tabId: string;
  bucket: string;
  busy: boolean;
  cwd: string | null;
  engineSessionId: string | null;
  visible: boolean;
}) {
  const { lang } = useT();
  const theme = usePluginPanelTheme();
  const viewRef = useRef<WebviewElement | null>(null);
  const [prepared, setPrepared] = useState<PreparedPluginPanel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPrepared(null);
    setError(null);
    window.codeshell.preparePluginPanel(descriptor.id).then(
      (result) => {
        if (alive) setPrepared(result);
      },
      (reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      alive = false;
    };
  }, [descriptor.hostId, descriptor.id]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !prepared) return;
    let alive = true;
    const bind = () => {
      const guestId = view.getWebContentsId?.();
      if (typeof guestId !== "number" || !Number.isFinite(guestId)) return;
      void window.codeshell
        .bindPluginPanel({
          guestId,
          panelId: descriptor.id,
          tabId,
          bucket,
          sessionId: engineSessionId,
          cwd,
          visible,
          busy,
          theme,
          locale: lang,
        })
        .then(
          () => {
            if (alive) setError(null);
          },
          (reason) => {
            if (alive) setError(reason instanceof Error ? reason.message : String(reason));
          },
        );
    };
    const crashed = () => {
      if (alive) setError("Plugin panel process exited.");
    };
    const timer = window.setTimeout(bind, 0);
    view.addEventListener("dom-ready", bind);
    view.addEventListener("render-process-gone", crashed);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      view.removeEventListener("dom-ready", bind);
      view.removeEventListener("render-process-gone", crashed);
    };
  }, [bucket, busy, cwd, descriptor.id, engineSessionId, lang, prepared, tabId, theme, visible]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Plugin panel failed to load: {error}
      </div>
    );
  }
  if (!prepared) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading plugin panel…
      </div>
    );
  }

  return (
    <webview
      key={`${prepared.partition}:${prepared.revision}`}
      ref={viewRef as unknown as Ref<HTMLElement>}
      src={prepared.src}
      partition={prepared.partition}
      style={{ width: "100%", height: "100%", display: "flex" }}
    />
  );
}
