import { describe, expect, test } from "bun:test";
import { GithubSkillReviewStore } from "./github-skill-review.js";
import type { RepoInspection } from "./github-skill-service.js";

const owner = new AbortController().signal;
const other = new AbortController().signal;

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
    const reviewed = store.issue(owner, inspection());
    const result = store.consume(owner, reviewed.reviewToken, reviewed.skills[0]);
    expect(result.selected.dirInRepo).toBe("skills/safe");
    expect(() => store.consume(owner, reviewed.reviewToken, reviewed.skills[0])).toThrow(
      /expired/i,
    );
  });

  test("rejects selection tampering and binds a review to one renderer window", () => {
    const store = new GithubSkillReviewStore();
    const first = store.issue(owner, inspection());
    expect(() => store.consume(other, first.reviewToken, first.skills[0])).toThrow(
      /another window/i,
    );
    // A wrong-window attempt does not burn the rightful owner's confirmation.
    expect(store.consume(owner, first.reviewToken, first.skills[0]).selected.name).toBe(
      "safe-skill",
    );

    const second = store.issue(owner, inspection());
    expect(() =>
      store.consume(owner, second.reviewToken, {
        ...second.skills[0],
        pathInRepo: "unreviewed/SKILL.md",
        dirInRepo: "unreviewed",
      }),
    ).toThrow(/not part/i);
  });

  test("an old document cannot authorize installation after its window reloads", () => {
    const store = new GithubSkillReviewStore();
    const original = new AbortController();
    const reviewed = store.issue(original.signal, inspection());
    original.abort();
    expect(() =>
      store.consume(new AbortController().signal, reviewed.reviewToken, reviewed.skills[0]),
    ).toThrow(/expired/i);
    expect(() => store.issue(original.signal, inspection())).toThrow();
  });

  test("expires reviews and evicts old entries at the capacity bound", () => {
    let now = 1_000;
    const expiring = new GithubSkillReviewStore(() => now, 10, 2);
    const expired = expiring.issue(owner, inspection());
    now += 11;
    expect(() => expiring.consume(owner, expired.reviewToken, expired.skills[0])).toThrow(
      /expired/i,
    );

    const a = expiring.issue(owner, inspection());
    now += 1;
    const b = expiring.issue(owner, inspection());
    now += 1;
    const c = expiring.issue(owner, inspection());
    expect(() => expiring.consume(owner, a.reviewToken, a.skills[0])).toThrow(/expired/i);
    expect(expiring.consume(owner, b.reviewToken, b.skills[0]).selected.name).toBe("safe-skill");
    expect(expiring.consume(owner, c.reviewToken, c.skills[0]).selected.name).toBe("safe-skill");
  });
});
