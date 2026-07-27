import { describe, expect, test } from "bun:test";
import { WORKSPACE_PROFILE_LIMITS, WorkspaceProfileSchema } from "./types.js";

describe("WorkspaceProfile schema", () => {
  test("accepts a minimal valid profile and fills defaults", () => {
    const p = WorkspaceProfileSchema.parse({
      name: "ui-designer",
      label: "UI 设计师",
      basePreset: "general",
    });
    expect(p.plugins).toEqual([]);
    expect(p.skills).toEqual([]);
    expect(p.mcp).toEqual([]);
    expect(p.agents).toEqual([]);
    expect(p.portableMemory).toBe(false);
  });

  test("accepts the full shape", () => {
    const p = WorkspaceProfileSchema.parse({
      name: "seedance",
      label: "Seedance 分镜制片人",
      description: "三阶段调度",
      basePreset: "general",
      plugins: ["seedance-pack"],
      skills: ["storyboard"],
      mcp: ["figma"],
      agents: ["director"],
      mainInstruction: "你是制片人，按 导演→服化道→分镜 三阶段调度。",
      portableMemory: true,
      version: "0.1.0",
    });
    expect(p.mainInstruction).toContain("制片人");
  });

  test("rejects illegal names (path traversal / uppercase / empty)", () => {
    for (const name of ["", "../evil", "UPPER", "has space", "a/b"]) {
      expect(() =>
        WorkspaceProfileSchema.parse({ name, label: "x", basePreset: "general" }),
      ).toThrow();
    }
  });

  test("rejects missing basePreset", () => {
    expect(() => WorkspaceProfileSchema.parse({ name: "x", label: "x" })).toThrow();
  });

  test("accepts values at the documented persistence limits", () => {
    const capabilities = Array.from(
      { length: WORKSPACE_PROFILE_LIMITS.capabilityCount },
      (_, index) => `capability-${index}`,
    );
    expect(
      WorkspaceProfileSchema.parse({
        name: "bounded",
        label: "l".repeat(WORKSPACE_PROFILE_LIMITS.label),
        description: "d".repeat(WORKSPACE_PROFILE_LIMITS.description),
        basePreset: "p".repeat(WORKSPACE_PROFILE_LIMITS.basePreset),
        plugins: capabilities,
        skills: capabilities,
        mcp: capabilities,
        agents: capabilities,
        mainInstruction: "i".repeat(WORKSPACE_PROFILE_LIMITS.mainInstruction),
        version: "v".repeat(WORKSPACE_PROFILE_LIMITS.version),
      }).label,
    ).toHaveLength(WORKSPACE_PROFILE_LIMITS.label);
  });

  test("rejects oversized strings, capability lists, entries, and duplicates", () => {
    const base = { name: "bounded", label: "Bounded", basePreset: "general" };
    for (const patch of [
      { label: "l".repeat(WORKSPACE_PROFILE_LIMITS.label + 1) },
      { description: "d".repeat(WORKSPACE_PROFILE_LIMITS.description + 1) },
      { basePreset: "p".repeat(WORKSPACE_PROFILE_LIMITS.basePreset + 1) },
      { mainInstruction: "i".repeat(WORKSPACE_PROFILE_LIMITS.mainInstruction + 1) },
      { version: "v".repeat(WORKSPACE_PROFILE_LIMITS.version + 1) },
      {
        skills: Array.from(
          { length: WORKSPACE_PROFILE_LIMITS.capabilityCount + 1 },
          (_, index) => `skill-${index}`,
        ),
      },
      { plugins: ["p".repeat(WORKSPACE_PROFILE_LIMITS.capabilityName + 1)] },
      { mcp: ["duplicate", "duplicate"] },
      { agents: [""] },
    ]) {
      expect(() => WorkspaceProfileSchema.parse({ ...base, ...patch })).toThrow();
    }
  });
});

describe("WorkspaceProfile requires", () => {
  const base = { name: "video-engineer", label: "视频工程师", basePreset: "terminal-coding" };

  test("omitting requires keeps the pre-existing shape (backward compatible)", () => {
    expect(WorkspaceProfileSchema.parse(base).requires).toBeUndefined();
  });

  test("parses a skill requirement and defaults scope/fullDepth", () => {
    const p = WorkspaceProfileSchema.parse({
      ...base,
      requires: { skills: [{ source: "github", repo: "heygen-com/hyperframes" }] },
    });
    const [req] = p.requires!.skills;
    expect(req.repo).toBe("heygen-com/hyperframes");
    // scope is deliberately project-only: `skills add -g` lands in ~/.claude/skills,
    // which is NOT one of the scanner's three roots.
    expect(req.scope).toBe("project");
    expect(req.fullDepth).toBe(false);
    expect(req.skills).toBeUndefined();
    expect(p.requires!.tools).toEqual([]);
  });

  test("rejects a user/global skill scope", () => {
    for (const scope of ["user", "global"]) {
      expect(() =>
        WorkspaceProfileSchema.parse({
          ...base,
          requires: { skills: [{ source: "github", repo: "a/b", scope }] },
        }),
      ).toThrow();
    }
  });

  test("rejects repo values that could inject CLI flags or traverse paths", () => {
    for (const repo of [
      "--version",
      "-g",
      "../evil/repo",
      "owner/../../etc",
      "owner",
      "owner/repo extra",
      "owner/repo;rm -rf /",
      "$(whoami)/repo",
      "-owner/repo",
      "",
    ]) {
      expect(() =>
        WorkspaceProfileSchema.parse({
          ...base,
          requires: { skills: [{ source: "github", repo }] },
        }),
      ).toThrow();
    }
  });

  test("rejects a non-github skill source", () => {
    expect(() =>
      WorkspaceProfileSchema.parse({
        ...base,
        requires: { skills: [{ source: "npm", repo: "a/b" }] },
      }),
    ).toThrow();
  });

  test("parses tool requirements and rejects non-numeric versions", () => {
    const p = WorkspaceProfileSchema.parse({
      ...base,
      requires: {
        tools: [
          { bin: "ffmpeg", hint: "brew install ffmpeg" },
          { bin: "node", minVersion: "22" },
        ],
      },
    });
    expect(p.requires!.tools).toHaveLength(2);
    expect(p.requires!.skills).toEqual([]);

    for (const minVersion of ["latest", "22.x", "v22", ">=22", ""]) {
      expect(() =>
        WorkspaceProfileSchema.parse({
          ...base,
          requires: { tools: [{ bin: "node", minVersion }] },
        }),
      ).toThrow();
    }
  });

  test("rejects an empty bin and too many requirement entries", () => {
    expect(() =>
      WorkspaceProfileSchema.parse({ ...base, requires: { tools: [{ bin: "" }] } }),
    ).toThrow();
    expect(() =>
      WorkspaceProfileSchema.parse({
        ...base,
        requires: {
          skills: Array.from({ length: WORKSPACE_PROFILE_LIMITS.requirementCount + 1 }, (_, i) => ({
            source: "github",
            repo: `owner/repo-${i}`,
          })),
        },
      }),
    ).toThrow();
  });
});
