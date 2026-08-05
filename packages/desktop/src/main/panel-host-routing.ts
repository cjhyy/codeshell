export interface PanelHostWindowRoute {
  isDestroyed(): boolean;
  webContents: { id: number };
}

export interface ResolvedPanelHostWindow<T extends PanelHostWindowRoute> {
  ownerWebContentsId: number | null;
  window: T | null;
}

export interface PanelHostOwnerClaimer {
  claimSessionPanelOwner(sessionId: string, webContentsId: number): void;
}

/**
 * Claim the unique renderer owner before a Panel App starts an agent run.
 *
 * Panel-originated runs do not cross the renderer's agent:msg IPC path, so they
 * must establish the same ownership explicitly. Failing closed for a missing
 * owner preserves the invariant that mutating Panel tools are never broadcast.
 */
export function claimPanelHostOwnerForRun(
  claimer: PanelHostOwnerClaimer,
  sessionId: string,
  owner: PanelHostWindowRoute | null,
): void {
  if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
  claimer.claimSessionPanelOwner(sessionId, owner.webContents.id);
}

/**
 * Tracks the renderer window that owns each agent session. Keeping this state
 * separate makes the multi-window routing contract deterministic and testable
 * without an Electron runtime.
 */
export class PanelHostWindowRoutes {
  private readonly ownerBySession = new Map<string, number>();

  claim(sessionId: string, webContentsId: number): void {
    this.ownerBySession.set(sessionId, webContentsId);
  }

  forgetSession(sessionId: string): void {
    this.ownerBySession.delete(sessionId);
  }

  releaseWindow(webContentsId: number): void {
    for (const [sessionId, ownerId] of this.ownerBySession) {
      if (ownerId === webContentsId) this.ownerBySession.delete(sessionId);
    }
  }

  /**
   * Non-mutating check for a live owning window.
   *
   * Deliberately NOT implemented via {@link resolve}: that method *deletes* a dead
   * owner as a side effect, so using it for a predicate would make a read-only
   * question mutate routing state.
   */
  hasLiveOwner<T extends PanelHostWindowRoute>(sessionId: string, windows: Iterable<T>): boolean {
    const ownerWebContentsId = this.ownerBySession.get(sessionId);
    if (ownerWebContentsId === undefined) return false;
    for (const window of windows) {
      if (!window.isDestroyed() && window.webContents.id === ownerWebContentsId) return true;
    }
    return false;
  }

  resolve<T extends PanelHostWindowRoute>(
    sessionId: string,
    windows: Iterable<T>,
  ): ResolvedPanelHostWindow<T> {
    const ownerWebContentsId = this.ownerBySession.get(sessionId);
    if (ownerWebContentsId === undefined) {
      return { ownerWebContentsId: null, window: null };
    }
    for (const window of windows) {
      if (!window.isDestroyed() && window.webContents.id === ownerWebContentsId) {
        return { ownerWebContentsId, window };
      }
    }
    // A renderer can disappear between agent/run and a later Panel tool. Do
    // not retain a dead owner: the caller may use its compatibility fallback.
    this.ownerBySession.delete(sessionId);
    return { ownerWebContentsId: null, window: null };
  }
}

export function acceptsPanelHostResponse(
  ownerWebContentsId: number | null,
  responderWebContentsId: number,
): boolean {
  return ownerWebContentsId === null || ownerWebContentsId === responderWebContentsId;
}

export function allowsPanelHostBroadcastFallback(
  action: "list" | "open" | "tools" | "invoke",
): boolean {
  return action !== "invoke";
}
