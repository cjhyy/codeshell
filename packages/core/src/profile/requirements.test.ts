import { describe, expect, test } from "bun:test";
import {
  buildSkillInstallArgs,
  compareToolVersions,
  parseToolVersion,
  planProfileRequirements,
  summarizeSkillConflicts,
} from "./requirements.js";
import type { SkillRequirement } from "./types.js";

const req = (patch: Partial<SkillRequirement> = {}): SkillRequirement => ({
  source: "github",
  repo: "heygen-com/hyperframes",
  scope: "project",
  fullDepth: false,
  ...patch,
});

describe("buildSkillInstallArgs", () => {
  test("installs everything with --all when no skill subset is named", () => {
    expect(buildSkillInstallArgs(req())).toEqual([
      "skills",
      "add",
      "heygen-com/hyperframes",
      "--all",
    ]);
  });

  test("names an explicit subset and still skips prompts", () => {
    const args = buildSkillInstallArgs(req({ skills: ["media-use", "hyperframes-core"] }));
    expect(args).toEqual([
      "skills",
      "add",
      "heygen-com/hyperframes",
      "--skill",
      "media-use,hyperframes-core",
      "--agent",
      "*",
      "--yes",
    ]);
    // Never global: `skills add -g` writes ~/.claude/skills, which the scanner
    // does not read, so the skill would install yet stay invisible.
    expect(args).not.toContain("-g");
    expect(args).not.toContain("--global");
  });

  test("passes --full-depth only when requested", () => {
    expect(buildSkillInstallArgs(req({ fullDepth: true }))).toContain("--full-depth");
    expect(buildSkillInstallArgs(req())).not.toContain("--full-depth");
  });

  test("puts the repo in an argv slot, never interpolated into a shell string", () => {
    // The value is regex-guarded at the schema layer; this asserts the caller
    // keeps it as one argv element so a hostile value cannot become a flag.
    const args = buildSkillInstallArgs(req({ repo: "owner/repo" }));
    expect(args[2]).toBe("owner/repo");
  });
});

describe("tool version comparison", () => {
  test("extracts the first version from real --version output", () => {
    expect(parseToolVersion("ffmpeg version 8.1.1 Copyright (c) 2000-2026")).toBe("8.1.1");
    expect(parseToolVersion("v25.8.1")).toBe("25.8.1");
    expect(parseToolVersion("git version 2.39.5 (Apple Git-154)")).toBe("2.39.5");
  });

  test("returns undefined when no version is present", () => {
    expect(parseToolVersion("command not found")).toBeUndefined();
    expect(parseToolVersion("")).toBeUndefined();
  });

  test("compares numerically, not lexicographically", () => {
    // "9" > "22" as strings — the bug this guards against.
    expect(compareToolVersions("22.0.0", "9.0.0")).toBeGreaterThan(0);
    expect(compareToolVersions("22", "22.0.0")).toBe(0);
    expect(compareToolVersions("21.9.9", "22")).toBeLessThan(0);
    expect(compareToolVersions("8.1.1", "8.1")).toBeGreaterThan(0);
  });
});

describe("summarizeSkillConflicts", () => {
  test("flags an incoming skill that an earlier-precedence root already owns", () => {
    const conflicts = summarizeSkillConflicts(
      ["media-use", "hyperframes"],
      [{ name: "media-use", source: "user" }],
    );
    expect(conflicts).toEqual([{ name: "media-use", existingSource: "user" }]);
  });

  test("reports nothing when names do not overlap", () => {
    expect(summarizeSkillConflicts(["a"], [{ name: "b", source: "project" }])).toEqual([]);
  });

  test("treats a plugin-namespaced skill as non-conflicting", () => {
    // Plugin skills live under `plugin:skill` in a separate dedup set, so a bare
    // name can never shadow them.
    expect(
      summarizeSkillConflicts(
        ["director-skill"],
        [{ name: "mimi-video:director-skill", source: "plugin" }],
      ),
    ).toEqual([]);
  });
});

describe("planProfileRequirements", () => {
  test("returns an empty plan for a profile with no requires (backward compatible)", () => {
    const plan = planProfileRequirements(undefined, { installedSkills: [], toolProbe: () => null });
    expect(plan.skillInstalls).toEqual([]);
    expect(plan.missingTools).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.needsInstall).toBe(false);
  });

  test("skips a requirement whose named skills are all present", () => {
    const plan = planProfileRequirements(
      { skills: [req({ skills: ["media-use"] })], tools: [] },
      { installedSkills: [{ name: "media-use", source: "project" }], toolProbe: () => null },
    );
    expect(plan.skillInstalls).toEqual([]);
    expect(plan.needsInstall).toBe(false);
  });

  test("plans an install when any named skill is missing", () => {
    const plan = planProfileRequirements(
      { skills: [req({ skills: ["media-use", "not-here"] })], tools: [] },
      { installedSkills: [{ name: "media-use", source: "project" }], toolProbe: () => null },
    );
    expect(plan.skillInstalls).toHaveLength(1);
    expect(plan.skillInstalls[0].missing).toEqual(["not-here"]);
    expect(plan.needsInstall).toBe(true);
  });

  test("always plans an install for an unscoped (--all) requirement", () => {
    const plan = planProfileRequirements(
      { skills: [req()], tools: [] },
      { installedSkills: [{ name: "media-use", source: "project" }], toolProbe: () => null },
    );
    expect(plan.skillInstalls).toHaveLength(1);
    expect(plan.skillInstalls[0].missing).toBeUndefined();
  });

  test("reports a missing tool and a too-old tool, with the hint", () => {
    const plan = planProfileRequirements(
      {
        skills: [],
        tools: [
          { bin: "ffmpeg", hint: "brew install ffmpeg" },
          { bin: "node", minVersion: "22" },
        ],
      },
      {
        installedSkills: [],
        toolProbe: (bin) => (bin === "node" ? "v20.1.0" : null),
      },
    );
    expect(plan.missingTools).toEqual([
      { bin: "ffmpeg", reason: "not-found", hint: "brew install ffmpeg" },
      { bin: "node", reason: "too-old", found: "20.1.0", required: "22" },
    ]);
    // Missing tools are surfaced, but they do not by themselves demand an install step.
    expect(plan.needsInstall).toBe(false);
  });

  test("accepts a tool that meets the minimum version", () => {
    const plan = planProfileRequirements(
      { skills: [], tools: [{ bin: "node", minVersion: "22" }] },
      { installedSkills: [], toolProbe: () => "v25.8.1" },
    );
    expect(plan.missingTools).toEqual([]);
  });

  test("surfaces shadowing conflicts for the skills it is about to install", () => {
    const plan = planProfileRequirements(
      { skills: [req({ skills: ["media-use"] })], tools: [] },
      { installedSkills: [{ name: "media-use", source: "user" }], toolProbe: () => null },
    );
    // Present but at a lower-precedence root: installing to the project root
    // shadows it. That is a surprise worth showing before it happens.
    expect(plan.conflicts).toEqual([{ name: "media-use", existingSource: "user" }]);
  });
});
