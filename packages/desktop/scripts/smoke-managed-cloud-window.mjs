import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:https";
import { once } from "node:events";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await realpath(await mkdtemp(join(tmpdir(), "codeshell-managed-cloud-window-")));
const env = createBunTestEnvironment(process.env, root);
let server,
  child,
  receipt,
  exited = false,
  cleaned = false,
  requests = 0,
  invalidRequest = false;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false;
    }
    return true;
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "ENOENT") return false;
    throw error;
  }
};
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=managed-cloud-window",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
    ],
    { stdio: "ignore", env },
  );
  execFileSync(
    "bun",
    [
      "build",
      "scripts/smoke-managed-cloud-window.fixture.ts",
      "--outdir",
      join(root, "build"),
      "--target=node",
      "--splitting",
      "--external=electron",
      "--external=ws",
      "--external=@cjhyy/code-shell-core/internal",
    ],
    { cwd: desktop, env, stdio: "pipe" },
  );
  await writeFile(join(root, "build/package.json"), '{"type":"module"}');
  await symlink(join(desktop, "node_modules"), join(root, "build/node_modules"));
  server = createServer(
    { key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) },
    (req, res) => {
      requests++;
      if (
        !/^cs_cloud_management=[A-Za-z0-9_-]{43}$/.test(req.headers.cookie ?? "") ||
        req.headers.authorization !== undefined ||
        req.url.includes("token")
      ) {
        invalidRequest = true;
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end("<!doctype html><title>Managed fixture</title><p>Cloud project</p>");
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `https://127.0.0.1:${server.address().port}`;
  const electron = createRequire(join(desktop, "package.json"))("electron");
  child = spawn(electron, [join(root, "build/smoke-managed-cloud-window.fixture.js")], {
    cwd: desktop,
    env: { ...env, CODESHELL_MANAGED_WINDOW_ROOT: root, CODESHELL_MANAGED_WINDOW_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (part) => {
    stderr = (stderr + part).slice(-8000);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 40_000);
  let result;
  try {
    result = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => done({ code, signal }));
    });
  } finally {
    clearTimeout(timeout);
  }
  exited = true;
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  receipt = JSON.parse(await readFile(join(root, "receipt.json"), "utf8"));
  assert.equal(receipt.passed, true);
  assert.equal(receipt.windows, 0);
  for (let i = 0; i < 100 && receipt.pids.some(alive); i++)
    await new Promise((done) => setTimeout(done, 50));
  assert.equal(
    receipt.pids.some(alive),
    false,
    "all reported Electron processes exited before HOME cleanup",
  );
  assert.ok(requests >= 5);
  assert.equal(invalidRequest, false);
  console.log(
    JSON.stringify({
      passed: true,
      requests,
      closedWindows: receipt.windows,
      exitedProcesses: receipt.pids.length,
      blockedExternalRequests: receipt.blocked,
    }),
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (exited && receipt && !receipt.pids.some(alive)) {
    await rm(root, { recursive: true, force: true });
    cleaned = true;
  }
  if (!cleaned) console.error(`Managed Cloud fixture state preserved for exit audit: ${root}`);
}
