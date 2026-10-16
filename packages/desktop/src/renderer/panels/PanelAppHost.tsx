import { useEffect, useRef, useState, type Ref } from "react";
import type { WebviewElement } from "../browser/types";
import type { PanelAppDescriptor, PreparedPanelApp } from "../../shared/panel-apps";
import { useT } from "../i18n/I18nProvider";

export type PanelAppHostState = "loading" | "ready" | "error";
export type PanelAppStateChange = (tabId: string, state: PanelAppHostState, error?: string) => void;

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
  modelKey,
  permissionMode,
  planMode,
  hasGoal,
  visible,
  onStateChange,
}: {
  descriptor: PanelAppDescriptor;
  tabId: string;
  bucket: string;
  busy: boolean;
  projectPath: string | null;
  cwd: string | null;
  engineSessionId: string | null;
  modelKey: string | null;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  planMode: boolean;
  hasGoal: boolean;
  visible: boolean;
  onStateChange?: PanelAppStateChange;
}) {
  const { lang } = useT();
  const theme = usePanelAppTheme();
  const viewRef = useRef<WebviewElement | null>(null);
  const guestReadyRef = useRef(false);
  const [prepared, setPrepared] = useState<PreparedPanelApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  useEffect(() => {
    let alive = true;
    guestReadyRef.current = false;
    onStateChangeRef.current?.(tabId, "loading");
    setPrepared(null);
    setError(null);
    if (!projectPath) {
      const message = "Panel App requires a bound project.";
      setError(message);
      onStateChangeRef.current?.(tabId, "error", message);
      return () => {
        alive = false;
      };
    }
    window.codeshell.preparePanelApp(descriptor.id, projectPath).then(
      (result) => {
        if (!alive) return;
        if (result.revision !== descriptor.revision) {
          const message = "Panel App version changed. Refresh the project before reopening.";
          setError(message);
          onStateChangeRef.current?.(tabId, "error", message);
          return;
        }
        setPrepared(result);
      },
      (reason) => {
        if (alive) {
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
          onStateChangeRef.current?.(tabId, "error", message);
        }
      },
    );
    return () => {
      alive = false;
      onStateChangeRef.current?.(tabId, "loading");
    };
  }, [cwd, descriptor.hostId, descriptor.id, descriptor.revision, projectPath, retryNonce]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !prepared || !projectPath) return;
    let alive = true;
    let generation = 0;
    const fail = (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      onStateChangeRef.current?.(tabId, "error", message);
    };
    const bind = async () => {
      const request = ++generation;
      onStateChangeRef.current?.(tabId, "loading");
      try {
        const guestId = view.getWebContentsId?.();
        if (typeof guestId !== "number" || !Number.isFinite(guestId)) {
          throw new Error("Panel App guest is not attached.");
        }
        const bound = await window.codeshell.bindPanelApp({
          guestId,
          appDescriptorId: descriptor.id,
          tabId,
          bucket,
          sessionId: engineSessionId,
          projectPath,
          cwd,
          visible,
          busy,
          modelKey,
          permissionMode,
          planMode,
          hasGoal,
          theme,
          locale: lang,
        });
        if (!alive || request !== generation) return;
        if (bound !== true) throw new Error("Panel App did not accept its source binding.");
        setError(null);
        onStateChangeRef.current?.(tabId, "ready");
      } catch (reason) {
        if (alive && request === generation) fail(reason);
      }
    };
    const ready = () => {
      guestReadyRef.current = true;
      void bind();
    };
    const loading = (event: Event) => {
      const navigation = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
      if (navigation.isMainFrame === false || navigation.isInPlace === true) return;
      guestReadyRef.current = false;
      generation++;
      onStateChangeRef.current?.(tabId, "loading");
    };
    const crashed = () => {
      generation++;
      guestReadyRef.current = false;
      if (alive) fail("Panel App process exited.");
    };
    const failedLoad = (event: Event) => {
      const failure = event as Event & {
        isMainFrame?: boolean;
        errorCode?: number;
        errorDescription?: string;
      };
      if (failure.isMainFrame === false || failure.errorCode === -3) return;
      generation++;
      guestReadyRef.current = false;
      if (alive) fail(failure.errorDescription || "Panel App failed to load.");
    };
    if (guestReadyRef.current) void bind();
    view.addEventListener("dom-ready", ready);
    view.addEventListener("did-start-navigation", loading);
    view.addEventListener("did-fail-load", failedLoad);
    view.addEventListener("render-process-gone", crashed);
    return () => {
      alive = false;
      onStateChangeRef.current?.(tabId, "loading");
      view.removeEventListener("dom-ready", ready);
      view.removeEventListener("did-start-navigation", loading);
      view.removeEventListener("did-fail-load", failedLoad);
      view.removeEventListener("render-process-gone", crashed);
    };
  }, [
    bucket,
    busy,
    cwd,
    descriptor.id,
    engineSessionId,
    lang,
    hasGoal,
    modelKey,
    permissionMode,
    planMode,
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
