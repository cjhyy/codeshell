import { describe, expect, test } from "bun:test";
import { WorkspaceProfileSchema } from "./types.js";

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
});
