import { describe, test, expect } from "bun:test";
import { parseChallenges, parseReviews } from "./utils.js";
import { applyReviewResult } from "../transitions.js";
import type { ClaimRecord } from "../types.js";

// Regression (ARENA-R3-01): a peer review whose verdict was missing or not one
// of the four allowed values used to be parsed as "agree", which then verified
// the claim. An unreadable verdict is not an endorsement.

function mkClaim(): ClaimRecord {
  return {
    claimId: "author:f1",
    owner: "author",
    finding: { id: "f1", summary: "s" } as ClaimRecord["finding"],
    evidenceRefs: [],
    evidencePacketIds: [],
    status: "under_review",
    challenges: [],
    debateRounds: [],
  };
}

describe("peer verdict parsing", () => {
  test.each([
    ["missing", { claimId: "author:f1", reason: "Not finished checking" }],
    ["invalid", { claimId: "author:f1", verdict: "uncertain", reason: "Unable to verify" }],
  ])("%s challenge verdict does not verify the claim", (_label, raw) => {
    const parsed = parseChallenges("reviewer", JSON.stringify([raw]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.verdict).not.toBe("agree");

    const claim = mkClaim();
    applyReviewResult(claim, parsed, false);
    expect(claim.status).not.toBe("verified");
  });

  test("explicit agree still verifies the claim", () => {
    const parsed = parseChallenges(
      "reviewer",
      JSON.stringify([{ claimId: "author:f1", verdict: "agree", reason: "ok" }]),
    );
    const claim = mkClaim();
    applyReviewResult(claim, parsed, false);
    expect(claim.status).toBe("verified");
  });

  test("V1 finding review with a missing verdict is not parsed as agree", () => {
    const [review] = parseReviews("reviewer", JSON.stringify([{ findingId: "f1", reason: "?" }]));
    expect(review!.verdict).not.toBe("agree");
  });
});
