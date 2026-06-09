import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentDefinitionsForCwd } from "../packages/core/src/engine/engine.ts";

// loadAgentDefinitionsForCwd merges global ~/.code-shell/agents with the cwd's,
// so isolate HOME + CODE_SHELL_HOME to keep the host user's global agents from
// leaking into "empty registry" assertions.
let fakeHome: string;
let savedHome: string | undefined;
let savedCsHome: string | undefined;
beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "eng-agents-home-"));
  savedHome = process.env.HOME;
  savedCsHome = process.env.CODE_SHELL_HOME;
  process.env.HOME = fakeHome;
  process.env.CODE_SHELL_HOME = join(fakeHome, ".code-shell");
});
afterAll(() => {
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  if (savedCsHome !== undefined) process.env.CODE_SHELL_HOME = savedCsHome;
  else delete process.env.CODE_SHELL_HOME;
  rmSync(fakeHome, { recursive: true, force: true });
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eng-agents-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadAgentDefinitionsForCwd", () => {
  it("loads from <cwd>/.code-shell/agents", () => {
    mkdirSync(join(dir, ".code-shell", "agents"), { recursive: true });
    writeFileSync(join(dir, ".code-shell", "agents", "r.md"), "---\nname: r\ndescription: d\n---\nBody.");
    const reg = loadAgentDefinitionsForCwd(dir);
    expect(reg.has("r")).toBe(true);
  });

  it("returns an empty registry when the dir is absent", () => {
    const reg = loadAgentDefinitionsForCwd(dir);
    expect(reg.list()).toEqual([]);
  });
});
