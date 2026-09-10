import type { BrowserBridge } from "@cjhyy/code-shell-core";
import type { BrowserActionRequest } from "../main/browser-driver/automation-host.js";

export const MAX_NATIVE_COMMAND_BYTES = 1024 * 1024;
export const MAX_NATIVE_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface ExtensionConnection {
  driver: BrowserBridge & { dispose(): void };
  disconnect(): Promise<void>;
}

interface Grant {
  tabId: number;
  grantId: string;
  expiresAt: number;
  generation: number;
  controlEpoch: number;
  paused: boolean;
  connection?: ExtensionConnection;
  connecting?: Promise<void>;
  tail: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

/** Owns authorization and action ordering; Puppeteer owns protocol/session routing. */
export class ExtensionBrowserSessions {
  private readonly grants = new Map<number, Grant>();
  // Keep the actual cleanup promise even if the caller stops waiting. A late
  // attach/detach must finish before this tab can receive another controller.
  private readonly closing = new Map<number, Promise<void>>();

  constructor(
    private readonly connect: (
      tabId: number,
      namespace: string,
      isActive: () => boolean,
    ) => Promise<ExtensionConnection>,
    private readonly now: () => number = Date.now,
    private readonly lifecycleTimeoutMs = 10_000,
  ) {}

  has(tabId: number, grantId?: string): boolean {
    const grant = this.grants.get(tabId);
    return !!grant && (!grantId || grant.grantId === grantId) && grant.expiresAt > this.now();
  }

  isPaused(tabId: number): boolean {
    return this.grants.get(tabId)?.paused === true;
  }

  ids(): number[] {
    return [...this.grants.keys()];
  }

  grantId(tabId: number): string | undefined {
    return this.grants.get(tabId)?.grantId;
  }

  setExpiry(tabId: number, grantId: string, expiresAt: number): void {
    const grant = this.requireGrant(tabId, grantId);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now())
      throw new Error("invalid grant expiry");
    clearTimeout(grant.timer);
    grant.expiresAt = expiresAt;
    grant.timer = setTimeout(() => void this.revoke(tabId, grantId), expiresAt - this.now());
  }

  async grant(tabId: number, grantId: string, expiresAt: number): Promise<void> {
    if (this.grants.has(tabId)) throw new Error("tab already has a browser grant");
    if (
      !Number.isSafeInteger(tabId) ||
      !grantId ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now()
    ) {
      throw new Error("invalid browser grant");
    }
    const grant: Grant = {
      tabId,
      grantId,
      expiresAt,
      generation: 0,
      controlEpoch: 0,
      paused: false,
      tail: Promise.resolve(),
      timer: setTimeout(() => void this.revoke(tabId, grantId), expiresAt - this.now()),
    };
    this.grants.set(tabId, grant);
    try {
      await this.open(grant);
    } catch (error) {
      // Invalidate immediately; a timed-out attachment still owns the tab's
      // cleanup barrier until the official transport has actually settled.
      void this.revoke(tabId, grantId);
      throw error;
    }
  }

  async revoke(tabId: number, grantId?: string): Promise<void> {
    const grant = this.grants.get(tabId);
    if (!grant || (grantId && grant.grantId !== grantId)) return;
    this.grants.delete(tabId);
    clearTimeout(grant.timer);
    await this.waitForLifecycle(this.close(grant)).catch(() => undefined);
  }

  async revokeAll(): Promise<void> {
    await Promise.all(this.ids().map((tabId) => this.revoke(tabId)));
  }

  async action(tabId: number, grantId: string, request: BrowserActionRequest): Promise<unknown> {
    const grant = this.requireGrant(tabId, grantId);
    // Taking control away must interrupt the current action, not wait behind it.
    if (request.action === "requestTakeover") {
      ++grant.controlEpoch;
      grant.paused = true;
      await this.waitForLifecycle(this.close(grant));
      return { ok: true, code: "NEEDS_HUMAN", detail: "Chrome control paused for the user" };
    }
    const controlEpoch = grant.controlEpoch;
    const checkControl = () => {
      if (this.requireGrant(tabId, grantId) !== grant || grant.controlEpoch !== controlEpoch) {
        throw new Error("Chrome control changed; issue a new request after the user finishes");
      }
    };
    const operation = async () => {
      this.requireGrant(tabId, grantId);
      if (grant.controlEpoch !== controlEpoch) {
        return { ok: false, code: "NEEDS_HUMAN", detail: "Chrome control changed while queued" };
      }
      if (request.action === "resumeControl") {
        if (grant.paused) {
          grant.paused = false;
          try {
            await this.open(grant);
            checkControl();
          } catch (error) {
            grant.paused = true;
            void this.close(grant);
            throw error;
          }
        }
        return { ok: true, code: "OK", detail: "Chrome control resumed; observe a new snapshot" };
      }
      if (grant.paused) {
        return {
          ok: false,
          code: "NEEDS_HUMAN",
          detail: "Chrome control is paused; resume explicitly",
        };
      }
      await grant.connecting;
      checkControl();
      if (grant.paused) throw new Error("Chrome control is paused; resume explicitly");
      if (!grant.connection) throw new Error("browser connection is unavailable");
      const result = await dispatchExtensionAction(grant.connection.driver, request);
      checkControl();
      return result;
    };
    const result = grant.tail.then(operation, operation);
    grant.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireGrant(tabId: number, grantId: string): Grant {
    const grant = this.grants.get(tabId);
    if (!grant || grant.grantId !== grantId || grant.expiresAt <= this.now()) {
      throw new Error("browser grant expired, was revoked, or does not match this tab");
    }
    return grant;
  }

  private async open(grant: Grant): Promise<void> {
    const generation = ++grant.generation;
    const previousClose = this.closing.get(grant.tabId);
    const isActive = () =>
      this.grants.get(grant.tabId) === grant &&
      grant.expiresAt > this.now() &&
      !grant.paused &&
      grant.generation === generation;
    grant.connecting = (async () => {
      await previousClose;
      if (!isActive()) throw new Error("browser grant ended while connecting");
      const connection = await this.connect(
        grant.tabId,
        `${grant.grantId}:${generation}`,
        isActive,
      );
      if (!isActive()) {
        connection.driver.dispose();
        await connection.disconnect().catch(() => undefined);
        throw new Error("browser grant ended while connecting");
      }
      grant.connection = connection;
    })();
    await this.waitForLifecycle(grant.connecting);
  }

  private close(grant: Grant): Promise<void> {
    ++grant.generation;
    const previous = this.closing.get(grant.tabId);
    const connecting = grant.connecting;
    const connection = grant.connection;
    grant.connection = undefined;
    connection?.driver.dispose();
    const closing = Promise.all([
      previous,
      connecting?.catch(() => undefined),
      connection?.disconnect().catch(() => undefined),
    ]).then(() => undefined);
    this.closing.set(grant.tabId, closing);
    void closing.then(() => {
      if (this.closing.get(grant.tabId) === closing) this.closing.delete(grant.tabId);
    });
    return closing;
  }

  private async waitForLifecycle(promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Chrome browser connection transition timed out")),
            this.lifecycleTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function dispatchExtensionAction(
  driver: BrowserBridge,
  request: BrowserActionRequest,
): Promise<unknown> {
  switch (request.action) {
    case "snapshot":
      return driver.snapshot();
    case "click":
      return driver.click(request.ref ?? "");
    case "type":
      return driver.type(request.ref ?? "", request.text ?? "");
    case "navigate":
      return driver.navigate(request.url ?? "");
    case "scroll":
      return driver.scroll(request.dir ?? "down", request.amount);
    case "readContent":
      return driver.readContent({ cursor: request.cursor, maxChars: request.maxChars });
    case "extractLinks":
      return driver.extractLinks();
    case "waitForLoad":
      return driver.waitForLoad(request.timeoutMs);
    case "hover":
      return driver.hover(request.ref ?? "");
    case "selectOption":
      return driver.selectOption(request.ref ?? "", request.value ?? "");
    case "pressKey":
      return driver.pressKey(request.key ?? "Enter", request.ref);
    case "fetchImages":
      return driver.fetchImages(request.refs ?? []);
    case "screenshot":
      return driver.screenshot(request.ref);
    case "inspect":
      if (!driver.inspect || !request.inspect) throw new Error("browser inspection is unavailable");
      return driver.inspect(request.inspect);
    // Tab identity and permitted switching are enforced by the desktop grant.
    default:
      throw new Error(`unsupported browser action: ${request.action}`);
  }
}
