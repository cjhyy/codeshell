import { describe, expect, test } from "bun:test";
import { WorkspaceProfileRequirementsSchema } from "../../../../core/src/profile/types";
import {
  normalizeDigitalHumanRequirements,
  replaceDigitalHumanSkillSourceDraft,
  validateDigitalHumanRequirements,
  type DigitalHumanRequirements,
} from "./requirementsEditor";

const repository: DigitalHumanRequirements["skills"][number] = {
  source: "github",
  repo: "owner/skills",
  scope: "project",
  fullDepth: true,
  skills: ["research"],
};

describe("digital-human dependency schema boundary", () => {
  test("accepts normalized requirements at the core limits", () => {
    const requires = {
      skills: Array.from({ length: 16 }, () => ({
        ...repository,
        repo: " owner/skills ",
        skills: Array.from({ length: 128 }, (_, index) => `${index}`.padEnd(256, "s")),
      })),
      tools: Array.from({ length: 16 }, () => ({
        bin: "b".repeat(256),
        minVersion: "22.1.0",
        hint: "h".repeat(256),
      })),
    };
    expect(validateDigitalHumanRequirements(requires).valid).toBe(true);
    const normalized = normalizeDigitalHumanRequirements(requires);
    expect(WorkspaceProfileRequirementsSchema.parse(normalized)).toEqual(normalized);
  });

  test.each([
    { skills: [{ ...repository, repo: "https://github.com/owner/repo" }], tools: [] },
    { skills: [{ ...repository, skills: [""] }], tools: [] },
    { skills: [{ ...repository, skills: ["--all"] }], tools: [] },
    { skills: [{ ...repository, skills: ["*"] }], tools: [] },
    { skills: [{ ...repository, skills: ["a\0b"] }], tools: [] },
    { skills: [{ ...repository, skills: ["same", "same"] }], tools: [] },
    { skills: [{ ...repository, skills: ["s".repeat(257)] }], tools: [] },
    {
      skills: [{ ...repository, skills: Array.from({ length: 129 }, (_, index) => `${index}`) }],
      tools: [],
    },
    { skills: Array.from({ length: 17 }, () => repository), tools: [] },
    { skills: [], tools: Array.from({ length: 17 }, () => ({ bin: "node" })) },
    { skills: [], tools: [{ bin: "" }] },
    { skills: [], tools: [{ bin: "b".repeat(257) }] },
    { skills: [], tools: [{ bin: "node", minVersion: "v22.0" }] },
    { skills: [], tools: [{ bin: "node", minVersion: "22.1.0.1" }] },
    { skills: [], tools: [{ bin: "node", hint: "h".repeat(257) }] },
  ])("rejects invalid persisted declarations %#", (requires) => {
    expect(validateDigitalHumanRequirements(requires).valid).toBe(false);
    expect(WorkspaceProfileRequirementsSchema.safeParse(requires).success).toBe(false);
  });

  test("removing every dependency omits requires", () => {
    expect(normalizeDigitalHumanRequirements({ skills: [], tools: [] })).toBeUndefined();
  });
});

describe("digital-human quick Skill source draft", () => {
  test("retains invalid input for error display and preserves unrelated metadata", () => {
    const current = [
      { ...repository, skills: ["research", "review"] },
      { ...repository, repo: "owner/all", skills: undefined },
    ];
    const changed = replaceDigitalHumanSkillSourceDraft(current, "review", "invalid");
    expect(changed).toEqual([
      { ...repository, skills: ["research"] },
      current[1],
      { ...repository, repo: "invalid", skills: ["review"] },
    ]);
    expect(validateDigitalHumanRequirements({ skills: changed, tools: [] }).valid).toBe(false);
    const cleared = replaceDigitalHumanSkillSourceDraft(changed, "review", "");
    expect(cleared).toEqual([
      ...changed.slice(0, 2),
      { ...repository, repo: "", skills: ["review"] },
    ]);
    expect(validateDigitalHumanRequirements({ skills: cleared, tools: [] }).valid).toBe(false);
    expect(current[0]?.skills).toEqual(["research", "review"]);
  });

  test("changing a source and restoring it preserves its metadata", () => {
    const current = [repository];
    const changed = replaceDigitalHumanSkillSourceDraft(current, "research", "owner/temporary");
    expect(changed[0]?.fullDepth).toBe(true);
    expect(replaceDigitalHumanSkillSourceDraft(changed, "research", "owner/skills")).toEqual(
      current,
    );
    expect(replaceDigitalHumanSkillSourceDraft(current, "research", " owner/skills ")).toEqual(
      current,
    );
  });
});
