import type { DesktopHostIdentity } from "../../shared/desktop-host-protocol.js";

export class HostRevokedError extends Error {
  constructor() {
    super("Desktop Host authority was revoked");
  }
}

interface SessionState {
  readonly owner: number | null;
  readonly deleting: boolean;
}

/** Only the trusted Main control channel updates this state. A new object
 * represents a new grant, including a round trip back to the same window. */
export class HostSessionAuthority {
  private readonly sessions = new Map<string, SessionState>();
  private readonly historicalReads = new Map<string, { readers: number }>();

  setOwner(sessionId: string, owner: number | null): void {
    const previous = this.sessions.get(sessionId);
    this.setState(sessionId, owner, previous?.deleting ?? false);
  }

  setDeleting(sessionId: string, deleting: boolean): void {
    const previous = this.sessions.get(sessionId);
    this.setState(sessionId, previous?.owner ?? null, deleting);
  }

  private setState(sessionId: string, owner: number | null, deleting: boolean): void {
    const previous = this.sessions.get(sessionId);
    if ((previous?.owner ?? null) === owner && (previous?.deleting ?? false) === deleting) return;
    // Invalidate even if the session returns to an unowned state before I/O finishes.
    this.historicalReads.delete(sessionId);
    if (owner === null && !deleting) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, { owner, deleting });
  }

  allows(sessionId: string, webContentsId: number): boolean {
    const entry = this.sessions.get(sessionId);
    return !!entry && entry.owner === webContentsId && !entry.deleting;
  }

  captureHistoryRead(sessionId: string, webContentsId: number) {
    const current = this.sessions.get(sessionId);
    if (current) return { historical: false, assertCurrent: this.grant(sessionId, webContentsId) };
    let lease = this.historicalReads.get(sessionId);
    if (!lease) this.historicalReads.set(sessionId, (lease = { readers: 0 }));
    lease.readers++;
    let released = false;
    return {
      historical: true,
      assertCurrent: () => {
        if (released || this.historicalReads.get(sessionId) !== lease) throw new HostRevokedError();
      },
      release: () => {
        if (released) return;
        released = true;
        if (--lease.readers === 0 && this.historicalReads.get(sessionId) === lease)
          this.historicalReads.delete(sessionId);
      },
    };
  }

  grant(sessionId: string, webContentsId: number): () => void {
    const observed = this.sessions.get(sessionId);
    if (!observed || observed.owner !== webContentsId || observed.deleting) {
      throw new HostRevokedError();
    }
    return () => {
      if (this.sessions.get(sessionId) !== observed) throw new HostRevokedError();
    };
  }
}

export interface HostRequestContext {
  readonly identity: Readonly<DesktopHostIdentity>;
  readonly historical?: boolean;
  release?(): void;
  /** Call again after each await, immediately before any effect. */
  assertCurrent(): void;
}

/** This object belongs to one transferred port, never to a renderer request. */
export class HostPortAuthority {
  private current = true;
  readonly identity: Readonly<DesktopHostIdentity>;

  constructor(
    identity: DesktopHostIdentity,
    private readonly sessions: HostSessionAuthority,
  ) {
    this.identity = Object.freeze({ ...identity });
  }

  revoke(): void {
    this.current = false;
  }

  captureHistoryRead(sessionId: string): HostRequestContext {
    const frame = this.capture();
    const lease = this.sessions.captureHistoryRead(sessionId, this.identity.webContentsId);
    return {
      ...lease,
      identity: frame.identity,
      assertCurrent() {
        frame.assertCurrent();
        lease.assertCurrent();
      },
    };
  }

  capture(sessionId?: string): HostRequestContext {
    const assertSession =
      sessionId === undefined
        ? undefined
        : this.sessions.grant(sessionId, this.identity.webContentsId);
    const assertCurrent = () => {
      if (!this.current) throw new HostRevokedError();
      assertSession?.();
    };
    assertCurrent();
    return { identity: this.identity, assertCurrent };
  }
}
