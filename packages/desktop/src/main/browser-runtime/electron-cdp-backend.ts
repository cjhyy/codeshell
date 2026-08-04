import {
  backgroundBrowserRuntime,
  type BackgroundBrowserRuntime,
} from "../browser-driver/background-runtime.js";
import type {
  BrowserRuntimeBackend,
  BrowserRuntimeBackendAcquireOptions,
  BrowserRuntimeBackendLease,
} from "./backend.js";
import { browserRuntimePartition } from "./profile.js";

interface ElectronTargetPool {
  acquire(options: {
    ownerId: string;
    partition: string;
    initialUrl?: string;
    title?: string;
  }): {
    bridge: BrowserRuntimeBackendLease["bridge"];
    show(): Promise<void>;
    hide(): void;
    release(): void;
  };
  close(ownerId: string): void;
  closeAll(): void;
}

/** Mature-runtime fallback and adapter for explicit Electron tab handoff. */
export class ElectronCdpRuntimeBackend implements BrowserRuntimeBackend {
  readonly kind = "electron-cdp" as const;

  constructor(private readonly targetPool: ElectronTargetPool = backgroundBrowserRuntime) {}

  isAvailable(): boolean {
    return true;
  }

  async acquire(
    options: BrowserRuntimeBackendAcquireOptions,
  ): Promise<BrowserRuntimeBackendLease> {
    const lease = this.targetPool.acquire({
      ownerId: options.ownerId,
      partition: browserRuntimePartition(options.profileId),
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

export const electronCdpRuntimeBackend = new ElectronCdpRuntimeBackend(
  backgroundBrowserRuntime as BackgroundBrowserRuntime,
);
