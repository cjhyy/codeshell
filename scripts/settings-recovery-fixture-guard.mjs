// Test-only deny-all preload policy for the standalone recovery CLI fixture.
// This module and its preload import only Node builtins before the product CLI.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidateFile, candidateHash } from "./docker-candidate-guard.mjs";

export const settingsRecoveryGuardFiles = [
  "settings-recovery-fixture-guard.mjs",
  "docker-candidate-guard.mjs",
  "docker-candidate-preload.mjs",
];

export function settingsRecoveryFixtureEvidence(output, passed, entryHash) {
  assert.ok(typeof output === "string" && Buffer.byteLength(output) <= 65536);
  const prefix = passed
    ? "CANDIDATE_SETTINGS_RECOVERY_GUARD "
    : "CANDIDATE_SETTINGS_RECOVERY_FAILURE ";
  const lines = output.split("\n").filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, "Expected exactly one bounded recovery guard receipt");
  const value = JSON.parse(lines[0].slice(prefix.length));
  assert.deepEqual(Object.keys(value).sort(), [
    "allowedChildren",
    "cliEntryHash",
    "listeners",
    "network",
    "nodePreloads",
    "passed",
    "policyHash",
  ]);
  assert.equal(value.passed, passed);
  assert.equal(value.network, "deny-all");
  assert.equal(value.listeners, 0);
  assert.equal(value.allowedChildren, 0);
  assert.equal(value.cliEntryHash, entryHash);
  assert.match(value.policyHash, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(value.nodePreloads) && value.nodePreloads.length <= 6);
  if (passed) assert.equal(value.nodePreloads.length, 6);
  const pids = new Set();
  for (const row of value.nodePreloads) {
    assert.deepEqual(Object.keys(row).sort(), [
      "dnsNegativeProbes",
      "negativeProbes",
      "pid",
      "ppid",
    ]);
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && !pids.has(row.pid));
    assert.ok(Number.isSafeInteger(row.ppid) && row.ppid > 0);
    assert.equal(row.negativeProbes, 6);
    assert.equal(row.dnsNegativeProbes, 4);
    pids.add(row.pid);
  }
  return value;
}

export function createSettingsRecoveryFixtureGuard({
  scratch,
  entry,
  guardRoot,
  node = process.execPath,
}) {
  scratch = realpathSync(scratch);
  entry = realpathSync(entry);
  guardRoot = realpathSync(guardRoot);
  node = realpathSync(node);
  const nodeHash = candidateFile(node, { maximum: 128 * 1024 * 1024 }).sha256;
  const entryHash = candidateFile(entry).sha256;
  const home = join(scratch, "private-home");
  mkdirSync(home, { mode: 0o700 });
  const preload = join(guardRoot, "docker-candidate-preload.mjs");
  const preloadHash = candidateFile(preload).sha256;
  const config = {
    version: 1,
    role: "installer",
    home,
    dataRoot: scratch,
    preload,
    preloadHash,
    guardHash: candidateFile(join(guardRoot, "docker-candidate-guard.mjs")).sha256,
    receipt: join(home, "guard.jsonl"),
    origins: [],
    listeners: [],
    children: [],
  };
  const policy = JSON.stringify(config) + "\n";
  const policyHash = candidateHash(policy);
  const configPath = join(home, "policy.json");
  writeFileSync(configPath, policy, { flag: "wx", mode: 0o600 });
  const environment = {
    PATH: dirname(node),
    LANG: "C.UTF-8",
    HOME: home,
    USERPROFILE: home,
    CODE_SHELL_HOME: join(home, ".code-shell"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    NODE_OPTIONS: `--import=${preload}`,
    CODESHELL_DOCKER_CANDIDATE_CONFIG: configPath,
    CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: policyHash,
  };
  const verified = new Map();
  const rows = () => {
    const bytes = candidateFile(config.receipt, { privateFile: true, maximum: 65536 }).bytes;
    return bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const evidence = (passed) => ({
    passed,
    network: "deny-all",
    listeners: 0,
    allowedChildren: 0,
    cliEntryHash: entryHash,
    policyHash,
    nodePreloads: [...verified.values()].map(
      ({ pid, ppid, negativeProbes, dnsNegativeProbes }) => ({
        pid,
        ppid,
        negativeProbes,
        dnsNegativeProbes,
      }),
    ),
  });
  return {
    node,
    environment,
    arguments(args) {
      assert.ok(
        Array.isArray(args) &&
          args.length <= 16 &&
          args.every(
            (arg) => typeof arg === "string" && arg.length <= 8192 && !/[\0\r\n]/.test(arg),
          ),
      );
      assert.equal(candidateFile(node, { maximum: 128 * 1024 * 1024 }).sha256, nodeHash);
      assert.equal(candidateFile(entry).sha256, entryHash, "Recovery CLI changed before launch");
      assert.equal(candidateFile(configPath, { privateFile: true }).sha256, policyHash);
      return [entry, ...args];
    },
    verify(pid, args) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "Expected the actual recovery CLI PID");
      assert.equal(candidateFile(entry).sha256, entryHash, "Recovery CLI changed");
      assert.ok(!verified.has(pid), "Recovery CLI PID was already verified");
      const entries = rows().filter((row) => row.pid === pid);
      assert.equal(entries.length, 1, "Every CLI must emit exactly one pre-Core proof");
      assert.deepEqual(entries[0], {
        event: "pre-core",
        pid,
        ppid: process.pid,
        role: "installer",
        homeHash: candidateHash(home),
        preloadHash,
        policyHash,
        negativeProbes: 6,
        dnsNegativeProbes: 4,
        argvHash: candidateHash(JSON.stringify([entry, ...args])),
      });
      verified.set(pid, entries[0]);
    },
    failureEvidence: () => evidence(false),
    finish(expected) {
      const entries = rows();
      assert.equal(verified.size, expected, "Incomplete recovery CLI fixture");
      assert.equal(entries.length, expected, "Unexpected recovery CLI activity");
      assert.ok(entries.every((row) => verified.has(row.pid) && row.event === "pre-core"));
      return evidence(true);
    },
  };
}
