import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile } from "@cjhyy/code-shell-core/internal";
import {
  deleteDigitalHumanTeam,
  listDigitalHumanTeams,
  readDigitalHumanTeam,
  saveDigitalHumanTeam,
} from "./digital-human-team-service.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-digital-human-teams-"));
  previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  for (const name of ["researcher", "developer"]) {
    saveWorkspaceProfile({
      name,
      label: name,
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
  }
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("digital-human team service", () => {
  test("persists, lists and deletes a team", () => {
    saveDigitalHumanTeam({
      id: "build-team",
      name: "构建小队",
      description: "Pet 自动分工",
      members: ["researcher", "developer"],
      mode: "auto",
    });
    expect(listDigitalHumanTeams()).toEqual([
      {
        id: "build-team",
        name: "构建小队",
        description: "Pet 自动分工",
        members: ["researcher", "developer"],
        mode: "auto",
      },
    ]);
    deleteDigitalHumanTeam("build-team");
    expect(listDigitalHumanTeams()).toEqual([]);
  });

  test("rejects a team that references a missing digital human", () => {
    expect(() =>
      saveDigitalHumanTeam({
        id: "missing-member",
        name: "Missing",
        members: ["researcher", "unknown"],
        mode: "divide",
      }),
    ).toThrow(/unknown/);
  });

  test("isolates a corrupt team file and reports it without hiding valid teams", () => {
    saveDigitalHumanTeam({
      id: "valid-team",
      name: "Valid",
      members: ["researcher", "developer"],
      mode: "auto",
    });
    const brokenDir = join(home, "digital-human-teams", "broken-team");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "team.json"), "{not-json", "utf-8");
    const issues: Array<{ id: string; path: string; error: string }> = [];

    expect(listDigitalHumanTeams({ onInvalidTeam: (issue) => issues.push(issue) })).toEqual([
      {
        id: "valid-team",
        name: "Valid",
        members: ["researcher", "developer"],
        mode: "auto",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: "broken-team" });
    expect(issues[0]?.path).toEndWith(join("broken-team", "team.json"));
    expect(issues[0]?.error).toContain("Invalid digital-human team");
  });

  test("atomically overwrites a team without leaving temporary files", () => {
    saveDigitalHumanTeam({
      id: "build-team",
      name: "Before",
      members: ["researcher", "developer"],
      mode: "auto",
    });
    saveDigitalHumanTeam({
      id: "build-team",
      name: "After",
      description: "Updated",
      members: ["developer", "researcher"],
      mode: "compare",
    });

    expect(listDigitalHumanTeams()[0]).toMatchObject({
      id: "build-team",
      name: "After",
      description: "Updated",
      mode: "compare",
    });
    expect(readdirSync(join(home, "digital-human-teams", "build-team"))).toEqual(["team.json"]);
  });

  test("refuses team directory and file symlinks that escape the data root", () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "digital-human-team-outside-"));
    try {
      const root = join(home, "digital-human-teams");
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, join(root, "linked-team"));
      expect(() =>
        saveDigitalHumanTeam({
          id: "linked-team",
          name: "Linked",
          members: ["researcher", "developer"],
          mode: "auto",
        }),
      ).toThrow(/team directory/);

      const fileTeamDir = join(root, "linked-file");
      mkdirSync(fileTeamDir, { recursive: true });
      const outsideFile = join(outside, "team.json");
      writeFileSync(
        outsideFile,
        JSON.stringify({
          id: "linked-file",
          name: "Outside",
          members: ["researcher", "developer"],
          mode: "auto",
        }),
      );
      symlinkSync(outsideFile, join(fileTeamDir, "team.json"));
      expect(() => readDigitalHumanTeam("linked-file")).toThrow(/team file/);
      expect(() =>
        saveDigitalHumanTeam({
          id: "linked-file",
          name: "Linked file",
          members: ["researcher", "developer"],
          mode: "auto",
        }),
      ).toThrow(/team file/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked teams root before listing its target", () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "digital-human-teams-root-outside-"));
    const root = join(home, "digital-human-teams");
    try {
      mkdirSync(outside, { recursive: true });
      mkdirSync(join(outside, "outside-team"), { recursive: true });
      symlinkSync(outside, root);
      expect(() => listDigitalHumanTeams()).toThrow(/teams root/);
    } finally {
      rmSync(root, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
