/**
 * ClaimRegistry — converts ResearchDossier findings into ClaimRecords.
 *
 * Each finding is elevated to a claim with:
 * - Stable global ID (owner + finding.id)
 * - Evidence packet references from findingEvidenceLinks
 * - Initial status: "proposed"
 */

import type {
  ResearchDossier,
  ClaimRecord,
  ArenaProgressEvent,
} from "../types.js";
import type { ArenaLedger } from "../ledger.js";

interface ClaimRegistryOptions {
  dossiers: ResearchDossier[];
  ledger: ArenaLedger;
  onProgress?: (event: ArenaProgressEvent) => void;
}

/**
 * Register all findings from research dossiers as claims.
 * Returns the newly created ClaimRecord array.
 */
export function registerClaims(options: ClaimRegistryOptions): ClaimRecord[] {
  const { dossiers, ledger, onProgress } = options;
  const claims: ClaimRecord[] = [];

  for (const dossier of dossiers) {
    // Build a lookup from findingId → evidencePacketIds
    const linkMap = new Map<string, string[]>();
    for (const link of dossier.findingEvidenceLinks) {
      linkMap.set(link.findingId, link.evidencePacketIds);
    }

    for (const finding of dossier.findings) {
      const claimId = `${dossier.participant}:${finding.id}`;
      const packetIds = linkMap.get(finding.id) ?? [];

      // Build evidence refs from finding.evidence + packet refs
      const evidenceRefs = finding.evidence.map((e) => `${e.type}:${e.ref}`);

      const claim: ClaimRecord = {
        claimId,
        owner: dossier.participant,
        finding,
        evidenceRefs,
        evidencePacketIds: packetIds,
        status: "proposed",
        challenges: [],
        debateRounds: [],
      };

      claims.push(claim);
      ledger.appendClaim(claim);
    }
  }

  onProgress?.({ type: "claims_registered", claimCount: claims.length });

  return claims;
}

/**
 * Select claims for review, prioritized by severity and confidence.
 * Respects the maxClaimsForReview limit.
 */
export function selectClaimsForReview(
  claims: ClaimRecord[],
  maxClaims: number,
): ClaimRecord[] {
  const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };

  const sorted = [...claims].sort((a, b) => {
    // Higher severity first
    const sevA = severityOrder[a.finding.severity ?? "medium"] ?? 1;
    const sevB = severityOrder[b.finding.severity ?? "medium"] ?? 1;
    if (sevA !== sevB) return sevA - sevB;

    // Higher confidence first
    return b.finding.confidence - a.finding.confidence;
  });

  return sorted.slice(0, maxClaims);
}
