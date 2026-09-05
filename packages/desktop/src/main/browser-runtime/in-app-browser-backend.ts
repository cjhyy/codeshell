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
import type { BrowserBridge, BrowserIdentity, BrowserSnapshot } from "@cjhyy/code-shell-core";

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
      // Stamp the identity the model sees. Only this layer knows which
      // partition the session resolved to, and browser_observe renders it so
      // the model can tell a sandbox from a real logged-in browser.
      bridge: withIdentity(lease.bridge, {
        profileId: partition,
        sourceKind: "builtin-panel",
      }),
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

/**
 * Wrap a bridge so every snapshot reports which identity produced it, leaving
 * all other behavior — and every other method — untouched.
 */
function withIdentity(inner: BrowserBridge, identity: BrowserIdentity): BrowserBridge {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== "snapshot") return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        const snap = await (target.snapshot as (...a: unknown[]) => Promise<BrowserSnapshot>).apply(
          target,
          args,
        );
        // A bridge that already knows its identity (a future external source)
        // wins: it knows more than this backend does.
        return snap.identity ? snap : { ...snap, identity };
      };
    },
  });
}
