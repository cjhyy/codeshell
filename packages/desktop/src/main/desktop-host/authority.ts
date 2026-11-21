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
    if (previous?.owner === owner && previous.deleting === deleting) return;
    if (owner === null && !deleting) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, { owner, deleting });
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
