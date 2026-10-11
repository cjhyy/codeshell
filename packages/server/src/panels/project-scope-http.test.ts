import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("real Web runtime discloses only authorized scope and revalidates the frozen mount", () => {
  const root = mkdtempSync(join(tmpdir(), "panel-project-scope-http-"));
  try {
    const repository = resolve(import.meta.dir, "../../../..");
    const config = JSON.parse(readFileSync(join(repository, "tsconfig.json"), "utf8"));
    config.compilerOptions.baseUrl = repository;
    config.compilerOptions.paths["@cjhyy/code-shell-core/internal/skills"] = [
      "packages/core/src/index.skills.ts",
    ];
    const override = join(root, "source-tsconfig.json");
    writeFileSync(override, JSON.stringify(config));
    const result = spawnSync(
      process.execPath,
      [
        "--tsconfig-override",
        override,
        join(import.meta.dir, "__fixtures__/project-scope-http.ts"),
        root,
      ],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    if (result.error || result.status !== 0)
      throw Error(
        `Project scope HTTP fixture failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
    expect(JSON.parse(result.stdout.trim())).toEqual({
      sourceOnly: true,
      guardedNetworkProbes: 2,
      workspacePermission: true,
      forgedIdentityRejected: true,
      noAdditionalAuthority: true,
      contextRevalidation: true,
      mountReplacementRevokesGrant: true,
      finalStorageFence: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
