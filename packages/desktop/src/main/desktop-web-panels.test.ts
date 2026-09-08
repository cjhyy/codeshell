import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Desktop Web panels use paired authority and Electron's existing storage", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-web-panels-"));
  try {
    // Only Electron and its bridge admission callback are simulated. The real
    // paired HTTP facade, Core installer and complete shared panel runtime run
    // in a child process so Electron mocks cannot contaminate other suites.
    const child = spawnSync(
      process.execPath,
      [join(import.meta.dir, "__fixtures__/desktop-web-panels.mjs"), root],
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
      crossWorkspaceInvalidation: true,
      logoutRevokesAssets: true,
      closeRevokesAssets: true,
      deviceRevocation: true,
      forgedBindingRejected: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
