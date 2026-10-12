import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createSettingsRecoveryFixtureGuard,
  settingsRecoveryFixtureEvidence,
} from "../scripts/settings-recovery-fixture-guard.mjs";
import { candidateHash } from "../scripts/docker-candidate-guard.mjs";

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
    const failed = guard.failureEvidence();
    expect(failed.passed).toBe(false);
    expect(failed.nodePreloads).toEqual([
      { pid, ppid: process.pid, negativeProbes: 6, dnsNegativeProbes: 4 },
    ]);
    expect(guard.finish(1).nodePreloads).toEqual([
      { pid, ppid: process.pid, negativeProbes: 6, dnsNegativeProbes: 4 },
    ]);
    expect(() => guard.verify(pid, args)).toThrow("already verified");
    expect(() => guard.finish(6)).toThrow("Incomplete recovery CLI fixture");
  });
});

test("failure export rejects extra fields, duplicate PIDs, a wrong CLI and incomplete success", () => {
  const proof = {
    passed: false,
    network: "deny-all",
    listeners: 0,
    allowedChildren: 0,
    cliEntryHash: "a".repeat(64),
    policyHash: "b".repeat(64),
    nodePreloads: [{ pid: 5, ppid: 4, negativeProbes: 6, dnsNegativeProbes: 4 }],
  };
  const output = (value: any) => "CANDIDATE_SETTINGS_RECOVERY_FAILURE " + JSON.stringify(value);
  expect(settingsRecoveryFixtureEvidence(output(proof), false, proof.cliEntryHash)).toEqual(proof);
  expect(() =>
    settingsRecoveryFixtureEvidence(
      output({ ...proof, settings: "private" }),
      false,
      proof.cliEntryHash,
    ),
  ).toThrow();
  expect(() =>
    settingsRecoveryFixtureEvidence(
      output({ ...proof, nodePreloads: [...proof.nodePreloads, ...proof.nodePreloads] }),
      false,
      proof.cliEntryHash,
    ),
  ).toThrow();
  expect(() => settingsRecoveryFixtureEvidence(output(proof), false, "c".repeat(64))).toThrow();
  expect(() =>
    settingsRecoveryFixtureEvidence(
      output(proof) + "\n" + output(proof),
      false,
      proof.cliEntryHash,
    ),
  ).toThrow();
  expect(() =>
    settingsRecoveryFixtureEvidence(
      "CANDIDATE_SETTINGS_RECOVERY_GUARD " + JSON.stringify({ ...proof, passed: true }),
      true,
      proof.cliEntryHash,
    ),
  ).toThrow();
});

test("an actual failed recovery fixture exports only verified proofs before its scratch can disappear", async () => {
  await fixture(async ({ scratch }) => {
    const server = join(scratch, "server");
    const bin = join(server, "dist/bin");
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(server, "package.json"),
      JSON.stringify({
        bin: { "code-shell-settings-recovery": "./dist/bin/code-shell-settings-recovery.js" },
      }),
    );
    const entry = join(bin, "code-shell-settings-recovery.js");
    writeFileSync(entry, 'console.log("invalid fixture help");\n');
    const execution = execute(node, [join(guardRoot, "smoke-settings-recovery.mjs"), server], {
      cwd: scratch,
      env: {
        PATH: dirname(node),
        HOME: scratch,
        USERPROFILE: scratch,
        LANG: "C.UTF-8",
        TMPDIR: scratch,
      },
      timeout: 10000,
      maxBuffer: 65536,
    });
    let failure: any;
    try {
      await execution;
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe(1);
    const proof = settingsRecoveryFixtureEvidence(
      failure.stdout,
      false,
      candidateHash(readFileSync(entry)),
    );
    expect(proof.nodePreloads).toHaveLength(1);
    expect(proof.nodePreloads[0].ppid).toBe(execution.child.pid);
    expect(JSON.stringify(proof)).not.toContain(scratch);
    expect(JSON.stringify(proof)).not.toContain("invalid fixture help");
    expect(failure.stderr).not.toContain("private evidence retained");
    expect(() =>
      settingsRecoveryFixtureEvidence(failure.stdout, true, proof.cliEntryHash),
    ).toThrow();
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
