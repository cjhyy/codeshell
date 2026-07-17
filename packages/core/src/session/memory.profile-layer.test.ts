import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-mem-profile-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("buildInjectionIndex profile layer", () => {
  test("orders sections global → digital-human → project", () => {
    const globalMemory = new MemoryManager({ baseDir: home });
    const profileDir = join(home, "profiles", "seedance");
    const profileMemory = new MemoryManager({ baseDir: profileDir });
    const projectDir = join(home, "ws");
    const projectMemory = new MemoryManager({ baseDir: home, projectDir });

    globalMemory.save({
      name: "g",
      description: "global fact",
      type: "user",
      content: "global body",
    });
    profileMemory.save({
      name: "p",
      description: "digital-human fact",
      type: "user",
      content: "digital-human body",
    });
    projectMemory.save({
      name: "l",
      description: "project fact",
      type: "user",
      content: "project body",
    });

    const index = MemoryManager.buildInjectionIndex({
      baseDir: home,
      projectDir,
      profileDir,
    });
    const globalPosition = index.indexOf("global fact");
    const profilePosition = index.indexOf("digital-human fact");
    const projectPosition = index.indexOf("project fact");
    expect(globalPosition).toBeGreaterThan(-1);
    expect(profilePosition).toBeGreaterThan(globalPosition);
    expect(projectPosition).toBeGreaterThan(profilePosition);
    expect(index).toContain("## Digital-human memories");
    expect(index).toContain("location = global, profile, or project");
  });

  test("no profileDir → no digital-human section", () => {
    new MemoryManager({ baseDir: home }).save({
      name: "g",
      description: "global fact",
      type: "user",
      content: "global body",
    });
    const index = MemoryManager.buildInjectionIndex({ baseDir: home });
    expect(index).not.toContain("Digital-human memories");
    expect(index).toContain("location = global or project");
    expect(index).not.toContain("location = global, profile");
  });
});
