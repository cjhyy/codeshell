import {
  bucketForSession,
  guestRecordForId,
  type GuestRecord,
} from "../browser-driver/active-guest.js";
import {
  handleBrowserAction,
  authorizeGuest,
  releaseGuest,
  type BrowserActionRequest,
} from "../browser-driver/automation-host.js";
import { loadBrowserAutomationPolicy } from "../browser-driver/load-policy.js";

const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_GRANT_TTL_MS = 60 * 60 * 1000;
const MAX_TRACKED_SESSIONS = 4096;

interface HandoffGrant {
  sessionId: string;
  guestId: number;
  bucket: string;
  grantedAt: number;
  expiresAt: number;
  /** Pause generations are independent of the still-valid capability grant. */
  controlEpoch: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  removeDestroyedListener?: () => void;
}

export interface BuiltInBrowserHandoffStatus {
  granted: boolean;
  sessionId: string;
  guestId?: number;
  url?: string;
  title?: string;
  grantedAt?: number;
  expiresAt?: number;
}

interface BuiltInHandoffDeps {
  guestRecordForId: (guestId: number) => GuestRecord | null;
  bucketForSession: (sessionId: string) => string | null;
  now: () => number;
  authorizeGuest: typeof authorizeGuest;
  releaseGuest: typeof releaseGuest;
  dispatchAction: typeof handleBrowserAction;
}

export interface GrantBuiltInBrowserInput {
  sessionId: string;
  guestId: number;
  /** Main-process BrowserWindow id of the renderer that made the user gesture. */
  sourceWindowId: number;
  ttlMs?: number;
}

/**
 * Explicit, expiring capability grant from one engine session to one built-in
 * BrowserPanel guest. It never copies cookies and never follows focus changes.
 */
export class BuiltInTabClaimBackend {
  private readonly grants = new Map<string, HandoffGrant>();
  /** Revocation never silently selects another target. Removed by explicit
   * grant/source switch or final session cleanup, never by an expiry timer. */
  private readonly revoked = new Set<string>();
  private readonly deps: BuiltInHandoffDeps;

  constructor(deps: Partial<BuiltInHandoffDeps> = {}) {
    this.deps = {
      guestRecordForId,
      bucketForSession,
      now: Date.now,
      authorizeGuest,
      releaseGuest,
      dispatchAction: handleBrowserAction,
      ...deps,
    };
  }

  grant(input: GrantBuiltInBrowserInput): BuiltInBrowserHandoffStatus {
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw new Error("browser handoff requires sessionId");
    if (
      !this.grants.has(sessionId) &&
      !this.revoked.has(sessionId) &&
      this.grants.size + this.revoked.size >= MAX_TRACKED_SESSIONS
    ) {
      throw new Error(
        "Browser grant capacity reached; clear ended sessions before granting another target",
      );
    }
    if (!Number.isFinite(input.guestId)) throw new Error("browser handoff requires guestId");
    const record = this.deps.guestRecordForId(input.guestId);
    if (!record) throw new Error("the selected built-in browser tab is no longer available");
    const bucket = this.deps.bucketForSession(sessionId);
    if (!bucket || record.bucket !== bucket) {
      throw new Error("the selected browser tab does not belong to this task");
    }
    if (!record.windowId || record.windowId !== input.sourceWindowId) {
      throw new Error("browser handoff must be granted from the window that owns the tab");
    }

    const grantedAt = this.deps.now();
    const requestedTtl = positiveFiniteOr(input.ttlMs, DEFAULT_GRANT_TTL_MS);
    const grant: HandoffGrant = {
      sessionId,
      guestId: record.guestId,
      bucket,
      grantedAt,
      expiresAt: grantedAt + Math.min(MAX_GRANT_TTL_MS, requestedTtl),
      controlEpoch: 0,
    };
    this.revoke(sessionId);
    this.deps.authorizeGuest(record.guest);
    this.revoked.delete(sessionId);
    this.grants.set(sessionId, grant);
    grant.expiryTimer = setTimeout(() => {
      if (this.grants.get(sessionId) === grant) this.revoke(sessionId);
    }, grant.expiresAt - grantedAt);
    grant.expiryTimer.unref?.();
    const onDestroyed = () => {
      const current = this.grants.get(sessionId);
      if (current?.guestId === record.guestId) this.revoke(sessionId);
    };
    grant.removeDestroyedListener = () => record.guest.removeListener?.("destroyed", onDestroyed);
    record.guest.once("destroyed", onDestroyed);
    return this.status(sessionId);
  }

  revoke(sessionId: string): boolean {
    const grant = this.grants.get(sessionId);
    if (!grant) return false;
    this.grants.delete(sessionId);
    this.revoked.add(sessionId);
    if (grant.expiryTimer) clearTimeout(grant.expiryTimer);
    grant.removeDestroyedListener?.();
    this.deps.releaseGuest(grant.guestId);
    return true;
  }

  /** Final session cleanup or an explicit switch to another authorized source. */
  clearSession(sessionId: string): void {
    this.revoke(sessionId);
    this.revoked.delete(sessionId);
  }

  revokeGuest(guestId: number): void {
    for (const [sessionId, grant] of this.grants) {
      if (grant.guestId === guestId) this.revoke(sessionId);
    }
  }

  status(sessionId: string): BuiltInBrowserHandoffStatus {
    const grant = this.liveGrant(sessionId);
    if (!grant) return { granted: false, sessionId };
    const record = this.deps.guestRecordForId(grant.guestId);
    if (!record) {
      this.revoke(sessionId);
      return { granted: false, sessionId };
    }
    return {
      granted: true,
      sessionId,
      guestId: grant.guestId,
      url: safe(() => record.guest.getURL()) ?? "",
      title: safe(() => record.guest.getTitle()) ?? "",
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
    };
  }

  /** Undefined means no claim: caller should use the task-owned in-app target. */
  async dispatch(sessionId: string, request: BrowserActionRequest): Promise<string | undefined> {
    const grant = this.liveGrant(sessionId);
    if (!grant)
      return this.revoked.has(sessionId)
        ? JSON.stringify({
            ok: false,
            code: "NEEDS_HUMAN",
            retryable: false,
            detail:
              "The granted browser tab was revoked or expired. Explicitly grant a tab again; automation will not switch to another target.",
          })
        : undefined;
    const record = this.deps.guestRecordForId(grant.guestId);
    if (!record || record.bucket !== grant.bucket) {
      this.revoke(sessionId);
      return JSON.stringify({
        ok: false,
        code: "NEEDS_HUMAN",
        retryable: false,
        detail: "the granted built-in browser tab was closed; grant another tab or use the Runtime",
      });
    }

    if (request.action === "requestTakeover") {
      grant.controlEpoch += 1;
      this.deps.releaseGuest(grant.guestId);
      return JSON.stringify({
        ok: true,
        code: "OK",
        detail: "Browser control released; explicitly resume after the user finishes.",
      });
    }
    const controlEpoch = grant.controlEpoch;
    return this.deps.dispatchAction(request, {
      isActive: () =>
        this.liveGrant(sessionId) === grant && grant.controlEpoch === controlEpoch,
      // Fixed target: focus changes and active-tab changes never broaden grant.
      activeGuest: () => record.guest,
      policy: loadBrowserAutomationPolicy,
      listTabs: () => [tabFromRecord(record)],
      switchTab: (tabId) => tabId === String(record.guestId),
      // No per-action approval UI is wired here. Secret-shaped input and refs
      // marked sensitive by the snapshot therefore fail closed.
      approve: undefined,
    });
  }

  private liveGrant(sessionId: string): HandoffGrant | undefined {
    const grant = this.grants.get(sessionId);
    if (!grant) return undefined;
    if (grant.expiresAt <= this.deps.now()) {
      this.revoke(sessionId);
      return undefined;
    }
    const bucket = this.deps.bucketForSession(sessionId);
    if (!bucket || bucket !== grant.bucket) {
      this.revoke(sessionId);
      return undefined;
    }
    return grant;
  }
}

export const builtInTabClaimBackend = new BuiltInTabClaimBackend();

/** @deprecated Use BuiltInTabClaimBackend. */
export { BuiltInTabClaimBackend as BuiltInBrowserHandoffGrants };
/** @deprecated Use builtInTabClaimBackend. */
export const builtInBrowserHandoffGrants = builtInTabClaimBackend;

function tabFromRecord(record: GuestRecord): {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
} {
  return {
    tabId: String(record.guestId),
    url: safe(() => record.guest.getURL()) ?? "",
    title: safe(() => record.guest.getTitle()) ?? "",
    active: true,
  };
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function safe<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}
