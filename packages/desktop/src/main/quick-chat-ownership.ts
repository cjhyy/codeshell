export class QuickChatOwnershipRegistry {
  private readonly ownersBySession = new Map<string, Set<number>>();
  private readonly sessionsByOwner = new Map<number, Set<string>>();
  private readonly cleanupInFlight = new Map<string, Promise<void>>();

  claim(sessionId: string, ownerId: number): void {
    let owners = this.ownersBySession.get(sessionId);
    if (!owners) {
      owners = new Set<number>();
      this.ownersBySession.set(sessionId, owners);
    }
    owners.add(ownerId);

    let sessions = this.sessionsByOwner.get(ownerId);
    if (!sessions) {
      sessions = new Set<string>();
      this.sessionsByOwner.set(ownerId, sessions);
    }
    sessions.add(sessionId);
  }

  release(sessionId: string, ownerId: number): void {
    const owners = this.ownersBySession.get(sessionId);
    owners?.delete(ownerId);
    if (owners?.size === 0) this.ownersBySession.delete(sessionId);

    const sessions = this.sessionsByOwner.get(ownerId);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) this.sessionsByOwner.delete(ownerId);
  }

  releaseOwner(ownerId: number): void {
    const sessions = this.sessionsByOwner.get(ownerId);
    if (!sessions) return;
    for (const sessionId of sessions) {
      const owners = this.ownersBySession.get(sessionId);
      owners?.delete(ownerId);
      if (owners?.size === 0) this.ownersBySession.delete(sessionId);
    }
    this.sessionsByOwner.delete(ownerId);
  }

  async cleanup(
    sessionId: string,
    requesterId: number,
    deleteSession: () => Promise<void>,
  ): Promise<{ deleted: boolean }> {
    this.release(sessionId, requesterId);
    if (this.ownersBySession.has(sessionId)) return { deleted: false };

    const existing = this.cleanupInFlight.get(sessionId);
    if (existing) {
      await existing;
      return { deleted: true };
    }

    const cleanup = deleteSession();
    this.cleanupInFlight.set(sessionId, cleanup);
    try {
      await cleanup;
      return { deleted: true };
    } finally {
      this.cleanupInFlight.delete(sessionId);
    }
  }
}
