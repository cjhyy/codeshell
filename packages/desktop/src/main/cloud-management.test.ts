import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../scripts/bun-test-completion.mjs";

test.each([
  "contract",
  "foreign-capability",
  "ticket-denied",
  "ticket-identity",
  "lifecycle",
  "late-exchange",
  "same-account-relogin",
  "unknown-revoke",
  "cleanup-failure",
  "expiry-and-rejection",
  "owner-loss",
])("Main Cloud management: %s", async (scenario) => {
  const directory = await mkdtemp(join(tmpdir(), "codeshell-cloud-manager-"));
  try {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./cloud-management.fixture.ts", import.meta.url)),
        scenario,
      ],
      env: createBunTestEnvironment(process.env, directory),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 1_048_576,
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
