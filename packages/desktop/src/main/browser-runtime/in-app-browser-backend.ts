import { partitionForSession } from "../browser-driver/active-guest.js";
import {
  backgroundBrowserRuntime,
  type BackgroundBrowserRuntime,
} from "../browser-driver/background-runtime.js";
import type {
  BrowserRuntimeBackend,
  BrowserRuntimeBackendAcquireOptions,
  BrowserRuntimeBackendLease,
} from "./backend.js";

interface InAppTargetPool {
  acquire(options: { ownerId: string; partition: string; initialUrl?: string; title?: string }): {
    bridge: BrowserRuntimeBackendLease["bridge"];
    show(): Promise<void>;
    hide(): void;
    release(): void;
  };
  close(ownerId: string): void;
  closeAll(): void;
}

export interface InAppBrowserBackendOptions {
  targetPool?: InAppTargetPool;
  /** Test seam. Production resolves the exact BrowserPanel session partition. */
  partitionForProfile?: (profileId: string) => string | null;
}

/**
 * Default Browser Runtime backend.
 *
 * It owns a task-only background target, but places that target in the same
 * Electron partition as the task's in-app BrowserPanel. Cookies and sign-in
 * state are therefore shared without granting control of any user-opened tab.
 * `show()` reveals this exact target in place for login or human takeover.
 */
export class InAppBrowserBackend implements BrowserRuntimeBackend {
  readonly kind = "in-app" as const;
  private readonly targetPool: InAppTargetPool;
  private readonly resolvePartition: (profileId: string) => string | null;

  constructor(options: InAppBrowserBackendOptions = {}) {
    this.targetPool = options.targetPool ?? backgroundBrowserRuntime;
    this.resolvePartition =
      options.partitionForProfile ?? ((profileId) => partitionForSession(profileId));
  }

  isAvailable(): boolean {
    return true;
  }

  async acquire(options: BrowserRuntimeBackendAcquireOptions): Promise<BrowserRuntimeBackendLease> {
    const partition = this.resolvePartition(options.profileId);
    if (!partition) {
      throw new Error(`no in-app browser profile is registered for ${options.profileId}`);
    }
    const lease = this.targetPool.acquire({
      ownerId: options.ownerId,
      partition,
      initialUrl: options.initialUrl,
      title: options.title,
    });
    return {
      kind: this.kind,
      bridge: lease.bridge,
      canReveal: true,
      show: () => lease.show(),
      hide: () => lease.hide(),
      release: () => lease.release(),
    };
  }

  close(ownerId: string): void {
    this.targetPool.close(ownerId);
  }

  closeAll(): void {
    this.targetPool.closeAll();
  }
}

export const inAppBrowserBackend = new InAppBrowserBackend({
  targetPool: backgroundBrowserRuntime as BackgroundBrowserRuntime,
});
