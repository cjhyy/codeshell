/**
 * IterativeArena — multi-model authoring loop.
 *
 * Pipeline:
 *   1. v1: tournament (default) or single-author
 *   2. for each round 2..maxRounds:
 *        a. argue (parallel critics)
 *        b. checkpoint (optional human pause)
 *        c. convergence check
 *        d. if not converged: revise → next round
 *   3. final draft = last round's draft
 */

import { logger } from "../../logging/logger.js";
import type { ArenaParticipant } from "../types.js";
import { defaultConvergence, diffRatio } from "./convergence.js";
import { getFormat } from "./formats/index.js";
import { runArgueRound } from "./phases/argue.js";
import { runRevise } from "./phases/revise.js";
import { mergeCandidatesToV1, runTournamentCandidates, singleAuthorV1 } from "./phases/tournament.js";
import type { ConvergenceSignal, Critique, Draft, IterateConfig, IterateResult, Round, StoppedReason } from "./types.js";

const DEFAULT_MAX_ROUNDS = 5;

export class IterativeArena {
  private readonly config: IterateConfig;

  constructor(config: IterateConfig) {
    if (!config.author) {
      throw new Error("IterativeArena requires an `author` participant");
    }
    if (!config.critics || config.critics.length === 0) {
      throw new Error("IterativeArena requires at least 1 critic");
    }
    const allNames = [config.author.name, ...config.critics.map((c) => c.name)];
    if (new Set(allNames).size !== allNames.length) {
      throw new Error("Author and critics must have unique names");
    }
    this.config = config;
  }

  async run(): Promise<IterateResult> {
    const start = Date.now();
    const { config } = this;
    const format = getFormat(config.format);
    const maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const minDraftLength = config.minDraftLength ?? (config.format === "code" ? 200 : 800);
    const signal = config.signal;

    const rounds: Round[] = [];

    // ─── Phase: v1 ────────────────────────────────────────────
    let currentDraft: Draft;
    try {
      if ((config.v1Strategy ?? "tournament") === "tournament") {
        const candidates = await runTournamentCandidates({
          subject: config.subject,
          format,
          participants: [config.author, ...config.critics],
          minDraftLength,
          signal,
          onProgress: config.onProgress,
        });
        currentDraft = await mergeCandidatesToV1({
          subject: config.subject,
          format,
          author: config.author,
          candidates,
          minDraftLength,
          signal,
          onProgress: config.onProgress,
        });
      } else {
        currentDraft = await singleAuthorV1({
          subject: config.subject,
          format,
          author: config.author,
          minDraftLength,
          signal,
        });
      }
    } catch (err) {
      logger.error("arena.iterate.v1_failed", { error: (err as Error).message });
      throw err;
    }

    // Author rotation state. We pick the next author from the pool of
    // {author, critics} according to the rotation policy.
    let currentAuthor: ArenaParticipant = config.author;
    const pool: ArenaParticipant[] = [config.author, ...config.critics];

    // ─── Phase: argue/revise loop ────────────────────────────
    let previousDraft: Draft | undefined;
    for (let r = 1; r <= maxRounds; r++) {
      signal?.throwIfAborted();

      // Argue against the current draft.
      const critiques = await runArgueRound({
        subject: config.subject,
        format,
        draft: currentDraft,
        critics: this.criticsForRound(r),
        round: r,
        enableWebSearch: config.enableWebSearch,
        maxToolRounds: config.maxArgueToolRounds,
        signal,
        onProgress: config.onProgress,
      });

      // Convergence check.
      const convergence = this.checkConvergence({
        round: r,
        critiques,
        draft: currentDraft,
        previousDraft,
      });

      const round: Round = {
        round: r,
        draft: currentDraft,
        critiques,
        convergence,
      };

      // Optional human checkpoint.
      let userAction: "continue" | "stop" | "force-continue" | undefined;
      if (config.humanCheckpoint) {
        config.onProgress?.({ type: "checkpoint_pause", round: r });
        userAction = await config.humanCheckpoint({
          round: r,
          draft: currentDraft,
          critiques,
          convergence,
        });
      }

      rounds.push(round);
      config.onProgress?.({
        type: "round_done",
        round: r,
        data: {
          critiques: critiques.length,
          shouldStop: convergence.shouldStop,
          userAction,
        },
      });

      if (userAction === "stop") {
        return this.finalize(rounds, "user_stop", start);
      }
      if (userAction !== "force-continue" && convergence.shouldStop) {
        return this.finalize(rounds, "converged", start);
      }
      if (r === maxRounds) {
        return this.finalize(rounds, "max_rounds", start);
      }

      // Revise → v(r+1)
      previousDraft = currentDraft;
      currentAuthor = this.pickNextAuthor(currentAuthor, critiques, pool, r);
      currentDraft = await runRevise({
        subject: config.subject,
        format,
        previous: previousDraft,
        critiques,
        author: currentAuthor,
        minDraftLength,
        signal,
        onProgress: config.onProgress,
      });
    }

    return this.finalize(rounds, "max_rounds", start);
  }

  /** Critics for a given round = pool minus current author (so author isn't critiquing self). */
  private criticsForRound(_round: number): ArenaParticipant[] {
    return this.config.critics;
  }

  private checkConvergence(args: {
    round: number;
    critiques: Critique[];
    draft: Draft;
    previousDraft?: Draft;
  }): ConvergenceSignal {
    if (this.config.convergenceStrategy && this.config.convergenceStrategy !== "default") {
      const stop = this.config.convergenceStrategy(args);
      const blockerCount = args.critiques.filter((c) => c.severity === "blocker").length;
      const majorCount = args.critiques.filter((c) => c.severity === "major").length;
      const diffFromPrevious = args.previousDraft
        ? diffRatio(args.previousDraft.content, args.draft.content)
        : 1;
      return {
        blockerCount,
        majorCount,
        totalCritiques: args.critiques.length,
        diffFromPrevious,
        shouldStop: stop,
        reason: stop ? "all_minor_or_praise" : "running",
      };
    }
    return defaultConvergence(args);
  }

  private pickNextAuthor(
    current: ArenaParticipant,
    critiques: Critique[],
    pool: ArenaParticipant[],
    round: number,
  ): ArenaParticipant {
    const policy = this.config.authorRotation ?? "fixed";
    if (policy === "fixed") return this.config.author;
    if (policy === "round-robin") {
      const idx = round % pool.length;
      return pool[idx];
    }
    if (policy === "best-critic") {
      // Score critics by sum of severities they raised; tie → most critiques.
      const sevWeight: Record<string, number> = {
        blocker: 5, major: 3, minor: 1, nit: 0.5, praise: 0,
      };
      const scores = new Map<string, number>();
      for (const c of critiques) {
        scores.set(c.critic, (scores.get(c.critic) ?? 0) + (sevWeight[c.severity] ?? 0));
      }
      let best = current.name;
      let bestScore = -1;
      for (const [name, score] of scores) {
        if (score > bestScore) { bestScore = score; best = name; }
      }
      const winner = pool.find((p) => p.name === best);
      return winner ?? current;
    }
    return current;
  }

  private finalize(rounds: Round[], stoppedAt: StoppedReason, start: number): IterateResult {
    const finalDraft = rounds.at(-1)!.draft;
    const result: IterateResult = {
      subject: this.config.subject,
      format: this.config.format,
      rounds,
      finalDraft,
      stoppedAt,
      durationMs: Date.now() - start,
    };
    this.config.onProgress?.({
      type: "iterate_complete",
      data: {
        stoppedAt,
        rounds: rounds.length,
        finalLength: finalDraft.content.length,
      },
    });
    logger.info("arena.iterate.complete", {
      stoppedAt,
      rounds: rounds.length,
      finalVersion: finalDraft.version,
      finalLength: finalDraft.content.length,
    });
    return result;
  }
}
