import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detect, pickIntent } from "../src/cli/commands/builtin/init/detect.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "init-detect-"));
}

describe("detect + pickIntent", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("classifies empty dir as 'empty'", () => {
    const d = detect(cwd);
    expect(d.hasCodeshell).toBe(false);
    expect(d.hasManifest).toBe(false);
    expect(d.hasSourceFiles).toBe(false);
    expect(d.hasReadme).toBe(false);
    expect(pickIntent(d)).toBe("empty");
  });

  it("classifies dir with only package.json as 'create'", () => {
    writeFileSync(join(cwd, "package.json"), "{}");
    const d = detect(cwd);
    expect(d.hasManifest).toBe(true);
    expect(pickIntent(d)).toBe("create");
  });

  it("classifies dir with only README as 'create'", () => {
    writeFileSync(join(cwd, "README.md"), "# hi");
    const d = detect(cwd);
    expect(d.hasReadme).toBe(true);
    expect(pickIntent(d)).toBe("create");
  });

  it("README detection is case-insensitive", () => {
    writeFileSync(join(cwd, "readme.md"), "# hi");
    const d = detect(cwd);
    expect(d.hasReadme).toBe(true);
  });

  it("classifies dir with TS source files as 'create'", () => {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "main.ts"), "export {}");
    const d = detect(cwd);
    expect(d.hasSourceFiles).toBe(true);
    expect(pickIntent(d)).toBe("create");
  });

  it("classifies dir with root-level source files as 'create'", () => {
    writeFileSync(join(cwd, "script.py"), "print('hi')");
    const d = detect(cwd);
    expect(d.hasSourceFiles).toBe(true);
    expect(pickIntent(d)).toBe("create");
  });

  it("ignores node_modules when scanning for source files", () => {
    mkdirSync(join(cwd, "node_modules"));
    mkdirSync(join(cwd, "node_modules", "foo"));
    writeFileSync(join(cwd, "node_modules", "foo", "index.js"), "module.exports = {}");
    const d = detect(cwd);
    expect(d.hasSourceFiles).toBe(false);
    expect(pickIntent(d)).toBe("empty");
  });

  it("ignores dotfiles when scanning for source files", () => {
    writeFileSync(join(cwd, ".eslintrc.js"), "module.exports = {}");
    const d = detect(cwd);
    expect(d.hasSourceFiles).toBe(false);
  });

  it("classifies CLAUDE.md presence as 'migrate'", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "# claude rules");
    const d = detect(cwd);
    expect(d.hasClaude).toBe(true);
    expect(pickIntent(d)).toBe("migrate");
  });

  it("classifies .cursorrules presence as 'migrate'", () => {
    writeFileSync(join(cwd, ".cursorrules"), "rules");
    const d = detect(cwd);
    expect(d.hasCursorRules).toBe(true);
    expect(pickIntent(d)).toBe("migrate");
  });

  it("classifies .cursor/rules/ dir as 'migrate'", () => {
    mkdirSync(join(cwd, ".cursor"));
    mkdirSync(join(cwd, ".cursor", "rules"));
    const d = detect(cwd);
    expect(d.hasCursorRulesDir).toBe(true);
    expect(pickIntent(d)).toBe("migrate");
  });

  it("classifies CODESHELL.md presence as 'improve' even when other AI configs exist", () => {
    writeFileSync(join(cwd, "CODESHELL.md"), "# existing");
    writeFileSync(join(cwd, "CLAUDE.md"), "# claude rules");
    writeFileSync(join(cwd, "package.json"), "{}");
    const d = detect(cwd);
    expect(pickIntent(d)).toBe("improve");
  });

  it("improve beats migrate beats create beats empty (priority order)", () => {
    // empty
    expect(pickIntent(detect(cwd))).toBe("empty");
    // → create
    writeFileSync(join(cwd, "package.json"), "{}");
    expect(pickIntent(detect(cwd))).toBe("create");
    // → migrate
    writeFileSync(join(cwd, "CLAUDE.md"), "# rules");
    expect(pickIntent(detect(cwd))).toBe("migrate");
    // → improve
    writeFileSync(join(cwd, "CODESHELL.md"), "# done");
    expect(pickIntent(detect(cwd))).toBe("improve");
  });
});
