import { randomBytes } from "node:crypto";
import type {
  BrowserBridge,
  BrowserContent,
  BrowserExtract,
  BrowserImageData,
  BrowserResult,
} from "@cjhyy/code-shell-core";
import { MAX_NATIVE_COMMAND_BYTES } from "../../chrome-extension/browser-sessions.js";
import {
  dispatchBrowserBridgeAction,
  type BrowserActionRequest,
} from "../browser-driver/automation-host.js";
import { loadBrowserAutomationPolicy } from "../browser-driver/load-policy.js";
import {
  isDomainAllowed,
  isSensitiveAction,
  SENSITIVE_WORDS,
  type BrowserAutomationPolicy,
} from "../browser-driver/policy.js";
import {
  ChromeNativeBridgeServer,
  type ChromeExtensionMessage,
  type ChromeNativeBridgeStatus,
} from "./chrome-native-server.js";

const PAIRING_TTL_MS = 2 * 60 * 1000;
const GRANT_TTL_MS = 30 * 60 * 1000;
const EXTENSION_UPDATE_REQUIRED =
  "Update the CodeShell Chrome extension to version 0.2.0 or later, then reload it in chrome://extensions";

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
  grantId: string;
  sessionId: string;
  tab: ChromeTabInfo;
  grantedAt: number;
  expiresAt: number;
  controlEpoch: number;
  sensitiveRefs: Set<string>;
  tail: Promise<void>;
}

export interface ChromeExtensionRuntimeStatus {
  sessionId: string;
  connected: boolean;
  error?: string;
  pairing?: { code: string; label: string; expiresAt: number };
  granted?: {
    grantId: string;
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
  policy?: () => BrowserAutomationPolicy;
}

export interface ChromeExtensionTransport {
  start(): Promise<ChromeNativeBridgeStatus>;
  stop(): Promise<void>;
  status(): ChromeNativeBridgeStatus;
  request(type: string, payload?: Record<string, unknown>): Promise<unknown>;
}

/** Logged-in Chrome: high-level actions over Native Messaging, Puppeteer inside the extension. */
export class ChromeExtensionBackend {
  private readonly server: ChromeExtensionTransport;
  private readonly now: () => number;
  private readonly onGranted?: (sessionId: string) => void;
  private readonly policy: () => BrowserAutomationPolicy;
  private readonly pairings = new Map<string, PairingRequest>();
  private readonly grants = new Map<string, ChromeTabGrant>();
  private readonly endedGrants = new Map<string, { tabId: number; reason: string }>();
  private extensionReady = false;
  private compatibilityError?: string;

  constructor(options: ChromeExtensionRuntimeServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onGranted = options.onGranted;
    this.policy = options.policy ?? loadBrowserAutomationPolicy;
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
      void this.server
        .request("tab.detach", { tabId: grant.tab.id, grantId: grant.grantId })
        .catch(() => undefined);
    }
    this.grants.clear();
    this.pairings.clear();
    this.endedGrants.clear();
    this.extensionReady = false;
    this.compatibilityError = undefined;
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
      connected: this.server.status().connected && this.extensionReady,
      ...(this.compatibilityError ? { error: this.compatibilityError } : {}),
      ...(pairing
        ? { pairing: { code: pairing.code, label: pairing.label, expiresAt: pairing.expiresAt } }
        : {}),
      ...(grant
        ? {
            granted: {
              grantId: grant.grantId,
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
      this.endedGrants.set(sessionId, {
        tabId: grant.tab.id,
        reason: "Chrome tab authorization was revoked",
      });
      void this.server
        .request("tab.detach", { tabId: grant.tab.id, grantId: grant.grantId })
        .catch(() => undefined);
    }
    return this.status(sessionId);
  }

  /** Explicit source changes and session deletion release the continuity marker. */
  forgetSession(sessionId: string): void {
    this.revoke(sessionId);
    this.endedGrants.delete(sessionId);
  }

  /** Only a task which never selected Chrome may fall through to another source. */
  async dispatch(sessionId: string, request: BrowserActionRequest): Promise<string | undefined> {
    const grant = this.liveGrant(sessionId);
    if (!grant) return this.endedGrants.has(sessionId) ? this.unavailable(sessionId) : undefined;
    if (request.action === "requestTakeover") ++grant.controlEpoch;
    const controlEpoch = grant.controlEpoch;
    const bridge = this.secureBridge(grant, controlEpoch);
    const operation = () =>
      this.isCurrentGrant(grant)
        ? grant.controlEpoch === controlEpoch
          ? dispatchBrowserBridgeAction(request, bridge)
          : Promise.resolve(
              JSON.stringify({
                ok: false,
                code: "NEEDS_HUMAN",
                detail:
                  "Chrome control changed while queued; issue a new request after the user finishes",
              }),
            )
        : Promise.resolve(this.unavailable(sessionId));
    // A handover must interrupt a pending action instead of sitting behind it.
    if (request.action === "requestTakeover") return operation();
    return this.enqueue(grant, operation);
  }

  async handleExtensionMessage(message: ChromeExtensionMessage): Promise<unknown> {
    this.sweepExpired();
    switch (message.type) {
      case "hello":
        // A new authenticated connection has no surviving browser grants.
        for (const grant of this.grants.values()) {
          this.endedGrants.set(grant.sessionId, {
            tabId: grant.tab.id,
            reason: "Chrome connection ended",
          });
        }
        this.grants.clear();
        this.extensionReady = message.protocolVersion === 2;
        this.compatibilityError = this.extensionReady ? undefined : EXTENSION_UPDATE_REQUIRED;
        if (!this.extensionReady) throw new Error(EXTENSION_UPDATE_REQUIRED);
        return { ready: true };
      case "pairing.list":
        if (!this.extensionReady) throw new Error(EXTENSION_UPDATE_REQUIRED);
        return {
          requests: [...this.pairings.values()].map((request) => ({
            code: request.code,
            label: request.label,
            expiresAt: request.expiresAt,
          })),
        };
      case "pairing.grant":
        if (!this.extensionReady) throw new Error(EXTENSION_UPDATE_REQUIRED);
        return this.acceptPairing(
          String(message.code || ""),
          String(message.grantId || ""),
          sanitizeChromeTab(message.tab),
        );
      case "tab.detached":
      case "tab.closed": {
        const tabId = Number(message.tabId);
        for (const [sessionId, grant] of this.grants) {
          if (grant.tab.id === tabId && grant.grantId === message.grantId) {
            this.endedGrants.set(sessionId, {
              tabId,
              reason: "Chrome tab was closed or debugger control was detached",
            });
            this.grants.delete(sessionId);
          }
        }
        return { revoked: true };
      }
      default:
        throw new Error(`unknown Chrome extension message: ${message.type}`);
    }
  }

  private acceptPairing(
    code: string,
    grantId: string,
    tab: ChromeTabInfo,
  ): ChromeExtensionRuntimeStatus {
    const pairing = this.pairings.get(code);
    if (!pairing || pairing.expiresAt <= this.now()) {
      this.pairings.delete(code);
      throw new Error("Chrome pairing request expired or was not found");
    }
    if (!/^https?:/i.test(tab.url)) throw new Error("only http(s) Chrome tabs can be granted");
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(grantId))
      throw new Error("invalid Chrome grant identity; update the extension");
    for (const [sessionId, existing] of this.grants) {
      if (existing.tab.id === tab.id && sessionId !== pairing.sessionId) {
        throw new Error("this Chrome tab is already granted to another CodeShell task");
      }
      if (existing.grantId === grantId) throw new Error("Chrome grant identity was already used");
    }
    this.pairings.delete(code);
    const grantedAt = this.now();
    const grant = {} as ChromeTabGrant;
    Object.assign(grant, {
      sessionId: pairing.sessionId,
      grantId,
      tab,
      grantedAt,
      expiresAt: grantedAt + GRANT_TTL_MS,
      controlEpoch: 0,
      sensitiveRefs: new Set<string>(),
      tail: Promise.resolve(),
    });
    this.grants.set(pairing.sessionId, grant);
    this.endedGrants.delete(pairing.sessionId);
    this.onGranted?.(pairing.sessionId);
    return this.status(pairing.sessionId);
  }

  private secureBridge(grant: ChromeTabGrant, controlEpoch: number): BrowserBridge {
    const driver = this.remoteDriver(grant, controlEpoch);
    const currentTab = async () => {
      const tab = sanitizeChromeTab(await this.requestForGrant(grant, controlEpoch, "tab.get"));
      if (tab.id !== grant.tab.id)
        throw new Error("Chrome returned a different tab than the grant");
      grant.tab = tab;
      return tab;
    };
    const allowed = (tab: ChromeTabInfo) => isDomainAllowed(tab.url, this.policy());
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
        if (!isDomainAllowed(tab.url, this.policy())) {
          return { url: tab.url, title: tab.title, elements: [], detail: blocked(tab.url).detail };
        }
        const snapshot = await driver.snapshot();
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
        return driver.click(ref);
      },
      type: async (ref, text) => {
        const tab = await currentTab();
        if (!allowed(tab)) return blocked(tab.url);
        if (grant.sensitiveRefs.has(ref) || isSensitiveAction({ action: "type", ref, text })) {
          return human("sensitive Chrome input requires the user");
        }
        return driver.type(ref, text);
      },
      navigate: async (url) => {
        if (!isDomainAllowed(url, this.policy())) return blocked(url);
        const result = await driver.navigate(url);
        if (result.ok) grant.sensitiveRefs.clear();
        return result;
      },
      scroll: async (dir, amount) => {
        const tab = await currentTab();
        return allowed(tab) ? driver.scroll(dir, amount) : blocked(tab.url);
      },
      readContent: async (options) => {
        const tab = await currentTab();
        if (allowed(tab)) return driver.readContent(options);
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
        if (allowed(tab)) return driver.extractLinks();
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
        return allowed(tab) ? driver.waitForLoad(timeoutMs) : blocked(tab.url);
      },
      hover: async (ref) => {
        const tab = await currentTab();
        return allowed(tab) ? driver.hover(ref) : blocked(tab.url);
      },
      selectOption: async (ref, value) => {
        const tab = await currentTab();
        if (!allowed(tab)) return blocked(tab.url);
        if (grant.sensitiveRefs.has(ref))
          return human("sensitive Chrome selection requires the user");
        return driver.selectOption(ref, value);
      },
      pressKey: async (key, ref) => {
        const tab = await currentTab();
        if (!allowed(tab)) return blocked(tab.url);
        if (ref && grant.sensitiveRefs.has(ref))
          return human("sensitive Chrome input requires the user");
        return driver.pressKey(key, ref);
      },
      fetchImages: async (refs) => {
        const tab = await currentTab();
        if (allowed(tab)) return driver.fetchImages(refs);
        return refs.map(
          (ref) => ({ ok: false, ref, detail: blocked(tab.url).detail }) satisfies BrowserImageData,
        );
      },
      screenshot: async (ref) => {
        const tab = await currentTab();
        return allowed(tab)
          ? driver.screenshot(ref)
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
      requestHumanTakeover: async () => driver.requestHumanTakeover!(),
      resumeControl: async () => driver.resumeControl!(),
      inspect: async (options) => {
        const tab = await currentTab();
        if (!allowed(tab))
          return { ok: false, mode: options.mode, detail: blocked(tab.url).detail };
        return driver.inspect!(options);
      },
    };
  }

  private remoteDriver(grant: ChromeTabGrant, controlEpoch: number): BrowserBridge {
    const forward = <T>(request: BrowserActionRequest) =>
      this.requestForGrant(grant, controlEpoch, "browser.action", { request }) as Promise<T>;
    return {
      snapshot: () => forward({ action: "snapshot" }),
      click: (ref) => forward({ action: "click", ref }),
      type: (ref, text) => forward({ action: "type", ref, text }),
      navigate: (url) => forward({ action: "navigate", url }),
      scroll: (dir, amount) => forward({ action: "scroll", dir, amount }),
      readContent: (options) => forward({ action: "readContent", ...options }),
      extractLinks: () => forward({ action: "extractLinks" }),
      waitForLoad: (timeoutMs) => forward({ action: "waitForLoad", timeoutMs }),
      hover: (ref) => forward({ action: "hover", ref }),
      selectOption: (ref, value) => forward({ action: "selectOption", ref, value }),
      pressKey: (key, ref) => forward({ action: "pressKey", key, ref }),
      fetchImages: (refs) => forward({ action: "fetchImages", refs }),
      screenshot: (ref) => forward({ action: "screenshot", ref }),
      requestHumanTakeover: () => forward({ action: "requestTakeover" }),
      resumeControl: () => forward({ action: "resumeControl" }),
      inspect: (inspect) => forward({ action: "inspect", inspect }),
      listTabs: async () => [
        { tabId: String(grant.tab.id), url: grant.tab.url, title: grant.tab.title, active: true },
      ],
      switchTab: async (tabId) =>
        tabId === String(grant.tab.id)
          ? { ok: true, code: "OK" }
          : { ok: false, code: "BLOCKED", detail: "tab was not granted to this task" },
    };
  }

  private isCurrentGrant(grant: ChromeTabGrant): boolean {
    if (this.grants.get(grant.sessionId) !== grant) return false;
    if (grant.expiresAt <= this.now() || !this.server.status().connected) {
      this.grants.delete(grant.sessionId);
      this.endedGrants.set(grant.sessionId, {
        tabId: grant.tab.id,
        reason:
          grant.expiresAt <= this.now()
            ? "Chrome tab authorization expired"
            : "Chrome connection ended",
      });
      if (this.server.status().connected) {
        void this.server
          .request("tab.detach", { tabId: grant.tab.id, grantId: grant.grantId })
          .catch(() => undefined);
      }
      return false;
    }
    return true;
  }

  private unavailable(sessionId: string): string {
    const ended = this.endedGrants.get(sessionId);
    return JSON.stringify({
      ok: false,
      code: "NEEDS_HUMAN",
      retryable: false,
      detail: `${ended?.reason ?? "Chrome control ended"}. Reauthorize the original tab or explicitly choose another browser source.`,
      ...(ended ? { tabId: String(ended.tabId) } : {}),
    });
  }

  private async requestForGrant(
    grant: ChromeTabGrant,
    controlEpoch: number,
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!this.isCurrentGrant(grant)) throw new Error("Chrome browser grant expired or was revoked");
    const checkControl = () => {
      if (grant.controlEpoch !== controlEpoch) {
        throw new Error("Chrome control changed; issue a new request after the user finishes");
      }
    };
    checkControl();
    const message = { tabId: grant.tab.id, grantId: grant.grantId, ...payload };
    if (
      Buffer.byteLength(JSON.stringify({ id: "desktop-request", type, ...message }), "utf8") >
      MAX_NATIVE_COMMAND_BYTES - 128
    ) {
      throw new Error("Chrome command exceeds native message size limit");
    }
    const result = await this.server.request(type, message);
    if (!this.isCurrentGrant(grant))
      throw new Error("Chrome browser grant ended while the action was running");
    checkControl();
    return result;
  }

  private liveGrant(sessionId: string): ChromeTabGrant | undefined {
    const grant = this.grants.get(sessionId);
    if (!grant) return undefined;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(sessionId);
      this.endedGrants.set(sessionId, {
        tabId: grant.tab.id,
        reason: "Chrome tab authorization expired",
      });
      void this.server
        .request("tab.detach", { tabId: grant.tab.id, grantId: grant.grantId })
        .catch(() => undefined);
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
