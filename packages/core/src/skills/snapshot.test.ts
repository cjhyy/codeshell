import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SKILL_MARKDOWN_BYTES } from "./management.js";
import { invalidateSkillCache, scanSkills } from "./scanner.js";
import { readSkillSnapshot } from "./snapshot.js";

const NAME = "optlab-snapshot-probe";
const MD =
  "---\nname: optlab-snapshot-probe\ndescription: Probe skill\n---\n# Steps\n1. Cite sources.\n";
const roots: string[] = [];

function project(): { cwd: string; skillDir: string; filePath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "optlab-snapshot-"));
  roots.push(cwd);
  const skillDir = join(cwd, ".code-shell", "skills", NAME);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.md");
  writeFileSync(filePath, MD);
  invalidateSkillCache();
  return { cwd, skillDir, filePath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  invalidateSkillCache();
});

describe("readSkillSnapshot", () => {
  test("returns full markdown, split frontmatter/body and a bundle revision", () => {
    const { cwd, filePath } = project();
    expect(readSkillSnapshot(NAME, cwd)).toEqual({
      name: NAME,
      source: "project",
      filePath,
      markdown: MD,
      frontmatter: { name: NAME, description: "Probe skill" },
      body: "# Steps\n1. Cite sources.\n",
      revisionKind: "bundle",
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
      extraFiles: [],
    });
  });

  test("returns null for an unknown skill", () => {
    expect(readSkillSnapshot("optlab-no-such-skill", project().cwd)).toBeNull();
  });

  test("lists extra bundle files and includes their content in the revision", () => {
    const { cwd, skillDir } = project();
    mkdirSync(join(skillDir, "scripts"));
    const script = join(skillDir, "scripts", "run.sh");
    writeFileSync(script, "echo hi\n");
    const before = readSkillSnapshot(NAME, cwd)!;
    expect(before.extraFiles).toEqual(["scripts/run.sh"]);
    writeFileSync(script, "echo goodbye\n");
    expect(readSkillSnapshot(NAME, cwd)!.revision).not.toBe(before.revision);
  });

  test("reads current markdown even when the scanner has cached the old body", () => {
    const { cwd, filePath } = project();
    const before = readSkillSnapshot(NAME, cwd)!;
    const changed = MD.replace("Cite sources.", "Cite every source.");
    writeFileSync(filePath, changed);
    const after = readSkillSnapshot(NAME, cwd)!;
    expect(after.revision).not.toBe(before.revision);
    expect(after.markdown).toBe(changed);
    expect(after.body).toBe("# Steps\n1. Cite every source.\n");
  });

  test("marks extra files unknown when only the safe markdown can be read", () => {
    const { cwd, skillDir, filePath } = project();
    symlinkSync(filePath, join(skillDir, "alias.md"));
    const snapshot = readSkillSnapshot(NAME, cwd)!;
    expect(snapshot.revisionKind).toBe("markdown");
    expect(snapshot.revision).toBe(createHash("sha256").update(MD).digest("hex"));
    expect(snapshot.extraFiles).toBeNull();
    expect(snapshot.markdown).toBe(MD);
  });

  test("never follows a symlinked SKILL.md in a markdown-only fallback", () => {
    const { cwd, skillDir, filePath } = project();
    scanSkills(cwd);
    const target = join(skillDir, "target.md");
    writeFileSync(target, MD);
    rmSync(filePath);
    symlinkSync(target, filePath);
    expect(() => readSkillSnapshot(NAME, cwd)).toThrow();
  });

  test("rejects a non-regular SKILL.md in a markdown-only fallback", () => {
    const { cwd, filePath } = project();
    scanSkills(cwd);
    rmSync(filePath);
    mkdirSync(filePath);
    expect(() => readSkillSnapshot(NAME, cwd)).toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "rejects a FIFO replacing cached SKILL.md without blocking the worker",
    () => {
      const { cwd, filePath } = project();
      const script = `
        import { execFileSync } from "node:child_process";
        import { rmSync } from "node:fs";
        import { readSkillSnapshot } from ${JSON.stringify(join(import.meta.dir, "snapshot.ts"))};
        if (!readSkillSnapshot(${JSON.stringify(NAME)}, ${JSON.stringify(cwd)})) {
          throw new Error("fixture was not discovered");
        }
        rmSync(${JSON.stringify(filePath)});
        execFileSync("mkfifo", [${JSON.stringify(filePath)}]);
        let rejected = false;
        try { readSkillSnapshot(${JSON.stringify(NAME)}, ${JSON.stringify(cwd)}); }
        catch { rejected = true; }
        if (!rejected) throw new Error("FIFO was accepted");
        console.log("FIFO rejected");
      `;
      // A separate, bounded process makes the regression fail instead of
      // hanging the entire test runner in a blocking open(2).
      const child = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
        env: { ...process.env, HOME: cwd, USERPROFILE: cwd },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stderr).toBe("");
      expect(child.stdout.trim()).toBe("FIFO rejected");
    },
    10_000,
  );

  test("rejects oversized markdown instead of falling back around the bundle limit", () => {
    const { cwd, filePath } = project();
    scanSkills(cwd);
    writeFileSync(filePath, "x".repeat(MAX_SKILL_MARKDOWN_BYTES + 1));
    expect(() => readSkillSnapshot(NAME, cwd)).toThrow();
  });

  test.each([
    ["empty markdown", ""],
    ["NUL bytes", "# Steps\n\0"],
    ["unclosed frontmatter", "---\nname: probe\n"],
    ["invalid YAML", "---\nname: probe\n  invalid: nested\n---\nBody\n"],
    ["list frontmatter", "---\n- name\n- description\n---\nBody\n"],
    ["invalid name type", "---\nname: 123\n---\nBody\n"],
    ["invalid description type", "---\ndescription: false\n---\nBody\n"],
  ])("rejects %s instead of accepting a markdown-only revision", (_label, markdown) => {
    const { cwd, skillDir, filePath } = project();
    scanSkills(cwd);
    writeFileSync(filePath, markdown);
    // Force the bundle to be unmanageable independently of markdown validation.
    symlinkSync(filePath, join(skillDir, "alias.md"));
    expect(() => readSkillSnapshot(NAME, cwd)).toThrow();
  });
});
