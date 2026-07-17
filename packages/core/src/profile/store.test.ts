import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteWorkspaceProfile,
  listWorkspaceProfiles,
  readWorkspaceProfile,
  saveWorkspaceProfile,
  workspaceProfileDir,
  workspaceProfilesRoot,
} from "./store.js";

let home: string;
let prevHome: string | undefined;
const externalRoots: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-profile-store-"));
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  for (const root of externalRoots.splice(0)) rmSync(root, { recursive: true, force: true });
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

  test("overwrites atomically without leaving temporary files", () => {
    saveWorkspaceProfile({
      name: "seedance",
      label: "First",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    saveWorkspaceProfile({
      name: "seedance",
      label: "Second",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });

    const files = readdirSync(workspaceProfileDir("seedance"));
    expect(files).toEqual(["profile.json"]);
    expect(
      JSON.parse(readFileSync(join(workspaceProfileDir("seedance"), "profile.json"), "utf-8")),
    ).toMatchObject({ label: "Second" });
  });

  test("rejects a symlinked profiles root before listing its target", () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "cs-profile-outside-"));
    externalRoots.push(outside);
    mkdirSync(join(outside, "visible"), { recursive: true });
    writeFileSync(
      join(outside, "visible", "profile.json"),
      JSON.stringify({ name: "visible", label: "Visible", basePreset: "general" }),
    );
    symlinkSync(outside, workspaceProfilesRoot(), "dir");

    expect(() => listWorkspaceProfiles()).toThrow(/profiles root/);
    expect(() =>
      saveWorkspaceProfile({
        name: "new-profile",
        label: "New",
        basePreset: "general",
        plugins: [],
        skills: [],
        mcp: [],
        agents: [],
        portableMemory: false,
      }),
    ).toThrow(/profiles root/);
  });

  test("does not follow a symlinked profile directory", () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "cs-profile-outside-"));
    externalRoots.push(outside);
    writeFileSync(
      join(outside, "profile.json"),
      JSON.stringify({ name: "linked", label: "Outside", basePreset: "general" }),
    );
    mkdirSync(workspaceProfilesRoot(), { recursive: true });
    symlinkSync(outside, workspaceProfileDir("linked"), "dir");

    expect(() => readWorkspaceProfile("linked")).toThrow(/profile directory/);
    expect(() =>
      saveWorkspaceProfile({
        name: "linked",
        label: "Changed",
        basePreset: "general",
        plugins: [],
        skills: [],
        mcp: [],
        agents: [],
        portableMemory: false,
      }),
    ).toThrow(/profile directory/);
    expect(() => deleteWorkspaceProfile("linked")).toThrow(/profile directory/);
    expect(JSON.parse(readFileSync(join(outside, "profile.json"), "utf-8"))).toMatchObject({
      label: "Outside",
    });
  });

  test("does not follow a symlinked profile file", () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "cs-profile-outside-"));
    externalRoots.push(outside);
    const externalFile = join(outside, "outside.json");
    writeFileSync(
      externalFile,
      JSON.stringify({ name: "linked", label: "Outside", basePreset: "general" }),
    );
    mkdirSync(workspaceProfileDir("linked"), { recursive: true });
    symlinkSync(externalFile, join(workspaceProfileDir("linked"), "profile.json"));

    expect(() => readWorkspaceProfile("linked")).toThrow(/profile file/);
    expect(() =>
      saveWorkspaceProfile({
        name: "linked",
        label: "Changed",
        basePreset: "general",
        plugins: [],
        skills: [],
        mcp: [],
        agents: [],
        portableMemory: false,
      }),
    ).toThrow(/profile file/);
    expect(JSON.parse(readFileSync(externalFile, "utf-8"))).toMatchObject({ label: "Outside" });
  });

  test("isolates symlink entries while listing valid profiles", () => {
    if (process.platform === "win32") return;
    saveWorkspaceProfile({
      name: "valid",
      label: "Valid",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    const outside = mkdtempSync(join(tmpdir(), "cs-profile-outside-"));
    externalRoots.push(outside);
    symlinkSync(outside, workspaceProfileDir("linked"), "dir");

    expect(listWorkspaceProfiles().map((profile) => profile.name)).toEqual(["valid"]);
  });
});
