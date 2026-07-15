import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile } from "@cjhyy/code-shell-core";
import {
  activateProfile,
  deactivateProfile,
  installCatalogProfile,
  listProfileCatalog,
  listProfiles,
  saveProfile,
} from "./profiles-service.js";

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
        basePreset: "general",
        plugins: [],
        skills: [],
        mcp: [],
        agents: [],
        mainInstruction: undefined,
        active: true,
        portableMemory: false,
        version: undefined,
      },
    ]);
  });

  test("lists the library without a selected workspace", () => {
    expect(listProfiles()[0]).toMatchObject({ name: "seedance", active: false });
  });

  test("installs a starter digital human from the local catalog", () => {
    expect(
      listProfileCatalog().find((entry) => entry.name === "product-researcher")?.installed,
    ).toBe(false);
    installCatalogProfile("product-researcher");
    expect(listProfiles().some((entry) => entry.name === "product-researcher")).toBe(true);
    expect(
      listProfileCatalog().find((entry) => entry.name === "product-researcher")?.installed,
    ).toBe(true);
  });

  test("creates and updates a digital human with assigned skills", () => {
    saveProfile({
      name: "research-lead",
      label: "研究负责人",
      description: "负责研究与交付",
      basePreset: "general",
      plugins: [],
      skills: ["web-search", "spreadsheets:analysis"],
      mcp: [],
      agents: [],
      mainInstruction: "先核对来源，再综合结论。",
      portableMemory: true,
      version: "1.0.0",
    });

    expect(listProfiles().find((profile) => profile.name === "research-lead")).toMatchObject({
      label: "研究负责人",
      skills: ["web-search", "spreadsheets:analysis"],
      mainInstruction: "先核对来源，再综合结论。",
      portableMemory: true,
    });

    saveProfile({
      name: "research-lead",
      label: "首席研究员",
      basePreset: "general",
      plugins: [],
      skills: ["web-search"],
      mcp: [],
      agents: [],
      mainInstruction: "只使用可追溯来源。",
      portableMemory: false,
      version: "1.0.1",
    });

    expect(listProfiles().find((profile) => profile.name === "research-lead")).toMatchObject({
      label: "首席研究员",
      skills: ["web-search"],
      mainInstruction: "只使用可追溯来源。",
      portableMemory: false,
      version: "1.0.1",
    });
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
