import { expect, test } from "bun:test";
import { LLMClientBase, registerProvider, type CreateMessageOptions, type LLMResponse } from "@cjhyy/code-shell-core/extension";
import { runVerificationReview } from "../../../packages/arena/src/phases/cross-review.js";
import { ArenaLedger } from "../../../packages/arena/src/ledger.js";
import { parseChallenges } from "../../../packages/arena/src/strategies/utils.js";
import { DEFAULT_EXECUTION_LIMITS, type ArenaParticipant, type ArenaStrategyV2, type ClaimRecord, type ParticipantReport } from "../../../packages/arena/src/types.js";

// This provider returns an in-memory object. It has no SDK, transport or process.
globalThis.fetch = (() => { throw new Error("audit fixture forbids network"); }) as typeof fetch;
let fakeCalls = 0;
class OfflineReviewClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(_options: CreateMessageOptions): Promise<LLMResponse> {
    fakeCalls++;
    return {
      text: JSON.stringify([{ claimId: "owner:f1", verdict: "agree", reason: "Offline fixture review" }]),
      toolCalls: [], stopReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
const provider = "audit-arena-reviewer-cap";
registerProvider(provider, OfflineReviewClient);

test("Arena default maxReviewersPerClaim two still sends one claim to all three nonowners", async () => {
  const participants = ["owner", "r1", "r2", "r3"].map((name) => ({ name, llm: { provider, model: "offline", apiKey: "fixture" } })) as ArenaParticipant[];
  const reports = participants.map(({ name }) => ({ participant: name, contextSummary: "Offline report", findings: [] })) as ParticipantReport[];
  const target: ClaimRecord = {
    claimId: "owner:f1", owner: "owner", status: "proposed",
    finding: { id: "f1", kind: "improvement", title: "One claim", summary: "Offline finding", confidence: 0.5, evidence: [], affectedFiles: [] },
    evidenceRefs: [], evidencePacketIds: [], challenges: [], debateRounds: [],
  };
  const ledger = new ArenaLedger();
  ledger.appendClaim(target);
  const strategy = {
    crossReviewSystemPrompt: () => "Offline fixture",
    verificationReviewUserPrompt: () => "Review owner:f1",
    parseVerificationReviewResponse: parseChallenges,
  } as unknown as ArenaStrategyV2;
  const result = await runVerificationReview({ participants, reports, strategy, topic: "offline", ledger, limits: { ...DEFAULT_EXECUTION_LIMITS } });
  const reviewerCount = new Set(result.challenges.map((item) => item.reviewer)).size;
  expect(DEFAULT_EXECUTION_LIMITS.maxReviewersPerClaim).toBe(2);
  expect(fakeCalls).toBe(3);
  expect(reviewerCount).toBe(3);
  expect(reviewerCount > DEFAULT_EXECUTION_LIMITS.maxReviewersPerClaim).toBe(true);
  console.log("AUDIT_OBSERVATIONS " + JSON.stringify({ id: "ARENA-R3-03", participants: participants.map((item) => item.name), maxReviewersPerClaim: DEFAULT_EXECUTION_LIMITS.maxReviewersPerClaim, fakeLLMCalls: fakeCalls, reviewers: result.challenges.map((item) => item.reviewer) }));
});
