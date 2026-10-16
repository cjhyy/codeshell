import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Remote Link settlement updates Worker readiness without invalidating new grants", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-remote-"));
  try {
    const child = spawnSync(
      process.execPath,
      [join(import.meta.dir, "__fixtures__", "agent-bridge-remote-credentials.mjs")],
      {
        env: { ...process.env, HOME: root, CODE_SHELL_HOME: join(root, "code-shell") },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (child.error || child.status !== 0)
      throw new Error(
        `Remote bridge fixture failed: ${child.error ?? ""}\n${child.stderr}\n${child.stdout}`,
      );
    expect(JSON.parse(child.stdout.trim())).toEqual({
      unauthorizedSnapshotUpdated: true,
      invalidParamsKeepGrant: true,
      successSnapshotPrecedesResult: true,
      replacementGrantPreserved: true,
      realToolErrorsPreserved: true,
      replacementContentDiscarded: true,
      taskCancellationPreserved: true,
      snapshotFailureKeepsError: true,
      priorWorkerReplyDiscarded: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
