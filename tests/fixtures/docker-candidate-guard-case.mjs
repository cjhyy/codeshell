// A real Node entry. The preload must reject unsafe policy before this executes.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";

assert.equal(globalThis[Symbol.for("codeshell.docker-candidate.pre-core")]?.negativeProbes, 6);
const config = JSON.parse(readFileSync(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG));
writeFileSync(`${config.home}/entry-reached`, "guard already installed\n", { mode: 0o600 });
const blocked = /Docker candidate refused/;
assert.throws(() => fetch("https://external.invalid/"), blocked);
assert.throws(() => fetch("http://localhost:1/"), blocked);
assert.throws(() => http.get("http://127.0.0.1:1/"), blocked);
assert.throws(() => net.connect({ path: "/tmp/unowned.sock" }), blocked);
assert.throws(() => tls.connect({ host: "127.0.0.1", port: 1 }), blocked);
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
