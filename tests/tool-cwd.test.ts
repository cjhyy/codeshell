import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globTool } from "../packages/core/src/tool-system/builtin/glob.js";
import { grepTool } from "../packages/core/src/tool-system/builtin/grep.js";
import { applyPatchTool } from "@cjhyy/code-shell-capability-coding";
import { replTool } from "../packages/core/src/tool-system/builtin/repl.js";
import { skillTool } from "../packages/core/src/tool-system/builtin/skill.js";
import type { ToolContext } from "../packages/core/src/tool-system/context.js";

// A4 regression tests: every builtin tool must resolve relative paths
// against ToolContext.cwd, not process.cwd(). Each test creates two
// distinct temp dirs A and B, points the host process at A, points
// ToolContext.cwd at B, and asserts the tool reads/writes B.
//
// We only set the `cwd` field on the partial ToolContext mock. The
// tools we cover here don't touch llmConfig / toolRegistry / etc.
function ctxAt(cwd: string): ToolContext {
  return { cwd } as unknown as ToolContext;
}

let dirA: string;
let dirB: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
});

afterAll(() => {
  process.chdir(originalCwd);
});

beforeEach(async () => {
  dirA = await mkdtemp(join(tmpdir(), "a4-A-"));
  dirB = await mkdtemp(join(tmpdir(), "a4-B-"));
  process.chdir(dirA);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

describe("A4 — Glob resolves pattern against ctx.cwd", () => {
  it("matches files in ctx.cwd, not process.cwd", async () => {
    // Different file in each directory; pattern looks for marker.
    await writeFile(join(dirA, "marker-a.txt"), "in A");
    await writeFile(join(dirB, "marker-b.txt"), "in B");

    const result = await globTool({ pattern: "marker-*.txt" }, ctxAt(dirB));

    expect(result).toContain("marker-b.txt");
    expect(result).not.toContain("marker-a.txt");
  });

  it("resolves relative args.path against ctx.cwd", async () => {
    await mkdir(join(dirB, "sub"), { recursive: true });
    await writeFile(join(dirB, "sub", "x.txt"), "in B sub");
    await mkdir(join(dirA, "sub"), { recursive: true });
    await writeFile(join(dirA, "sub", "y.txt"), "in A sub");

    const result = await globTool(
      { pattern: "*.txt", path: "sub" },
      ctxAt(dirB),
    );

    expect(result).toContain("x.txt");
    expect(result).not.toContain("y.txt");
  });
});

describe("A4 — Grep resolves search path against ctx.cwd", () => {
  it("searches in ctx.cwd, not process.cwd", async () => {
    await writeFile(join(dirA, "fa.txt"), "needle-A unique");
    await writeFile(join(dirB, "fb.txt"), "needle-B unique");

    const result = await grepTool(
      { pattern: "needle-", output_mode: "files_with_matches" },
      ctxAt(dirB),
    );

    expect(result).toContain("fb.txt");
    expect(result).not.toContain("fa.txt");
  });
});

describe("A4 — ApplyPatch resolves hunk paths against ctx.cwd", () => {
  it("writes file into ctx.cwd, not process.cwd", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+hello from B",
      "*** End Patch",
    ].join("\n");

    const result = await applyPatchTool({ patch }, ctxAt(dirB));

    expect(result).toContain("Patch applied successfully");
    const content = await readFile(join(dirB, "created.txt"), "utf-8");
    // applier appends a trailing newline.
    expect(content.trim()).toBe("hello from B");

    // The file should NOT exist in dirA.
    let aExists = false;
    try {
      await readFile(join(dirA, "created.txt"));
      aExists = true;
    } catch {
      /* expected */
    }
    expect(aExists).toBe(false);
  });
});

describe("A4 — REPL runs child process in ctx.cwd", () => {
  it("node -e process.cwd() reflects ctx.cwd", async () => {
    const result = await replTool(
      { language: "javascript", code: "process.stdout.write(process.cwd())" },
      ctxAt(dirB),
    );

    // macOS prepends /private to /var/folders/... tmpdir paths when
    // reported by process.cwd() inside a child, so compare with a
    // suffix match instead of strict equality.
    const dirBTail = dirB.replace(/^\/private/, "");
    expect(result.endsWith(dirBTail)).toBe(true);
  });
});

describe("A4 — Skill scans skills from ctx.cwd", () => {
  it("finds skill in ctx.cwd, not process.cwd", async () => {
    // Scanner walks <cwd>/.code-shell/skills/<name>/SKILL.md.
    const skillA = join(dirA, ".code-shell", "skills", "from-a");
    const skillB = join(dirB, ".code-shell", "skills", "from-b");
    await mkdir(skillA, { recursive: true });
    await mkdir(skillB, { recursive: true });
    await writeFile(
      join(skillA, "SKILL.md"),
      "---\nname: from-a\ndescription: in A\n---\nA body",
    );
    await writeFile(
      join(skillB, "SKILL.md"),
      "---\nname: from-b\ndescription: in B\n---\nB body",
    );

    const result = await skillTool({ skill: "from-b" }, ctxAt(dirB));
    expect(result).toContain("B body");

    const notFound = await skillTool({ skill: "from-a" }, ctxAt(dirB));
    expect(notFound).toMatch(/not found/);
  });
});

describe("A4 — fallback to process.cwd when ctx is undefined", () => {
  it("Glob still works without ctx", async () => {
    process.chdir(dirB);
    await writeFile(join(dirB, "fallback.txt"), "ok");
    const result = await globTool({ pattern: "fallback.txt" });
    expect(result).toContain("fallback.txt");
  });
});
