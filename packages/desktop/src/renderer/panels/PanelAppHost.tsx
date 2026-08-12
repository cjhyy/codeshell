import { useEffect, useRef, useState, type Ref } from "react";
import type { WebviewElement } from "../browser/types";
import type { PanelAppDescriptor, PreparedPanelApp } from "../../shared/panel-apps";
import { useT } from "../i18n/I18nProvider";

function currentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function usePanelAppTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() => currentTheme());
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function PanelAppHost({
  descriptor,
  tabId,
  bucket,
  busy,
  projectPath,
  cwd,
  engineSessionId,
  visible,
}: {
  descriptor: PanelAppDescriptor;
  tabId: string;
  bucket: string;
  busy: boolean;
  projectPath: string | null;
  cwd: string | null;
  engineSessionId: string | null;
  visible: boolean;
}) {
  const { lang } = useT();
  const theme = usePanelAppTheme();
  const viewRef = useRef<WebviewElement | null>(null);
  const guestReadyRef = useRef(false);
  const [prepared, setPrepared] = useState<PreparedPanelApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    guestReadyRef.current = false;
    setPrepared(null);
    setError(null);
    if (!projectPath) {
      setError("Panel App requires a bound project.");
      return () => {
        alive = false;
      };
    }
    window.codeshell.preparePanelApp(descriptor.id, projectPath).then(
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
  }, [cwd, descriptor.hostId, descriptor.id, projectPath, retryNonce]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !prepared || !projectPath) return;
    let alive = true;
    const bind = () => {
      const guestId = view.getWebContentsId?.();
      if (typeof guestId !== "number" || !Number.isFinite(guestId)) return;
      void window.codeshell
        .bindPanelApp({
          guestId,
          appDescriptorId: descriptor.id,
          tabId,
          bucket,
          sessionId: engineSessionId,
          projectPath,
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
    const ready = () => {
      guestReadyRef.current = true;
      bind();
    };
    const crashed = () => {
      if (alive) setError("Panel App process exited.");
    };
    if (guestReadyRef.current) bind();
    view.addEventListener("dom-ready", ready);
    view.addEventListener("render-process-gone", crashed);
    return () => {
      alive = false;
      view.removeEventListener("dom-ready", ready);
      view.removeEventListener("render-process-gone", crashed);
    };
  }, [
    bucket,
    busy,
    cwd,
    descriptor.id,
    engineSessionId,
    lang,
    prepared,
    projectPath,
    tabId,
    theme,
    visible,
  ]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <div>
          {lang.toLowerCase().startsWith("zh") ? "Panel App 打开失败" : "Panel App failed to load"}
          {`: ${error}`}
        </div>
        <button
          type="button"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-foreground hover:bg-muted"
          onClick={() => setRetryNonce((value) => value + 1)}
        >
          {lang.toLowerCase().startsWith("zh") ? "重试打开" : "Try again"}
        </button>
      </div>
    );
  }
  if (!prepared) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading Panel App…
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
