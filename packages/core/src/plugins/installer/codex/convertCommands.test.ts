import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyCodexCommands } from "./convertCommands.js";

describe("copyCodexCommands", () => {
  let src: string, dest: string;
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "cs-cmd-src-"));
    dest = mkdtempSync(join(tmpdir(), "cs-cmd-dest-"));
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  test("copies prompts/<name>.md into dest/commands (Codex prompts ARE CC commands)", async () => {
    mkdirSync(join(src, "prompts"), { recursive: true });
    writeFileSync(
      join(src, "prompts", "review.md"),
      "---\ndescription: review a PR\n---\nDo the review of $1.",
    );
    await copyCodexCommands(src, dest);
    const out = join(dest, "commands", "review.md");
    expect(existsSync(out)).toBe(true);
    // Body is preserved verbatim; runtime expansion handles the $1 placeholder.
    expect(readFileSync(out, "utf-8")).toContain("Do the review of $1.");
  });

  test("also folds an explicit commands/ dir into dest/commands", async () => {
    mkdirSync(join(src, "commands"), { recursive: true });
    writeFileSync(join(src, "commands", "ship.md"), "ship it");
    await copyCodexCommands(src, dest);
    expect(existsSync(join(dest, "commands", "ship.md"))).toBe(true);
  });

  test("commands/ wins over prompts/ on filename collision (explicit beats prompt)", async () => {
    mkdirSync(join(src, "prompts"), { recursive: true });
    mkdirSync(join(src, "commands"), { recursive: true });
    writeFileSync(join(src, "prompts", "dup.md"), "from prompts");
    writeFileSync(join(src, "commands", "dup.md"), "from commands");
    await copyCodexCommands(src, dest);
    expect(readFileSync(join(dest, "commands", "dup.md"), "utf-8")).toBe("from commands");
  });

  test("ignores non-.md files (Codex ignores them too)", async () => {
    mkdirSync(join(src, "prompts"), { recursive: true });
    writeFileSync(join(src, "prompts", "notes.txt"), "not a command");
    writeFileSync(join(src, "prompts", "ok.md"), "ok");
    await copyCodexCommands(src, dest);
    expect(existsSync(join(dest, "commands", "notes.txt"))).toBe(false);
    expect(existsSync(join(dest, "commands", "ok.md"))).toBe(true);
  });

  test("no-op when source has neither prompts nor commands", async () => {
    await copyCodexCommands(src, dest);
    expect(existsSync(join(dest, "commands"))).toBe(false);
  });

  test("rejects a prompt file symlink that escapes the plugin root", async () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "cs-cmd-outside-"));
    try {
      mkdirSync(join(src, "prompts"), { recursive: true });
      writeFileSync(join(outside, "private.md"), "must not be copied");
      symlinkSync(join(outside, "private.md"), join(src, "prompts", "leak.md"));
      await expect(copyCodexCommands(src, dest)).rejects.toThrow(
        "plugin command source escapes plugin dir",
      );
      expect(existsSync(join(dest, "commands", "leak.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a prompts directory symlink that escapes the plugin root", async () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "cs-cmd-dir-outside-"));
    try {
      writeFileSync(join(outside, "leak.md"), "must not be copied");
      symlinkSync(outside, join(src, "prompts"));
      await expect(copyCodexCommands(src, dest)).rejects.toThrow(
        "plugin command source escapes plugin dir",
      );
      expect(existsSync(join(dest, "commands"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
