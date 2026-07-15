import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listWorkspaceProfiles,
  readWorkspaceProfile,
  saveWorkspaceProfile,
  workspaceProfileDir,
  workspaceProfilesRoot,
} from "./store.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-profile-store-"));
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("workspace profile store", () => {
  test("save then read round-trips and paths derive from CODE_SHELL_HOME", () => {
    saveWorkspaceProfile({
      name: "seedance",
      label: "Seedance",
      basePreset: "general",
      plugins: ["seedance-pack"],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: true,
    });
    expect(workspaceProfilesRoot()).toBe(join(home, "profiles"));
    expect(workspaceProfileDir("seedance")).toBe(join(home, "profiles", "seedance"));
    const read = readWorkspaceProfile("seedance");
    expect(read?.label).toBe("Seedance");
    expect(read?.portableMemory).toBe(true);
  });

  test("read returns undefined for a missing profile", () => {
    expect(readWorkspaceProfile("nope")).toBeUndefined();
  });

  test("read throws a wrapped error for invalid JSON content", () => {
    mkdirSync(join(home, "profiles", "bad"), { recursive: true });
    writeFileSync(join(home, "profiles", "bad", "profile.json"), "not json");
    expect(() => readWorkspaceProfile("bad")).toThrow(/bad/);
  });

  test("read rejects names failing the name regex without touching disk", () => {
    expect(readWorkspaceProfile("../evil")).toBeUndefined();
  });

  test("list returns valid profiles sorted by name and skips broken ones", () => {
    saveWorkspaceProfile({
      name: "b-two",
      label: "B",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    saveWorkspaceProfile({
      name: "a-one",
      label: "A",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    mkdirSync(join(home, "profiles", "broken"), { recursive: true });
    writeFileSync(join(home, "profiles", "broken", "profile.json"), "{}");
    expect(listWorkspaceProfiles().map((p) => p.name)).toEqual(["a-one", "b-two"]);
  });

  test("list returns [] when the library directory does not exist", () => {
    expect(listWorkspaceProfiles()).toEqual([]);
  });
});
