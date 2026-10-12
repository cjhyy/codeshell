// Capture builtin constructors without invoking them; install protection before
// every negative probe. No Core, UDP, WebSocket or inspector transport executes.
import assert from "node:assert/strict";
import children from "node:child_process";
import dgram from "node:dgram";
import inspector from "node:inspector";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const Socket = dgram.Socket;
const ChildProcess = children.ChildProcess;
const config = JSON.parse(readFileSync(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG));
process.env.NODE_OPTIONS = `--import=${config.preload}`;
config.docker = { command: "reviewed-docker-fixture" };
const { installDockerCandidateGuard } = await import(
  new URL("./docker-candidate-guard.mjs", pathToFileURL(config.preload)).href
);
const guard = installDockerCandidateGuard(config, {
  dockerCommand({ command, args, options, callback, original }) {
    assert.equal(command, config.docker.command);
    assert.deepEqual(args, ["fixed-args"]);
    assert.equal(options.cwd, config.home);
    return original(
      config.children[0].path,
      config.children[0].args,
      {
        cwd: config.home,
        env: { ...process.env, CODESHELL_DOCKER_CANDIDATE_ROLE: "worker" },
      },
      callback,
    );
  },
});
const blocked = /Docker candidate refused/;
const require = createRequire(import.meta.url);
for (const Constructor of [dgram.Socket, require("node:dgram").Socket])
  assert.throws(() => new Constructor("udp4"), blocked);
for (const method of ["bind", "connect", "send"])
  assert.throws(() => Socket.prototype[method].call({}), blocked);
assert.throws(() => dgram.createSocket("udp4"), blocked);
assert.throws(() => new globalThis.WebSocket("wss://external.invalid/"), blocked);
assert.throws(() => inspector.open(0, "127.0.0.1"), blocked);
assert.throws(() => new ChildProcess().spawn({}), blocked);

// Exercise the same private original-executor boundary used by the Docker
// adapter, using only the already pinned, harmless Node child fixture.
let error, output, errors;
const child = children.execFile(
  config.docker.command,
  ["fixed-args"],
  { cwd: config.home },
  (failure, stdout, stderr) => {
    error = failure;
    output = stdout;
    errors = stderr;
  },
);
const [code, signal] = await once(child, "close");
assert.ifError(error);
assert.equal(code, 0, errors);
assert.equal(signal, null);
assert.equal(output.trim(), "child guarded");
assert.throws(() => new ChildProcess().spawn({}), blocked);

const server = http.createServer((_request, response) => response.end("owned loopback"));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal(await (await fetch(origin)).text(), "owned loopback");
  for (const foreign of [
    `${origin}/path`,
    `${origin}?query`,
    origin.replace("127.0.0.1", "localhost"),
    "https://external.invalid",
    "http://127.0.0.1:0",
  ])
    assert.throws(() => guard.revokeOrigin(foreign), blocked);
  assert.equal(await (await fetch(origin)).text(), "owned loopback");
  assert.equal(guard.revokeOrigin(origin), true);
  assert.throws(() => fetch(origin), blocked);
  assert.equal(guard.revokeOrigin(origin), false);
  guard.allowOrigin(origin);
  assert.equal(await (await fetch(origin)).text(), "owned loopback");
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  guard.revokeOrigin(origin);
}
assert.throws(() => fetch(origin), blocked);
console.log("PASS public native refusals, reviewed executor and origin revocation");
