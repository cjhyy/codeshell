/**
 * DigestBuilder — constructs RoundResearchDigest from the shared ledger.
 *
 * The digest is a filtered view injected into prompts to avoid
 * token explosion from the full ledger. Program-built, not model-built.
 */

import type { ArenaLedger } from "./ledger.js";
import type {
  RoundResearchDigest,
  EvidencePacket,
  ClaimChallenge,
  RequestedCheck,
  ClaimAdjudication,
} from "./types.js";

interface DigestOptions {
  /** Current round number */
  round: number;
  /** Claim IDs relevant to this round (e.g. contested claims in debate) */
  relevantClaimIds: string[];
}

/**
 * Build a digest from the shared ledger for a specific round.
 * Only includes data relevant to the specified claims.
 */
export function buildDigest(ledger: ArenaLedger, options: DigestOptions): RoundResearchDigest {
  const { round, relevantClaimIds } = options;
  const claimIdSet = new Set(relevantClaimIds);
  const snapshot = ledger.getSnapshot();

  // Collect evidence packets referenced by relevant claims
  const packetIds = new Set<string>();
  for (const claimId of relevantClaimIds) {
    const claim = ledger.getClaimById(claimId);
    if (claim) {
      for (const pid of claim.evidencePacketIds) {
        packetIds.add(pid);
      }
    }
  }

  const evidencePackets: EvidencePacket[] = [];
  for (const pid of packetIds) {
    const packet = ledger.getPacketById(pid);
    if (packet) evidencePackets.push(packet);
  }

  // Tool trace summary — built directly from dossiers to preserve participant ownership
  const toolTraceSummary: RoundResearchDigest["toolTraceSummary"] = [];
  for (const dossier of snapshot.dossiers) {
    for (const trace of dossier.toolTrace) {
      if (trace.keptAsEvidence) {
        toolTraceSummary.push({
          participant: dossier.participant,
          toolName: trace.toolName,
          ref: trace.resultRef,
        });
      }
    }
  }

  // Recent challenges for relevant claims
  const recentChallenges: ClaimChallenge[] = snapshot.challenges
    .filter((c) => claimIdSet.has(c.claimId));

  // Pending requested checks for relevant claims
  const requestedChecks: RequestedCheck[] = snapshot.requestedChecks
    .filter((c) => claimIdSet.has(c.claimId));

  // Prior adjudications for relevant claims
  const priorAdjudications: ClaimAdjudication[] = snapshot.adjudications
    .filter((a) => claimIdSet.has(a.claimId));

  return {
    round,
    relevantClaimIds,
    evidencePackets,
    toolTraceSummary,
    recentChallenges,
    requestedChecks,
    priorAdjudications,
  };
}

/**
 * Sanitize text from LLM output before re-injecting into a prompt.
 * Strips patterns that could be interpreted as prompt-level instructions.
 */
function sanitize(text: string): string {
  if (!text) return "";
  return text
    // Strip fake system/assistant role tags
    .replace(/<\/?(?:system|assistant|user|system-reminder)[^>]*>/gi, "")
    // Strip instruction-like prefixes (case-insensitive)
    .replace(/^(?:IGNORE|DISREGARD|FORGET|OVERRIDE|SYSTEM|INSTRUCTION)[:\s].*/gim, "")
    // Collapse excessive whitespace
    .replace(/\n{3,}/g, "\n\n")
    // Limit length per field
    .slice(0, 2000);
}

/**
 * Format a digest into a text block suitable for prompt injection.
 * All LLM-originated text is sanitized before inclusion.
 */
export function formatDigest(digest: RoundResearchDigest): string {
  const sections: string[] = [];

  sections.push(`## Round ${digest.round} Research Digest`);
  sections.push(`Claims under consideration: ${digest.relevantClaimIds.join(", ")}`);

  if (digest.evidencePackets.length > 0) {
    sections.push("\n### Evidence");
    for (const packet of digest.evidencePackets) {
      sections.push(`- [${packet.packetId}] ${sanitize(packet.title)} (${packet.source})`);
      sections.push(`  ${sanitize(packet.summary)}`);
      for (const excerpt of packet.excerpts.slice(0, 3)) {
        sections.push(`  > ${excerpt.ref}: ${sanitize(excerpt.snippet)}`);
        if (excerpt.note) sections.push(`    Note: ${sanitize(excerpt.note)}`);
      }
    }
  }

  if (digest.recentChallenges.length > 0) {
    sections.push("\n### Challenges");
    for (const c of digest.recentChallenges) {
      sections.push(`- [${c.reviewer}] on ${c.claimId}: ${c.verdict} — ${sanitize(c.reason)}`);
    }
  }

  if (digest.requestedChecks.length > 0) {
    sections.push("\n### Requested Checks");
    for (const check of digest.requestedChecks) {
      const pri = check.priority ? ` (${check.priority})` : "";
      sections.push(`- [${check.requestId}]${pri}: ${sanitize(check.description)}`);
    }
  }

  if (digest.priorAdjudications.length > 0) {
    sections.push("\n### Prior Adjudications");
    for (const adj of digest.priorAdjudications) {
      sections.push(`- ${adj.claimId}: ${adj.outcome} — ${sanitize(adj.rationale)}`);
    }
  }

  return sections.join("\n");
}
