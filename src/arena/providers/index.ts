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

// Hard ceiling for any single provider. The repo provider can fan
// out 5+ recursive greps; without this, one slow grep on a large
// tree would freeze the entire arena startup. Tuned to be generous
// for normal cases but tight enough that the user doesn't sit
// staring at "Arena {}" for a minute.
const PROVIDER_TIMEOUT_MS = 8_000;

export interface CollectEvidenceOptions {
  /** Heartbeat callback fired before/after each provider runs. */
  onProgress?: (event: { type: "evidence_started" | "evidence_collected"; source: ArenaSourceKind; count?: number; durationMs?: number; timedOut?: boolean }) => void;
  signal?: AbortSignal;
}

/**
 * Collect all evidence according to the plan's sources.
 * Returns unified ArenaArtifact[] and quickFacts.
 *
 * Providers run in parallel (independent of one another) with a
 * per-provider timeout, so a single slow source can't stall the
 * whole arena. Heartbeats are emitted around each provider so the
 * UI can show "collecting from repo..." instead of a blank pause.
 */
export async function collectEvidence(
  plan: ArenaPlan,
  topic: string,
  options: CollectEvidenceOptions = {},
): Promise<{ artifacts: ArenaArtifact[]; quickFacts: ArenaQuickFact[] }> {
  const artifacts: ArenaArtifact[] = [];
  const quickFacts: ArenaQuickFact[] = [];
  const seenSources = new Set<ArenaSourceKind>();
  const { onProgress, signal } = options;

  const tasks: Array<Promise<{ kind: ArenaSourceKind; artifacts: ArenaArtifact[]; durationMs: number; timedOut: boolean }>> = [];

  for (const sourceSpec of plan.sources) {
    if (seenSources.has(sourceSpec.kind)) continue;
    seenSources.add(sourceSpec.kind);

    const provider = PROVIDER_MAP[sourceSpec.kind];
    if (!provider) continue;

    onProgress?.({ type: "evidence_started", source: sourceSpec.kind });
    tasks.push(runProviderWithTimeout(provider, plan, topic, signal));
  }

  const results = await Promise.all(tasks);

  for (const r of results) {
    artifacts.push(...r.artifacts);
    logger.info("arena.evidence_collected", {
      source: r.kind,
      count: r.artifacts.length,
      durationMs: r.durationMs,
      timedOut: r.timedOut || undefined,
    });
    onProgress?.({
      type: "evidence_collected",
      source: r.kind,
      count: r.artifacts.length,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
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

async function runProviderWithTimeout(
  provider: ArenaContextProvider,
  plan: ArenaPlan,
  topic: string,
  signal?: AbortSignal,
): Promise<{ kind: ArenaSourceKind; artifacts: ArenaArtifact[]; durationMs: number; timedOut: boolean }> {
  const started = Date.now();
  let timedOut = false;
  // Hold the timer outside the timeout Promise so the work-winner
  // branch can clear it. Previously the timer kept ticking after
  // work resolved and fired a spurious "timeout" warn 8s later.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (abortHandler) {
      signal?.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }
  };

  const work = Promise.resolve().then(() => provider.collect(plan, topic));
  const timeout = new Promise<ArenaArtifact[]>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      logger.warn("arena.provider.timeout", { source: provider.kind, ms: PROVIDER_TIMEOUT_MS });
      resolve([]);
    }, PROVIDER_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    if (signal) {
      abortHandler = () => resolve([]);
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });

  let artifacts: ArenaArtifact[];
  try {
    artifacts = await Promise.race([work, timeout]);
  } catch (err) {
    logger.warn("arena.provider.error", { source: provider.kind, error: (err as Error).message });
    artifacts = [];
  } finally {
    cleanup();
  }

  return {
    kind: provider.kind,
    artifacts,
    durationMs: Date.now() - started,
    timedOut,
  };
}
