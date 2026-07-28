import { Fragment, useEffect, useRef, type ReactNode } from "react";
import {
  PanelAppLifecycleRuntime,
  type PanelAppLifecycleModule,
} from "@cjhyy/code-shell-core/browser/panel-app-runtime";
import type { LucideIcon } from "lucide-react";
import {
  PANEL_REGISTRY,
  type PanelEntry,
  type PanelRenderContext,
  type PanelTitle,
} from "./PanelRegistry";
import type { PanelId } from "../view";

/** Desktop capabilities visible to trusted code-backed panel modules. */
export interface DesktopBuiltinPanelAppHost {
  getService(appId: string): unknown;
}

/** UI-free context passed through core's lifecycle runtime. */
export interface DesktopPanelAppLifecycleContext {
  panelId: string;
  tabId: string;
  bucket: string;
  cwd: string | null;
  engineSessionId: string | null;
  busy: boolean;
}

export interface DesktopBuiltinPanelAppDefinition {
  module: PanelAppLifecycleModule<DesktopBuiltinPanelAppHost, DesktopPanelAppLifecycleContext>;
  panel: {
    id: PanelId;
    panelId: string;
    title: PanelTitle;
    icon: LucideIcon;
    order: number;
    singleton?: boolean;
    enabled?: PanelEntry["enabled"];
    render(context: PanelRenderContext, host: DesktopBuiltinPanelAppHost | undefined): ReactNode;
  };
}

export const DESKTOP_BUILTIN_PANEL_APP_RUNTIME = new PanelAppLifecycleRuntime<
  DesktopBuiltinPanelAppHost,
  DesktopPanelAppLifecycleContext
>({
  onError: ({ appId, event, error }) => {
    console.error(`Built-in Panel App '${appId}' failed during ${event.type}:`, error);
  },
});

/** Register a trusted built-in Panel App controller and its Desktop view adapter. */
export function registerDesktopBuiltinPanelApp(
  definition: DesktopBuiltinPanelAppDefinition,
): () => void {
  const disposeModule = DESKTOP_BUILTIN_PANEL_APP_RUNTIME.register(definition.module);
  let disposePanel: (() => void) | undefined;
  try {
    disposePanel = PANEL_REGISTRY.register({
      key: definition.panel.id,
      owner: {
        kind: "builtin-panel-app",
        appId: definition.module.id,
        panelId: definition.panel.panelId,
      },
      title: definition.panel.title,
      icon: definition.panel.icon,
      order: definition.panel.order,
      singleton: definition.panel.singleton ?? false,
      enabled: definition.panel.enabled ?? (() => true),
      lifecycle: { appId: definition.module.id, panelId: definition.panel.panelId },
      render: (context) => definition.panel.render(context, context.builtinPanelAppHost),
    });
  } catch (error) {
    disposeModule();
    throw error;
  }
  return () => {
    disposePanel?.();
    disposeModule();
  };
}

/**
 * Bind lifecycle to the logical tab, not its temporarily renderable DOM body.
 * Workspace loading can hide a body without closing the panel instance.
 */
export function DesktopPanelLifecycleBoundary({
  entry,
  host,
  tabId,
  bucket,
  cwd,
  engineSessionId,
  busy,
  visible,
  children,
}: {
  entry: PanelEntry | undefined;
  host: DesktopBuiltinPanelAppHost | undefined;
  tabId: string;
  bucket: string;
  cwd: string | null;
  engineSessionId: string | null;
  busy: boolean;
  visible: boolean;
  children: ReactNode;
}) {
  const appId = entry?.lifecycle?.appId;
  const panelId = entry?.lifecycle?.panelId;
  const instanceId = `${bucket}\0${tabId}`;
  const hostAvailable = Boolean(host);
  const hostRef = useRef(host);
  hostRef.current = host;
  const contextPassRef = useRef<string | null>(null);
  const visibilityPassRef = useRef<string | null>(null);

  useEffect(() => {
    const currentHost = hostRef.current;
    if (!appId || !panelId || !currentHost) return;
    void DESKTOP_BUILTIN_PANEL_APP_RUNTIME.mountPanel(
      appId,
      {
        panelId,
        instanceId,
        context: { panelId, tabId, bucket, cwd, engineSessionId, busy },
        visible,
      },
      currentHost,
    );
    return () => {
      contextPassRef.current = null;
      visibilityPassRef.current = null;
      const latestHost = hostRef.current;
      if (latestHost) {
        void DESKTOP_BUILTIN_PANEL_APP_RUNTIME.unmountPanel(appId, instanceId, latestHost);
      }
    };
  }, [appId, panelId, instanceId, hostAvailable]);

  useEffect(() => {
    const currentHost = hostRef.current;
    if (!appId || !panelId || !currentHost) return;
    const identity = `${appId}\0${instanceId}`;
    if (contextPassRef.current !== identity) {
      contextPassRef.current = identity;
      return;
    }
    void DESKTOP_BUILTIN_PANEL_APP_RUNTIME.updatePanelContext(
      appId,
      instanceId,
      { panelId, tabId, bucket, cwd, engineSessionId, busy },
      currentHost,
    );
  }, [appId, panelId, instanceId, tabId, bucket, cwd, engineSessionId, busy, hostAvailable]);

  useEffect(() => {
    const currentHost = hostRef.current;
    if (!appId || !currentHost) return;
    const identity = `${appId}\0${instanceId}`;
    if (visibilityPassRef.current !== identity) {
      visibilityPassRef.current = identity;
      return;
    }
    void DESKTOP_BUILTIN_PANEL_APP_RUNTIME.setPanelVisibility(
      appId,
      instanceId,
      visible,
      currentHost,
    );
  }, [appId, instanceId, visible, hostAvailable]);

  return <Fragment>{children}</Fragment>;
}
