import { randomBytes } from "node:crypto";
import type { DetectedSkill, RepoInspection } from "./github-skill-service.js";

export interface ReviewedRepoInspection extends RepoInspection {
  reviewToken: string;
}

interface ReviewEntry {
  ownerWebContentsId: number;
  inspection: RepoInspection;
  expiresAt: number;
  issuedAt: number;
}

/** One-time, window-bound proof that a GitHub skill was actually previewed. */
export class GithubSkillReviewStore {
  private readonly entries = new Map<string, ReviewEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 15 * 60_000,
    private readonly maxEntries = 128,
  ) {}

  issue(ownerWebContentsId: number, inspection: RepoInspection): ReviewedRepoInspection {
    this.prune();
    while (this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries.entries()].sort(
        (left, right) => left[1].issuedAt - right[1].issuedAt,
      )[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
    const reviewToken = randomBytes(32).toString("base64url");
    const snapshot = structuredClone(inspection);
    const issuedAt = this.now();
    this.entries.set(reviewToken, {
      ownerWebContentsId,
      inspection: snapshot,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    });
    return { ...structuredClone(snapshot), reviewToken };
  }

  consume(
    ownerWebContentsId: number,
    reviewToken: unknown,
    selected: unknown,
  ): { inspection: RepoInspection; selected: DetectedSkill } {
    if (typeof reviewToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(reviewToken)) {
      throw new Error("a valid GitHub skill review token is required");
    }
    const entry = this.entries.get(reviewToken);
    if (!entry || entry.expiresAt <= this.now()) {
      this.entries.delete(reviewToken);
      throw new Error("GitHub skill review expired; inspect the repository again");
    }
    if (entry.ownerWebContentsId !== ownerWebContentsId) {
      throw new Error("GitHub skill review belongs to another window");
    }
    // Same-window confirmation is single use, including malformed attempts.
    this.entries.delete(reviewToken);
    if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
      throw new Error("a reviewed GitHub skill selection is required");
    }
    const raw = selected as Record<string, unknown>;
    const match = entry.inspection.skills.find(
      (candidate) =>
        candidate.name === raw.name &&
        candidate.pathInRepo === raw.pathInRepo &&
        candidate.dirInRepo === raw.dirInRepo,
    );
    if (!match) throw new Error("selected GitHub skill was not part of the reviewed inspection");
    return {
      inspection: structuredClone(entry.inspection),
      selected: structuredClone(match),
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}
