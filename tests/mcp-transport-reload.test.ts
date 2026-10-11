import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../scripts/bun-test-completion.mjs";
function nodeExecutable() {
  for (const part of (process.env.PATH ?? "").split(delimiter)) {
    try {
      const path = realpathSync(join(part, process.platform === "win32" ? "node.exe" : "node"));
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Try the installed PATH only. */
    }
  }
  throw new Error("Actual Node is required; no runtime download fallback.");
}
async function runOwned(
  executable: string,
  args: string[],
  root: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  label: string,
  timeout: number,
) {
  const child = spawn(executable, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "",
    closed = false,
    timedOut = false,
    cleanupUnknown = false;
  let spawnError: Error | undefined,
    result: { code: number | null; signal: string | null } | undefined;
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  const completed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function wait(ms: number) {
    try {
      return await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    result = await wait(timeout);
    if (spawnError) throw spawnError;
    expect(result).toEqual({ code: 0, signal: null });
  } finally {
    if (!closed) {
      timedOut = true;
      if (label === "node") writeFileSync(join(directory, "shutdown.request"), "shutdown");
      try {
        result = await wait(label === "node" ? 5000 : 100);
      } catch {
        cleanupUnknown = true;
      }
      if (!closed && child.exitCode === null && child.signalCode === null) {
        cleanupUnknown = true;
        child.kill("SIGKILL");
        try {
          result = await wait(2000);
        } catch {
          cleanupUnknown = true;
        }
      }
    }
    writeFileSync(join(directory, label + ".stdout"), stdout);
    writeFileSync(join(directory, label + ".stderr"), stderr);
    writeFileSync(
      join(directory, label + ".json"),
      JSON.stringify({
        pid: child.pid,
        ppid: process.pid,
        executable,
        result,
        closed,
        timedOut,
        cleanupUnknown,
        spawnError: spawnError?.message,
      }) + "\n",
    );
  }
  expect(cleanupUnknown).toBe(false);
  expect(timedOut).toBe(false);
}

test("actual Node MCP configuration versions and Run leases use isolated local stdio", async () => {
  const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  const cache = join(root, "packages/core/node_modules/.cache/mcp-transport-reload");
  mkdirSync(cache, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(cache, "run-")));
  const env = {
    ...createBunTestEnvironment(process.env, join(directory, "isolation")),
    CODESHELL_MCP_RELOAD_EVIDENCE: directory,
    CODESHELL_MCP_RELOAD_ROOT: root,
  };
  console.log("MCP transport reload evidence: " + directory);
  await runOwned(
    realpathSync(process.execPath),
    [join(root, "tests/fixtures/mcp-transport-reload-build.mjs"), root, directory],
    root,
    directory,
    env,
    "builder",
    30000,
  );
  const build = JSON.parse(readFileSync(join(directory, "build.json"), "utf8"));
  const bundle = join(directory, "build/mcp-transport-reload.fixture.js");
  expect(build.success).toBe(true);
  expect(build.sha256).toBe(createHash("sha256").update(readFileSync(bundle)).digest("hex"));
  const report = join(directory, "junit.xml");
  await runOwned(
    nodeExecutable(),
    [
      "--test-reporter=junit",
      "--test-reporter-destination=" + report,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      bundle,
    ],
    root,
    directory,
    env,
    "node",
    60000,
  );
  const xml = readFileSync(report, "utf8");
  expect(xml).toMatch(/<\/testsuites>\s*$/);
  expect(xml).not.toMatch(/<(?:failure|error|skipped)\b/);
  expect([...xml.matchAll(/<testcase\b/g)]).toHaveLength(9);
  const receipt = JSON.parse(readFileSync(join(directory, "completion.json"), "utf8"));
  const node = JSON.parse(readFileSync(join(directory, "node.json"), "utf8"));
  expect(receipt.guard.pid).toBe(node.pid);
  expect(receipt.unexpectedNetworkCalls).toBe(0);
  expect(receipt.children.length).toBeGreaterThan(10);
  expect(receipt.children.every((child: { closed: boolean }) => child.closed)).toBe(true);
  expect(receipt.guard.negativeProbes).toBe(8);
  expect(receipt.guard.homeSha256).toBe(createHash("sha256").update(env.HOME).digest("hex"));
}, 100000);
