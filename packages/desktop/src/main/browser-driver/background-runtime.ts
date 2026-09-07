/**
 * BackgroundBrowserRuntime — legacy-named low-level pool of runtime-owned hidden
 * Electron BrowserWindows.
 *
 * This is not the product-level Browser Runtime and it never selects a visible
 * BrowserPanel tab. `browser-runtime/runtime.ts` owns agent session/profile
 * semantics and uses this class only as its initial Electron target backend.
 * The legacy public name remains temporarily for compatibility with focused
 * driver tests and the smoke script.
 *
 * Design constraints:
 * - lazy: acquiring a lease does not start Chromium; the first browser call does
 * - isolated: every owner gets a persistent partition supplied by the caller
 * - serial: one CDP action at a time per target, preserving snapshot ref maps
 * - bounded: a small target cap plus idle eviction prevents renderer leaks
 * - fail-closed: domain policy and sensitive literal input are enforced here
 * - inspectable: a hidden target can be revealed for a human takeover
 */

import type {
  BrowserBridge,
  BrowserContent,
  BrowserExtract,
  BrowserImageData,
  BrowserResult,
  BrowserSnapshot,
  BrowserTab,
} from "@cjhyy/code-shell-core";
import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  openBrowserHost,
  type BrowserHostHandle,
  type BrowserHostOpenOptions,
} from "../browser-host/index.js";
import { CdpBrowserDriver } from "./cdp-driver.js";
import { attachDebugger, detachDebugger, driverFor } from "./electron-cdp.js";
import { loadBrowserAutomationPolicy } from "./load-policy.js";
import {
  isDomainAllowed,
  isSensitiveAction,
  SENSITIVE_WORDS,
  type BrowserAutomationPolicy,
} from "./policy.js";

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TARGETS = 3;
const BACKGROUND_TAB_ID = "background";
const DEFAULT_CONTINUITY_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_REMEMBERED_TARGETS = 128;

interface TargetContinuity {
  partition: string;
  tabId: string;
  url: string;
  title: string;
  reason: "idle" | "capacity" | "closed";
  expiresAt: number;
}

type BrowserDriver = CdpBrowserDriver;

export interface BackgroundBrowserAcquireOptions {
  /** Stable task/session identity. Re-acquiring the same owner reuses its target. */
  ownerId: string;
  /** Persistent Electron partition, e.g. persist:browser:automation:<job>. */
  partition: string;
  /** Initial page. Defaults to about:blank and remains lazy until first use. */
  initialUrl?: string;
  /** Window title used if the target is revealed for a human takeover. */
  title?: string;
}

export interface BackgroundBrowserLease {
  readonly bridge: BrowserBridge;
  /** Reveal the exact target (same DOM/session/ref state) for human intervention. */
  show(): Promise<void>;
  hide(): void;
  /** Release this run's ownership. Idempotent; target is evicted after the idle TTL. */
  release(): void;
}

export interface BackgroundBrowserRuntimeLike {
  acquire(options: BackgroundBrowserAcquireOptions): BackgroundBrowserLease;
}

interface BackgroundTarget {
  host: BrowserHostHandle;
  driver: BrowserDriver;
}

interface RuntimeEntry {
  ownerId: string;
  partition: string;
  initialUrl: string;
  title: string;
  leases: number;
  tabId: string;
  lastUrl: string;
  lastTitle: string;
  recovery?: TargetContinuity["reason"];
  pendingOperations: number;
  lastUsedAt: number;
  target?: BackgroundTarget;
  opening?: Promise<BackgroundTarget>;
  idleTimer?: ReturnType<typeof setTimeout>;
  disposed?: boolean;
  /** Rebuilt on snapshot; these refs require the exact target to be shown. */
  interactiveOnlyRefs: Set<string>;
  /** Promise-chain mutex. Rejections are swallowed only in the stored tail. */
  tail: Promise<void>;
}

interface BackgroundBrowserRuntimeDeps {
  openHost: (options: BrowserHostOpenOptions) => Promise<BrowserHostHandle>;
  createDriver: (webContents: WebContents) => BrowserDriver;
  attach: (webContents: WebContents) => boolean;
  detach: (webContents: WebContents) => void;
  policy: () => BrowserAutomationPolicy;
  now: () => number;
}

export interface BackgroundBrowserRuntimeOptions {
  idleTtlMs?: number;
  maxTargets?: number;
  /** Bounded metadata only; these do not retain Chromium targets or DOM refs. */
  continuityTtlMs?: number;
  maxRememberedTargets?: number;
  /** Test seams; production callers should omit. */
  deps?: Partial<BackgroundBrowserRuntimeDeps>;
}

export function backgroundBrowserPartition(ownerId: string): string {
  const safe = ownerId.replace(/[^a-zA-Z0-9_:.@-]/g, "_").slice(0, 160);
  return `persist:browser:automation:${safe || "anonymous"}`;
}

export class BackgroundBrowserRuntime implements BackgroundBrowserRuntimeLike {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly continuity = new Map<string, TargetContinuity>();
  private readonly continuityTtlMs: number;
  private readonly maxRememberedTargets: number;
  private readonly idleTtlMs: number;
  private readonly maxTargets: number;
  private readonly deps: BackgroundBrowserRuntimeDeps;

  constructor(options: BackgroundBrowserRuntimeOptions = {}) {
    this.idleTtlMs = positiveFiniteOr(options.idleTtlMs, DEFAULT_IDLE_TTL_MS);
    this.continuityTtlMs = positiveFiniteOr(options.continuityTtlMs, DEFAULT_CONTINUITY_TTL_MS);
    this.maxRememberedTargets = Math.max(
      1,
      Math.floor(positiveFiniteOr(options.maxRememberedTargets, DEFAULT_MAX_REMEMBERED_TARGETS)),
    );
    this.maxTargets = Math.max(
      1,
      Math.floor(positiveFiniteOr(options.maxTargets, DEFAULT_MAX_TARGETS)),
    );
    this.deps = {
      openHost: openBrowserHost,
      createDriver: driverFor,
      attach: attachDebugger,
      detach: detachDebugger,
      policy: loadBrowserAutomationPolicy,
      now: Date.now,
      ...options.deps,
    };
  }

  acquire(options: BackgroundBrowserAcquireOptions): BackgroundBrowserLease {
    const ownerId = options.ownerId.trim();
    const partition = options.partition.trim();
    if (!ownerId) throw new Error("background browser ownerId is required");
    if (!partition) throw new Error("background browser partition is required");

    this.pruneContinuity();
    const remembered = this.continuity.get(ownerId);
    if (remembered && remembered.partition !== partition) {
      throw new Error(`background browser owner ${ownerId} is already bound to another partition`);
    }
    let entry = this.entries.get(ownerId);
    if (entry && entry.partition !== partition) {
      throw new Error(`background browser owner ${ownerId} is already bound to another partition`);
    }
    if (!entry) {
      entry = {
        ownerId,
        partition,
        initialUrl: options.initialUrl?.trim() || "about:blank",
        title: options.title?.trim() || "CodeShell 后台浏览器",
        leases: 0,
        tabId: remembered?.tabId ?? `task-tab-${randomUUID()}`,
        lastUrl: remembered?.url ?? options.initialUrl?.trim() ?? "about:blank",
        lastTitle: remembered?.title ?? "",
        recovery: remembered?.reason,
        pendingOperations: 0,
        lastUsedAt: this.deps.now(),
        interactiveOnlyRefs: new Set(),
        tail: Promise.resolve(),
      };
      this.entries.set(ownerId, entry);
      this.continuity.delete(ownerId);
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.leases += 1;
    entry.lastUsedAt = this.deps.now();

    let released = false;
    const bridge = this.bridgeFor(entry, () => !released);
    return {
      bridge,
      show: async () => {
        const target = await this.enqueue(entry!, () => {
          if (released) throw new Error("background browser lease has been released");
          return this.ensureTarget(entry!);
        });
        target.host.show();
      },
      hide: () => {
        if (!released) entry?.target?.host.hide();
      },
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(entry!);
      },
    };
  }

  /** Immediately closes every hidden target. Used during app shutdown and tests. */
  closeAll(): void {
    for (const entry of [...this.entries.values()]) this.disposeEntry(entry);
    this.continuity.clear();
  }

  /** Immediately close one owner's target, for example when a session is deleted. */
  close(ownerId: string): void {
    this.continuity.delete(ownerId);
    const entry = this.entries.get(ownerId);
    if (entry) this.disposeEntry(entry);
  }

  /** Small observable surface for tests/diagnostics; never exposes cookies or page data. */
  stats(): { entries: number; liveTargets: number; leased: number } {
    const values = [...this.entries.values()];
    return {
      entries: values.length,
      liveTargets: values.filter((e) => e.target !== undefined).length,
      leased: values.reduce((sum, e) => sum + e.leases, 0),
    };
  }

  private bridgeFor(entry: RuntimeEntry, isActive: () => boolean): BrowserBridge {
    const queue = <T>(operation: () => Promise<T>) =>
      this.enqueue(entry, () => {
        if (!isActive()) throw new Error("background browser lease has been released");
        return operation();
      });
    const use = <T>(
      operation: (target: BackgroundTarget) => Promise<T>,
      recover = false,
    ): Promise<T> =>
      queue(async () => {
        const target = await this.ensureTarget(entry, recover);
        entry.lastUsedAt = this.deps.now();
        const attached = this.deps.attach(target.host.webContents);
        try {
          return await operation(target);
        } finally {
          entry.lastUrl = safeCall(() => target.host.webContents.getURL()) ?? entry.lastUrl;
          entry.lastTitle = safeCall(() => target.host.webContents.getTitle()) ?? entry.lastTitle;
          if (attached) {
            this.deps.detach(target.host.webContents);
            target.driver.resetDomains();
          }
        }
      });

    const currentPage = (target: BackgroundTarget) => ({
      url: safeCall(() => target.host.webContents.getURL()) ?? "",
      title: safeCall(() => target.host.webContents.getTitle()) ?? undefined,
    });
    const allowed = (target: BackgroundTarget) => {
      const { url } = currentPage(target);
      return isInternalPage(url) || isDomainAllowed(url, this.deps.policy());
    };
    const deniedDetail = (target: BackgroundTarget) => {
      const { url } = currentPage(target);
      return `background browser domain not allowed by whitelist: ${hostOf(url)}`;
    };

    return {
      snapshot: () =>
        safely(
          () =>
            use(async ({ driver, ...target }) => {
              const full = { driver, ...target };
              if (!allowed(full)) {
                const page = currentPage(full);
                return {
                  ...page,
                  elements: [],
                  detail: deniedDetail(full),
                } satisfies BrowserSnapshot;
              }
              const snapshot = await driver.snapshot();
              entry.interactiveOnlyRefs = new Set(
                snapshot.elements
                  .filter(
                    (element) => element.sensitive === true || hasHighConsequenceName(element.name),
                  )
                  .map((element) => element.ref),
              );
              if (snapshot.needsHuman) full.host.show();
              return snapshot;
            }),
          (detail) => ({ url: "", elements: [], detail }),
        ),
      click: (ref) =>
        safely(
          () =>
            use(async (target) => {
              if (!allowed(target)) return { ok: false, detail: deniedDetail(target) };
              if (entry.interactiveOnlyRefs.has(ref)) {
                target.host.show();
                return {
                  ok: false,
                  detail: "high-consequence action requires an interactive browser session",
                };
              }
              return target.driver.click(ref);
            }),
          failResult,
        ),
      type: (ref, text) =>
        safely(
          () =>
            use(async (target) => {
              if (!allowed(target)) return { ok: false, detail: deniedDetail(target) };
              if (
                entry.interactiveOnlyRefs.has(ref) ||
                isSensitiveAction({ action: "type", ref, text })
              ) {
                target.host.show();
                return {
                  ok: false,
                  detail: "sensitive input requires an interactive browser session",
                };
              }
              return target.driver.type(ref, text);
            }),
          failResult,
        ),
      navigate: (url) =>
        safely(
          () =>
            use(async (target) => {
              if (!isInternalPage(url) && !isDomainAllowed(url, this.deps.policy())) {
                return {
                  ok: false,
                  detail: `background browser domain not allowed by whitelist: ${hostOf(url)}`,
                };
              }
              const result = await target.driver.navigate(url);
              if (result.ok) entry.interactiveOnlyRefs.clear();
              return result;
            }, true),
          failResult,
        ),
      scroll: (dir, amount) =>
        safely(
          () =>
            use(async (target) =>
              allowed(target)
                ? target.driver.scroll(dir, amount)
                : { ok: false, detail: deniedDetail(target) },
            ),
          failResult,
        ),
      readContent: (options) =>
        safely(
          () =>
            use(async (target) => {
              if (allowed(target)) return target.driver.readContent(options);
              const page = currentPage(target);
              return {
                ok: false,
                ...page,
                text: "",
                detail: deniedDetail(target),
              } satisfies BrowserContent;
            }),
          (detail) => ({ ok: false, url: "", text: "", detail }),
        ),
      extractLinks: () =>
        safely(
          () =>
            use(async (target) => {
              if (allowed(target)) return target.driver.extractLinks();
              const page = currentPage(target);
              return {
                ok: false,
                ...page,
                links: [],
                images: [],
                videos: [],
                detail: deniedDetail(target),
              } satisfies BrowserExtract;
            }),
          (detail) => ({
            ok: false,
            url: "",
            links: [],
            images: [],
            videos: [],
            detail,
          }),
        ),
      waitForLoad: (timeoutMs) =>
        safely(
          () =>
            use(async (target) =>
              allowed(target)
                ? target.driver.waitForLoad(timeoutMs)
                : { ok: false, detail: deniedDetail(target) },
            ),
          failResult,
        ),
      hover: (ref) =>
        safely(
          () =>
            use(async (target) =>
              allowed(target)
                ? target.driver.hover(ref)
                : { ok: false, detail: deniedDetail(target) },
            ),
          failResult,
        ),
      selectOption: (ref, value) =>
        safely(
          () =>
            use(async (target) =>
              allowed(target)
                ? target.driver.selectOption(ref, value)
                : { ok: false, detail: deniedDetail(target) },
            ),
          failResult,
        ),
      pressKey: (key, ref) =>
        safely(
          () =>
            use(async (target) => {
              if (!allowed(target)) return { ok: false, detail: deniedDetail(target) };
              if (ref && entry.interactiveOnlyRefs.has(ref)) {
                target.host.show();
                return {
                  ok: false,
                  detail: "sensitive input requires an interactive browser session",
                };
              }
              return target.driver.pressKey(key, ref);
            }),
          failResult,
        ),
      fetchImages: (refs) =>
        safely(
          () =>
            use(async (target) =>
              allowed(target)
                ? target.driver.fetchImages(refs)
                : refs.map(
                    (ref) =>
                      ({
                        ok: false,
                        ref,
                        detail: deniedDetail(target),
                      }) satisfies BrowserImageData,
                  ),
            ),
          (detail) => refs.map((ref) => ({ ok: false, ref, detail })),
        ),
      screenshot: (ref) =>
        safely(
          () =>
            use(async (target) =>
              allowed(target)
                ? target.driver.screenshot(ref)
                : { ok: false, detail: deniedDetail(target) },
            ),
          failImage,
        ),
      listTabs: () =>
        safely(
          () =>
            queue<BrowserTab[]>(async () => {
              if (!entry.target && entry.recovery) {
                return [
                  {
                    tabId: entry.tabId,
                    url: entry.lastUrl,
                    title: entry.lastTitle,
                    active: false,
                    status: "closed",
                  },
                ];
              }
              const target = await this.ensureTarget(entry);
              const page = currentPage(target);
              return [
                {
                  tabId: entry.tabId,
                  url: page.url,
                  title: page.title ?? "",
                  active: true,
                  status: "open",
                },
              ];
            }),
          () => [],
        ),
      switchTab: (tabId) =>
        safely(
          () =>
            queue<BrowserResult>(async () => {
              // Never create a target just to reject an unrelated/stale handle.
              if (tabId !== entry.tabId && tabId !== BACKGROUND_TAB_ID) {
                return {
                  ok: false,
                  code: "FAILED",
                  retryable: false,
                  detail: `tab ${tabId} is not owned by this task. Use browser_act with action "list_tabs" for this task's current handle; do not retry the old ID.`,
                };
              }
              await this.ensureTarget(entry);
              return { ok: true, code: "OK" };
            }),
          failResult,
        ),
    };
  }

  private async ensureTarget(entry: RuntimeEntry, recover = false): Promise<BackgroundTarget> {
    if (entry.disposed || this.entries.get(entry.ownerId) !== entry) {
      throw new Error("background browser lease is no longer active");
    }
    if (entry.target) return entry.target;
    if (entry.opening) return entry.opening;
    if (entry.recovery && !recover) throw new Error(recoveryDetail(entry));
    this.makeTargetCapacity(entry);

    const opening = this.deps
      .openHost({
        kind: "window",
        url: entry.recovery ? "about:blank" : entry.initialUrl,
        partition: entry.partition,
        title: entry.title,
        show: false,
        backgroundThrottling: false,
      })
      .then((host) => {
        if (entry.disposed || this.entries.get(entry.ownerId) !== entry) {
          host.close();
          throw new Error("background browser lease was released while opening");
        }
        const target = { host, driver: this.deps.createDriver(host.webContents) };
        entry.target = target;
        entry.opening = undefined;
        entry.recovery = undefined;
        host.onClosed(() => {
          if (entry.target?.host === host) {
            entry.target = undefined;
            entry.recovery = "closed";
            entry.interactiveOnlyRefs.clear();
          }
        });
        return target;
      })
      .catch((error) => {
        entry.opening = undefined;
        throw error;
      });
    entry.opening = opening;
    return opening;
  }

  private enqueue<T>(entry: RuntimeEntry, operation: () => Promise<T>): Promise<T> {
    entry.pendingOperations += 1;
    const guarded = () => {
      if (entry.disposed || this.entries.get(entry.ownerId) !== entry)
        throw new Error("background browser lease is no longer active");
      return operation();
    };
    const result = entry.tail.then(guarded, guarded).finally(() => {
      entry.pendingOperations -= 1;
    });
    entry.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private releaseEntry(entry: RuntimeEntry): void {
    entry.leases = Math.max(0, entry.leases - 1);
    entry.lastUsedAt = this.deps.now();
    this.scheduleIdleEviction(entry);
  }

  private scheduleIdleEviction(entry: RuntimeEntry): void {
    if (this.entries.get(entry.ownerId) !== entry || entry.leases > 0 || entry.idleTimer) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.leases > 0) return;
      if (entry.pendingOperations > 0) {
        this.scheduleIdleEviction(entry);
        return;
      }
      // A revealed target is under human control. Keep it alive (and keep its
      // DOM/session/ref state intact) until the user hides/closes it.
      if (entry.target?.host.isVisible()) {
        entry.lastUsedAt = this.deps.now();
        this.scheduleIdleEviction(entry);
        return;
      }
      this.disposeEntry(entry, "idle");
    }, this.idleTtlMs);
    if (typeof entry.idleTimer === "object" && "unref" in entry.idleTimer) {
      entry.idleTimer.unref();
    }
  }

  private makeTargetCapacity(requestingEntry: RuntimeEntry): void {
    const liveCount = [...this.entries.values()].filter(
      (entry) => entry.target !== undefined || entry.opening !== undefined,
    ).length;
    if (liveCount < this.maxTargets) return;
    const idle = [...this.entries.values()]
      .filter(
        (entry) =>
          entry !== requestingEntry &&
          entry.leases === 0 &&
          entry.pendingOperations === 0 &&
          entry.target?.host.isVisible() !== true &&
          (entry.target !== undefined || entry.opening !== undefined),
      )
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    if (idle[0]) this.disposeEntry(idle[0], "capacity");
    const afterEviction = [...this.entries.values()].filter(
      (entry) => entry.target !== undefined || entry.opening !== undefined,
    ).length;
    if (afterEviction >= this.maxTargets) {
      throw new Error(`background browser target limit reached (${this.maxTargets})`);
    }
  }

  private disposeEntry(entry: RuntimeEntry, reason?: "idle" | "capacity"): void {
    if (this.entries.get(entry.ownerId) !== entry) return;
    if (reason && (entry.target || entry.recovery)) {
      this.continuity.delete(entry.ownerId);
      this.continuity.set(entry.ownerId, {
        partition: entry.partition,
        tabId: entry.tabId,
        url: safeCall(() => entry.target?.host.webContents.getURL()) ?? entry.lastUrl,
        title: safeCall(() => entry.target?.host.webContents.getTitle()) ?? entry.lastTitle,
        reason,
        expiresAt: this.deps.now() + this.continuityTtlMs,
      });
      this.pruneContinuity();
    }
    this.entries.delete(entry.ownerId);
    entry.disposed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.target?.host.close();
    entry.target = undefined;
  }

  private pruneContinuity(): void {
    for (const [ownerId, value] of this.continuity) {
      if (value.expiresAt <= this.deps.now()) this.continuity.delete(ownerId);
    }
    while (this.continuity.size > this.maxRememberedTargets) {
      this.continuity.delete(this.continuity.keys().next().value!);
    }
  }
}

function recoveryDetail(entry: RuntimeEntry): string {
  return (
    `TARGET_CLOSED: this task's tab ${entry.tabId} was ${entry.recovery === "idle" ? "reclaimed after idle time" : entry.recovery === "capacity" ? "reclaimed to free browser capacity" : "closed"}. ` +
    `Its last URL was ${entry.lastUrl || "about:blank"}. Use browser_navigate with the intended URL to reopen this same task-owned tab, then take a new snapshot. The tabId remains valid; all old element refs and read cursors have expired. Do not retry the previous action or switch to another task's page.`
  );
}

export const backgroundBrowserRuntime = new BackgroundBrowserRuntime();

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isInternalPage(url: string): boolean {
  return url === "" || url === "about:blank";
}

function hasHighConsequenceName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length > 0 && SENSITIVE_WORDS.some((word) => normalized.includes(word.toLowerCase()))
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || new URL(url).protocol.replace(/:$/, "");
  } catch {
    return url || "(unknown)";
  }
}

function failResult(detail: string): BrowserResult {
  return {
    ok: false,
    detail,
    ...(detail.startsWith("TARGET_CLOSED:")
      ? { code: "TARGET_CLOSED" as const, retryable: false }
      : {}),
  };
}

function failImage(detail: string): BrowserImageData {
  return { ok: false, detail };
}

async function safely<T>(operation: () => Promise<T>, onError: (detail: string) => T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return onError(error instanceof Error ? error.message : String(error));
  }
}

function safeCall<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}
