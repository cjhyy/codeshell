import { describe, test, expect } from "bun:test";
import { runAdjudication } from "./adjudication.js";
import { ArenaLedger } from "../ledger.js";
import type { ArenaParticipant, ArenaStrategy, ClaimRecord, ClaimStatus } from "../types.js";

function mkClaim(claimId: string, status: ClaimStatus): ClaimRecord {
  return {
    claimId,
    owner: "author",
    finding: { id: claimId, summary: "s" } as ClaimRecord["finding"],
    evidenceRefs: [],
    evidencePacketIds: [],
    status,
    challenges: [],
    debateRounds: [],
  };
}

describe("runAdjudication", () => {
  // Regression (ARENA-R3-02): with no contested or verified claims the phase
  // returned early and skipped the sweep that closes leftover proposed /
  // under_review claims as unresolved, so they vanished from the consensus
  // claim-status summary.
  test("sweeps leftover claims to unresolved even when nothing needs a ruling", async () => {
    const ledger = new ArenaLedger();
    const proposed = mkClaim("author:proposed", "proposed");
    const underReview = mkClaim("author:under-review", "under_review");
    ledger.appendClaim(proposed);
    ledger.appendClaim(underReview);

    const adjudications = await runAdjudication({
      // No model call is needed on this path; an unknown provider proves it.
      concluder: { name: "unused", llm: { provider: "none", model: "none" } } as ArenaParticipant,
      strategy: {} as ArenaStrategy,
      topic: "t",
      ledger,
    });

    expect(adjudications).toEqual([]);
    expect(proposed.status).toBe("unresolved");
    expect(underReview.status).toBe("unresolved");
  });
});
