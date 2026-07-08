import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _resetCodeShellMarkdownPathAllowlistForTests,
  assertCodeShellMarkdownPath,
  rememberCodeShellMarkdownPath,
} from "./safe-read.js";

// Regression: readSkillBody/readAgentBody fs.readFile'd any path the renderer
// sent, with no containment (review-2026-05-30, security). A crafted path like
// ../../../../etc/passwd could exfiltrate arbitrary files. The guard restricts
// reads to .md files living under a `.code-shell` directory.

describe("assertCodeShellMarkdownPath", () => {
  let root: string;

  function seedFile(...parts: string[]): string {
    const filePath = path.join(root, ...parts);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "# test\n", "utf-8");
    return filePath;
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "safe-read-"));
    _resetCodeShellMarkdownPathAllowlistForTests();
  });

  afterEach(() => {
    _resetCodeShellMarkdownPathAllowlistForTests();
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts a .md under a user .code-shell dir", () => {
    const userSkill = seedFile("home", ".code-shell", "skills", "s", "SKILL.md");
    rememberCodeShellMarkdownPath(userSkill);
    expect(() => assertCodeShellMarkdownPath(userSkill)).not.toThrow();
  });

  test("accepts a .md under a project .code-shell dir", () => {
    const projectAgent = seedFile("work", "proj", ".code-shell", "agents", "a.md");
    rememberCodeShellMarkdownPath(projectAgent);
    expect(() => assertCodeShellMarkdownPath(projectAgent)).not.toThrow();
  });

  test("rejects a path outside any .code-shell dir", () => {
    expect(() => assertCodeShellMarkdownPath("/etc/passwd")).toThrow();
  });

  test("rejects an unlisted markdown path under an arbitrary .code-shell dir", () => {
    const forged = seedFile("evil", ".code-shell", "skills", "s", "SKILL.md");
    expect(() => assertCodeShellMarkdownPath(forged)).toThrow();
  });

  test("rejects traversal that escapes .code-shell", () => {
    const evil = path.join(
      root,
      "home",
      ".code-shell",
      "skills",
      "..",
      "..",
      "..",
      "etc",
      "passwd",
    );
    expect(() => assertCodeShellMarkdownPath(evil)).toThrow();
  });

  test("rejects a non-markdown file even under .code-shell", () => {
    const p = seedFile("home", ".code-shell", "skills", "s", "secret.key");
    expect(() => assertCodeShellMarkdownPath(p)).toThrow();
  });

  test("accepts a .code-shell/skills symlink that resolves into .agents/skills (npx skills add)", () => {
    // npx skills add installs to .agents/skills and symlinks .code-shell/skills/<name> → it.
    const realDir = path.join(root, "proj", ".agents", "skills", "s");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(path.join(realDir, "SKILL.md"), "# test\n", "utf-8");
    const linkParent = path.join(root, "proj", ".code-shell", "skills");
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(realDir, path.join(linkParent, "s"), "dir");
    const linkedFile = path.join(linkParent, "s", "SKILL.md");
    rememberCodeShellMarkdownPath(linkedFile);
    expect(() => assertCodeShellMarkdownPath(linkedFile)).not.toThrow();
  });

  test("rejects a .code-shell symlink that resolves outside both roots", () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "SKILL.md"), "# evil\n", "utf-8");
    const linkParent = path.join(root, "home", ".code-shell", "skills");
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(outside, path.join(linkParent, "s"), "dir");
    expect(() =>
      assertCodeShellMarkdownPath(path.join(linkParent, "s", "SKILL.md")),
    ).toThrow();
  });
});
