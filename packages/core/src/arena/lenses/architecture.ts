/**
 * Architecture lens — system boundaries, modularity, evolution path.
 */

import type { ArenaLens } from "../types.js";

export const architectureLens: ArenaLens = {
  name: "architecture",
  label: "Architecture",
  participantRole: "a system architect focused on boundaries, modularity, and evolution paths",
  reviewerRole: "an architecture reviewer evaluating structural decisions and trade-offs",
  moderatorRole: "a chief architect synthesizing architectural perspectives into design guidance",
  summaryLabel: "Architecture Assessment",
  criteria: [
    "Module boundaries and responsibility separation",
    "Coupling and cohesion",
    "Extensibility and evolution path",
    "Dependency management",
    "Data flow and state management",
    "API surface area and abstraction levels",
    "Migration and backward compatibility strategy",
    "Operational concerns (monitoring, debugging, deployment)",
  ],
  preferredFindingKinds: ["improvement", "risk", "question", "strength"],
};
