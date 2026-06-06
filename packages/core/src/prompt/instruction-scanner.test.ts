import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanInstructions, combineInstructions } from "./instruction-scanner.js";

// TODO §8.2 — AGENTS.md hierarchy: deep-dir instructions layer over shallow
// (root→cwd ordering so nearest wins), AGENTS.local.md is an un-versioned
// local override, and entries carry scope/depth for ordered injection.

const dirs: string[] = [];
function tmpRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cs-instr-")));
  dirs.push(d);
  // Make it a git repo so findGitRoot resolves and depth is relative to it.
  execSync("git init -q", { cwd: d });
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scanInstructions hierarchy (AGENTS.md)", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-instr-home-"));
    dirs.push(home);
    prevHome = process.env.HOME;
    process.env.HOME = home; // isolate user-level instructions
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  test("deeper directory instructions come AFTER shallow ones (nearest wins on conflict)", () => {
    const root = tmpRepo();
    const sub = join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "ROOT RULE");
    writeFileSync(join(sub, "AGENTS.md"), "SUB RULE");

    const entries = scanInstructions(sub, { compatFileNames: ["AGENTS.md"] });
    const projectEntries = entries.filter((e) => e.source === "project");
    expect(projectEntries.map((e) => e.content)).toEqual(["ROOT RULE", "SUB RULE"]);
    // depth increases toward cwd.
    expect(projectEntries[0].depth).toBeLessThan(projectEntries[1].depth);

    // Combined output places the deeper (nearest) instruction last.
    const combined = combineInstructions(entries);
    expect(combined.indexOf("ROOT RULE")).toBeLessThan(combined.indexOf("SUB RULE"));
  });

  test("AGENTS.local.md is picked up as an un-versioned local override", () => {
    const root = tmpRepo();
    writeFileSync(join(root, "AGENTS.md"), "VERSIONED");
    writeFileSync(join(root, "AGENTS.local.md"), "LOCAL ONLY");

    const entries = scanInstructions(root, { compatFileNames: ["AGENTS.md"] });
    const local = entries.find((e) => e.source === "local");
    expect(local?.content).toBe("LOCAL ONLY");
    // local sorts after project in the combined output (highest priority/last).
    const combined = combineInstructions(entries);
    expect(combined.indexOf("VERSIONED")).toBeLessThan(combined.indexOf("LOCAL ONLY"));
    expect(combined).toContain("local override");
  });

  test("scope labels distinguish project depth vs local", () => {
    const root = tmpRepo();
    writeFileSync(join(root, "AGENTS.md"), "P");
    writeFileSync(join(root, "AGENTS.local.md"), "L");
    const combined = combineInstructions(
      scanInstructions(root, { compatFileNames: ["AGENTS.md"] }),
    );
    expect(combined).toContain("project (depth 0)");
    expect(combined).toContain("local override (depth 0)");
  });

  test("the scan stops at the git root (does not climb above the repo)", () => {
    const root = tmpRepo();
    // A file ABOVE the repo root must not be included.
    // (tmpdir parent is outside the repo; we can't write AGENTS.md to every
    // ancestor safely, so assert no project entry has a path outside root.)
    writeFileSync(join(root, "AGENTS.md"), "ROOT");
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    const entries = scanInstructions(sub, { compatFileNames: ["AGENTS.md"] });
    for (const e of entries.filter((x) => x.source === "project")) {
      expect(e.path.startsWith(root)).toBe(true);
    }
  });
});
