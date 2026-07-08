import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const probeFiles = [
  join(repoRoot, "packages", "core", "src", "__lint_boundary_dynamic_probe__.ts"),
  join(repoRoot, "packages", "core", "src", "__lint_boundary_relative_probe__.ts"),
  join(
    repoRoot,
    "packages",
    "desktop",
    "src",
    "renderer",
    "__lint_boundary_dynamic_probe__.tsx",
  ),
];

describe("ESLint CodeShell package boundary guards", () => {
  it("rejects dynamic and relative runtime imports across package boundaries", () => {
    writeFileSync(
      probeFiles[0]!,
      [
        "export async function loadTui() {",
        '  return import("@cjhyy/code-shell-tui");',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      probeFiles[1]!,
      ['import "../../tui/src/index";', "", "export const marker = true;", ""].join("\n"),
    );
    writeFileSync(
      probeFiles[2]!,
      [
        "export async function loadCore() {",
        '  return import("@cjhyy/code-shell-core");',
        "}",
        "",
      ].join("\n"),
    );

    try {
      const result = spawnSync("bunx", ["eslint", ...probeFiles], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).not.toBe(0);
      expect(output).toContain("core must not import tui");
      expect(output).toContain("renderer must not import codeshell packages at runtime");
    } finally {
      for (const file of probeFiles) {
        rmSync(file, { force: true });
      }
    }
  });
});
