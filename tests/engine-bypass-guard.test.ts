import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const temporaryBypassFile = join(
  repoRoot,
  "packages",
  "tui",
  "src",
  "__engine_bypass_guard_tmp__.ts",
);

describe("check-no-engine-bypass", () => {
  it("fails when an unauthorized package source file constructs Engine directly", () => {
    writeFileSync(
      temporaryBypassFile,
      [
        'import { Engine } from "@cjhyy/code-shell-core";',
        "",
        "const engine = new Engine({} as any);",
        "void engine;",
        "",
      ].join("\n"),
    );

    try {
      const result = spawnSync("bash", ["scripts/check-no-engine-bypass.sh"], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unauthorized 'new Engine('");
      expect(result.stderr).toContain("__engine_bypass_guard_tmp__.ts");
    } finally {
      rmSync(temporaryBypassFile, { force: true });
    }
  });
});
