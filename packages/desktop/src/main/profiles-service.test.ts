import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile } from "@cjhyy/code-shell-core";
import { activateProfile, deactivateProfile, listProfiles } from "./profiles-service.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-desk-profiles-"));
  cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveWorkspaceProfile({
    name: "seedance",
    label: "Seedance",
    basePreset: "general",
    plugins: [],
    skills: [],
    mcp: [],
    agents: [],
    portableMemory: false,
  });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("desktop profiles service", () => {
  test("lists library profiles with active mark for a cwd", () => {
    activateProfile(cwd, "seedance");
    const profiles = listProfiles(cwd);
    expect(profiles).toEqual([
      {
        name: "seedance",
        label: "Seedance",
        description: undefined,
        active: true,
        portableMemory: false,
      },
    ]);
  });

  test("activate writes the subtree; deactivate removes it", () => {
    activateProfile(cwd, "seedance");
    const raw = () => JSON.parse(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf-8"));
    expect(raw().profile.active).toBe("seedance");
    deactivateProfile(cwd);
    expect(raw().profile).toBeUndefined();
    expect(listProfiles(cwd)[0]?.active).toBe(false);
  });
});
