import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../../scripts/bun-test-completion.mjs";

test.each([
  "review-cancel-revoke",
  "connection-cascade",
  "load-failure",
  "unconfirmed-revoke",
  "confirmed-refresh-failure",
  "stale-account",
  "same-account-relogin",
  "refresh-keeps-view",
])("account Link settings: %s", async (scenario) => {
  const directory = await mkdtemp(join(tmpdir(), "codeshell-account-links-ui-"));
  try {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./CloudAccountLinks.interaction.fixture.tsx", import.meta.url)),
        scenario,
      ],
      env: createBunTestEnvironment(process.env, directory),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(JSON.parse(child.stdout.toString())).toEqual({
      scenario,
      passed: true,
      unexpectedRequests: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
