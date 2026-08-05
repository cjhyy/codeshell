import { randomBytes } from "node:crypto";
import type {
  BrowserBridge,
  BrowserContent,
  BrowserExtract,
  BrowserImageData,
  BrowserResult,
} from "@cjhyy/code-shell-core";
import { CdpBrowserDriver } from "../browser-driver/cdp-driver.js";
import {
  dispatchBrowserBridgeAction,
  type BrowserActionRequest,
} from "../browser-driver/automation-host.js";
import { loadBrowserAutomationPolicy } from "../browser-driver/load-policy.js";
import { isDomainAllowed, isSensitiveAction, SENSITIVE_WORDS } from "../browser-driver/policy.js";
import {
  ChromeNativeBridgeServer,
  type ChromeExtensionMessage,
  type ChromeNativeBridgeStatus,
} from "./chrome-native-server.js";

const PAIRING_TTL_MS = 2 * 60 * 1000;
const GRANT_TTL_MS = 30 * 60 * 1000;

interface ChromeTabInfo {
  id: number;
  windowId?: number;
  url: string;
  title: string;
  active?: boolean;
}

interface PairingRequest {
  code: string;
  sessionId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
}

interface ChromeTabGrant {
  sessionId: string;
  tab: ChromeTabInfo;
  grantedAt: number;
  expiresAt: number;
  driver: CdpBrowserDriver;
  bridge?: BrowserBridge;
  sensitiveRefs: Set<string>;
  tail: Promise<void>;
}

export interface ChromeExtensionRuntimeStatus {
  sessionId: string;
  connected: boolean;
  pairing?: { code: string; label: string; expiresAt: number };
  granted?: {
    tabId: number;
    url: string;
    title: string;
    grantedAt: number;
    expiresAt: number;
  };
}

export interface ChromeExtensionRuntimeServiceOptions {
  server?: ChromeExtensionTransport;
  now?: () => number;
  onGranted?: (sessionId: string) => void;
}

export interface ChromeExtensionTransport {
  start(): Promise<ChromeNativeBridgeStatus>;
  stop(): Promise<void>;
  status(): ChromeNativeBridgeStatus;
  request(type: string, payload?: Record<string, unknown>): Promise<unknown>;
}

/** Logged-in Chrome channel: Extension chrome.debugger → Native Messaging → Runtime. */
export class ChromeExtensionBackend {
  private readonly server: ChromeExtensionTransport;
  private readonly now: () => number;
  private readonly onGranted?: (sessionId: string) => void;
  private readonly pairings = new Map<string, PairingRequest>();
  private readonly grants = new Map<string, ChromeTabGrant>();

  constructor(options: ChromeExtensionRuntimeServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onGranted = options.onGranted;
    this.server =
      options.server ??
      new ChromeNativeBridgeServer({
        onMessage: (message) => this.handleExtensionMessage(message),
      });
  }

  start(): Promise<ChromeNativeBridgeStatus> {
    return this.server.start();
  }

  async stop(): Promise<void> {
    for (const grant of this.grants.values()) {
      void this.server.request("tab.detach", { tabId: grant.tab.id }).catch(() => undefined);
    }
    this.grants.clear();
    this.pairings.clear();
    await this.server.stop();
  }

  beginPairing(sessionId: string, label?: string): ChromeExtensionRuntimeStatus {
    const normalized = sessionId.trim();
    if (!normalized) throw new Error("Chrome pairing requires sessionId");
    this.sweepExpired();
    const existingGrant = this.liveGrant(normalized);
    if (existingGrant) return this.status(normalized);
    for (const [code, request] of this.pairings) {
      if (request.sessionId === normalized) this.pairings.delete(code);
    }
    const now = this.now();
    const code = this.uniquePairingCode();
    this.pairings.set(code, {
      code,
      sessionId: normalized,
      label: label?.trim() || `CodeShell task ${normalized.slice(0, 8)}`,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
    });
    return this.status(normalized);
  }

  status(sessionId: string): ChromeExtensionRuntimeStatus {
    this.sweepExpired();
    const grant = this.liveGrant(sessionId);
    const pairing = [...this.pairings.values()].find((request) => request.sessionId === sessionId);
    return {
      sessionId,
      connected: this.server.status().connected,
      ...(pairing
        ? { pairing: { code: pairing.code, label: pairing.label, expiresAt: pairing.expiresAt } }
        : {}),
      ...(grant
        ? {
            granted: {
              tabId: grant.tab.id,
              url: grant.tab.url,
              title: grant.tab.title,
              grantedAt: grant.grantedAt,
              expiresAt: grant.expiresAt,
            },
          }
        : {}),
    };
  }

  revoke(sessionId: string): ChromeExtensionRuntimeStatus {
    for (const [code, request] of this.pairings) {
      if (request.sessionId === sessionId) this.pairings.delete(code);
    }
    const grant = this.grants.get(sessionId);
    if (grant) {
      this.grants.delete(sessionId);
      void this.server.request("tab.detach", { tabId: grant.tab.id }).catch(() => undefined);
    }
    return this.status(sessionId);
  }

  /** Undefined means no Chrome grant; caller should use another Runtime target. */
  async dispatch(sessionId: string, request: BrowserActionRequest): Promise<string | undefined> {
    const grant = this.liveGrant(sessionId);
    if (!grant) return undefined;
    const bridge = grant.bridge ?? (grant.bridge = this.secureBridge(grant));
    return this.enqueue(grant, () => dispatchBrowserBridgeAction(request, bridge));
  }

  async handleExtensionMessage(message: ChromeExtensionMessage): Promise<unknown> {
    this.sweepExpired();
    switch (message.type) {
      case "hello":
        return { ready: true };
      case "pairing.list":
        return {
          requests: [...this.pairings.values()].map((request) => ({
            code: request.code,
            label: request.label,
            expiresAt: request.expiresAt,
          })),
        };
      case "pairing.grant":
        return this.acceptPairing(String(message.code || ""), sanitizeChromeTab(message.tab));
      case "tab.detached":
      case "tab.closed": {
        const tabId = Number(message.tabId);
        for (const [sessionId, grant] of this.grants) {
          if (grant.tab.id === tabId) this.grants.delete(sessionId);
        }
        return { revoked: true };
      }
      default:
        throw new Error(`unknown Chrome extension message: ${message.type}`);
    }
  }

  private acceptPairing(code: string, tab: ChromeTabInfo): ChromeExtensionRuntimeStatus {
    const pairing = this.pairings.get(code);
    if (!pairing || pairing.expiresAt <= this.now()) {
      this.pairings.delete(code);
      throw new Error("Chrome pairing request expired or was not found");
    }
    if (!/^https?:/i.test(tab.url)) throw new Error("only http(s) Chrome tabs can be granted");
    for (const [sessionId, existing] of this.grants) {
      if (existing.tab.id === tab.id && sessionId !== pairing.sessionId) {
        throw new Error("this Chrome tab is already granted to another CodeShell task");
      }
    }
    this.pairings.delete(code);
    const grantedAt = this.now();
    const grant = {} as ChromeTabGrant;
    Object.assign(grant, {
      sessionId: pairing.sessionId,
      tab,
      grantedAt,
      expiresAt: grantedAt + GRANT_TTL_MS,
      sensitiveRefs: new Set<string>(),
      tail: Promise.resolve(),
    });
    grant.driver = new CdpBrowserDriver(
      async (method, params) =>
        this.server.request("cdp.command", { tabId: tab.id, method, params }) as Promise<unknown>,
      async () => {
        const current = sanitizeChromeTab(await this.server.request("tab.get", { tabId: tab.id }));
        grant.tab = current;
        return { url: current.url, title: current.title };
      },
    );
    this.grants.set(pairing.sessionId, grant);
    this.onGranted?.(pairing.sessionId);
    return this.status(pairing.sessionId);
  }

  private secureBridge(grant: ChromeTabGrant): BrowserBridge {
    const currentTab = async () => {
      const tab = sanitizeChromeTab(await this.server.request("tab.get", { tabId: grant.tab.id }));
      grant.tab = tab;
      return tab;
    };
    const allowed = (tab: ChromeTabInfo) => isDomainAllowed(tab.url, loadBrowserAutomationPolicy());
    const blocked = (url: string): BrowserResult => ({
      ok: false,
      code: "BLOCKED",
      retryable: false,
      detail: `Chrome tab domain not allowed by whitelist: ${hostOf(url)}`,
    });
    const human = (detail: string): BrowserResult => ({
      ok: false,
      code: "NEEDS_HUMAN",
      retryable: false,
      detail,
    });

    return {
      snapshot: async () => {
        const tab = await currentTab();
        if (!isDomainAllowed(tab.url, loadBrowserAutomationPolicy())) {
          return { url: tab.url, title: tab.title, elements: [], detail: blocked(tab.url).detail };
        }
        const snapshot = await grant.driver.snapshot();
        grant.sensitiveRefs = new Set(
          snapshot.elements
            .filter((element) => element.sensitive === true || hasHighConsequenceName(element.name))
            .map((element) => element.ref),
        );
        return snapshot;
      },
      click: async (ref) => {
        const tab = await currentTab();
        if (!allowed(tab)) return blocked(tab.url);
        if (grant.sensitiveRefs.has(ref)) return human("sensitive Chrome action requires the user");
        return grant.driver.click(ref);
      },
      type: async (ref, text) => {
        const tab = await currentTab();
        if (!allowed(tab)) return blocked(tab.url);
        if (grant.sensitiveRefs.has(ref) || isSensitiveAction({ action: "type", ref, text })) {
          return human("sensitive Chrome input requires the user");
        }
        return grant.driver.type(ref, text);
      },
      navigate: async (url) => {
        if (!isDomainAllowed(url, loadBrowserAutomationPolicy())) return blocked(url);
        const result = await grant.driver.navigate(url);
        if (result.ok) grant.sensitiveRefs.clear();
        return result;
      },
      scroll: async (dir, amount) => {
        const tab = await currentTab();
        return allowed(tab) ? grant.driver.scroll(dir, amount) : blocked(tab.url);
      },
      readContent: async (options) => {
        const tab = await currentTab();
        if (allowed(tab)) return grant.driver.readContent(options);
        return {
          ok: false,
          code: "BLOCKED",
          url: tab.url,
          title: tab.title,
          text: "",
          detail: blocked(tab.url).detail,
        } satisfies BrowserContent;
      },
      extractLinks: async () => {
        const tab = await currentTab();
        if (allowed(tab)) return grant.driver.extractLinks();
        return {
          ok: false,
          url: tab.url,
          title: tab.title,
          links: [],
          images: [],
          videos: [],
          detail: blocked(tab.url).detail,
        } satisfies BrowserExtract;
      },
      waitForLoad: async (timeoutMs) => {
        const tab = await currentTab();
        return allowed(tab) ? grant.driver.waitForLoad(timeoutMs) : blocked(tab.url);
      },
      hover: async (ref) => {
        const tab = await currentTab();
        return allowed(tab) ? grant.driver.hover(ref) : blocked(tab.url);
      },
      selectOption: async (ref, value) => {
        const tab = await currentTab();
        if (!allowed(tab)) return blocked(tab.url);
        if (grant.sensitiveRefs.has(ref))
          return human("sensitive Chrome selection requires the user");
        return grant.driver.selectOption(ref, value);
      },
      pressKey: async (key, ref) => {
        const tab = await currentTab();
        if (!allowed(tab)) return blocked(tab.url);
        if (ref && grant.sensitiveRefs.has(ref))
          return human("sensitive Chrome input requires the user");
        return grant.driver.pressKey(key, ref);
      },
      fetchImages: async (refs) => {
        const tab = await currentTab();
        if (allowed(tab)) return grant.driver.fetchImages(refs);
        return refs.map(
          (ref) => ({ ok: false, ref, detail: blocked(tab.url).detail }) satisfies BrowserImageData,
        );
      },
      screenshot: async (ref) => {
        const tab = await currentTab();
        return allowed(tab)
          ? grant.driver.screenshot(ref)
          : { ok: false, detail: blocked(tab.url).detail };
      },
      listTabs: async () => {
        const tab = await currentTab();
        return [
          {
            tabId: String(tab.id),
            url: tab.url,
            title: tab.title,
            active: true,
          },
        ];
      },
      switchTab: async (tabId) =>
        tabId === String(grant.tab.id)
          ? { ok: true, code: "OK" }
          : { ok: false, code: "BLOCKED", detail: "tab was not granted to this task" },
    };
  }

  private liveGrant(sessionId: string): ChromeTabGrant | undefined {
    const grant = this.grants.get(sessionId);
    if (!grant) return undefined;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(sessionId);
      void this.server.request("tab.detach", { tabId: grant.tab.id }).catch(() => undefined);
      return undefined;
    }
    return grant;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [code, pairing] of this.pairings) {
      if (pairing.expiresAt <= now) this.pairings.delete(code);
    }
    for (const sessionId of this.grants.keys()) this.liveGrant(sessionId);
  }

  private uniquePairingCode(): string {
    for (;;) {
      const code = randomBytes(3).toString("hex").toUpperCase();
      if (!this.pairings.has(code)) return code;
    }
  }

  private enqueue<T>(grant: ChromeTabGrant, operation: () => Promise<T>): Promise<T> {
    const result = grant.tail.then(operation, operation);
    grant.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** @deprecated Use ChromeExtensionBackend. */
export { ChromeExtensionBackend as ChromeExtensionRuntimeService };

function sanitizeChromeTab(value: unknown): ChromeTabInfo {
  const tab = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const id = Number(tab.id);
  if (!Number.isFinite(id)) throw new Error("Chrome extension returned an invalid tab id");
  return {
    id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : undefined,
    url: typeof tab.url === "string" ? tab.url : "",
    title: typeof tab.title === "string" ? tab.title : "",
    active: tab.active === true,
  };
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
