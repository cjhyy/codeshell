import { assertDesktopSessionId } from "./session-validation.js";

interface BrowserSessionBridge {
  hasKnownSession(sessionId: string): boolean;
  panelOwnerWebContentsId(sessionId: string): number | undefined;
  sessionPanelOwnerRevision(sessionId: string): number;
  workerGeneration(): number;
}

interface BrowserSessionWindow {
  isDestroyed(): boolean;
  webContents: {
    id: number;
    mainFrame: unknown;
    isDestroyed(): boolean;
  };
}

export interface PersistedBrowserSessionAuthority {
  /** Derived by Main from the persisted Session and its mounted project. */
  bucket: string;
  /** Rechecks the Session incarnation, physical roots and project binding. */
  assertCurrent(): void;
}

export interface RendererBrowserSessionAuthorization {
  sessionId: string;
  bucket: string | null;
  /** Retain this guard with a grant; check it again before every dispatch. */
  assertCurrent(): void;
}

export interface RendererBrowserSessionAccessDeps {
  bridge(): BrowserSessionBridge | null;
  windowForSender(senderId: number): BrowserSessionWindow | null;
  resolvePersistedSession(
    sessionId: string,
    requestedBucket?: string,
  ): Promise<PersistedBrowserSessionAuthority>;
  bucketForSession(sessionId: string): string | null;
  registerSessionBucket(sessionId: string, bucket: string): void;
}

interface ColdClaim extends RendererBrowserSessionAuthorization {
  senderId: number;
}

const MAX_BROWSER_UI_SESSIONS = 4096;

/**
 * Browser UI authority is independent of worker/run authority. Opening an
 * existing conversation may register its browser before its next agent/run,
 * but must never reserve a generic Host session or start a worker.
 *
 * The injected resolver accepts only a durable, usable Session. New drafts,
 * Quick Chats and other process-local sessions retain their Main-owned path.
 */
export class RendererBrowserSessionAccess {
  private readonly claims = new Map<string, ColdClaim>();
  private readonly sessionLifetimes = new Map<string, Map<number, object>>();
  private readonly windowLifetimes = new Map<number, object>();

  constructor(private readonly deps: RendererBrowserSessionAccessDeps) {}

  /** Synchronous check for callers that already registered their browser. */
  assertAccess(rawSessionId: unknown, senderId: number): string {
    assertDesktopSessionId(rawSessionId);
    const claim = this.claims.get(rawSessionId);
    if (claim) {
      claim.assertCurrent();
      if (claim.senderId !== senderId)
        throw new Error("browser operation belongs to another window");
      return rawSessionId;
    }
    this.captureLive(rawSessionId, senderId).assertCurrent();
    return rawSessionId;
  }

  async prepare(
    rawSessionId: unknown,
    senderId: number,
    requestedBucket?: string,
  ): Promise<RendererBrowserSessionAuthorization> {
    assertDesktopSessionId(rawSessionId);
    if (
      requestedBucket !== undefined &&
      (typeof requestedBucket !== "string" ||
        !requestedBucket ||
        requestedBucket.length > 512 ||
        requestedBucket.includes("\0"))
    )
      throw new Error("invalid browser bucket");
    const sessionId = rawSessionId;
    const previous = this.claims.get(sessionId);
    if (previous) {
      // A different window cannot revoke a healthy claim by merely asking for
      // its status. Retire only a claim whose own captured authority is stale.
      try {
        previous.assertCurrent();
      } catch {
        if (this.claims.get(sessionId) === previous) this.claims.delete(sessionId);
      }
      if (this.claims.get(sessionId) === previous) {
        if (previous.senderId !== senderId)
          throw new Error("browser operation belongs to another window");
        if (requestedBucket !== undefined && requestedBucket !== previous.bucket)
          throw new Error("browser bucket does not match the conversation");
        return previous;
      }
    }

    const caller = this.captureCaller(sessionId, senderId);
    if (caller.bridge.hasKnownSession(sessionId)) {
      const live = this.captureLive(sessionId, senderId);
      live.assertCurrent();
      return live;
    }

    const owner = caller.bridge.panelOwnerWebContentsId(sessionId);
    const ownerRevision = caller.bridge.sessionPanelOwnerRevision(sessionId);
    const generation = caller.bridge.workerGeneration();
    const existingBucket = this.deps.bucketForSession(sessionId);
    const authority = await this.deps.resolvePersistedSession(sessionId, requestedBucket);
    caller.assertCurrent();
    if (
      caller.bridge.hasKnownSession(sessionId) ||
      caller.bridge.workerGeneration() !== generation ||
      caller.bridge.panelOwnerWebContentsId(sessionId) !== owner ||
      caller.bridge.sessionPanelOwnerRevision(sessionId) !== ownerRevision
    )
      throw new Error("browser Session authority changed while opening the conversation");
    authority.assertCurrent();
    if (
      !authority.bucket ||
      authority.bucket.length > 512 ||
      authority.bucket.includes("\0") ||
      (existingBucket !== null && existingBucket !== authority.bucket)
    )
      throw new Error("browser bucket does not match the persisted conversation");

    // Two windows may have resolved the same cold Session concurrently. The
    // first committed UI claim wins; it cannot be overwritten by a late read.
    const concurrent = this.claims.get(sessionId);
    if (concurrent) {
      concurrent.assertCurrent();
      if (concurrent.senderId !== senderId)
        throw new Error("browser operation belongs to another window");
      if (concurrent.bucket !== authority.bucket)
        throw new Error("browser bucket does not match the persisted conversation");
      return concurrent;
    }
    if (this.deps.bucketForSession(sessionId) !== existingBucket)
      throw new Error("browser Session authority changed while opening the conversation");

    const claim: ColdClaim = {
      sessionId,
      senderId,
      bucket: authority.bucket,
      assertCurrent: () => {
        caller.assertCurrent();
        if (this.claims.get(sessionId) !== claim)
          throw new Error("browser conversation registration was retired");
        authority.assertCurrent();
        if (this.deps.bucketForSession(sessionId) !== authority.bucket)
          throw new Error("browser conversation binding changed");
      },
    };
    this.deps.registerSessionBucket(sessionId, authority.bucket);
    this.claims.set(sessionId, claim);
    claim.assertCurrent();
    return claim;
  }

  forgetSession(sessionId: string): void {
    this.claims.delete(sessionId);
    this.sessionLifetimes.delete(sessionId);
  }

  forgetWindow(senderId: number): void {
    this.windowLifetimes.delete(senderId);
    for (const [sessionId, lifetimes] of this.sessionLifetimes) {
      lifetimes.delete(senderId);
      if (lifetimes.size === 0) this.sessionLifetimes.delete(sessionId);
    }
    for (const [sessionId, claim] of this.claims) {
      if (claim.senderId === senderId) this.claims.delete(sessionId);
    }
  }

  /** Called by Main at the real owner-claim point, including the first run. */
  sessionOwnerClaimed(sessionId: string, senderId: number): void {
    // Invalidate other windows immediately: observing only the current owner
    // cannot distinguish a first claim from an unseen A -> B -> A transfer.
    const lifetimes = this.sessionLifetimes.get(sessionId);
    for (const previousSender of lifetimes?.keys() ?? []) {
      if (previousSender !== senderId) lifetimes?.delete(previousSender);
    }
    if (lifetimes?.size === 0) this.sessionLifetimes.delete(sessionId);
    const claim = this.claims.get(sessionId);
    if (claim && claim.senderId !== senderId) this.claims.delete(sessionId);
  }

  private captureLive(sessionId: string, senderId: number): RendererBrowserSessionAuthorization {
    const caller = this.captureCaller(sessionId, senderId);
    const bucket = this.deps.bucketForSession(sessionId);
    return {
      sessionId,
      bucket,
      assertCurrent: () => {
        caller.assertCurrent();
        if (!caller.bridge.hasKnownSession(sessionId))
          throw new Error("Open an existing conversation before authorizing its browser");
        if (this.deps.bucketForSession(sessionId) !== bucket)
          throw new Error("browser conversation binding changed");
      },
    };
  }

  private captureCaller(sessionId: string, senderId: number) {
    const bridge = this.deps.bridge();
    const window = this.deps.windowForSender(senderId);
    const frame = window?.webContents.mainFrame;
    if (!bridge || !window || !frame)
      throw new Error("browser operation requires an available conversation window");
    let sessionWindows = this.sessionLifetimes.get(sessionId);
    if (!sessionWindows) {
      if (this.sessionLifetimes.size >= MAX_BROWSER_UI_SESSIONS)
        throw new Error("Too many browser conversations are open");
      sessionWindows = new Map();
      this.sessionLifetimes.set(sessionId, sessionWindows);
    }
    let sessionLifetime = sessionWindows.get(senderId);
    if (!sessionLifetime) {
      sessionLifetime = {};
      sessionWindows.set(senderId, sessionLifetime);
    }
    let windowLifetime = this.windowLifetimes.get(senderId);
    if (!windowLifetime) {
      windowLifetime = {};
      this.windowLifetimes.set(senderId, windowLifetime);
    }
    let acceptedOwner = bridge.panelOwnerWebContentsId(sessionId);
    let acceptedOwnerRevision = bridge.sessionPanelOwnerRevision(sessionId);
    const assertCurrent = () => {
      if (
        this.deps.bridge() !== bridge ||
        this.deps.windowForSender(senderId) !== window ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        window.webContents.id !== senderId ||
        window.webContents.mainFrame !== frame ||
        this.sessionLifetimes.get(sessionId)?.get(senderId) !== sessionLifetime ||
        this.windowLifetimes.get(senderId) !== windowLifetime
      )
        throw new Error("browser conversation window changed");
      const owner = bridge.panelOwnerWebContentsId(sessionId);
      if (owner !== undefined && owner !== senderId)
        throw new Error("browser operation belongs to another window");
      const revision = bridge.sessionPanelOwnerRevision(sessionId);
      // The first legitimate run claims this renderer and can also start a
      // worker. Neither event should revoke a tab granted before that run.
      if (acceptedOwner === undefined && owner === senderId) {
        acceptedOwner = owner;
        acceptedOwnerRevision = revision;
      } else if (owner !== acceptedOwner || revision !== acceptedOwnerRevision) {
        throw new Error("browser conversation owner changed");
      }
    };
    assertCurrent();
    return { bridge, assertCurrent };
  }
}
