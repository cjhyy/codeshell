import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentDefinitionsForCwd } from "../packages/core/src/engine/engine.ts";

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
