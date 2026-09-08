import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real Desktop bridge admission and paired HTTP APIs share authoritative workspace state", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-web-integration-"));
  try {
    // The actual AgentBridge, WorkerBridgeCore, ProjectStore, orchestrator and HTTP
    // facade run together. Only Electron services and the model worker are fixtures.
    // Isolating Electron mocks avoids altering unrelated Desktop tests in this process.
    const child = spawnSync(
      process.execPath,
      [join(import.meta.dir, "__fixtures__", "desktop-web-integration.mjs"), root],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    if (child.error || child.status !== 0) {
      throw new Error(
        `Desktop integration failed: ${child.error ?? ""}\n${child.stderr}\n${child.stdout}`,
      );
    }
    expect(JSON.parse(child.stdout.trim())).toEqual({
      rendererGate: true,
      mobileGate: true,
      hostGate: true,
      allEntrypointsBlockedDuringWrite: true,
      sharedWorkerReload: true,
      sendFailureReleasesAdmission: true,
      workerExitDuringReloadRecovers: true,
      knownWorkspaceIsolation: true,
      pairedHttpWorkspaceIsolation: true,
      deletedWorktreeRejected: true,
      symlinkWorktreeRejected: true,
      replacedWorktreeRejected: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
