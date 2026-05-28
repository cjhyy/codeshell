import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTool } from "../packages/core/src/tool-system/builtin/write.js";
import { editTool } from "../packages/core/src/tool-system/builtin/edit.js";
import { readTool } from "../packages/core/src/tool-system/builtin/read.js";
import { globTool } from "../packages/core/src/tool-system/builtin/glob.js";
import { grepTool } from "../packages/core/src/tool-system/builtin/grep.js";

/**
 * Task 6 — verify the file tools actually consult PathPolicy when called
 * with a ToolContext (the LLM-driven path). The classifier itself is unit-
 * tested in path-policy.test.ts; this file proves the wire-up.
 *
 * To keep the test self-contained, we synthesize the minimum ctx shape the
 * tools touch (`.cwd`). The cast is intentional — only `cwd` matters here.
 */

function ctx(cwd: string): { cwd: string } {
  return { cwd };
}

describe("Write tool — PathPolicy wired", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "codeshell-pp-write-ws-"));
    outside = mkdtempSync(join(tmpdir(), "codeshell-pp-write-out-"));
    delete process.env.CODESHELL_PATH_POLICY;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("in-workspace write succeeds", async () => {
    const target = join(workspace, "ok.txt");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await writeTool({ file_path: target, content: "hi" }, ctx(workspace) as any);
    expect(out).toContain("Successfully wrote");
    expect(existsSync(target)).toBe(true);
  });

  test("outside-workspace write is refused with policy message", async () => {
    const target = join(outside, "leaked.txt");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await writeTool({ file_path: target, content: "hi" }, ctx(workspace) as any);
    expect(out.toLowerCase()).toMatch(/approval|denied|blocked|outside|path policy/);
    // Sanity: the file must NOT have been written.
    expect(existsSync(target)).toBe(false);
  });

  test("write to a .env file inside workspace is denied", async () => {
    const target = join(workspace, ".env");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await writeTool({ file_path: target, content: "SECRET=x" }, ctx(workspace) as any);
    expect(out).toContain("blocked by path policy");
    expect(existsSync(target)).toBe(false);
  });

  test("CODESHELL_PATH_POLICY=off lets outside-workspace write through", async () => {
    process.env.CODESHELL_PATH_POLICY = "off";
    const target = join(outside, "rollback.txt");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await writeTool({ file_path: target, content: "hi" }, ctx(workspace) as any);
    expect(out).toContain("Successfully wrote");
    expect(existsSync(target)).toBe(true);
  });

  test("legacy callers without ctx are unaffected (bypass)", async () => {
    // Calling writeTool() without ctx must not engage PathPolicy — otherwise
    // every existing standalone test / script would break. The env-flag
    // rollback path covers the LLM-driven side.
    const target = join(outside, "legacy.txt");
    const out = await writeTool({ file_path: target, content: "hi" });
    expect(out).toContain("Successfully wrote");
    expect(existsSync(target)).toBe(true);
  });
});

describe("Edit tool — PathPolicy wired", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "codeshell-pp-edit-ws-"));
    outside = mkdtempSync(join(tmpdir(), "codeshell-pp-edit-out-"));
    delete process.env.CODESHELL_PATH_POLICY;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("in-workspace edit succeeds", async () => {
    const target = join(workspace, "x.txt");
    writeFileSync(target, "hello world");
    const out = await editTool(
      { file_path: target, old_string: "world", new_string: "there" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx(workspace) as any,
    );
    expect(out).toContain("Successfully");
  });

  test("outside-workspace edit is refused", async () => {
    const target = join(outside, "x.txt");
    writeFileSync(target, "hello world");
    const out = await editTool(
      { file_path: target, old_string: "world", new_string: "there" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx(workspace) as any,
    );
    expect(out.toLowerCase()).toMatch(/approval|blocked|outside|path policy/);
    // File must be untouched.
    const fs = await import("node:fs/promises");
    expect(await fs.readFile(target, "utf-8")).toBe("hello world");
  });
});

describe("Read tool — PathPolicy wired", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "codeshell-pp-read-ws-"));
    outside = mkdtempSync(join(tmpdir(), "codeshell-pp-read-out-"));
    delete process.env.CODESHELL_PATH_POLICY;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("in-workspace read passes through", async () => {
    const target = join(workspace, "ok.txt");
    writeFileSync(target, "hello");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await readTool({ file_path: target }, ctx(workspace) as any);
    expect(out).toContain("hello");
  });

  test("outside-workspace read is refused", async () => {
    const target = join(outside, "leaked.txt");
    writeFileSync(target, "secret-contents");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await readTool({ file_path: target }, ctx(workspace) as any);
    expect(out.toLowerCase()).toMatch(/approval|outside|path policy/);
    // Critical: the body must NOT appear in the error message.
    expect(out).not.toContain("secret-contents");
  });

  test("legacy caller without ctx still works (bypass)", async () => {
    const target = join(outside, "legacy.txt");
    writeFileSync(target, "legacy");
    const out = await readTool({ file_path: target });
    expect(out).toContain("legacy");
  });
});

describe("Glob tool — PathPolicy wired", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "codeshell-pp-glob-ws-"));
    outside = mkdtempSync(join(tmpdir(), "codeshell-pp-glob-out-"));
    writeFileSync(join(outside, "a.txt"), "x");
    writeFileSync(join(outside, "b.txt"), "y");
    delete process.env.CODESHELL_PATH_POLICY;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("Glob with outside-workspace path is refused", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await globTool({ pattern: "*.txt", path: outside }, ctx(workspace) as any);
    expect(out.toLowerCase()).toMatch(/approval|outside|path policy/);
    // Must not have enumerated the files — names must not leak.
    expect(out).not.toContain("a.txt");
    expect(out).not.toContain("b.txt");
  });
});

describe("Grep tool — PathPolicy wired", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "codeshell-pp-grep-ws-"));
    outside = mkdtempSync(join(tmpdir(), "codeshell-pp-grep-out-"));
    writeFileSync(join(outside, "x.txt"), "MAGIC_TOKEN_SHOULD_NOT_LEAK");
    delete process.env.CODESHELL_PATH_POLICY;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("Grep with outside-workspace path is refused", async () => {
    const out = await grepTool(
      { pattern: "MAGIC_TOKEN_SHOULD_NOT_LEAK", path: outside },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx(workspace) as any,
    );
    expect(out.toLowerCase()).toMatch(/approval|outside|path policy/);
    expect(out).not.toContain("MAGIC_TOKEN_SHOULD_NOT_LEAK");
  });
});
