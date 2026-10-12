import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createSettingsRecoveryFixtureGuard } from "../scripts/settings-recovery-fixture-guard.mjs";

const execute = promisify(execFile);
const guardRoot = resolve(import.meta.dir, "../scripts");
const node = realpathSync(Bun.which("node")!);

async function fixture(check: (value: any) => Promise<void>) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "settings-recovery-guard-test-")));
  const entry = join(scratch, "recovery.mjs");
  writeFileSync(
    entry,
    `import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import { spawn } from "node:child_process";
const proof = globalThis[Symbol.for("codeshell.docker-candidate.pre-core")];
assert.equal(proof.negativeProbes, 6);
assert.equal(proof.dnsNegativeProbes, 4);
assert.throws(() => dns.resolveTxt("external.invalid"), /Docker candidate refused/);
assert.throws(() => http.get("http://127.0.0.1:1"), /Docker candidate refused/);
assert.throws(() => spawn(process.execPath, ["-e", "process.exit(0)"]), /Docker candidate refused/);
assert.equal(process.env.PRIVATE_PROVIDER_TOKEN, undefined);
console.log("entry saw the pre-Core proof");
`,
    { mode: 0o600 },
  );
  const guard = createSettingsRecoveryFixtureGuard({ scratch, entry, guardRoot, node });
  try {
    await check({ scratch, entry, guard });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("actual Node denies network, DNS and descendants before the recovery entry", async () => {
  await fixture(async ({ scratch, guard }) => {
    const project = join(scratch, "project");
    mkdirSync(project, { mode: 0o700 });
    const args = ["--help"];
    const execution = execute(node, guard.arguments(args), {
      cwd: project,
      env: guard.environment,
      timeout: 10000,
    });
    const pid = execution.child.pid;
    const { stdout, stderr } = await execution;
    expect(stdout.trim()).toBe("entry saw the pre-Core proof");
    expect(stderr).toBe("");
    guard.verify(pid, args);
    expect(guard.finish(1).nodePreloads).toEqual([
      { pid, ppid: process.pid, negativeProbes: 6, dnsNegativeProbes: 4 },
    ]);
    expect(() => guard.verify(pid, args)).toThrow("already verified");
    expect(() => guard.finish(6)).toThrow("Incomplete recovery CLI fixture");
  });
});

test("proof from the wrong argv or PID cannot qualify a recovery command", async () => {
  await fixture(async ({ guard }) => {
    const execution = execute(node, guard.arguments(["--help"]), {
      env: guard.environment,
      timeout: 10000,
    });
    await execution;
    expect(() => guard.verify(execution.child.pid, ["inspect"])).toThrow();
    expect(() => guard.verify(execution.child.pid! + 100000, ["--help"])).toThrow();
    guard.verify(execution.child.pid, ["--help"]);
    expect(guard.finish(1).passed).toBe(true);
  });
});

test("changed executable entry or policy is rejected before launch", async () => {
  await fixture(async ({ entry, guard }) => {
    writeFileSync(entry, "throw new Error('changed entry');\n");
    expect(() => guard.arguments(["--help"])).toThrow("changed before launch");
  });
  await fixture(async ({ guard }) => {
    const policy = guard.environment.CODESHELL_DOCKER_CANDIDATE_CONFIG;
    const bytes = readFileSync(policy, "utf8");
    writeFileSync(policy, bytes.replace('"origins":[]', '"origins":["http://127.0.0.1:1"]'));
    expect(() => guard.arguments(["--help"])).toThrow();
    expect(() => guard.arguments(["bad\nargument"])).toThrow();
  });
});
