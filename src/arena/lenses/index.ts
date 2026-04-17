/**
 * Lens registry — analysis perspectives for Arena sessions.
 */

import type { ArenaLens, ArenaLensName, ArenaLensRef } from "../types.js";
import { engineeringLens } from "./engineering.js";
import { productLens } from "./product.js";
import { architectureLens } from "./architecture.js";
import { generalLens } from "./general.js";

export { engineeringLens } from "./engineering.js";
export { productLens } from "./product.js";
export { architectureLens } from "./architecture.js";
export { generalLens } from "./general.js";

const LENS_MAP: Record<ArenaLensName, ArenaLens> = {
  engineering: engineeringLens,
  product: productLens,
  architecture: architectureLens,
  general: generalLens,
};

/** Get a lens by name. */
export function getLens(name: ArenaLensName): ArenaLens {
  return LENS_MAP[name];
}

/** Resolve lens refs into full ArenaLens objects. */
export function resolveLenses(refs: ArenaLensRef[]): ArenaLens[] {
  return refs.map((ref) => LENS_MAP[ref.name]);
}

/** Build a combined lens prompt fragment for participant system prompts. */
export function buildLensPrompt(lenses: ArenaLens[], phase: "participant" | "reviewer" | "moderator"): string {
  if (lenses.length === 0) return "";

  const roleKey = phase === "participant" ? "participantRole"
    : phase === "reviewer" ? "reviewerRole"
    : "moderatorRole";

  const roles = lenses.map((l) => l[roleKey]);
  const allCriteria = lenses.flatMap((l) => l.criteria);
  const uniqueCriteria = [...new Set(allCriteria)];

  const roleDesc = lenses.length === 1
    ? `You are ${roles[0]}.`
    : `You combine multiple perspectives: ${roles.join("; ")}.`;

  return [
    roleDesc,
    "",
    "Evaluation criteria (prioritized):",
    ...uniqueCriteria.map((c) => `- ${c}`),
  ].join("\n");
}

/** All available lens names */
export const LENS_NAMES: ArenaLensName[] = ["engineering", "product", "architecture", "general"];
