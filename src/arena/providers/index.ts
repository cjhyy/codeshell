/**
 * Provider registry — evidence collectors for Arena.
 */

import type { ArenaPlan, ArenaArtifact, ArenaContextProvider, ArenaSourceKind, ArenaQuickFact } from "../types.js";
import { gitProvider } from "./git.js";
import { repoProvider } from "./repo.js";
import { docsProvider } from "./docs.js";
import { noneProvider } from "./none.js";
import { logger } from "../../logging/logger.js";

export { gitProvider } from "./git.js";
export { repoProvider } from "./repo.js";
export { docsProvider } from "./docs.js";
export { noneProvider } from "./none.js";

const PROVIDER_MAP: Record<ArenaSourceKind, ArenaContextProvider> = {
  git: gitProvider,
  repo: repoProvider,
  docs: docsProvider,
  web: noneProvider, // web deferred to Phase 4 — falls back to none for now
  none: noneProvider,
};

/**
 * Collect all evidence according to the plan's sources.
 * Returns unified ArenaArtifact[] and quickFacts.
 */
export function collectEvidence(plan: ArenaPlan, topic: string): {
  artifacts: ArenaArtifact[];
  quickFacts: ArenaQuickFact[];
} {
  const artifacts: ArenaArtifact[] = [];
  const quickFacts: ArenaQuickFact[] = [];
  const seenSources = new Set<ArenaSourceKind>();

  for (const sourceSpec of plan.sources) {
    if (seenSources.has(sourceSpec.kind)) continue;
    seenSources.add(sourceSpec.kind);

    const provider = PROVIDER_MAP[sourceSpec.kind];
    if (!provider) continue;

    const collected = provider.collect(plan, topic);
    artifacts.push(...collected);

    logger.info("arena.evidence_collected", {
      source: sourceSpec.kind,
      count: collected.length,
    });
  }

  // Build quick facts from artifacts
  const branchArtifact = artifacts.find((a) => a.id === "git-branch");
  if (branchArtifact) quickFacts.push({ label: "Branch", value: branchArtifact.preview });

  const changedFilesArtifact = artifacts.find((a) => a.id === "git-changed-files");
  if (changedFilesArtifact?.metadata?.totalCount) {
    quickFacts.push({ label: "Changed Files", value: String(changedFilesArtifact.metadata.totalCount) });
  }

  const docCount = artifacts.filter((a) => a.source === "docs").length;
  if (docCount > 0) quickFacts.push({ label: "Documents", value: String(docCount) });

  quickFacts.push({ label: "Sources", value: [...seenSources].join(", ") });
  quickFacts.push({ label: "Lenses", value: plan.lenses.map((l) => l.name).join(", ") });

  return { artifacts, quickFacts };
}
