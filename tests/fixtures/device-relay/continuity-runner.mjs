import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { credentialRotationAcceptance } from "./credential-rotation.mjs";

const root = process.argv[2];
const sockets = new Set();
let denied = 0;
const reject = () => {
  denied++;
  throw new Error("Relay continuity fixture denied a non-fixture network target");
};
const checkSocket = (args) => {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options =
    typeof values[0] === "object"
      ? values[0]
      : { port: values[0], host: typeof values[1] === "string" ? values[1] : "localhost" };
  if (
    !options ||
    options.path ||
    options.lookup ||
    options.socket ||
    !sockets.has(`${options.host ?? options.hostname ?? "localhost"}:${options.port}`)
  )
    reject();
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  checkSocket(args);
  return originalConnect.apply(this, args);
};
const originalTlsConnect = tls.connect;
tls.connect = function (...args) {
  checkSocket(args);
  return originalTlsConnect.apply(this, args);
};
globalThis.fetch = reject;
syncBuiltinESMExports();
assert.throws(() => net.connect({ host: "127.0.0.1", port: 9 }), /non-fixture/);
assert.throws(() => tls.connect({ host: "outside.fixture.invalid", port: 443 }), /non-fixture/);
assert.throws(() => fetch("https://outside.fixture.invalid"), /non-fixture/);
assert.equal(denied, 3);

// No product or ws import happens before the outbound socket guard is active.
const api = {
  ...(await import(pathToFileURL(join(root, "protocol.js")))),
  ...(await import(pathToFileURL(join(root, "connector.js")))),
};
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
    "/CN=relay-continuity-fixture",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    join(root, "key.pem"),
    "-out",
    join(root, "cert.pem"),
  ],
  { stdio: "ignore" },
);
await credentialRotationAcceptance(
  api,
  { cert: await readFile(join(root, "cert.pem")), key: await readFile(join(root, "key.pem")) },
  root,
  {
    allowOrigin(value) {
      const url = new URL(value);
      assert.ok(["http:", "https:"].includes(url.protocol));
      assert.equal(url.hostname, "127.0.0.1");
      assert.ok(url.port);
      sockets.add(url.host);
    },
  },
);
assert.equal(denied, 3, "Only explicit network-guard negative controls were denied");
console.log(
  "PASS account connector continuity survives token rotation and reconnect; explicit close retires it",
);
