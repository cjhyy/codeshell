import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("@cjhyy/code-shell-core", () => ({
  addMarketplace: async () => ({ ok: false, error: "mocked" }),
}));

const { seedAgents, seedMarketplacesWith } = await import("./seed-defaults.js");

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

describe("seedMarketplaces", () => {
  it("writes status for skipped, added, and failed marketplace seeds", async () => {
    const seedFile = join(home, "known-marketplaces-seed.json");
    writeFileSync(
      seedFile,
      JSON.stringify({
        official: { source: "github", repo: "cjhyy/mimi-plugins" },
        broken: { source: "git", url: "https://example.invalid/broken.git" },
        existing: { source: "github", repo: "cjhyy/existing" },
      }),
    );
    const knownDir = join(home, ".code-shell", "plugins");
    mkdirSync(knownDir, { recursive: true });
    writeFileSync(
      join(knownDir, "known_marketplaces.json"),
      JSON.stringify({ existing: { source: { source: "github", repo: "cjhyy/existing" } } }),
    );

    const attempted = await seedMarketplacesWith(seedFile, home, async (name, _source) => {
      if (name === "broken") return { ok: false, error: "clone failed" };
      return {
        ok: true,
        name,
        marketplace: { name, plugins: [] },
        replaced: false,
      };
    });

    expect(attempted).toEqual(["official", "broken"]);
    const status = JSON.parse(
      readFileSync(join(knownDir, "seed_marketplaces_status.json"), "utf-8"),
    );
    expect(status.added).toEqual(["official"]);
    expect(status.skipped).toEqual(["existing"]);
    expect(status.failed).toEqual([{ name: "broken", error: "clone failed" }]);
  });
});
