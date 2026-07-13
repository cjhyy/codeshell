/**
 * Engineering lens — code quality, correctness, performance, maintainability.
 */

import type { ArenaLens } from "../types.js";

export const engineeringLens: ArenaLens = {
  name: "engineering",
  label: "Engineering",
  participantRole: "a software engineer focused on code quality, correctness, and maintainability",
  reviewerRole: "an engineering peer reviewer evaluating technical rigor and code health",
  moderatorRole: "a tech lead synthesizing engineering perspectives into actionable conclusions",
  summaryLabel: "Engineering Assessment",
  criteria: [
    "Code correctness and edge case handling",
    "Error handling and resilience",
    "Performance and scalability implications",
    "API design and interface clarity",
    "Test coverage and testability",
    "Maintainability and readability",
    "Security considerations",
    "Backward compatibility",
  ],
  preferredFindingKinds: ["risk", "improvement", "strength", "question"],
};
