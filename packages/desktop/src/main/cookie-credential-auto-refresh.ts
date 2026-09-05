import type { ElectronCookieLike } from "./credentials-service.js";
import type { CredentialScope } from "@cjhyy/code-shell-core";
import {
  refreshCookieCredentialFromBrowser,
  type DesktopCredentialScope,
} from "./credential-action.js";
import { dlog } from "./desktop-logger.js";

const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

type CookieChangedListener = (
  event: unknown,
  cookie: ElectronCookieLike,
  cause: string,
  removed: boolean,
) => void;

export interface CookieSessionLike {
  cookies: {
    get(filter: { domain?: string }): Promise<ElectronCookieLike[]>;
    on(event: "changed", listener: CookieChangedListener): unknown;
    removeListener(event: "changed", listener: CookieChangedListener): unknown;
  };
}

export interface CookieCredentialAutoRefreshBinding {
  session: CookieSessionLike;
  sessionCwd?: string;
  credentialId: string;
  credentialScope: DesktopCredentialScope;
  storeScope: CredentialScope;
  captureScope: "domain" | "all";
  domain?: string;
  /** Cookie domains present when the credential was restored. */
  seedJar: unknown[];
  /** Original serialized secret, including formatting, for optimistic writes. */
  sourceSecret?: string;
  /** Keep the account binding while avoiding reads when sync is switched off. */
  enabled?: boolean;
}

interface ActiveBinding extends CookieCredentialAutoRefreshBinding {
  credentialKey: string;
  managedDomains: Set<string>;
  requiredCookieKeys: Set<string>;
  expectedSecret: string;
  enabled: boolean;
  revision: number;
  listener: CookieChangedListener;
  timer?: ReturnType<typeof setTimeout>;
}

export interface CookieCredentialAutoRefreshOptions {
  debounceMs?: number;
  shutdownTimeoutMs?: number;
  persist?: typeof refreshCookieCredentialFromBrowser;
  onError?: (error: unknown) => void;
}

function normalizeDomain(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/^\./, "") : "";
}

function domainMatches(candidate: unknown, managedDomains: Set<string>): boolean {
  const domain = normalizeDomain(candidate);
  if (!domain) return false;
  for (const managed of managedDomains) {
    if (domain === managed || domain.endsWith(`.${managed}`)) {
      return true;
    }
  }
  return false;
}

function cookieKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cookie = value as Partial<ElectronCookieLike>;
  const domain = normalizeDomain(cookie.domain);
  if (!domain || typeof cookie.name !== "string") return undefined;
  return JSON.stringify([domain, cookie.path ?? "/", cookie.name]);
}

function seedDomains(seedJar: unknown[], domain?: string): Set<string> {
  const domains = new Set<string>();
  const primary = normalizeDomain(domain);
  if (primary) domains.add(primary);
  for (const item of seedJar) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = normalizeDomain((item as { domain?: unknown }).domain);
    if (candidate) domains.add(candidate);
  }
  return domains;
}

/**
 * Keeps the credential that was explicitly restored into a browser Session in
 * sync with server-side cookie rotation. Restoring another account for an
 * overlapping domain replaces the previous listener; unrelated sites in the
 * same browser profile remain bound.
 */
export class CookieCredentialAutoRefresh {
  private readonly bindings = new Map<CookieSessionLike, Set<ActiveBinding>>();
  private readonly bindingByCredential = new Map<string, ActiveBinding>();
  private readonly debounceMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly persist: typeof refreshCookieCredentialFromBrowser;
  private readonly onError: (error: unknown) => void;
  private readonly inFlight = new Set<Promise<void>>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: CookieCredentialAutoRefreshOptions = {}) {
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.shutdownTimeoutMs = Math.max(0, options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this.persist = options.persist ?? refreshCookieCredentialFromBrowser;
    this.onError =
      options.onError ??
      ((error) => dlog("credentials", "cookie_auto_refresh_failed", { error: String(error) }));
  }

  bind(input: CookieCredentialAutoRefreshBinding): boolean {
    if (this.shuttingDown) return false;
    const managedDomains = seedDomains(input.seedJar, input.domain);
    if (managedDomains.size === 0) return false;

    const credentialKey = this.credentialKey(input);
    const previousSession = this.bindingByCredential.get(credentialKey);
    if (previousSession) this.removeBinding(previousSession);

    let sessionBindings = this.bindings.get(input.session);
    if (!sessionBindings) {
      sessionBindings = new Set();
      this.bindings.set(input.session, sessionBindings);
    }
    for (const existing of [...sessionBindings]) {
      if (this.domainsOverlap(existing.managedDomains, managedDomains)) {
        this.removeBinding(existing);
      }
    }

    const binding = {} as ActiveBinding;
    const listener: CookieChangedListener = (_event, cookie, _cause, removed) => {
      if (!domainMatches(cookie.domain, managedDomains)) return;
      // Invalidate pending and in-flight captures on every mutation. In
      // particular, a deletion must cancel an earlier write's debounce rather
      // than let that capture persist the logged-out remainder of the jar.
      binding.revision += 1;
      if (binding.timer !== undefined) clearTimeout(binding.timer);
      binding.timer = undefined;
      if (removed || !binding.enabled) return;
      this.schedule(binding);
    };
    Object.assign(binding, input, {
      credentialKey,
      managedDomains,
      requiredCookieKeys: new Set(input.seedJar.map(cookieKey).filter((key) => key !== undefined)),
      expectedSecret: input.sourceSecret ?? JSON.stringify(input.seedJar),
      enabled: input.enabled ?? true,
      revision: 0,
      listener,
    });
    if (!this.bindings.has(input.session)) this.bindings.set(input.session, sessionBindings);
    sessionBindings.add(binding);
    this.bindingByCredential.set(credentialKey, binding);
    input.session.cookies.on("changed", listener);
    return true;
  }

  unbind(session: CookieSessionLike): void {
    const sessionBindings = this.bindings.get(session);
    if (!sessionBindings) return;
    for (const binding of [...sessionBindings]) this.removeBinding(binding);
  }

  /** Stop old account listeners before the first cookie is injected. */
  prepareRestore(
    session: CookieSessionLike,
    seedJar: unknown[],
    mode: "clear" | "merge" = "merge",
  ): void {
    if (mode === "clear") {
      this.unbind(session);
      return;
    }
    const domains = seedDomains(seedJar);
    for (const binding of [...(this.bindings.get(session) ?? [])]) {
      if (this.domainsOverlap(binding.managedDomains, domains)) this.removeBinding(binding);
    }
  }

  detachForCredential(
    sessionCwd: string | undefined,
    credentialId: string,
    storeScope: CredentialScope,
  ): void {
    const binding = this.bindingByCredential.get(
      this.credentialKey({ sessionCwd, credentialId, storeScope }),
    );
    if (binding) this.removeBinding(binding);
  }

  /** Capture the current bound profile after enabling sync, without reinjection. */
  requestRefreshForCredential(
    sessionCwd: string | undefined,
    credentialId: string,
    storeScope: CredentialScope,
  ): boolean {
    if (this.shuttingDown) return false;
    const binding = this.bindingByCredential.get(
      this.credentialKey({ sessionCwd, credentialId, storeScope }),
    );
    if (!binding) return false;
    binding.enabled = true;
    binding.revision += 1;
    this.schedule(binding);
    return true;
  }

  /** Invalidates pending/in-flight work while retaining the profile binding. */
  cancelRefreshForCredential(
    sessionCwd: string | undefined,
    credentialId: string,
    storeScope: CredentialScope,
  ): boolean {
    const binding = this.bindingByCredential.get(
      this.credentialKey({ sessionCwd, credentialId, storeScope }),
    );
    if (!binding) return false;
    binding.enabled = false;
    binding.revision += 1;
    if (binding.timer !== undefined) clearTimeout(binding.timer);
    binding.timer = undefined;
    return true;
  }

  closeAll(): void {
    for (const session of this.bindings.keys()) this.unbind(session);
  }

  /** Drain pending rotations on app quit without waiting indefinitely on Electron. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.drainPending(),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, this.shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        // Removing bindings also invalidates any capture that finishes after
        // the timeout, so it cannot write after application shutdown proceeds.
        this.closeAll();
      }
    })();
    return this.shutdownPromise;
  }

  async flushNow(session: CookieSessionLike): Promise<void> {
    const scheduled = [...(this.bindings.get(session) ?? [])].filter(
      (binding) => binding.timer !== undefined,
    );
    for (const binding of scheduled) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
      await this.startFlush(binding);
    }
  }

  private schedule(binding: ActiveBinding): void {
    if (!this.hasBinding(binding) || !binding.enabled) return;
    if (binding.timer !== undefined) clearTimeout(binding.timer);
    binding.timer = setTimeout(() => {
      binding.timer = undefined;
      void this.startFlush(binding).catch(this.onError);
    }, this.debounceMs);
  }

  private async drainPending(): Promise<void> {
    while (true) {
      const scheduled = [...this.bindingByCredential.values()].filter(
        (binding) => binding.timer !== undefined,
      );
      for (const binding of scheduled) {
        clearTimeout(binding.timer);
        binding.timer = undefined;
        void this.startFlush(binding).catch(this.onError);
      }
      const running = [...this.inFlight];
      if (running.length === 0) return;
      await Promise.allSettled(running);
      // A Cookie event during the reads invalidates their results and queues a
      // fresh snapshot. The next pass drains it, subject to shutdown's timeout.
      if (
        this.inFlight.size === 0 &&
        ![...this.bindingByCredential.values()].some((binding) => binding.timer !== undefined)
      ) {
        return;
      }
    }
  }

  private startFlush(binding: ActiveBinding): Promise<void> {
    const pending = this.flush(binding);
    this.inFlight.add(pending);
    void pending.then(
      () => this.inFlight.delete(pending),
      () => this.inFlight.delete(pending),
    );
    return pending;
  }

  private async flush(binding: ActiveBinding): Promise<void> {
    if (!this.hasBinding(binding) || !binding.enabled) return;
    const revision = binding.revision;
    const filter =
      binding.captureScope === "domain" && binding.domain ? { domain: binding.domain } : {};
    const captured = await binding.session.cookies.get(filter);
    if (!this.hasBinding(binding) || !binding.enabled || binding.revision !== revision) return;

    // Even a historical "all" credential is constrained to the domains it
    // originally owned. Browsing an unrelated site must not silently copy that
    // site's login into this credential.
    const jar = captured.filter((cookie) => domainMatches(cookie.domain, binding.managedDomains));
    if (jar.length === 0) return;
    // A later tracking/guest write after logout must not bypass the removal
    // guard. Without site-specific authentication knowledge, retain the saved
    // credential until all cookies present at binding are present again.
    const capturedKeys = new Set(jar.map(cookieKey));
    if ([...binding.requiredCookieKeys].some((key) => !capturedKeys.has(key))) return;
    const result = this.persist(
      binding.sessionCwd,
      binding.credentialId,
      binding.storeScope,
      jar,
      binding.expectedSecret,
    );
    if (result === "updated") binding.expectedSecret = JSON.stringify(jar);
    if (result === "missing" || result === "conflict") this.removeBinding(binding);
  }

  private hasBinding(binding: ActiveBinding): boolean {
    return this.bindings.get(binding.session)?.has(binding) === true;
  }

  private removeBinding(binding: ActiveBinding): void {
    if (binding.timer !== undefined) clearTimeout(binding.timer);
    binding.timer = undefined;
    binding.revision += 1;
    binding.session.cookies.removeListener("changed", binding.listener);
    const sessionBindings = this.bindings.get(binding.session);
    sessionBindings?.delete(binding);
    if (sessionBindings?.size === 0) this.bindings.delete(binding.session);
    if (this.bindingByCredential.get(binding.credentialKey) === binding) {
      this.bindingByCredential.delete(binding.credentialKey);
    }
  }

  private domainsOverlap(left: Set<string>, right: Set<string>): boolean {
    for (const domain of left) if (domainMatches(domain, right)) return true;
    for (const domain of right) if (domainMatches(domain, left)) return true;
    return false;
  }

  private credentialKey(
    input: Pick<CookieCredentialAutoRefreshBinding, "sessionCwd" | "credentialId" | "storeScope">,
  ): string {
    const owner = input.storeScope === "project" ? (input.sessionCwd ?? "") : "user";
    return `${input.storeScope}\0${owner}\0${input.credentialId}`;
  }
}

export const cookieCredentialAutoRefresh = new CookieCredentialAutoRefresh();
