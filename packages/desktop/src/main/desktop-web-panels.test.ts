import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Desktop Web panels use paired authority and Electron's existing storage", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-web-panels-"));
  try {
    const repository = resolve(import.meta.dir, "../../../..");
    const sourceArgs: string[] = [];
    if (
      process.env.CODESHELL_PANEL_SOURCE_TEST === "1" ||
      !existsSync(join(repository, "packages/core/dist/index.js"))
    ) {
      // Source-only task checks do not compete with the integration owner's build.
      const config = JSON.parse(readFileSync(join(repository, "tsconfig.json"), "utf8"));
      config.compilerOptions.baseUrl = repository;
      config.compilerOptions.paths["@cjhyy/code-shell-core/internal/skills"] = [
        "packages/core/src/index.skills.ts",
      ];
      const override = join(root, "source-tsconfig.json");
      writeFileSync(override, JSON.stringify(config));
      sourceArgs.push("--tsconfig-override", override);
    }
    // Only Electron and its bridge admission callback are simulated. The real
    // paired HTTP facade, Core installer and complete shared panel runtime run
    // in a child process so Electron mocks cannot contaminate other suites.
    const child = spawnSync(
      process.execPath,
      [...sourceArgs, join(import.meta.dir, "__fixtures__/desktop-web-panels.mjs"), root],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    if (child.error || child.status !== 0)
      throw new Error(
        `Desktop panel integration failed: ${child.error ?? ""}\n${child.stderr}\n${child.stdout}`,
      );
    expect(JSON.parse(child.stdout.trim())).toEqual({
      pairedFacade: true,
      sharedDesktopStorage: true,
      workspaceIsolation: true,
      opaqueModuleAssets: true,
      mutationGate: true,
      projectScopedInvalidation: true,
      logoutRevokesAssets: true,
      closeRevokesAssets: true,
      deviceRevocation: true,
      forgedBindingRejected: true,
      sharedAutomationScheduler: true,
      automationTaskScope: true,
      nativePairedProjectScope: true,
      sessionIndependentProjectScope: true,
      forgedProjectScopeRejected: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
