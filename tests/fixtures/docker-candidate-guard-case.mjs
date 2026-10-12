// A real Node entry. The preload must reject unsafe policy before this executes.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { spawn, execFile } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { summarizeFailure } from "../../scripts/smoke-project-diagnostics.mjs";

assert.equal(globalThis[Symbol.for("codeshell.docker-candidate.pre-core")]?.negativeProbes, 6);
assert.equal(globalThis[Symbol.for("codeshell.docker-candidate.pre-core")]?.dnsNegativeProbes, 4);
const config = JSON.parse(readFileSync(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG));
writeFileSync(`${config.home}/entry-reached`, "guard already installed\n", { mode: 0o600 });
const blocked = /Docker candidate refused/;
assert.throws(
  () => fetch("https://external.invalid/"),
  (error) => {
    assert.equal(error.message, "Docker candidate refused an unowned transport/process/policy");
    const diagnostic = summarizeFailure(error);
    assert.equal(
      diagnostic.sha256,
      "e1bcd3fb891860e5d2f6c4b00b2320a6476d95acd85dd93bf515b1083b013fb0",
    );
    assert.equal(diagnostic.guardRefusal.sha256, config.guardHash);
    assert(diagnostic.guardRefusal.line > 0);
    assert(diagnostic.guardRefusal.column > 0);
    const source = readFileSync(
      new URL("./docker-candidate-guard.mjs", pathToFileURL(config.preload)),
      "utf8",
    );
    assert.match(source.split("\n")[diagnostic.guardRefusal.line - 1], /refuse\(\)/);
    assert(!JSON.stringify(diagnostic).includes(config.home));
    assert(!JSON.stringify(diagnostic).includes("external.invalid"));
    assert(!JSON.stringify(diagnostic).includes("at "));
    console.log("GUARD_REFUSAL_DIAGNOSTIC " + JSON.stringify(diagnostic));
    return true;
  },
);
assert.throws(() => fetch("http://localhost:1/"), blocked);
assert.throws(() => http.get("http://127.0.0.1:1/"), blocked);
assert.throws(() => net.connect({ path: "/tmp/unowned.sock" }), blocked);
assert.throws(() => tls.connect({ host: "127.0.0.1", port: 1 }), blocked);
for (const surface of [dns, dns.promises]) {
  for (const method of Object.keys(surface).filter((name) => /^resolve/.test(name)))
    assert.throws(() => surface[method]("external.invalid"), blocked);
  assert.throws(() => new surface.Resolver(), blocked);
  assert.throws(() => surface.lookupService("127.0.0.1", 1), blocked);
}
assert.throws(() => spawn("sh", ["-c", "exit 0"]), blocked);
assert.throws(
  () =>
    spawn(config.children[0].path, config.children[0].args, {
      env: { ...process.env, NODE_OPTIONS: "" },
    }),
  blocked,
);
assert.throws(
  () => spawn(config.children[0].path, [...config.children[0].args, "--escape"]),
  blocked,
);

const server = http.createServer((request, response) => {
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "https://external.invalid/" });
    response.end();
  } else response.end("owned listener");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal(await (await fetch(origin)).text(), "owned listener");
  await assert.rejects(fetch(`${origin}/redirect`), /fetch failed/);
  assert.throws(() => fetch(origin, { dispatcher: {} }), blocked);
  assert.throws(() => http.get(origin, { createConnection() {} }), blocked);
  assert.throws(() => http.get(origin, { hostname: "external.invalid" }), blocked);
  const child = spawn(config.children[0].path, config.children[0].args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: config.home,
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  child.stdout.resume();
  const [code, signal] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  // Match the real Panel service's stripped environment and detached custody.
  const stripped = spawn(config.children[0].path, config.children[0].args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: config.home,
    detached: true,
    env: { HOME: config.home, USERPROFILE: config.home, PATH: process.env.PATH },
  });
  let strippedError = "";
  stripped.stderr.on("data", (part) => {
    strippedError += part;
  });
  stripped.stdout.resume();
  const [strippedCode, strippedSignal] = await once(stripped, "close");
  assert.equal(strippedCode, 0, strippedError);
  assert.equal(strippedSignal, null);
  let fileError, fileOutput, fileStderr;
  const fileChild = execFile(
    config.children[0].path,
    config.children[0].args,
    { cwd: config.home },
    (error, stdout, stderr) => {
      fileError = error;
      fileOutput = stdout;
      fileStderr = stderr;
    },
  );
  const [fileCode, fileSignal] = await once(fileChild, "close");
  assert.ifError(fileError);
  assert.equal(fileCode, 0, fileStderr);
  assert.equal(fileSignal, null);
  assert.equal(fileOutput.trim(), "child guarded");
  appendFileSync(config.preload, "\n// changed after parent installed\n");
  assert.throws(
    () => spawn(config.children[0].path, config.children[0].args, { cwd: config.home }),
    blocked,
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
console.log("PASS actual Node pre-Core guard, owned HTTP, descendant preload and tamper refusal");
