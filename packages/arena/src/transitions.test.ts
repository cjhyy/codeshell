import { describe, test, expect } from "bun:test";
import { transitionClaim, markUnresolved, markUnderReview } from "./transitions.js";
import type { ClaimRecord, ClaimStatus } from "./types.js";

function mkClaim(status: ClaimStatus): ClaimRecord {
  return {
    claimId: "c1",
    owner: "o",
    finding: { summary: "s" } as ClaimRecord["finding"],
    evidenceRefs: [],
    evidencePacketIds: [],
    status,
    challenges: [],
    debateRounds: [],
  };
}

describe("claim transitions — unresolved sweep", () => {
  // Regression: adjudication sweeps leftover proposed/under_review claims to
  // unresolved when the round/budget is exhausted. Previously the transition
  // table only allowed unresolved from contested, so markUnresolved() no-oped
  // and the claims stayed (and were dropped from the consensus summary).
  test("markUnresolved succeeds from under_review", () => {
    const c = mkClaim("under_review");
    expect(markUnresolved(c)).toBe(true);
    expect(c.status).toBe("unresolved");
  });

  test("markUnresolved succeeds from proposed", () => {
    const c = mkClaim("proposed");
    expect(markUnresolved(c)).toBe(true);
    expect(c.status).toBe("unresolved");
  });

  test("markUnresolved still succeeds from contested", () => {
    const c = mkClaim("contested");
    expect(markUnresolved(c)).toBe(true);
    expect(c.status).toBe("unresolved");
  });

  test("terminal states cannot transition to unresolved", () => {
    for (const terminal of ["verified", "rejected", "unresolved"] as const) {
      const c = mkClaim(terminal);
      expect(markUnresolved(c)).toBe(false);
      expect(c.status).toBe(terminal);
    }
  });

  test("the normal happy path is unaffected", () => {
    const c = mkClaim("proposed");
    expect(markUnderReview(c)).toBe(true);
    expect(c.status).toBe("under_review");
    expect(transitionClaim(c, "verified")).toBe(true);
    expect(c.status).toBe("verified");
  });
});
