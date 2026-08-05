import type { BrowserBridge } from "@cjhyy/code-shell-core";

/** Runtime-owned target kinds. Explicit tab claims are routed before lease acquisition. */
export type BrowserRuntimeBackendKind = "in-app" | "dedicated-playwright";

export type BrowserRuntimeBackendPreference = "auto" | BrowserRuntimeBackendKind;

export interface BrowserRuntimeBackendAcquireOptions {
  ownerId: string;
  profileId: string;
  initialUrl?: string;
  title?: string;
}

export interface BrowserRuntimeBackendLease {
  readonly kind: BrowserRuntimeBackendKind;
  readonly bridge: BrowserBridge;
  /** Whether this concrete target can be revealed without changing sessions. */
  readonly canReveal: boolean;
  show(): Promise<void>;
  hide(): void;
  release(): void;
}

/**
 * Concrete execution backend below the product-level Browser Runtime.
 *
 * Backends own transports and browser processes. They do not choose which
 * product surface the model is allowed to control; that decision belongs to
 * DesktopBrowserRuntime and the explicit handoff layer above it.
 */
export interface BrowserRuntimeBackend {
  readonly kind: BrowserRuntimeBackendKind;
  /** Cheap availability probe. acquire() remains authoritative. */
  isAvailable(): boolean;
  acquire(options: BrowserRuntimeBackendAcquireOptions): Promise<BrowserRuntimeBackendLease>;
  close(ownerId: string): void;
  closeAll(): void;
}
