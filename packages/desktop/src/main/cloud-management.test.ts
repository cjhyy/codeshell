import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  "cleanup-early-rejection",
  "cleanup-sync-throw",
  "late-window-cleanup-debt",
  "dispose-late-exchange",
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

test("native Node keeps cleanup failures handled while Cloud revocation awaits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeshell-cloud-retirement-node-"));
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./cloud-management.fixture.ts", import.meta.url))],
      outdir: directory,
      target: "node",
      splitting: true,
      packages: "external",
    });
    expect(build.success, build.logs.map(String).join("\n")).toBe(true);
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await symlink(resolve("packages/desktop/node_modules"), join(directory, "node_modules"));
    const child = Bun.spawnSync({
      cmd: [
        "node",
        "--unhandled-rejections=strict",
        join(directory, "cloud-management.fixture.js"),
        "cleanup-early-rejection",
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
      scenario: "cleanup-early-rejection",
      passed: true,
      unexpectedRequests: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);
