import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgents } from "./seed-defaults.js";

let home: string;
let agentSrc: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seed-home-"));
  agentSrc = mkdtempSync(join(tmpdir(), "seed-src-"));
  writeFileSync(join(agentSrc, "explorer.md"), "---\nname: explorer\n---\nbody");
  writeFileSync(join(agentSrc, "planner.md"), "---\nname: planner\n---\nbody");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(agentSrc, { recursive: true, force: true });
});

describe("seedAgents", () => {
  it("copies agent .md files into <home>/.code-shell/agents on first run", () => {
    const n = seedAgents(agentSrc, home);
    expect(n).toBe(2);
    const dest = join(home, ".code-shell", "agents");
    expect(existsSync(join(dest, "explorer.md"))).toBe(true);
    expect(existsSync(join(dest, "planner.md"))).toBe(true);
  });

  it("is idempotent — does not overwrite existing user agents", () => {
    const dest = join(home, ".code-shell", "agents");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "explorer.md"), "USER EDITED");
    const n = seedAgents(agentSrc, home);
    // explorer 已存在 → 跳过;planner 新增 → 1
    expect(n).toBe(1);
    expect(readdirSync(dest).sort()).toEqual(["explorer.md", "planner.md"]);
    // 用户编辑的 explorer 不被覆盖
    expect(readFileSync(join(dest, "explorer.md"), "utf-8")).toBe("USER EDITED");
  });

  it("returns 0 when source dir is missing (no throw)", () => {
    const n = seedAgents(join(agentSrc, "nonexistent"), home);
    expect(n).toBe(0);
  });
});
