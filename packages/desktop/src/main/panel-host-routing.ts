export interface PanelHostWindowRoute {
  isDestroyed(): boolean;
  webContents: { id: number };
}

export interface ResolvedPanelHostWindow<T extends PanelHostWindowRoute> {
  ownerWebContentsId: number | null;
  window: T | null;
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
