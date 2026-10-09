import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { rememberOwnedProcesses } from "./process-custody.mjs";
import { bindPrivateKeychainContext, readKeychainReference } from "./macos-keychain-context.mjs";

if (process.platform !== "darwin" || process.version !== "v22.16.0")
  throw new Error("Run this macOS acceptance with the actual Node 22.16.0 floor runtime");
const options = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!value || !["--output", "--default-keychain-reference"].includes(flag) || options.has(flag))
    throw new Error(
      "usage: node run-macos-keychain-acceptance.mjs --default-keychain-reference <private-metadata-file> [--output <new-directory>]",
    );
  options.set(flag, value);
}
if (!options.has("--default-keychain-reference"))
  throw new Error("Capture the existing OS default Keychain metadata before entering private HOME");
const reference = readKeychainReference(options.get("--default-keychain-reference"));
const destination = options.get("--output");
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
const privateReference = join(directory, "default-keychain-reference.json");
writeFileSync(privateReference, `${JSON.stringify(reference)}\n`, { flag: "wx", mode: 0o600 });
bindPrivateKeychainContext({
  home: environment.HOME,
  root: directory,
  reference,
  receiptFile: join(evidence, "parent-keychain-context.json"),
});
Object.assign(environment, {
  TMPDIR: temporary,
  TMP: temporary,
  TEMP: temporary,
  CODESHELL_MACOS_KEYCHAIN_ACCEPTANCE: "1",
  CODESHELL_MACOS_ACCEPTANCE_ROOT: directory,
  CODESHELL_MACOS_ACCEPTANCE_EVIDENCE: evidence,
  CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE: privateReference,
  DEBUG: "pw:browser",
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
const completion = new Promise((resolveResult) => {
  child.once("error", (error) => resolveResult({ code: null, signal: null, error: error.message }));
  child.once("close", (code, signal) => resolveResult({ code, signal }));
});
// Capture once. Later PID reuse can never reseed or replace this authority.
const rootProcess = processes().find((item) => item.pid === child.pid && item.ppid === process.pid);
if (rootProcess) owned.set(rootProcess.pid, rootProcess);
const remember = () => {
  rememberOwnedProcesses(owned, processes());
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
  if (!rootProcess)
    throw new Error("Could not establish the fixture child's initial process identity");
  remember();
  console.log(`macOS Keychain acceptance evidence: ${directory}`);
  result = await completion;
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
  await new Promise((done) => setTimeout(done, 200));
  const remaining = processes().filter((item) => owned.get(item.pid)?.birth === item.birth);
  if (remaining.length) process.exitCode = 1;
  writeFileSync(
    join(directory, "launcher-receipt.json"),
    `${JSON.stringify(
      {
        node: process.version,
        launcherPid: process.pid,
        launcherPpid: process.ppid,
        childRoot: rootProcess,
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
