/** Bounded developer observations, without an arbitrary script or CDP port. */
export interface BrowserInspectOptions {
  mode: "dom" | "console" | "network" | "performance" | "stop";
  /** DOM mode: CSS selector for the subtree to inspect. */
  selector?: string;
  /** Maximum returned records/nodes, clamped by the inspector. */
  maxEntries?: number;
}

export interface BrowserInspectResult {
  ok: boolean;
  mode: BrowserInspectOptions["mode"];
  code?: "BLOCKED" | "TARGET_CLOSED" | "FAILED";
  url?: string;
  data?: unknown;
  detail?: string;
}

/**
 * Public page operations used by the inspector. The host supplies an authorized
 * page; this module does not select targets or own the browser connection.
 * Compatible page libraries can implement this port without runtime imports.
 */
export interface BrowserInspectorPage {
  url(): string;
  isClosed(): boolean;
  mainFrame?(): unknown;
  evaluate: (fn: any, arg?: any) => Promise<any>;
  on: (event: any, listener: any) => unknown;
  off: (event: any, listener: any) => unknown;
}

export interface BrowserInspector {
  inspect(options: BrowserInspectOptions): Promise<BrowserInspectResult>;
  dispose(): void;
}
