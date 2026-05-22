/**
 * Product lens — user value, completeness, edge cases, acceptance criteria.
 */

import type { ArenaLens } from "../types.js";

export const productLens: ArenaLens = {
  name: "product",
  label: "Product",
  participantRole: "a product analyst focused on user value, completeness, and edge cases",
  reviewerRole: "a product reviewer evaluating requirements coverage and user impact",
  moderatorRole: "a product lead synthesizing product perspectives into prioritized insights",
  summaryLabel: "Product Assessment",
  criteria: [
    "Requirements completeness and coverage",
    "User experience and usability",
    "Edge cases and boundary conditions",
    "Acceptance criteria clarity",
    "Feature scope — too broad or too narrow",
    "User journey coherence",
    "Metric and success criteria definition",
    "Stakeholder alignment",
  ],
  preferredFindingKinds: ["question", "improvement", "risk", "strength"],
};
