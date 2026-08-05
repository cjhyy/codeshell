import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type {
  BrowserBridge,
  BrowserContent,
  BrowserExtract,
  BrowserImageData,
  BrowserResult,
  BrowserSnapshot,
} from "@cjhyy/code-shell-core";
import { chromium, type BrowserContext } from "playwright-core";
import { loadBrowserAutomationPolicy } from "../browser-driver/load-policy.js";
import {
  isDomainAllowed,
  isSensitiveAction,
  SENSITIVE_WORDS,
  type BrowserAutomationPolicy,
} from "../browser-driver/policy.js";
import type {
  BrowserRuntimeBackend,
  BrowserRuntimeBackendAcquireOptions,
  BrowserRuntimeBackendLease,
} from "./backend.js";
import { PlaywrightBrowserDriver } from "./playwright-driver.js";
import { browserRuntimeProfilePath, defaultBrowserRuntimeProfilesRoot } from "./profile.js";

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONTEXTS = 3;

interface ChromiumLauncher {
  executablePath(): string;
  launchPersistentContext(
    userDataDir: string,
    options: Parameters<typeof chromium.launchPersistentContext>[1],
  ): Promise<BrowserContext>;
}

export interface PlaywrightLaunchCandidate {
  label: string;
  executablePath?: string;
  channel?: "chrome" | "msedge";
}

interface PlaywrightEntry {
  ownerId: string;
  profileId: string;
  profilePath: string;
  leases: number;
  lastUsedAt: number;
  initialUrl: string;
  context?: BrowserContext;
  driver?: PlaywrightBrowserDriver;
  bridge?: BrowserBridge;
  opening?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  disposed?: boolean;
  sensitiveRefs: Set<string>;
  tail: Promise<void>;
}

interface PlaywrightBackendDeps {
  launcher: ChromiumLauncher;
  policy: () => BrowserAutomationPolicy;
  now: () => number;
  launchCandidates: () => PlaywrightLaunchCandidate[];
}

export interface DedicatedPlaywrightBackendOptions {
  profilesRoot?: string;
  idleTtlMs?: number;
  maxContexts?: number;
  /** Test seams. */
  deps?: Partial<PlaywrightBackendDeps>;
}

/** Explicit isolated Chromium backend powered by Playwright Locator semantics. */
export class DedicatedPlaywrightBackend implements BrowserRuntimeBackend {
  readonly kind = "dedicated-playwright" as const;
  private readonly entries = new Map<string, PlaywrightEntry>();
  private readonly profileOwners = new Map<string, string>();
  private readonly profilesRoot: string;
  private readonly idleTtlMs: number;
  private readonly maxContexts: number;
  private readonly deps: PlaywrightBackendDeps;

  constructor(options: DedicatedPlaywrightBackendOptions = {}) {
    this.profilesRoot = options.profilesRoot ?? defaultBrowserRuntimeProfilesRoot();
    this.idleTtlMs = positiveFiniteOr(options.idleTtlMs, DEFAULT_IDLE_TTL_MS);
    this.maxContexts = Math.max(
      1,
      Math.floor(positiveFiniteOr(options.maxContexts, DEFAULT_MAX_CONTEXTS)),
    );
    this.deps = {
      launcher: chromium,
      policy: loadBrowserAutomationPolicy,
      now: Date.now,
      launchCandidates: defaultLaunchCandidates,
      ...options.deps,
    };
  }

  isAvailable(): boolean {
    try {
      return this.deps.launchCandidates().length > 0;
    } catch {
      return false;
    }
  }

  async acquire(options: BrowserRuntimeBackendAcquireOptions): Promise<BrowserRuntimeBackendLease> {
    const ownerId = options.ownerId.trim();
    const profileId = options.profileId.trim();
    if (!ownerId) throw new Error("Playwright Browser Runtime ownerId is required");
    if (!profileId) throw new Error("Playwright Browser Runtime profileId is required");

    let entry = this.entries.get(ownerId);
    if (entry && entry.profileId !== profileId) {
      throw new Error(
        `Browser Runtime owner ${ownerId} is already bound to profile ${entry.profileId}`,
      );
    }
    const currentProfileOwner = this.profileOwners.get(profileId);
    if (currentProfileOwner && currentProfileOwner !== ownerId) {
      throw new Error(
        `Browser Runtime profile ${profileId} is already active for ${currentProfileOwner}`,
      );
    }
    if (!entry) {
      entry = {
        ownerId,
        profileId,
        profilePath: browserRuntimeProfilePath(this.profilesRoot, profileId),
        leases: 0,
        lastUsedAt: this.deps.now(),
        initialUrl: options.initialUrl?.trim() || "about:blank",
        sensitiveRefs: new Set(),
        tail: Promise.resolve(),
      };
      this.entries.set(ownerId, entry);
      this.profileOwners.set(profileId, ownerId);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }

    try {
      await this.enqueue(entry, () => this.ensureContext(entry!));
    } catch (error) {
      this.disposeEntry(entry);
      throw error;
    }
    entry.leases += 1;
    entry.lastUsedAt = this.deps.now();
    let released = false;
    return {
      kind: this.kind,
      bridge: entry.bridge!,
      canReveal: false,
      show: async () => {
        throw new Error(
          "headless Playwright Runtime cannot be revealed in place; use explicit Browser/Chrome handoff",
        );
      },
      hide: () => undefined,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(entry!);
      },
    };
  }

  close(ownerId: string): void {
    const entry = this.entries.get(ownerId);
    if (entry) this.disposeEntry(entry);
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) this.disposeEntry(entry);
  }

  stats(): { entries: number; liveContexts: number; leased: number } {
    const values = [...this.entries.values()];
    return {
      entries: values.length,
      liveContexts: values.filter((entry) => entry.context !== undefined).length,
      leased: values.reduce((sum, entry) => sum + entry.leases, 0),
    };
  }

  private async ensureContext(entry: PlaywrightEntry): Promise<void> {
    if (entry.context && entry.driver && entry.bridge) return;
    if (entry.opening) return entry.opening;
    if (entry.disposed || this.entries.get(entry.ownerId) !== entry) {
      throw new Error("Playwright Browser Runtime lease is no longer active");
    }
    this.makeContextCapacity(entry);
    const candidates = this.deps.launchCandidates();
    if (candidates.length === 0) {
      throw new Error(
        "no Playwright Chromium is installed and no supported system Chrome/Edge was found",
      );
    }
    mkdirSync(entry.profilePath, { recursive: true });
    const opening = this.launchFirstAvailable(entry, candidates)
      .then(async (context) => {
        if (entry.disposed || this.entries.get(entry.ownerId) !== entry) {
          await context.close().catch(() => undefined);
          throw new Error("Playwright Browser Runtime lease was released while opening");
        }
        const page = context.pages()[0] ?? (await context.newPage());
        const driver = new PlaywrightBrowserDriver(context, page);
        entry.context = context;
        entry.driver = driver;
        entry.bridge = this.secureBridge(entry, driver);
        entry.opening = undefined;
        context.on("close", () => {
          if (entry.context !== context) return;
          entry.context = undefined;
          entry.driver = undefined;
          entry.bridge = undefined;
          entry.sensitiveRefs.clear();
        });
        if (entry.initialUrl !== "about:blank") {
          if (
            !isInternalPage(entry.initialUrl) &&
            !isDomainAllowed(entry.initialUrl, this.deps.policy())
          ) {
            throw new Error(
              `Browser Runtime domain not allowed by whitelist: ${hostOf(entry.initialUrl)}`,
            );
          }
          // Do not call the serialized bridge from inside the acquire queue.
          // Doing so would enqueue behind this very launch operation.
          const result = await driver.navigate(entry.initialUrl);
          if (!result.ok) throw new Error(result.detail || "initial navigation failed");
        }
      })
      .catch((error) => {
        entry.opening = undefined;
        throw error;
      });
    entry.opening = opening;
    return opening;
  }

  private async launchFirstAvailable(
    entry: PlaywrightEntry,
    candidates: PlaywrightLaunchCandidate[],
  ): Promise<BrowserContext> {
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        return await this.deps.launcher.launchPersistentContext(entry.profilePath, {
          headless: true,
          acceptDownloads: true,
          viewport: { width: 1280, height: 800 },
          ...(candidate.executablePath ? { executablePath: candidate.executablePath } : {}),
          ...(candidate.channel ? { channel: candidate.channel } : {}),
        });
      } catch (error) {
        failures.push(`${candidate.label}: ${errMsg(error)}`);
      }
    }
    throw new Error(`Playwright could not launch a browser (${failures.join("; ")})`);
  }

  private secureBridge(entry: PlaywrightEntry, driver: PlaywrightBrowserDriver): BrowserBridge {
    const currentAllowed = () => {
      const url = driver.currentPageInfo().url;
      return isInternalPage(url) || isDomainAllowed(url, this.deps.policy());
    };
    const denied = (): BrowserResult => ({
      ok: false,
      code: "BLOCKED",
      retryable: false,
      detail: `Browser Runtime domain not allowed by whitelist: ${hostOf(
        driver.currentPageInfo().url,
      )}`,
    });
    const human = (detail: string): BrowserResult => ({
      ok: false,
      code: "NEEDS_HUMAN",
      retryable: false,
      detail,
    });

    return {
      snapshot: async () => {
        if (!currentAllowed()) {
          const page = driver.currentPageInfo();
          return {
            url: page.url,
            documentId: page.documentId,
            elements: [],
            detail: denied().detail,
          } satisfies BrowserSnapshot;
        }
        const snapshot = await driver.snapshot();
        entry.sensitiveRefs = new Set(
          snapshot.elements
            .filter((element) => element.sensitive === true || hasHighConsequenceName(element.name))
            .map((element) => element.ref),
        );
        return snapshot;
      },
      click: (ref) =>
        this.run(entry, async () => {
          if (!currentAllowed()) return denied();
          if (entry.sensitiveRefs.has(ref)) {
            return human("high-consequence action requires explicit browser handoff");
          }
          return driver.click(ref);
        }),
      type: (ref, text) =>
        this.run(entry, async () => {
          if (!currentAllowed()) return denied();
          if (entry.sensitiveRefs.has(ref) || isSensitiveAction({ action: "type", ref, text })) {
            return human("sensitive input requires explicit browser handoff");
          }
          return driver.type(ref, text);
        }),
      navigate: (url) =>
        this.run(entry, async () => {
          if (!isInternalPage(url) && !isDomainAllowed(url, this.deps.policy())) {
            return {
              ok: false,
              code: "BLOCKED",
              retryable: false,
              detail: `Browser Runtime domain not allowed by whitelist: ${hostOf(url)}`,
            };
          }
          const result = await driver.navigate(url);
          if (result.ok) entry.sensitiveRefs.clear();
          return result;
        }),
      scroll: (dir, amount) =>
        this.run(entry, () =>
          currentAllowed() ? driver.scroll(dir, amount) : Promise.resolve(denied()),
        ),
      readContent: (options) =>
        this.run(entry, async () => {
          if (currentAllowed()) return driver.readContent(options);
          const page = driver.currentPageInfo();
          return {
            ok: false,
            code: "BLOCKED",
            url: page.url,
            documentId: page.documentId,
            text: "",
            detail: denied().detail,
          } satisfies BrowserContent;
        }),
      extractLinks: () =>
        this.run(entry, async () => {
          if (currentAllowed()) return driver.extractLinks();
          const page = driver.currentPageInfo();
          return {
            ok: false,
            url: page.url,
            links: [],
            images: [],
            videos: [],
            detail: denied().detail,
          } satisfies BrowserExtract;
        }),
      waitForLoad: (timeoutMs) =>
        this.run(entry, () =>
          currentAllowed() ? driver.waitForLoad(timeoutMs) : Promise.resolve(denied()),
        ),
      hover: (ref) =>
        this.run(entry, () => (currentAllowed() ? driver.hover(ref) : Promise.resolve(denied()))),
      selectOption: (ref, value) =>
        this.run(entry, async () => {
          if (!currentAllowed()) return denied();
          if (entry.sensitiveRefs.has(ref)) return human("sensitive selection requires handoff");
          return driver.selectOption(ref, value);
        }),
      pressKey: (key, ref) =>
        this.run(entry, async () => {
          if (!currentAllowed()) return denied();
          if (ref && entry.sensitiveRefs.has(ref)) return human("sensitive input requires handoff");
          return driver.pressKey(key, ref);
        }),
      fetchImages: (refs) =>
        this.run(entry, () =>
          currentAllowed()
            ? driver.fetchImages(refs)
            : Promise.resolve(
                refs.map(
                  (ref) => ({ ok: false, ref, detail: denied().detail }) satisfies BrowserImageData,
                ),
              ),
        ),
      screenshot: (ref) =>
        this.run(entry, () =>
          currentAllowed()
            ? driver.screenshot(ref)
            : Promise.resolve({ ok: false, detail: denied().detail }),
        ),
      listTabs: () => this.run(entry, () => driver.listTabs()),
      switchTab: (tabId) => this.run(entry, () => driver.switchTab(tabId)),
    };
  }

  private run<T>(entry: PlaywrightEntry, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(entry, async () => {
      await this.ensureContext(entry);
      entry.lastUsedAt = this.deps.now();
      return operation();
    });
  }

  private enqueue<T>(entry: PlaywrightEntry, operation: () => Promise<T>): Promise<T> {
    const result = entry.tail.then(operation, operation);
    entry.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private releaseEntry(entry: PlaywrightEntry): void {
    entry.leases = Math.max(0, entry.leases - 1);
    entry.lastUsedAt = this.deps.now();
    this.scheduleIdleEviction(entry);
  }

  private scheduleIdleEviction(entry: PlaywrightEntry): void {
    if (this.entries.get(entry.ownerId) !== entry || entry.leases > 0 || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.leases === 0) this.disposeEntry(entry);
    }, this.idleTtlMs);
    if (typeof entry.idleTimer === "object" && "unref" in entry.idleTimer) {
      entry.idleTimer.unref();
    }
  }

  private makeContextCapacity(requesting: PlaywrightEntry): void {
    const live = [...this.entries.values()].filter(
      (entry) => entry.context !== undefined || entry.opening !== undefined,
    );
    if (live.length < this.maxContexts) return;
    const idle = live
      .filter((entry) => entry !== requesting && entry.leases === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    if (idle[0]) this.disposeEntry(idle[0]);
    const after = [...this.entries.values()].filter(
      (entry) => entry.context !== undefined || entry.opening !== undefined,
    ).length;
    if (after >= this.maxContexts) {
      throw new Error(`Playwright Browser Runtime context limit reached (${this.maxContexts})`);
    }
  }

  private disposeEntry(entry: PlaywrightEntry): void {
    if (this.entries.get(entry.ownerId) !== entry) return;
    this.entries.delete(entry.ownerId);
    this.profileOwners.delete(entry.profileId);
    entry.disposed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    const context = entry.context;
    entry.context = undefined;
    entry.driver = undefined;
    entry.bridge = undefined;
    entry.sensitiveRefs.clear();
    if (context) void context.close().catch(() => undefined);
  }
}

export const dedicatedPlaywrightBackend = new DedicatedPlaywrightBackend();

/** @deprecated Use DedicatedPlaywrightBackendOptions. */
export type PlaywrightRuntimeBackendOptions = DedicatedPlaywrightBackendOptions;
/** @deprecated Use DedicatedPlaywrightBackend. */
export { DedicatedPlaywrightBackend as PlaywrightRuntimeBackend };
/** @deprecated Use dedicatedPlaywrightBackend. */
export const playwrightRuntimeBackend = dedicatedPlaywrightBackend;

export function defaultLaunchCandidates(): PlaywrightLaunchCandidate[] {
  const candidates: PlaywrightLaunchCandidate[] = [];
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) {
      candidates.push({ label: "Playwright Chromium", executablePath: bundled });
    }
  } catch {
    // The runtime dependency can be present while its version-pinned browser is not installed.
  }

  const paths = systemBrowserPaths();
  if (paths.chrome.some(existsSync))
    candidates.push({ label: "system Google Chrome", channel: "chrome" });
  if (paths.edge.some(existsSync))
    candidates.push({ label: "system Microsoft Edge", channel: "msedge" });
  return candidates;
}

function systemBrowserPaths(): { chrome: string[]; edge: string[] } {
  if (process.platform === "darwin") {
    return {
      chrome: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(
          process.env.USERPROFILE || "",
          "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ),
      ],
      edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    };
  }
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter((value): value is string => Boolean(value));
    return {
      chrome: roots.map((root) => path.join(root, "Google", "Chrome", "Application", "chrome.exe")),
      edge: roots.map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
    };
  }
  return {
    chrome: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
    edge: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
  };
}

function isInternalPage(url: string): boolean {
  return url === "" || url === "about:blank" || url.startsWith("data:");
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

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
