import { Fragment, useEffect, useRef, type ReactNode } from "react";
import {
  PluginLifecycleRuntime,
  type PluginLifecycleModule,
} from "@cjhyy/code-shell-core/browser/plugin-runtime";
import type { LucideIcon } from "lucide-react";
import {
  PANEL_REGISTRY,
  type PanelEntry,
  type PanelRenderContext,
  type PanelTitle,
} from "./PanelRegistry";
import type { PanelId } from "../view";

/** Desktop capabilities visible to trusted code-backed panel modules. */
export interface DesktopPanelPluginHost {
  getService(pluginId: string): unknown;
}

/** UI-free context passed through core's lifecycle runtime. */
export interface DesktopPanelLifecycleContext {
  panelId: string;
  tabId: string;
  bucket: string;
  cwd: string | null;
  engineSessionId: string | null;
  busy: boolean;
}

export interface DesktopPanelPluginDefinition {
  module: PluginLifecycleModule<DesktopPanelPluginHost, DesktopPanelLifecycleContext>;
  panel: {
    id: PanelId;
    panelId: string;
    title: PanelTitle;
    icon: LucideIcon;
    order: number;
    singleton?: boolean;
    enabled?: PanelEntry["enabled"];
    render(context: PanelRenderContext, host: DesktopPanelPluginHost | undefined): ReactNode;
  };
}

export const DESKTOP_PANEL_PLUGIN_RUNTIME = new PluginLifecycleRuntime<
  DesktopPanelPluginHost,
  DesktopPanelLifecycleContext
>({
  onError: ({ pluginId, event, error }) => {
    console.error(`Panel plugin '${pluginId}' failed during ${event.type}:`, error);
  },
});

/** Register the code controller and its Desktop view adapter as one panel plugin. */
export function registerDesktopPanelPlugin(definition: DesktopPanelPluginDefinition): () => void {
  const disposeModule = DESKTOP_PANEL_PLUGIN_RUNTIME.register(definition.module);
  let disposePanel: (() => void) | undefined;
  try {
    disposePanel = PANEL_REGISTRY.register({
      key: definition.panel.id,
      owner: {
        kind: "code",
        pluginId: definition.module.id,
        panelId: definition.panel.panelId,
      },
      title: definition.panel.title,
      icon: definition.panel.icon,
      order: definition.panel.order,
      singleton: definition.panel.singleton ?? false,
      enabled: definition.panel.enabled ?? (() => true),
      lifecycle: { pluginId: definition.module.id, panelId: definition.panel.panelId },
      render: (context) => definition.panel.render(context, context.panelPluginHost),
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
  host: DesktopPanelPluginHost | undefined;
  tabId: string;
  bucket: string;
  cwd: string | null;
  engineSessionId: string | null;
  busy: boolean;
  visible: boolean;
  children: ReactNode;
}) {
  const pluginId = entry?.lifecycle?.pluginId;
  const panelId = entry?.lifecycle?.panelId;
  const instanceId = `${bucket}\0${tabId}`;
  const hostAvailable = Boolean(host);
  const hostRef = useRef(host);
  hostRef.current = host;
  const contextPassRef = useRef<string | null>(null);
  const visibilityPassRef = useRef<string | null>(null);

  useEffect(() => {
    const currentHost = hostRef.current;
    if (!pluginId || !panelId || !currentHost) return;
    void DESKTOP_PANEL_PLUGIN_RUNTIME.mountPanel(
      pluginId,
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
        void DESKTOP_PANEL_PLUGIN_RUNTIME.unmountPanel(pluginId, instanceId, latestHost);
      }
    };
  }, [pluginId, panelId, instanceId, hostAvailable]);

  useEffect(() => {
    const currentHost = hostRef.current;
    if (!pluginId || !panelId || !currentHost) return;
    const identity = `${pluginId}\0${instanceId}`;
    if (contextPassRef.current !== identity) {
      contextPassRef.current = identity;
      return;
    }
    void DESKTOP_PANEL_PLUGIN_RUNTIME.updatePanelContext(
      pluginId,
      instanceId,
      { panelId, tabId, bucket, cwd, engineSessionId, busy },
      currentHost,
    );
  }, [pluginId, panelId, instanceId, tabId, bucket, cwd, engineSessionId, busy, hostAvailable]);

  useEffect(() => {
    const currentHost = hostRef.current;
    if (!pluginId || !currentHost) return;
    const identity = `${pluginId}\0${instanceId}`;
    if (visibilityPassRef.current !== identity) {
      visibilityPassRef.current = identity;
      return;
    }
    void DESKTOP_PANEL_PLUGIN_RUNTIME.setPanelVisibility(
      pluginId,
      instanceId,
      visible,
      currentHost,
    );
  }, [pluginId, instanceId, visible, hostAvailable]);

  return <Fragment>{children}</Fragment>;
}
