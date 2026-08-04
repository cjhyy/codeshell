import {
  bucketForSession,
  guestRecordForId,
  type GuestRecord,
} from "../browser-driver/active-guest.js";
import {
  handleBrowserAction,
  type BrowserActionRequest,
} from "../browser-driver/automation-host.js";
import { loadBrowserAutomationPolicy } from "../browser-driver/load-policy.js";

const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_GRANT_TTL_MS = 60 * 60 * 1000;

interface HandoffGrant {
  sessionId: string;
  guestId: number;
  bucket: string;
  grantedAt: number;
  expiresAt: number;
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
export class BuiltInBrowserHandoffGrants {
  private readonly grants = new Map<string, HandoffGrant>();
  private readonly deps: BuiltInHandoffDeps;

  constructor(deps: Partial<BuiltInHandoffDeps> = {}) {
    this.deps = {
      guestRecordForId,
      bucketForSession,
      now: Date.now,
      ...deps,
    };
  }

  grant(input: GrantBuiltInBrowserInput): BuiltInBrowserHandoffStatus {
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw new Error("browser handoff requires sessionId");
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
    };
    this.grants.set(sessionId, grant);
    record.guest.once("destroyed", () => {
      const current = this.grants.get(sessionId);
      if (current?.guestId === record.guestId) this.grants.delete(sessionId);
    });
    return this.status(sessionId);
  }

  revoke(sessionId: string): boolean {
    return this.grants.delete(sessionId);
  }

  revokeGuest(guestId: number): void {
    for (const [sessionId, grant] of this.grants) {
      if (grant.guestId === guestId) this.grants.delete(sessionId);
    }
  }

  status(sessionId: string): BuiltInBrowserHandoffStatus {
    const grant = this.liveGrant(sessionId);
    if (!grant) return { granted: false, sessionId };
    const record = this.deps.guestRecordForId(grant.guestId);
    if (!record) {
      this.grants.delete(sessionId);
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

  /** Undefined means no grant: caller should use the independent Runtime. */
  async dispatch(
    sessionId: string,
    request: BrowserActionRequest,
  ): Promise<string | undefined> {
    const grant = this.liveGrant(sessionId);
    if (!grant) return undefined;
    const record = this.deps.guestRecordForId(grant.guestId);
    if (!record || record.bucket !== grant.bucket) {
      this.grants.delete(sessionId);
      return JSON.stringify({
        ok: false,
        code: "NEEDS_HUMAN",
        retryable: false,
        detail: "the granted built-in browser tab was closed; grant another tab or use the Runtime",
      });
    }

    return handleBrowserAction(request, {
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
      this.grants.delete(sessionId);
      return undefined;
    }
    const bucket = this.deps.bucketForSession(sessionId);
    if (!bucket || bucket !== grant.bucket) {
      this.grants.delete(sessionId);
      return undefined;
    }
    return grant;
  }
}

export const builtInBrowserHandoffGrants = new BuiltInBrowserHandoffGrants();

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
