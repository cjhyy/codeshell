/**
 * General lens — broad analysis without a specific domain focus.
 */

import type { ArenaLens } from "../types.js";

export const generalLens: ArenaLens = {
  name: "general",
  label: "General",
  participantRole: "an analyst providing a broad, balanced perspective",
  reviewerRole: "a peer reviewer evaluating clarity, logic, and completeness",
  moderatorRole: "a neutral moderator synthesizing diverse perspectives into balanced conclusions",
  summaryLabel: "General Assessment",
  criteria: [
    "Logical coherence and consistency",
    "Completeness of analysis",
    "Trade-off identification",
    "Assumption clarity",
    "Evidence quality",
    "Actionability of recommendations",
  ],
  preferredFindingKinds: ["strength", "risk", "question", "improvement"],
};
