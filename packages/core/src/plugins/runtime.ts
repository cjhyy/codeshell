/**
 * UI-agnostic lifecycle runtime for trusted, code-backed plugin modules.
 *
 * A host supplies its own service object and panel context. Core owns ordering,
 * instance identity, and error isolation; it does not import React/Electron or
 * decide how an untrusted installed plugin is sandboxed.
 */

export type PluginLifecycleEventName =
  | "activate"
  | "panel_mount"
  | "panel_context_changed"
  | "panel_visibility_changed"
  | "panel_unmount"
  | "deactivate";

export interface PluginPanelInstance<TContext extends object = Record<string, unknown>> {
  panelId: string;
  instanceId: string;
  context: TContext;
  visible: boolean;
}

export type PluginLifecycleEvent<TContext extends object = Record<string, unknown>> =
  | { type: "activate" }
  | { type: "panel_mount"; panel: PluginPanelInstance<TContext> }
  | { type: "panel_context_changed"; panel: PluginPanelInstance<TContext> }
  | { type: "panel_visibility_changed"; panel: PluginPanelInstance<TContext> }
  | { type: "panel_unmount"; panel: PluginPanelInstance<TContext> }
  | { type: "deactivate" };

export interface PluginLifecycleHookContext<
  THost,
  TContext extends object = Record<string, unknown>,
> {
  pluginId: string;
  host: THost;
  event: PluginLifecycleEvent<TContext>;
}

export type PluginLifecycleHook<THost, TContext extends object = Record<string, unknown>> = (
  context: PluginLifecycleHookContext<THost, TContext>,
) => void | Promise<void>;

export type PluginLifecycleHooks<
  THost,
  TContext extends object = Record<string, unknown>,
> = Partial<
  Record<
    PluginLifecycleEventName,
    PluginLifecycleHook<THost, TContext> | readonly PluginLifecycleHook<THost, TContext>[]
  >
>;

/** Trusted code module. Installed web content must not be imported through this boundary. */
export interface PluginLifecycleModule<THost, TContext extends object = Record<string, unknown>> {
  id: string;
  hooks?: PluginLifecycleHooks<THost, TContext>;
}

export interface PluginLifecycleError<THost, TContext extends object = Record<string, unknown>> {
  pluginId: string;
  event: PluginLifecycleEvent<TContext>;
  host: THost;
  error: unknown;
}

export interface PluginLifecycleRuntimeOptions<
  THost,
  TContext extends object = Record<string, unknown>,
> {
  onError?(error: PluginLifecycleError<THost, TContext>): void;
}

function panelKey(pluginId: string, instanceId: string): string {
  return `${pluginId}\0${instanceId}`;
}

function clonePanel<TContext extends object>(
  panel: PluginPanelInstance<TContext>,
): PluginPanelInstance<TContext> {
  return { ...panel, context: { ...panel.context } };
}

/**
 * Stateful lifecycle coordinator shared by headless and UI hosts.
 *
 * Mounting the first panel activates its module automatically. State changes
 * are recorded before hooks run, so re-entrant/StrictMode calls remain
 * idempotent even when a hook is asynchronous.
 */
export class PluginLifecycleRuntime<THost, TContext extends object = Record<string, unknown>> {
  private readonly modules = new Map<string, PluginLifecycleModule<THost, TContext>>();
  private readonly active = new Set<string>();
  private readonly panels = new Map<string, PluginPanelInstance<TContext>>();

  constructor(private readonly options: PluginLifecycleRuntimeOptions<THost, TContext> = {}) {}

  register(module: PluginLifecycleModule<THost, TContext>): () => void {
    if (!module.id) throw new Error("plugin lifecycle module id is required");
    if (this.modules.has(module.id)) {
      throw new Error(`plugin lifecycle module '${module.id}' is already registered`);
    }
    this.modules.set(module.id, module);
    let disposed = false;
    return () => {
      if (disposed) return;
      if (this.active.has(module.id) || this.hasMountedPanels(module.id)) {
        throw new Error(`plugin lifecycle module '${module.id}' must be deactivated first`);
      }
      disposed = true;
      if (this.modules.get(module.id) === module) this.modules.delete(module.id);
    };
  }

  has(pluginId: string): boolean {
    return this.modules.has(pluginId);
  }

  isActive(pluginId: string): boolean {
    return this.active.has(pluginId);
  }

  mountedPanels(pluginId?: string): PluginPanelInstance<TContext>[] {
    const prefix = pluginId === undefined ? null : `${pluginId}\0`;
    return [...this.panels.entries()]
      .filter(([key]) => prefix === null || key.startsWith(prefix))
      .map(([, panel]) => clonePanel(panel));
  }

  async activate(pluginId: string, host: THost): Promise<void> {
    this.requireModule(pluginId);
    if (this.active.has(pluginId)) return;
    this.active.add(pluginId);
    await this.emit(pluginId, host, { type: "activate" });
  }

  async mountPanel(
    pluginId: string,
    panel: PluginPanelInstance<TContext>,
    host: THost,
  ): Promise<void> {
    this.requireModule(pluginId);
    const key = panelKey(pluginId, panel.instanceId);
    if (this.panels.has(key)) return;
    const snapshot = clonePanel(panel);
    this.panels.set(key, snapshot);
    await this.activate(pluginId, host);
    // A host can unmount/remount while an async activate hook is pending. Only
    // the generation that installed this snapshot may publish its mount event.
    if (this.panels.get(key) !== snapshot) return;
    await this.emit(pluginId, host, { type: "panel_mount", panel: clonePanel(snapshot) });
  }

  async updatePanelContext(
    pluginId: string,
    instanceId: string,
    context: TContext,
    host: THost,
  ): Promise<void> {
    const current = this.requirePanel(pluginId, instanceId);
    const next = { ...current, context: { ...context } };
    this.panels.set(panelKey(pluginId, instanceId), next);
    await this.emit(pluginId, host, {
      type: "panel_context_changed",
      panel: clonePanel(next),
    });
  }

  async setPanelVisibility(
    pluginId: string,
    instanceId: string,
    visible: boolean,
    host: THost,
  ): Promise<void> {
    const current = this.requirePanel(pluginId, instanceId);
    if (current.visible === visible) return;
    const next = { ...current, visible };
    this.panels.set(panelKey(pluginId, instanceId), next);
    await this.emit(pluginId, host, {
      type: "panel_visibility_changed",
      panel: clonePanel(next),
    });
  }

  async unmountPanel(pluginId: string, instanceId: string, host: THost): Promise<void> {
    const key = panelKey(pluginId, instanceId);
    const current = this.panels.get(key);
    if (!current) return;
    this.panels.delete(key);
    await this.emit(pluginId, host, {
      type: "panel_unmount",
      panel: clonePanel(current),
    });
  }

  async deactivate(pluginId: string, host: THost): Promise<void> {
    this.requireModule(pluginId);
    for (const panel of this.mountedPanels(pluginId)) {
      await this.unmountPanel(pluginId, panel.instanceId, host);
    }
    if (!this.active.delete(pluginId)) return;
    await this.emit(pluginId, host, { type: "deactivate" });
  }

  private hasMountedPanels(pluginId: string): boolean {
    const prefix = `${pluginId}\0`;
    for (const key of this.panels.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private requireModule(pluginId: string): PluginLifecycleModule<THost, TContext> {
    const module = this.modules.get(pluginId);
    if (!module) throw new Error(`unknown plugin lifecycle module '${pluginId}'`);
    return module;
  }

  private requirePanel(pluginId: string, instanceId: string): PluginPanelInstance<TContext> {
    const panel = this.panels.get(panelKey(pluginId, instanceId));
    if (!panel) {
      throw new Error(`plugin panel instance '${pluginId}:${instanceId}' is not mounted`);
    }
    return panel;
  }

  private async emit(
    pluginId: string,
    host: THost,
    event: PluginLifecycleEvent<TContext>,
  ): Promise<void> {
    const configured = this.requireModule(pluginId).hooks?.[event.type];
    const hooks = configured ? (Array.isArray(configured) ? configured : [configured]) : [];
    for (const hook of hooks as readonly PluginLifecycleHook<THost, TContext>[]) {
      try {
        await hook({ pluginId, host, event });
      } catch (error) {
        this.options.onError?.({ pluginId, event, host, error });
      }
    }
  }
}
