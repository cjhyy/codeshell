import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTool } from "../packages/core/src/tool-system/builtin/write.js";
import { editTool } from "../packages/core/src/tool-system/builtin/edit.js";

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
