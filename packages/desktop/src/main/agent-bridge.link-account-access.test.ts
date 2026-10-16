import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunTestEnvironment } from "../../../../scripts/bun-test-completion.mjs";

test("actual Desktop worker Link route requires the current account lease", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-link-account-"));
  try {
    const child = spawnSync(
      process.execPath,
      [join(import.meta.dir, "__fixtures__", "agent-bridge-link-account-access.mjs")],
      {
        env: createBunTestEnvironment(process.env, directory),
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (child.error || child.status !== 0)
      throw new Error(`Link account bridge fixture failed: ${child.error ?? ""}\n${child.stderr}`);
    expect(JSON.parse(child.stdout.trim())).toEqual({
      signedOutNoRequest: true,
      signedInRequest: true,
      logoutResultDiscarded: true,
      providerGrantPreserved: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
