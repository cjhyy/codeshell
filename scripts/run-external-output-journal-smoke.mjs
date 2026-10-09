import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Retention is explicit and task-owned. CI cleans only the directory it creates.
const retain = process.argv[2] === "--retain";
const root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-external-output-native-")));
chmodSync(root, 0o700);
const cache = join(repo, "packages/desktop/node_modules/.cache", `external-output-${process.pid}`);
mkdirSync(cache, { recursive: true });
const adapters = join(cache, "adapters.mjs");
const deadline = Date.now() + 180_000;
let child;
let timer;
let killTimer;
let failure;
const terminateOwned = (reason) => {
  failure ??= reason;
  if (!child?.pid) return;
  const kill = (signal) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal); // Only the group created below.
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  kill("SIGTERM");
  killTimer ??= setTimeout(() => kill("SIGKILL"), 2000);
};
const onSignal = (signal) => terminateOwned(`launcher received ${signal}`);
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
try {
  const env = createBunTestEnvironment(process.env, root);
  const bin = join(root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  // Pin the shebang interpreter as well as the Main executable.
  symlinkSync(process.execPath, join(bin, "node"));
  const children = [];
  const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  for (const [name, kind] of [
    ["codex", "codex"],
    ["claude", "claude-code"],
  ]) {
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!/usr/bin/env node\nprocess.env.CODESHELL_OUTPUT_KIND=${JSON.stringify(kind)};\nawait import(${JSON.stringify(pathToFileURL(join(repo, "scripts/fixtures/external-output-cli.mjs")).href)});\n`,
      { mode: 0o700 },
    );
    children.push({ command: name, path, hash: hashFile(path) });
  }
  env.PATH = `${bin}:${env.PATH}`;
  // Bun compiles source without executing Core or the fixture. All subsequent
  // Node imports and actual children inherit the reviewed pre-Core guard.
  const build = spawnSync(
    "bun",
    [
      "build",
      "scripts/fixtures/external-output-adapters.ts",
      "--target=node",
      "--packages=external",
      `--outfile=${adapters}`,
    ],
    {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: Math.min(60_000, deadline - Date.now()),
      killSignal: "SIGKILL",
    },
  );
  if (build.status !== 0) throw new Error(build.stderr || "fixture adapter compilation failed");
  env.CODESHELL_OUTPUT_ROOT = root;
  env.CODESHELL_OUTPUT_ADAPTERS = adapters;
  env.CODESHELL_OUTPUT_HOME_HASH = createHash("sha256").update(env.HOME).digest("hex");
  env.CODESHELL_OUTPUT_ORIGINS = "[]";
  env.CODESHELL_OUTPUT_GUARD_LOG = join(root, "guard.jsonl");
  env.CODESHELL_OUTPUT_REQUEST_LOG = join(root, "requests.jsonl");
  env.CODESHELL_OUTPUT_CHILDREN = JSON.stringify(children);
  env.CODESHELL_OUTPUT_COLD_ENTRY = join(repo, "scripts/smoke-external-output-journal.mjs");
  env.CODESHELL_OUTPUT_COLD_HASH = hashFile(env.CODESHELL_OUTPUT_COLD_ENTRY);
  env.NODE_OPTIONS = `--import=${pathToFileURL(join(repo, "scripts/external-output-smoke-isolation.mjs")).href}`;
  if (failure) throw new Error(failure);
  child = spawn(process.execPath, ["scripts/smoke-external-output-journal.mjs"], {
    cwd: repo,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  timer = setTimeout(
    () => terminateOwned("native fixture total deadline exceeded"),
    Math.max(1, deadline - Date.now()),
  );
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  if (failure || code !== 0)
    throw new Error(failure ?? `External output native fixture failed (${code})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  // The Main may exit before a descendant ignores SIGTERM. Reap only this
  // launcher's detached group even on success; never leave a fixture CLI alive.
  if (child?.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  clearTimeout(timer);
  clearTimeout(killTimer);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  if (retain) console.log(JSON.stringify({ retainedEvidence: root }));
  else rmSync(root, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
}
