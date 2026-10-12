// Verify the built or independently installed server command without TUI/model setup.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

if (
  ![3, 5].includes(process.argv.length) ||
  (process.argv.length === 5 && process.argv[3] !== "--guard-root")
)
  throw new Error("Usage: smoke-settings-recovery.mjs <server-package> [--guard-root <bundle>]");
const server = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(server, "package.json"), "utf8"));
assert.equal(
  manifest.bin["code-shell-settings-recovery"],
  "./dist/bin/code-shell-settings-recovery.js",
);
const entry = join(server, manifest.bin["code-shell-settings-recovery"]);
const execute = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "installed-settings-recovery-"));
const root = join(scratch, "project");
await mkdir(root, { mode: 0o700 });
const guardRoot = resolve(process.argv[4] ?? fileURLToPath(new URL(".", import.meta.url)));
const { createSettingsRecoveryFixtureGuard } = await import(
  pathToFileURL(join(guardRoot, "settings-recovery-fixture-guard.mjs")).href
);
const guard = createSettingsRecoveryFixtureGuard({ scratch, entry, guardRoot });
let passed = false;
const secret = "private-recovery-fixture-do-not-print";
async function command(args, fails = false) {
  let code = 0,
    stdout,
    stderr;
  const execution = execute(guard.node, guard.arguments(args), {
    cwd: root,
    env: guard.environment,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  const pid = execution.child.pid;
  try {
    ({ stdout, stderr } = await execution);
  } catch (error) {
    assert.equal(typeof error.code, "number", "command must exit, not hang or fail to launch");
    code = error.code;
    stdout = error.stdout;
    stderr = error.stderr;
  }
  guard.verify(pid, args);
  assert.equal(code, fails ? 1 : 0, stderr);
  assert.ok(!(stdout + stderr).includes(secret), "CLI must never print configuration values");
  if (!fails) assert.equal(stderr, "");
  return stdout;
}
try {
  assert.match(await command(["--help"]), /Stop the project/);
  assert.equal(JSON.parse(await command(["inspect"])).status, "missing");
  assert.deepEqual(await readdir(root), [], "help and inspection must not bootstrap a project");
  const state = join(root, ".code-shell");
  await mkdir(state);
  const file = join(state, "settings.local.json");
  const broken = `{"env":{"PRIVATE":"${secret}"},`;
  await writeFile(file, broken);
  await writeFile(join(state, "settings.json"), '{"model":"untouched"}\n');
  const candidate = join(root, "reviewed.json");
  const reviewed = JSON.stringify({ model: "reviewed", env: { PRIVATE: secret } }) + "\n";
  await writeFile(candidate, reviewed);
  const target = ["--project", root, "--scope", "local"];
  const inspection = JSON.parse(await command(["inspect", ...target, "--from", candidate]));
  assert.equal(inspection.status, "invalid_syntax");
  const repair = [
    "repair",
    ...target,
    "--from",
    candidate,
    "--expected-revision",
    inspection.revision,
    "--candidate-sha256",
    inspection.candidate.sha256,
  ];
  const result = JSON.parse(await command(repair));
  assert.equal(result.status, "valid");
  assert.equal(await readFile(file, "utf8"), reviewed);
  await command(repair, true);
  const restored = JSON.parse(
    await command([
      "restore",
      ...target,
      "--backup-id",
      result.backupId,
      "--expected-revision",
      result.revision,
    ]),
  );
  assert.equal(restored.status, "invalid_syntax");
  assert.equal(await readFile(file, "utf8"), broken);
  assert.equal(await readFile(join(state, "settings.json"), "utf8"), '{"model":"untouched"}\n');
  console.log(
    "✓ Server recovery CLI: read-only inspection, reviewed repair, stale-write rejection and exact rollback.",
  );
  console.log("CANDIDATE_SETTINGS_RECOVERY_GUARD " + JSON.stringify(guard.finish(6)));
  passed = true;
} finally {
  if (passed) await rm(scratch, { recursive: true, force: true });
  else console.error(`Recovery fixture failed; private evidence retained: ${scratch}`);
}
