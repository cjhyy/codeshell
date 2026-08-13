import { describe, expect, test } from "bun:test";
import { GithubSkillReviewStore } from "./github-skill-review.js";
import type { RepoInspection } from "./github-skill-service.js";

function inspection(): RepoInspection {
  return {
    url: { owner: "owner", repo: "repo", ref: "main" },
    defaultBranch: "main",
    skills: [
      {
        name: "safe-skill",
        description: "reviewed",
        pathInRepo: "skills/safe/SKILL.md",
        dirInRepo: "skills/safe",
      },
    ],
    isPlugin: false,
    totalDetected: 1,
  };
}

describe("GithubSkillReviewStore", () => {
  test("returns the authoritative reviewed selection and consumes the token once", () => {
    const store = new GithubSkillReviewStore();
    const reviewed = store.issue(7, inspection());
    const result = store.consume(7, reviewed.reviewToken, reviewed.skills[0]);
    expect(result.selected.dirInRepo).toBe("skills/safe");
    expect(() => store.consume(7, reviewed.reviewToken, reviewed.skills[0])).toThrow(/expired/i);
  });

  test("rejects selection tampering and binds a review to one renderer window", () => {
    const store = new GithubSkillReviewStore();
    const first = store.issue(7, inspection());
    expect(() => store.consume(8, first.reviewToken, first.skills[0])).toThrow(/another window/i);
    // A wrong-window attempt does not burn the rightful owner's confirmation.
    expect(store.consume(7, first.reviewToken, first.skills[0]).selected.name).toBe("safe-skill");

    const second = store.issue(7, inspection());
    expect(() =>
      store.consume(7, second.reviewToken, {
        ...second.skills[0],
        pathInRepo: "unreviewed/SKILL.md",
        dirInRepo: "unreviewed",
      }),
    ).toThrow(/not part/i);
  });

  test("expires reviews and evicts old entries at the capacity bound", () => {
    let now = 1_000;
    const expiring = new GithubSkillReviewStore(() => now, 10, 2);
    const expired = expiring.issue(1, inspection());
    now += 11;
    expect(() => expiring.consume(1, expired.reviewToken, expired.skills[0])).toThrow(/expired/i);

    const a = expiring.issue(1, inspection());
    now += 1;
    const b = expiring.issue(1, inspection());
    now += 1;
    const c = expiring.issue(1, inspection());
    expect(() => expiring.consume(1, a.reviewToken, a.skills[0])).toThrow(/expired/i);
    expect(expiring.consume(1, b.reviewToken, b.skills[0]).selected.name).toBe("safe-skill");
    expect(expiring.consume(1, c.reviewToken, c.skills[0]).selected.name).toBe("safe-skill");
  });
});
