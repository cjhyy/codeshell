// Read-only CI diagnosis. Never launches an App, signals a process, reads command
// lines, or changes the custody query used by native acceptance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { win32, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  parseWindowsProcessSnapshot,
  snapshotElectronTestProcesses,
} from "./electron-test-process-snapshot.mjs";

assert.equal(process.platform, "win32");
const output = process.argv[2];
assert.ok(output, "Expected a new owned evidence directory");
mkdirSync(output, { mode: 0o700 });
const home = join(output, "private-query-home");
mkdirSync(home, { mode: 0o700 });
let command;
snapshotElectronTestProcesses({
  execFile(executable, args, options) {
    command = { executable, args, options };
    return "[]";
  },
});
const environment = command.options.env;
const ownedEnvironment = {
  ...environment,
  HOME: home,
  USERPROFILE: home,
  APPDATA: home,
  LOCALAPPDATA: home,
  TEMP: home,
  TMP: home,
};
const pwsh = win32.join(
  win32.parse(environment.SystemRoot).root,
  "Program Files/PowerShell/7/pwsh.exe",
);
const candidates = [
  { name: "windows-powershell-original-minimal", executable: command.executable, env: environment },
  {
    name: "windows-powershell-owned-profile",
    executable: command.executable,
    env: ownedEnvironment,
  },
  { name: "powershell7-original-minimal", executable: pwsh, env: environment },
  { name: "powershell7-owned-profile", executable: pwsh, env: ownedEnvironment },
];
const results = [];
for (const candidate of candidates) {
  const started = performance.now();
  const result = { name: candidate.name };
  try {
    const info = lstatSync(candidate.executable);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    const text = execFileSync(candidate.executable, command.args, {
      ...command.options,
      env: candidate.env,
      timeout: 30_000,
    });
    const rows = parseWindowsProcessSnapshot(text);
    const own = rows.find((row) => row.pid === process.pid);
    assert.equal(own?.ppid, process.ppid);
    result.status = "passed";
    result.rows = rows.length;
    result.ownIdentityVerified = true;
  } catch (error) {
    result.status = "failed";
    // Fixed labels only; never preserve native output, paths, or error payloads.
    result.reason =
      error.code === "ETIMEDOUT"
        ? "timeout"
        : error.code === "ENOENT"
          ? "unavailable"
          : "query-or-identity-check-failed";
  }
  result.elapsedMs = Math.round(performance.now() - started);
  results.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(join(output, "report.json"), JSON.stringify({ results }, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
