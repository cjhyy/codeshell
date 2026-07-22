import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { effectiveProjectOverrides, mergeCapabilityOverrides } from "./overlay.js";

describe("mergeCapabilityOverrides", () => {
  test("user layer wins per key; unique keys from both survive", () => {
    expect(
      mergeCapabilityOverrides(
        {
          plugins: { a: "on", b: "on" },
          skills: { s: "on" },
          pet: { showExternalCodexSessions: "on" },
        },
        {
          plugins: { a: "off" },
          agents: { g: "off" },
          pet: { showExternalClaudeSessions: "off" },
        },
      ),
    ).toEqual({
      plugins: { a: "off", b: "on" },
      skills: { s: "on" },
      agents: { g: "off" },
      pet: {
        showExternalClaudeSessions: "off",
      },
    });
  });

  test("either side undefined passes the other through", () => {
    expect(mergeCapabilityOverrides(undefined, { skills: { x: "on" } })).toEqual({
      skills: { x: "on" },
    });
    expect(mergeCapabilityOverrides({ skills: { x: "on" } }, undefined)).toEqual({
      skills: { x: "on" },
    });
    expect(mergeCapabilityOverrides(undefined, undefined)).toBeUndefined();
  });

  test("portable profile pet visibility is ignored; direct project pet override survives", () => {
    expect(
      mergeCapabilityOverrides(
        { pet: { showExternalCodexSessions: "on" } },
        { pet: { showExternalClaudeSessions: "off" } },
      ),
    ).toEqual({ pet: { showExternalClaudeSessions: "off" } });
    expect(
      mergeCapabilityOverrides({ pet: { showExternalCodexSessions: "on" } }, undefined),
    ).toBeUndefined();
    expect(
      mergeCapabilityOverrides(undefined, { pet: { showExternalCodexSessions: "on" } }),
    ).toEqual({ pet: { showExternalCodexSessions: "on" } });
  });
});

describe("effectiveProjectOverrides", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-eff-ov-"));
    cwd = join(home, "ws");
    mkdirSync(cwd, { recursive: true });
    prevHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("folds profile.overrides under user capabilityOverrides", () => {
    const settings = new SettingsManager(cwd, "full");
    settings.saveProjectSetting(
      "profile",
      {
        active: "seedance",
        overrides: { plugins: { "seedance-pack": "on", shared: "on" } },
      },
      cwd,
    );
    settings.saveProjectSetting("capabilityOverrides", { plugins: { shared: "off" } }, cwd);
    expect(effectiveProjectOverrides(settings, cwd)).toEqual({
      plugins: { "seedance-pack": "on", shared: "off" },
    });
  });

  test("no cwd → undefined; no overrides at all → undefined", () => {
    const settings = new SettingsManager(cwd, "full");
    expect(effectiveProjectOverrides(settings, undefined)).toBeUndefined();
    expect(effectiveProjectOverrides(settings, cwd)).toBeUndefined();
  });
});
