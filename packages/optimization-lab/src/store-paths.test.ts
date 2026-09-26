import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labRoot, projectKey } from "./store-paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("store paths", () => {
  test("keeps lab data under the isolated CodeShell home", () => {
    const cwd = mkdtempSync(join(tmpdir(), "optlab-paths-"));
    roots.push(cwd);
    const home = process.env.CODE_SHELL_HOME ?? process.env.CODE_SHELL_TEST_HOME;
    expect(home).toBeTruthy();
    expect(labRoot(cwd).startsWith(join(home!, "optimization-lab"))).toBe(true);
  });

  test("gives a symlinked project the same key as its real path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "optlab-paths-"));
    roots.push(cwd);
    const alias = `${cwd}-alias`;
    symlinkSync(cwd, alias);
    roots.push(alias);
    expect(projectKey(alias)).toBe(projectKey(cwd));
    expect(projectKey(cwd)).toMatch(/^[0-9a-f]{16}$/);
  });
});
