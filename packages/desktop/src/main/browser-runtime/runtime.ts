/**
 * Desktop Browser Runtime.
 *
 * This is the ownership boundary between agent browser tools and concrete
 * browser targets. The built-in BrowserPanel is a user-facing product surface
 * and is deliberately not consulted here. A runtime lease always targets a
 * task-owned browser session. It never controls a user-opened BrowserPanel tab
 * unless that exact tab is explicitly claimed by the handoff service.
 *
 * The default backend is a background in-app-browser target sharing the task's
 * BrowserPanel profile. Dedicated Playwright remains available for isolated
 * crawling, scheduled work, and other explicitly unattended execution.
 */

import { ConfiguredBrowserRuntime } from "./configured-runtime.js";
export type {
  BrowserRuntimeVisibility,
  BrowserRuntimeAcquireOptions,
  BrowserRuntimeLike,
  BrowserRuntimeLease,
} from "./configured-runtime.js";
import type { BackgroundBrowserLease } from "../browser-driver/background-runtime.js";
import type { BrowserRuntimeBackend, BrowserRuntimeBackendPreference } from "./backend.js";
import { InAppBrowserBackend, inAppBrowserBackend } from "./in-app-browser-backend.js";
import { dedicatedPlaywrightBackend } from "./playwright-backend.js";
export { browserRuntimePartition } from "./profile.js";

export interface RuntimeTargetPool {
  acquire(options: {
    ownerId: string;
    partition: string;
    initialUrl?: string;
    title?: string;
  }): BackgroundBrowserLease;
  close(ownerId: string): void;
  closeAll(): void;
  cancelPending?(ownerId: string): void;
  beginRun?(ownerId: string): void;
}

export interface DesktopBrowserRuntimeOptions {
  /** Test seam; production uses the main-process in-app target pool. */
  targetPool?: RuntimeTargetPool;
  /** Test seam for resolving the in-app partition used by targetPool. */
  inAppPartitionForProfile?: (profileId: string) => string | null;
  /** Ordered concrete backends. Production uses in-app, then optional Playwright. */
  backends?: BrowserRuntimeBackend[];
  /** Default is in-app. "auto" is opt-in fallback behavior. */
  backendPreference?: BrowserRuntimeBackendPreference;
}

export class DesktopBrowserRuntime extends ConfiguredBrowserRuntime {
  constructor(options: DesktopBrowserRuntimeOptions = {}) {
    if (options.targetPool && options.backends) {
      throw new Error("provide targetPool or backends, not both");
    }
    const backends = options.targetPool
      ? [
          new InAppBrowserBackend({
            targetPool: options.targetPool,
            partitionForProfile: options.inAppPartitionForProfile,
          }),
        ]
      : (options.backends ?? [inAppBrowserBackend, dedicatedPlaywrightBackend]);
    super(backends, options.backendPreference ?? "in-app");
  }
}

export const browserRuntime = new DesktopBrowserRuntime();
