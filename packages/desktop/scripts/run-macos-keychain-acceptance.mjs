import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

if (process.platform !== "darwin" || process.version !== "v22.16.0")
  throw new Error("Run this macOS acceptance with the actual Node 22.16.0 floor runtime");
const [flag, destination, ...extra] = process.argv.slice(2);
if (extra.length || (flag && (flag !== "--output" || !destination)))
  throw new Error("usage: node run-macos-keychain-acceptance.mjs [--output <new-directory>]");
let directory;
if (destination) {
  directory = resolve(destination);
  mkdirSync(directory, { mode: 0o700 }); // Exclusive: never append to old evidence.
} else directory = mkdtempSync(join(tmpdir(), "codeshell-macos-keychain-acceptance-"));
directory = realpathSync(directory);
const evidence = join(directory, "evidence");
const temporary = join(directory, "tmp");
mkdirSync(evidence, { mode: 0o700 });
mkdirSync(temporary, { mode: 0o700 });
const environment = createBunTestEnvironment(process.env, directory);
Object.assign(environment, {
  TMPDIR: temporary,
  TMP: temporary,
  TEMP: temporary,
  CODESHELL_MACOS_KEYCHAIN_ACCEPTANCE: "1",
  CODESHELL_MACOS_ACCEPTANCE_ROOT: directory,
  CODESHELL_MACOS_ACCEPTANCE_EVIDENCE: evidence,
});
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const owned = new Map();
const processes = () => {
  const lines = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8" });
  return lines.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match ? [{ pid: +match[1], ppid: +match[2], birth: match[3] }] : [];
  });
};
const child = spawn(process.execPath, [join(appDir, "scripts", "smoke-panels.mjs")], {
  cwd: appDir,
  env: environment,
  stdio: "inherit",
  detached: true,
});
const remember = () => {
  const current = processes();
  const ids = new Set([child.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of current)
      if (ids.has(item.ppid) && !ids.has(item.pid)) {
        ids.add(item.pid);
        changed = true;
      }
  }
  for (const item of current) if (ids.has(item.pid)) owned.set(item.pid, item);
};
const signalOwned = (signal) => {
  const current = new Map(processes().map((item) => [item.pid, item]));
  for (const item of [...owned.values()].reverse())
    if (current.get(item.pid)?.birth === item.birth) {
      try {
        process.kill(item.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
};
let timedOut = false;
let result;
const started = Date.now();
const interval = setInterval(remember, 1_000);
const deadline = setTimeout(() => {
  timedOut = true;
  remember();
  signalOwned("SIGTERM");
}, 180_000);
const killDeadline = setTimeout(() => signalOwned("SIGKILL"), 183_000);
try {
  remember();
  console.log(`macOS Keychain acceptance evidence: ${directory}`);
  result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
  if (timedOut || result.code !== 0 || result.signal)
    throw new Error(
      `Keychain acceptance failed (${timedOut ? "180s deadline; OS interaction may be pending" : (result.signal ?? result.code)}). Do not approve any OS dialog automatically.`,
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(interval);
  clearTimeout(deadline);
  clearTimeout(killDeadline);
  remember();
  signalOwned("SIGTERM");
  await new Promise((done) => setTimeout(done, 500));
  signalOwned("SIGKILL");
  const remaining = processes().filter((item) => owned.get(item.pid)?.birth === item.birth);
  if (remaining.length) process.exitCode = 1;
  writeFileSync(
    join(directory, "launcher-receipt.json"),
    `${JSON.stringify(
      {
        node: process.version,
        launcherPid: process.pid,
        launcherPpid: process.ppid,
        parentHomeHash: createHash("sha256").update(environment.HOME).digest("hex"),
        elapsedMs: Date.now() - started,
        timedOut,
        result,
        ownedPids: [...owned.keys()],
        remainingOwnedPids: remaining.map((item) => item.pid),
        passed: !process.exitCode,
        boundary:
          "ordinary app safeStorage access only; no Keychain enumeration/export/unlock; JS guards are not an OS sandbox",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
