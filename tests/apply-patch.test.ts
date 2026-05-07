/**
 * Conformance tests for the V4A apply-patch implementation.
 *
 * Each codex scenario has:
 *   - patch.txt          → the patch to apply
 *   - input/ (optional)  → initial workdir contents
 *   - expected/          → final workdir contents (whether or not the patch succeeded)
 *
 * For codex's behavior, expected/ matches input/ in rejection cases (because
 * the failure happens before any write). Our atomic semantics intentionally
 * diverge for scenario 015 — see the special case below.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { parsePatch } from "../src/tool-system/builtin/apply-patch/parser.js";
import { applyPatch } from "../src/tool-system/builtin/apply-patch/applier.js";
import { seekSequence } from "../src/tool-system/builtin/apply-patch/seek-sequence.js";

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "apply-patch");

// ─── Unit: seekSequence ───────────────────────────────────────────

describe("seekSequence", () => {
  it("finds an exact match", () => {
    expect(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false)).toBe(1);
  });

  it("ignores trailing whitespace", () => {
    expect(seekSequence(["foo   ", "bar\t"], ["foo", "bar"], 0, false)).toBe(0);
  });

  it("ignores leading and trailing whitespace", () => {
    expect(seekSequence(["    foo  ", "  bar"], ["foo", "bar"], 0, false)).toBe(0);
  });

  it("returns null when pattern is longer than input", () => {
    expect(seekSequence(["only"], ["a", "b", "c"], 0, false)).toBeNull();
  });

  it("normalizes Unicode quotes and dashes", () => {
    // Input has typographic chars; pattern has ASCII chars.
    expect(seekSequence(["\u2018hello\u2019 \u2014 world"], ["'hello' - world"], 0, false))
      .toBe(0);
  });

  it("returns start for empty pattern", () => {
    expect(seekSequence(["a", "b"], [], 3, false)).toBe(3);
  });

  it("with eof=true matches at end of file", () => {
    expect(seekSequence(["a", "b", "c", "d"], ["c", "d"], 0, true)).toBe(2);
  });
});

// ─── Unit: parsePatch ─────────────────────────────────────────────

describe("parsePatch", () => {
  it("parses an Add hunk", () => {
    const out = parsePatch(`*** Begin Patch
*** Add File: foo.txt
+hello
+world
*** End Patch`);
    expect(out.hunks).toHaveLength(1);
    expect(out.hunks[0]).toEqual({
      kind: "add",
      path: "foo.txt",
      contents: "hello\nworld\n",
    });
  });

  it("parses Delete + Update + rename in one patch", () => {
    const out = parsePatch(`*** Begin Patch
*** Delete File: dead.txt
*** Update File: src/old.ts
*** Move to: src/new.ts
@@ class Foo
-  bar() {}
+  baz() {}
*** End Patch`);
    expect(out.hunks).toHaveLength(2);
    expect(out.hunks[0].kind).toBe("delete");
    const update = out.hunks[1];
    if (update.kind !== "update") throw new Error("expected update");
    expect(update.path).toBe("src/old.ts");
    expect(update.movePath).toBe("src/new.ts");
    expect(update.chunks[0].changeContext).toBe("class Foo");
  });

  it("rejects missing begin marker", () => {
    expect(() => parsePatch("bad\n*** End Patch")).toThrow("Begin Patch");
  });

  it("rejects missing end marker", () => {
    expect(() => parsePatch("*** Begin Patch\nbad")).toThrow("End Patch");
  });

  it("rejects invalid hunk header", () => {
    expect(() => parsePatch(`*** Begin Patch
*** Wrong Action: foo
*** End Patch`)).toThrow("not a valid hunk header");
  });

  it("strips heredoc wrapper in lenient mode", () => {
    const wrapped = `<<'EOF'
*** Begin Patch
*** Add File: x.txt
+hi
*** End Patch
EOF`;
    const out = parsePatch(wrapped, "lenient");
    expect(out.hunks).toHaveLength(1);
  });

  it("allows missing @@ on first chunk", () => {
    const out = parsePatch(`*** Begin Patch
*** Update File: a.ts
 import foo
+bar
*** End Patch`);
    const u = out.hunks[0];
    if (u.kind !== "update") throw new Error("expected update");
    expect(u.chunks).toHaveLength(1);
    expect(u.chunks[0].changeContext).toBeUndefined();
    expect(u.chunks[0].oldLines).toEqual(["import foo"]);
    expect(u.chunks[0].newLines).toEqual(["import foo", "bar"]);
  });

  it("supports *** End of File marker", () => {
    const out = parsePatch(`*** Begin Patch
*** Update File: a.ts
@@
+last line
*** End of File
*** End Patch`);
    const u = out.hunks[0];
    if (u.kind !== "update") throw new Error("expected update");
    expect(u.chunks[0].isEndOfFile).toBe(true);
  });
});

// ─── Atomicity: behaviors beyond codex parity ─────────────────────

describe("applyPatch atomicity", () => {
  let workDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "apply-patch-atomic-"));
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("rejects a patch that touches the same path twice", async () => {
    const patch = `*** Begin Patch
*** Add File: dup.txt
+first
*** Add File: dup.txt
+second
*** End Patch`;
    const parsed = parsePatch(patch, "lenient");
    let threw = false;
    try {
      await applyPatch(parsed.hunks, { cwd: workDir });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("more than once");
    }
    expect(threw).toBe(true);
    // Nothing should have been written.
    expect(listFiles(workDir)).toEqual([]);
  });

  it("treats `Move to: <self>` as a degenerate update", async () => {
    const filePath = join(workDir, "self.txt");
    require("node:fs").writeFileSync(filePath, "hello\nworld\n");
    const patch = `*** Begin Patch
*** Update File: self.txt
*** Move to: self.txt
@@
 hello
-world
+earth
*** End Patch`;
    const parsed = parsePatch(patch, "lenient");
    await applyPatch(parsed.hunks, { cwd: workDir });
    expect(readFileSync(filePath, "utf-8")).toBe("hello\nearth\n");
  });
});

// ─── Conformance: 22 codex golden fixtures ────────────────────────

interface Scenario {
  name: string;
  dir: string;
  hasInput: boolean;
  hasExpected: boolean;
}

function loadScenarios(): Scenario[] {
  return readdirSync(FIXTURE_ROOT)
    .filter((name) => statSync(join(FIXTURE_ROOT, name)).isDirectory())
    .sort()
    .map((name) => {
      const dir = join(FIXTURE_ROOT, name);
      return {
        name,
        dir,
        hasInput: existsSync(join(dir, "input")),
        hasExpected: existsSync(join(dir, "expected")),
      };
    });
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  }
  if (existsSync(root)) walk(root);
  return out.sort();
}

describe("apply-patch fixtures", () => {
  let workDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "apply-patch-fixture-"));
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  for (const scenario of loadScenarios()) {
    it(scenario.name, async () => {
      if (scenario.hasInput) {
        cpSync(join(scenario.dir, "input"), workDir, { recursive: true });
      }
      const patchText = readFileSync(join(scenario.dir, "patch.txt"), "utf-8");

      // Run the patch, capturing failure. We intentionally do NOT assert
      // success/failure here — the source of truth is the on-disk state
      // compared against expected/.
      try {
        const parsed = parsePatch(patchText, "lenient");
        await applyPatch(parsed.hunks, { cwd: workDir });
      } catch {
        // Errors are expected in rejection cases. Atomic rollback should
        // leave workDir matching input/ (which equals expected/ for codex's
        // rejection scenarios).
      }

      // Scenario 015 — codex leaves partial writes (created.txt remains)
      // because it has no rollback. Our atomic semantics reject the whole
      // patch and produce an empty workdir, which differs from
      // expected/created.txt. Verify our stronger guarantee here and skip
      // the codex-parity comparison.
      if (scenario.name === "015_failure_after_partial_success_leaves_changes") {
        expect(listFiles(workDir)).toEqual([]);
        return;
      }

      const expectedFiles = listFiles(join(scenario.dir, "expected"));
      const actualFiles = listFiles(workDir);
      expect(actualFiles).toEqual(expectedFiles);

      for (const rel of expectedFiles) {
        const expected = readFileSync(join(scenario.dir, "expected", rel), "utf-8");
        const actual = readFileSync(join(workDir, rel), "utf-8");
        expect(actual).toBe(expected);
      }
    });
  }
});
