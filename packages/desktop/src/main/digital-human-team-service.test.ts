import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile } from "@cjhyy/code-shell-core";
import {
  deleteDigitalHumanTeam,
  listDigitalHumanTeams,
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
});
