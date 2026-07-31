import { describe, expect, test } from "bun:test";
import {
  canAddDigitalHumanSkill,
  digitalHumanMissingSkillNames,
  digitalHumanSkillRequirementsFromSources,
  digitalHumanSkillSourcesByName,
  digitalHumanSkillsWithoutSource,
  DIGITAL_HUMAN_PROFILE_LIMITS,
  hasDigitalHumanCatchAllSkillRequirement,
  normalizeDigitalHumanSkillRepo,
  replaceDigitalHumanSkillSources,
} from "./types";

describe("digital-human editor limits", () => {
  test("permits a valid Skill below the selection limit", () => {
    expect(
      canAddDigitalHumanSkill(
        DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount - 1,
        "s".repeat(DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName),
      ),
    ).toBe(true);
  });

  test("blocks additions at the count limit and rejects invalid names", () => {
    expect(
      canAddDigitalHumanSkill(DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount, "another-skill"),
    ).toBe(false);
    expect(canAddDigitalHumanSkill(0, "")).toBe(false);
    expect(
      canAddDigitalHumanSkill(0, "s".repeat(DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName + 1)),
    ).toBe(false);
  });
});

describe("digital-human Skill source validation", () => {
  test("normalizes a trusted GitHub owner/repo shorthand", () => {
    expect(normalizeDigitalHumanSkillRepo("  heygen-com/hyperframes  ")).toBe(
      "heygen-com/hyperframes",
    );
  });

  test("rejects URLs, commands, path traversal, and incomplete repositories", () => {
    for (const value of [
      "",
      "https://github.com/owner/repo",
      "owner/repo;rm -rf /",
      "../repo",
      "owner",
      "owner/repo/extra",
      "-owner/repo",
    ]) {
      expect(normalizeDigitalHumanSkillRepo(value)).toBeNull();
    }
  });

  test("keeps different Skill sources separate and merges shared repositories", () => {
    expect(
      digitalHumanSkillRequirementsFromSources({
        hyperframes: "heygen-com/hyperframes",
        "media-use": "openai/media-skills",
        storyboard: "heygen-com/hyperframes",
      }),
    ).toEqual([
      {
        source: "github",
        repo: "heygen-com/hyperframes",
        skills: ["hyperframes", "storyboard"],
        scope: "project",
        fullDepth: false,
      },
      {
        source: "github",
        repo: "openai/media-skills",
        skills: ["media-use"],
        scope: "project",
        fullDepth: false,
      },
    ]);
  });

  test("ignores empty or invalid Skill source rows", () => {
    expect(
      digitalHumanSkillRequirementsFromSources({
        valid: "owner/repo",
        empty: "",
        invalid: "https://github.com/owner/repo",
      }),
    ).toHaveLength(1);
  });

  test("pre-fills named sources and rewrites only the Skills the user changed", () => {
    const current = [
      {
        source: "github" as const,
        repo: "owner/shared",
        skills: ["research", "review"],
        scope: "project" as const,
        fullDepth: true,
      },
      {
        source: "github" as const,
        repo: "owner/all",
        scope: "project" as const,
        fullDepth: false,
      },
    ];
    expect(digitalHumanSkillSourcesByName({ skills: current, tools: [] })).toEqual({
      research: "owner/shared",
      review: "owner/shared",
    });
    expect(
      replaceDigitalHumanSkillSources(current, {
        review: "owner/review",
        storyboard: "owner/review",
      }),
    ).toEqual([
      {
        source: "github",
        repo: "owner/shared",
        skills: ["research"],
        scope: "project",
        fullDepth: true,
      },
      {
        source: "github",
        repo: "owner/all",
        scope: "project",
        fullDepth: false,
      },
      {
        source: "github",
        repo: "owner/review",
        skills: ["review", "storyboard"],
        scope: "project",
        fullDepth: false,
      },
    ]);
  });

  test("clearing a named source removes only that row", () => {
    expect(
      replaceDigitalHumanSkillSources(
        [
          {
            source: "github",
            repo: "owner/shared",
            skills: ["research", "review"],
            scope: "project",
            fullDepth: false,
          },
        ],
        { review: "" },
      ),
    ).toEqual([
      {
        source: "github",
        repo: "owner/shared",
        skills: ["research"],
        scope: "project",
        fullDepth: false,
      },
    ]);
  });

  test("changing a Skill to an existing compatible repo merges the requirement", () => {
    expect(
      replaceDigitalHumanSkillSources(
        [
          {
            source: "github",
            repo: "owner/shared",
            skills: ["research"],
            scope: "project",
            fullDepth: false,
          },
          {
            source: "github",
            repo: "owner/review",
            skills: ["review"],
            scope: "project",
            fullDepth: false,
          },
        ],
        { review: "owner/shared" },
      ),
    ).toEqual([
      {
        source: "github",
        repo: "owner/shared",
        skills: ["research", "review"],
        scope: "project",
        fullDepth: false,
      },
    ]);
  });
});

describe("digital-human missing Skill recovery", () => {
  test("reports only missing Skills not covered by an explicit source", () => {
    expect(
      digitalHumanSkillsWithoutSource(["research", "review"], {
        skills: [
          {
            source: "github",
            repo: "owner/research-skills",
            skills: ["research"],
            scope: "project",
            fullDepth: false,
          },
        ],
        tools: [],
      }),
    ).toEqual(["review"]);
  });

  test("treats a whole-repository requirement as covering every missing Skill", () => {
    expect(
      digitalHumanSkillsWithoutSource(["research", "review"], {
        skills: [
          {
            source: "github",
            repo: "owner/all-skills",
            scope: "project",
            fullDepth: false,
          },
        ],
        tools: [],
      }),
    ).toEqual([]);
  });

  test("a named project requirement is not satisfied by a user-wide copy", () => {
    const requires = {
      skills: [
        {
          source: "github" as const,
          repo: "owner/research-skills",
          skills: ["research"],
          scope: "project" as const,
          fullDepth: false,
        },
      ],
      tools: [],
    };
    expect(
      digitalHumanMissingSkillNames(["research"], requires, [
        { name: "research", description: "", source: "user" },
      ]),
    ).toEqual(["research"]);
    expect(
      digitalHumanMissingSkillNames(["research"], requires, [
        { name: "research", description: "", source: "project" },
      ]),
    ).toEqual([]);
  });

  test("a configured Skill without a project requirement may use any visible source", () => {
    expect(
      digitalHumanMissingSkillNames(["writing"], undefined, [
        { name: "writing", description: "", source: "user" },
      ]),
    ).toEqual([]);
  });

  test("recognizes a whole-repository requirement as needing runtime review", () => {
    expect(
      hasDigitalHumanCatchAllSkillRequirement({
        skills: [
          {
            source: "github",
            repo: "owner/all-skills",
            scope: "project",
            fullDepth: false,
          },
        ],
        tools: [],
      }),
    ).toBe(true);
  });
});
