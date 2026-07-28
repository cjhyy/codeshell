/**
 * UI-agnostic lifecycle runtime for trusted, code-backed Panel App modules.
 *
 * A host supplies its own service object and panel context. Core owns ordering,
 * instance identity, and error isolation; it does not import React/Electron or
 * decide how an untrusted installed Panel App is sandboxed.
 */

export type PanelAppLifecycleEventName =
  | "activate"
  | "panel_mount"
  | "panel_context_changed"
  | "panel_visibility_changed"
  | "panel_unmount"
  | "deactivate";

export interface PanelAppInstance<TContext extends object = Record<string, unknown>> {
  panelId: string;
  instanceId: string;
  context: TContext;
  visible: boolean;
}

export type PanelAppLifecycleEvent<TContext extends object = Record<string, unknown>> =
  | { type: "activate" }
  | { type: "panel_mount"; panel: PanelAppInstance<TContext> }
  | { type: "panel_context_changed"; panel: PanelAppInstance<TContext> }
  | { type: "panel_visibility_changed"; panel: PanelAppInstance<TContext> }
  | { type: "panel_unmount"; panel: PanelAppInstance<TContext> }
  | { type: "deactivate" };

export interface PanelAppLifecycleHookContext<
  THost,
  TContext extends object = Record<string, unknown>,
> {
  appId: string;
  host: THost;
  event: PanelAppLifecycleEvent<TContext>;
}

export type PanelAppLifecycleHook<THost, TContext extends object = Record<string, unknown>> = (
  context: PanelAppLifecycleHookContext<THost, TContext>,
) => void | Promise<void>;

export type PanelAppLifecycleHooks<
  THost,
  TContext extends object = Record<string, unknown>,
> = Partial<
  Record<
    PanelAppLifecycleEventName,
    PanelAppLifecycleHook<THost, TContext> | readonly PanelAppLifecycleHook<THost, TContext>[]
  >
>;

/** Trusted code module. Installed web content must not be imported through this boundary. */
export interface PanelAppLifecycleModule<THost, TContext extends object = Record<string, unknown>> {
  id: string;
  hooks?: PanelAppLifecycleHooks<THost, TContext>;
}

export interface PanelAppLifecycleError<THost, TContext extends object = Record<string, unknown>> {
  appId: string;
  event: PanelAppLifecycleEvent<TContext>;
  host: THost;
  error: unknown;
}

export interface PanelAppLifecycleRuntimeOptions<
  THost,
  TContext extends object = Record<string, unknown>,
> {
  onError?(error: PanelAppLifecycleError<THost, TContext>): void;
}

function panelKey(appId: string, instanceId: string): string {
  return `${appId}\0${instanceId}`;
}

function clonePanel<TContext extends object>(
  panel: PanelAppInstance<TContext>,
): PanelAppInstance<TContext> {
  return { ...panel, context: { ...panel.context } };
}

/**
 * Stateful lifecycle coordinator shared by headless and UI hosts.
 *
 * Mounting the first panel activates its module automatically. State changes
 * are recorded before hooks run, so re-entrant/StrictMode calls remain
 * idempotent even when a hook is asynchronous.
 */
export class PanelAppLifecycleRuntime<THost, TContext extends object = Record<string, unknown>> {
  private readonly modules = new Map<string, PanelAppLifecycleModule<THost, TContext>>();
  private readonly active = new Set<string>();
  private readonly panels = new Map<string, PanelAppInstance<TContext>>();

  constructor(private readonly options: PanelAppLifecycleRuntimeOptions<THost, TContext> = {}) {}

  register(module: PanelAppLifecycleModule<THost, TContext>): () => void {
    if (!module.id) throw new Error("Panel App lifecycle module id is required");
    if (this.modules.has(module.id)) {
      throw new Error(`Panel App lifecycle module '${module.id}' is already registered`);
    }
    this.modules.set(module.id, module);
    let disposed = false;
    return () => {
      if (disposed) return;
      if (this.active.has(module.id) || this.hasMountedPanels(module.id)) {
        throw new Error(`Panel App lifecycle module '${module.id}' must be deactivated first`);
      }
      disposed = true;
      if (this.modules.get(module.id) === module) this.modules.delete(module.id);
    };
  }

  has(appId: string): boolean {
    return this.modules.has(appId);
  }

  isActive(appId: string): boolean {
    return this.active.has(appId);
  }

  mountedPanels(appId?: string): PanelAppInstance<TContext>[] {
    const prefix = appId === undefined ? null : `${appId}\0`;
    return [...this.panels.entries()]
      .filter(([key]) => prefix === null || key.startsWith(prefix))
      .map(([, panel]) => clonePanel(panel));
  }

  async activate(appId: string, host: THost): Promise<void> {
    this.requireModule(appId);
    if (this.active.has(appId)) return;
    this.active.add(appId);
    await this.emit(appId, host, { type: "activate" });
  }

  async mountPanel(appId: string, panel: PanelAppInstance<TContext>, host: THost): Promise<void> {
    this.requireModule(appId);
    const key = panelKey(appId, panel.instanceId);
    if (this.panels.has(key)) return;
    const snapshot = clonePanel(panel);
    this.panels.set(key, snapshot);
    await this.activate(appId, host);
    // A host can unmount/remount while an async activate hook is pending. Only
    // the generation that installed this snapshot may publish its mount event.
    if (this.panels.get(key) !== snapshot) return;
    await this.emit(appId, host, { type: "panel_mount", panel: clonePanel(snapshot) });
  }

  async updatePanelContext(
    appId: string,
    instanceId: string,
    context: TContext,
    host: THost,
  ): Promise<void> {
    const current = this.requirePanel(appId, instanceId);
    const next = { ...current, context: { ...context } };
    this.panels.set(panelKey(appId, instanceId), next);
    await this.emit(appId, host, {
      type: "panel_context_changed",
      panel: clonePanel(next),
    });
  }

  async setPanelVisibility(
    appId: string,
    instanceId: string,
    visible: boolean,
    host: THost,
  ): Promise<void> {
    const current = this.requirePanel(appId, instanceId);
    if (current.visible === visible) return;
    const next = { ...current, visible };
    this.panels.set(panelKey(appId, instanceId), next);
    await this.emit(appId, host, {
      type: "panel_visibility_changed",
      panel: clonePanel(next),
    });
  }

  async unmountPanel(appId: string, instanceId: string, host: THost): Promise<void> {
    const key = panelKey(appId, instanceId);
    const current = this.panels.get(key);
    if (!current) return;
    this.panels.delete(key);
    await this.emit(appId, host, {
      type: "panel_unmount",
      panel: clonePanel(current),
    });
  }

  async deactivate(appId: string, host: THost): Promise<void> {
    this.requireModule(appId);
    for (const panel of this.mountedPanels(appId)) {
      await this.unmountPanel(appId, panel.instanceId, host);
    }
    if (!this.active.delete(appId)) return;
    await this.emit(appId, host, { type: "deactivate" });
  }

  private hasMountedPanels(appId: string): boolean {
    const prefix = `${appId}\0`;
    for (const key of this.panels.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private requireModule(appId: string): PanelAppLifecycleModule<THost, TContext> {
    const module = this.modules.get(appId);
    if (!module) throw new Error(`unknown Panel App lifecycle module '${appId}'`);
    return module;
  }

  private requirePanel(appId: string, instanceId: string): PanelAppInstance<TContext> {
    const panel = this.panels.get(panelKey(appId, instanceId));
    if (!panel) {
      throw new Error(`Panel App instance '${appId}:${instanceId}' is not mounted`);
    }
    return panel;
  }

  private async emit(
    appId: string,
    host: THost,
    event: PanelAppLifecycleEvent<TContext>,
  ): Promise<void> {
    const configured = this.requireModule(appId).hooks?.[event.type];
    const hooks = configured ? (Array.isArray(configured) ? configured : [configured]) : [];
    for (const hook of hooks as readonly PanelAppLifecycleHook<THost, TContext>[]) {
      try {
        await hook({ appId, host, event });
      } catch (error) {
        this.options.onError?.({ appId, event, host, error });
      }
    }
  }
}
