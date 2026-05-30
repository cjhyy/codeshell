import { describe, test, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { assertCodeShellMarkdownPath } from "./safe-read.js";

// Regression: readSkillBody/readAgentBody fs.readFile'd any path the renderer
// sent, with no containment (review-2026-05-30, security). A crafted path like
// ../../../../etc/passwd could exfiltrate arbitrary files. The guard restricts
// reads to .md files living under a `.code-shell` directory.

describe("assertCodeShellMarkdownPath", () => {
  const userSkill = path.join(os.homedir(), ".code-shell", "skills", "s", "SKILL.md");
  const projectAgent = path.join("/work/proj", ".code-shell", "agents", "a.md");

  test("accepts a .md under a user .code-shell dir", () => {
    expect(() => assertCodeShellMarkdownPath(userSkill)).not.toThrow();
  });

  test("accepts a .md under a project .code-shell dir", () => {
    expect(() => assertCodeShellMarkdownPath(projectAgent)).not.toThrow();
  });

  test("rejects a path outside any .code-shell dir", () => {
    expect(() => assertCodeShellMarkdownPath("/etc/passwd")).toThrow();
  });

  test("rejects traversal that escapes .code-shell", () => {
    const evil = path.join(os.homedir(), ".code-shell", "skills", "..", "..", "..", "etc", "passwd");
    expect(() => assertCodeShellMarkdownPath(evil)).toThrow();
  });

  test("rejects a non-markdown file even under .code-shell", () => {
    const p = path.join(os.homedir(), ".code-shell", "skills", "s", "secret.key");
    expect(() => assertCodeShellMarkdownPath(p)).toThrow();
  });
});
