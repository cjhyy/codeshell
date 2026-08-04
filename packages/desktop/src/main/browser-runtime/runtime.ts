/**
 * Desktop Browser Runtime.
 *
 * This is the ownership boundary between agent browser tools and concrete
 * browser targets. The built-in BrowserPanel is a user-facing product surface
 * and is deliberately not consulted here. A runtime lease always targets a
 * browser session owned by the runtime itself; explicit BrowserPanel handoff is
 * a separate capability that can be added as another backend later.
 *
 * The default backend is a Playwright-owned Chromium profile. The existing
 * hidden Electron/CDP pool remains a compatibility fallback and later serves
 * as the adapter for explicit built-in-browser handoff.
 */

import type { BrowserBridge } from "@cjhyy/code-shell-core";
import { type BackgroundBrowserLease } from "../browser-driver/background-runtime.js";
import type {
  BrowserRuntimeBackend,
  BrowserRuntimeBackendKind,
} from "./backend.js";
import {
  ElectronCdpRuntimeBackend,
  electronCdpRuntimeBackend,
} from "./electron-cdp-backend.js";
import { playwrightRuntimeBackend } from "./playwright-backend.js";
export { browserRuntimePartition } from "./profile.js";

export type BrowserRuntimeVisibility = "hidden" | "milestones" | "full";

export interface BrowserRuntimeAcquireOptions {
  /** Stable owner of this execution session, e.g. interactive:<sid>. */
  ownerId: string;
  /** Stable, explicit runtime login profile. Never a BrowserPanel bucket. */
  profileId: string;
  /** Controls UI projection only; the complete trace remains available. */
  visibility: BrowserRuntimeVisibility;
  initialUrl?: string;
  title?: string;
}

export interface BrowserRuntimeLease {
  readonly ownerId: string;
  readonly profileId: string;
  readonly visibility: BrowserRuntimeVisibility;
  readonly backendKind: BrowserRuntimeBackendKind | "pending";
  readonly canReveal: boolean;
  /** Compatibility port consumed by the current three core browser tools. */
  readonly bridge: BrowserBridge;
  /** Reveal the exact runtime-owned target for login/2FA/human takeover. */
  show(): Promise<void>;
  hide(): void;
  release(): void;
}

export interface BrowserRuntimeLike {
  acquire(options: BrowserRuntimeAcquireOptions): Promise<BrowserRuntimeLease>;
  close(ownerId: string): void;
  closeAll(): void;
}

export interface RuntimeTargetPool {
  acquire(options: {
    ownerId: string;
    partition: string;
    initialUrl?: string;
    title?: string;
  }): BackgroundBrowserLease;
  close(ownerId: string): void;
  closeAll(): void;
}

export interface DesktopBrowserRuntimeOptions {
  /** Test seam; production uses the main-process hidden Electron target pool. */
  targetPool?: RuntimeTargetPool;
  /** Ordered concrete backends. Production uses Playwright, then Electron/CDP. */
  backends?: BrowserRuntimeBackend[];
  /** "auto" falls back; an explicit backend fails closed instead. */
  backendPreference?: "auto" | BrowserRuntimeBackendKind;
}

export class DesktopBrowserRuntime implements BrowserRuntimeLike {
  private readonly backends: BrowserRuntimeBackend[];
  private readonly backendPreference: "auto" | BrowserRuntimeBackendKind;
  private readonly selectedBackendByOwner = new Map<string, BrowserRuntimeBackendKind>();
  private readonly profileByOwner = new Map<string, string>();
  private readonly progressByOwner = new Map<
    string,
    {
      readRequest?: string;
      readSignature?: string;
      scrollSignature?: string;
    }
  >();

  constructor(options: DesktopBrowserRuntimeOptions = {}) {
    if (options.targetPool && options.backends) {
      throw new Error("provide targetPool or backends, not both");
    }
    this.backends = options.targetPool
      ? [new ElectronCdpRuntimeBackend(options.targetPool)]
      : options.backends ?? [playwrightRuntimeBackend, electronCdpRuntimeBackend];
    this.backendPreference = options.backendPreference ?? "auto";
  }

  async acquire(options: BrowserRuntimeAcquireOptions): Promise<BrowserRuntimeLease> {
    const ownerId = options.ownerId.trim();
    const profileId = options.profileId.trim();
    if (!ownerId) throw new Error("browser runtime ownerId is required");
    if (!profileId) throw new Error("browser runtime profileId is required");

    const boundProfile = this.profileByOwner.get(ownerId);
    if (boundProfile && boundProfile !== profileId) {
      throw new Error(`browser runtime owner ${ownerId} is already bound to profile ${boundProfile}`);
    }
    this.profileByOwner.set(ownerId, profileId);

    let backendLease: Awaited<ReturnType<BrowserRuntimeBackend["acquire"]>> | undefined;
    let backendLeasePromise:
      | Promise<Awaited<ReturnType<BrowserRuntimeBackend["acquire"]>>>
      | undefined;
    let released = false;
    const ensureBackend = async () => {
      if (released) throw new Error("browser runtime lease has been released");
      if (backendLease) return backendLease;
      backendLeasePromise ??= this.acquireBackend(ownerId, profileId, options);
      backendLease = await backendLeasePromise;
      return backendLease;
    };
    const lazyBridge = lazyBrowserBridge(async () => {
      const lease = await ensureBackend();
      return lease.bridge;
    });

    return {
      ownerId,
      profileId,
      visibility: options.visibility,
      get backendKind() {
        return backendLease?.kind ?? "pending";
      },
      get canReveal() {
        return backendLease?.canReveal ?? false;
      },
      bridge: this.withProgressGuard(ownerId, lazyBridge),
      show: async () => (await ensureBackend()).show(),
      hide: () => backendLease?.hide(),
      release: () => {
        if (released) return;
        released = true;
        backendLease?.release();
        if (!backendLease && backendLeasePromise) {
          void backendLeasePromise.then((lease) => lease.release()).catch(() => undefined);
        }
      },
    };
  }

  private async acquireBackend(
    ownerId: string,
    profileId: string,
    options: BrowserRuntimeAcquireOptions,
  ): Promise<Awaited<ReturnType<BrowserRuntimeBackend["acquire"]>>> {
    const selected = this.selectedBackendByOwner.get(ownerId);
    const candidates = this.backends.filter((backend) => {
      if (selected) return backend.kind === selected;
      if (this.backendPreference !== "auto") return backend.kind === this.backendPreference;
      return true;
    });
    const failures: string[] = [];
    let backendLease: Awaited<ReturnType<BrowserRuntimeBackend["acquire"]>> | undefined;
    for (const backend of candidates) {
      if (!backend.isAvailable()) {
        failures.push(`${backend.kind}: unavailable`);
        continue;
      }
      try {
        backendLease = await backend.acquire({
          ownerId,
          profileId,
          initialUrl: options.initialUrl,
          title: options.title?.trim() || "CodeShell Browser Runtime — 需要你接管",
        });
        this.selectedBackendByOwner.set(ownerId, backend.kind);
        break;
      } catch (error) {
        failures.push(`${backend.kind}: ${error instanceof Error ? error.message : String(error)}`);
        // An acquire failure must not leave a half-open context or profile lock.
        backend.close(ownerId);
        if (selected || this.backendPreference !== "auto") break;
      }
    }
    if (!backendLease) {
      throw new Error(`no Browser Runtime backend could be acquired (${failures.join("; ")})`);
    }
    return backendLease;
  }

  close(ownerId: string): void {
    this.progressByOwner.delete(ownerId);
    this.selectedBackendByOwner.delete(ownerId);
    this.profileByOwner.delete(ownerId);
    for (const backend of this.backends) backend.close(ownerId);
  }

  closeAll(): void {
    this.progressByOwner.clear();
    this.selectedBackendByOwner.clear();
    this.profileByOwner.clear();
    for (const backend of this.backends) backend.closeAll();
  }

  private withProgressGuard(ownerId: string, bridge: BrowserBridge): BrowserBridge {
    const state = this.progressByOwner.get(ownerId) ?? {};
    this.progressByOwner.set(ownerId, state);
    return {
      ...bridge,
      snapshot: async () => {
        const result = await bridge.snapshot();
        // A new snapshot is a new semantic observation. Preserve read progress
        // only when the document itself is unchanged.
        if (result.documentId && !state.readSignature?.startsWith(`${result.documentId}|`)) {
          state.readRequest = undefined;
          state.readSignature = undefined;
          state.scrollSignature = undefined;
        }
        return result;
      },
      navigate: async (url) => {
        const result = await bridge.navigate(url);
        if (result.ok) {
          state.readRequest = undefined;
          state.readSignature = undefined;
          state.scrollSignature = undefined;
        }
        return result;
      },
      readContent: async (readOptions) => {
        const result = await bridge.readContent(readOptions);
        if (!result.ok) return result;
        const request = readOptions?.cursor ?? "<start>";
        const signature = [
          result.documentId ?? result.url,
          result.contentHash ?? result.text,
          result.cursor ?? request,
          result.nextCursor ?? "<done>",
        ].join("|");
        if (state.readRequest === request && state.readSignature === signature) {
          return {
            ...result,
            ok: false,
            code: "NO_PROGRESS",
            detail:
              "repeated read produced the same chunk; use nextCursor, change the page, or stop",
          };
        }
        state.readRequest = request;
        state.readSignature = signature;
        return result;
      },
      scroll: async (dir, amount) => {
        const result = await bridge.scroll(dir, amount);
        if (!result.ok || !result.scroll) return result;
        const signature = [
          result.documentId ?? "",
          Math.round(result.scroll.x),
          Math.round(result.scroll.y),
          Math.round(result.scroll.maxX),
          Math.round(result.scroll.maxY),
          result.contentChanged === true ? "content-changed" : "content-same",
        ].join("|");
        if (state.scrollSignature === signature) {
          return {
            ...result,
            ok: false,
            code: "NO_PROGRESS",
            retryable: false,
            detail: result.scroll.atEnd
              ? "repeated scroll is already at the end of the page"
              : "repeated scroll produced no observable progress",
          };
        }
        state.scrollSignature = signature;
        return result;
      },
    };
  }
}

function lazyBrowserBridge(resolve: () => Promise<BrowserBridge>): BrowserBridge {
  return {
    snapshot: async () => (await resolve()).snapshot(),
    click: async (ref) => (await resolve()).click(ref),
    type: async (ref, text) => (await resolve()).type(ref, text),
    navigate: async (url) => (await resolve()).navigate(url),
    scroll: async (dir, amount) => (await resolve()).scroll(dir, amount),
    readContent: async (options) => (await resolve()).readContent(options),
    extractLinks: async () => (await resolve()).extractLinks(),
    waitForLoad: async (timeoutMs) => (await resolve()).waitForLoad(timeoutMs),
    hover: async (ref) => (await resolve()).hover(ref),
    selectOption: async (ref, value) => (await resolve()).selectOption(ref, value),
    pressKey: async (key, ref) => (await resolve()).pressKey(key, ref),
    fetchImages: async (refs) => (await resolve()).fetchImages(refs),
    screenshot: async (ref) => (await resolve()).screenshot(ref),
    listTabs: async () => (await resolve()).listTabs(),
    switchTab: async (tabId) => (await resolve()).switchTab(tabId),
  };
}

export const browserRuntime = new DesktopBrowserRuntime();
