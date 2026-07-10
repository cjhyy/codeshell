interface QuickChatClaim {
  claimId: string;
  forkInFlight: boolean;
  tombstoned: boolean;
}

type DeleteSession = (sessionId: string) => Promise<void>;

export class QuickChatOwnershipRegistry {
  private readonly claimsBySession = new Map<string, Map<number, QuickChatClaim>>();
  private readonly sessionsByOwner = new Map<number, Set<string>>();
  private readonly cleanupInFlight = new Map<string, Promise<void>>();
  private readonly deletedSessions = new Set<string>();

  claim(sessionId: string, ownerId: number, claimId: string): void {
    let claims = this.claimsBySession.get(sessionId);
    if (!claims) {
      claims = new Map<number, QuickChatClaim>();
      this.claimsBySession.set(sessionId, claims);
    }
    claims.set(ownerId, { claimId, forkInFlight: false, tombstoned: false });
    this.deletedSessions.delete(sessionId);

    let sessions = this.sessionsByOwner.get(ownerId);
    if (!sessions) {
      sessions = new Set<string>();
      this.sessionsByOwner.set(ownerId, sessions);
    }
    sessions.add(sessionId);
  }

  isClaimActive(sessionId: string, ownerId: number, claimId: string): boolean {
    const claim = this.claimsBySession.get(sessionId)?.get(ownerId);
    return Boolean(claim && claim.claimId === claimId && !claim.tombstoned);
  }

  beginFork(sessionId: string, ownerId: number, claimId: string): boolean {
    const claim = this.claimsBySession.get(sessionId)?.get(ownerId);
    if (!claim || claim.claimId !== claimId || claim.tombstoned) return false;
    claim.forkInFlight = true;
    return true;
  }

  async settleFork(
    sessionId: string,
    ownerId: number,
    claimId: string,
    succeeded: boolean,
    deleteSession: () => Promise<void>,
  ): Promise<{ active: boolean; deleted: boolean }> {
    const claim = this.claimsBySession.get(sessionId)?.get(ownerId);
    if (claim && claim.claimId === claimId) claim.forkInFlight = false;
    const active = this.isClaimActive(sessionId, ownerId, claimId);
    if (!succeeded || active || this.hasActiveOwner(sessionId)) {
      return { active, deleted: false };
    }
    await this.deleteOnce(sessionId, async () => deleteSession());
    return { active: false, deleted: true };
  }

  async cleanup(
    sessionId: string,
    requesterId: number,
    claimId: string,
    deleteSession: () => Promise<void>,
  ): Promise<{ deleted: boolean; deferred?: boolean }> {
    const claim = this.claimsBySession.get(sessionId)?.get(requesterId);
    if (claim && claim.claimId === claimId) claim.tombstoned = true;
    if (this.hasActiveOwner(sessionId)) return { deleted: false };
    if (this.hasForkInFlight(sessionId)) return { deleted: false, deferred: true };
    await this.deleteOnce(sessionId, deleteSession);
    return { deleted: true };
  }

  async releaseOwner(ownerId: number, deleteSession: DeleteSession): Promise<void> {
    const sessions = [...(this.sessionsByOwner.get(ownerId) ?? [])];
    this.sessionsByOwner.delete(ownerId);
    for (const sessionId of sessions) {
      const claim = this.claimsBySession.get(sessionId)?.get(ownerId);
      if (claim) claim.tombstoned = true;
      if (this.hasActiveOwner(sessionId) || this.hasForkInFlight(sessionId)) continue;
      await this.deleteOnce(sessionId, () => deleteSession(sessionId));
    }
  }

  private hasActiveOwner(sessionId: string): boolean {
    const claims = this.claimsBySession.get(sessionId);
    return Boolean(claims && [...claims.values()].some((claim) => !claim.tombstoned));
  }

  private hasForkInFlight(sessionId: string): boolean {
    const claims = this.claimsBySession.get(sessionId);
    return Boolean(claims && [...claims.values()].some((claim) => claim.forkInFlight));
  }

  private async deleteOnce(sessionId: string, deleteSession: () => Promise<void>): Promise<void> {
    if (this.deletedSessions.has(sessionId)) return;
    const existing = this.cleanupInFlight.get(sessionId);
    if (existing) return existing;

    const cleanup = deleteSession();
    this.cleanupInFlight.set(sessionId, cleanup);
    try {
      await cleanup;
      this.deletedSessions.add(sessionId);
      this.claimsBySession.delete(sessionId);
      for (const [ownerId, sessions] of this.sessionsByOwner) {
        sessions.delete(sessionId);
        if (sessions.size === 0) this.sessionsByOwner.delete(ownerId);
      }
    } finally {
      this.cleanupInFlight.delete(sessionId);
    }
  }
}
