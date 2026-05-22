/**
 * SharedResearchLedger — append-only shared state across all arena rounds.
 *
 * Design constraints (from architecture doc):
 * - All objects have stable IDs
 * - Append-only: history preserved, never overwritten
 * - Query layer supports latest-view aggregation
 * - Supports by-id, by-claim, by-participant, by-round filtering
 */

import type {
  SharedResearchLedger,
  ResearchDossier,
  EvidencePacket,
  ToolTrace,
  ClaimRecord,
  ClaimChallenge,
  RequestedCheck,
  ClaimAdjudication,
} from "./types.js";
import { logger } from "../logging/logger.js";

/** Thresholds for memory warnings */
const WARN_CLAIMS = 50;
const WARN_PACKETS = 200;
const WARN_CHALLENGES = 100;

/** Index for fast lookups into the append-only ledger */
interface LedgerIndex {
  claimsById: Map<string, ClaimRecord>;
  packetsById: Map<string, EvidencePacket>;
  requestsById: Map<string, RequestedCheck>;
}

/**
 * Manages the shared research ledger — the single source of truth
 * for all evidence, claims, challenges, and adjudications in an arena session.
 */
export class ArenaLedger {
  private ledger: SharedResearchLedger;
  private index: LedgerIndex;

  constructor() {
    this.ledger = {
      dossiers: [],
      evidencePackets: [],
      toolTraces: [],
      claims: [],
      challenges: [],
      requestedChecks: [],
      adjudications: [],
    };
    this.index = {
      claimsById: new Map(),
      packetsById: new Map(),
      requestsById: new Map(),
    };
  }

  // ─── Append operations ──────────────────────────────────────

  /** Check if ledger is approaching memory limits and log warnings */
  private checkGrowth(): void {
    const claims = this.ledger.claims.length;
    const packets = this.ledger.evidencePackets.length;
    const challenges = this.ledger.challenges.length;

    if (claims === WARN_CLAIMS || packets === WARN_PACKETS || challenges === WARN_CHALLENGES) {
      logger.warn("arena.ledger_growth", { claims, packets, challenges, toolTraces: this.ledger.toolTraces.length });
    }
  }

  appendDossier(dossier: ResearchDossier): void {
    this.ledger.dossiers.push(dossier);

    for (const packet of dossier.evidencePackets) {
      this.appendEvidencePacket(packet);
    }
    for (const trace of dossier.toolTrace) {
      this.ledger.toolTraces.push(trace);
    }
  }

  appendEvidencePacket(packet: EvidencePacket): void {
    // Deduplicate by packetId — reuse existing if same ID
    if (!this.index.packetsById.has(packet.packetId)) {
      this.ledger.evidencePackets.push(packet);
      this.index.packetsById.set(packet.packetId, packet);
    }
  }

  appendClaim(claim: ClaimRecord): void {
    this.ledger.claims.push(claim);
    this.index.claimsById.set(claim.claimId, claim);
    this.checkGrowth();
  }

  appendChallenge(challenge: ClaimChallenge): void {
    this.ledger.challenges.push(challenge);

    // Also add to the claim's challenges array
    const claim = this.index.claimsById.get(challenge.claimId);
    if (claim) {
      claim.challenges.push(challenge);
    }

    this.checkGrowth();

    // Register any requested checks
    if (challenge.requestedChecks) {
      for (const check of challenge.requestedChecks) {
        this.appendRequestedCheck(check);
      }
    }
  }

  appendRequestedCheck(check: RequestedCheck): void {
    if (!this.index.requestsById.has(check.requestId)) {
      this.ledger.requestedChecks.push(check);
      this.index.requestsById.set(check.requestId, check);
    }
  }

  appendAdjudication(adjudication: ClaimAdjudication): void {
    this.ledger.adjudications.push(adjudication);

    // Also attach to the claim
    const claim = this.index.claimsById.get(adjudication.claimId);
    if (claim) {
      claim.adjudication = adjudication;
    }
  }

  // ─── Query operations ───────────────────────────────────────

  /**
   * Return a read-only reference to the full ledger.
   *
   * Note: `Readonly<>` is shallow — inner arrays are still mutable at the
   * type level. Callers MUST NOT mutate the returned object; use the
   * append* methods instead. A deep-freeze or structural clone can be
   * added later if external consumers need a truly immutable snapshot.
   */
  getSnapshot(): Readonly<SharedResearchLedger> {
    return this.ledger;
  }

  getClaimById(claimId: string): ClaimRecord | undefined {
    return this.index.claimsById.get(claimId);
  }

  getPacketById(packetId: string): EvidencePacket | undefined {
    return this.index.packetsById.get(packetId);
  }

  getAllClaims(): ClaimRecord[] {
    return this.ledger.claims;
  }

  getClaimsByStatus(...statuses: ClaimRecord["status"][]): ClaimRecord[] {
    const set = new Set(statuses);
    return this.ledger.claims.filter((c) => set.has(c.status));
  }

  getClaimsByOwner(owner: string): ClaimRecord[] {
    return this.ledger.claims.filter((c) => c.owner === owner);
  }

  getChallengesForClaim(claimId: string): ClaimChallenge[] {
    return this.ledger.challenges.filter((c) => c.claimId === claimId);
  }

  getPendingChecks(): RequestedCheck[] {
    return this.ledger.requestedChecks;
  }

  getPendingChecksForClaim(claimId: string): RequestedCheck[] {
    return this.ledger.requestedChecks.filter((c) => c.claimId === claimId);
  }

  getPacketsForClaim(claimId: string): EvidencePacket[] {
    const claim = this.index.claimsById.get(claimId);
    if (!claim) return [];
    return claim.evidencePacketIds
      .map((id) => this.index.packetsById.get(id))
      .filter((p): p is EvidencePacket => p !== undefined);
  }

  getDossiers(): ResearchDossier[] {
    return this.ledger.dossiers;
  }

  getDossierByParticipant(participant: string): ResearchDossier | undefined {
    // Return the latest dossier for this participant (supports multi-round)
    const dossiers = this.ledger.dossiers.filter((d) => d.participant === participant);
    return dossiers[dossiers.length - 1];
  }
}
