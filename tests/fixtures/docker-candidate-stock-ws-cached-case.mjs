// Actual Node's prepopulated cache is not proof of the pinned on-disk source.
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const config = JSON.parse(readFileSync(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG));
process.env.NODE_OPTIONS = `--import=${config.preload}`;
const { installDockerCandidateGuard } = await import(
  new URL("./docker-candidate-guard.mjs", pathToFileURL(config.preload))
);
const { loadCandidateStockWebSocket } = await import(
  new URL("./docker-candidate-stock-ws.mjs", pathToFileURL(config.preload))
);
const require = createRequire(import.meta.url);
let fakeCalls = 0,
  nativeRequests = 0,
  loaderCalls = 0;
const fake = function () {
  fakeCalls++;
};
fake.WebSocket = fake;
for (const name of ["index.js", "lib/websocket.js"])
  require.cache[`${config.stockWebSocket.packageRoot}/${name}`] = { exports: fake, loaded: true };
http.request = () => {
  nativeRequests++;
  throw new Error("native request unexpectedly delegated");
};
assert.throws(
  () =>
    installDockerCandidateGuard(config, {
      loadStockWebSocket() {
        loaderCalls++;
        return loadCandidateStockWebSocket(config.stockWebSocket);
      },
    }),
  /stock WebSocket source refused/,
);
assert.equal(loaderCalls, 1);
assert.equal(fakeCalls, 0);
assert.equal(nativeRequests, 0);
// Bootstrap failure leaves the installed guard closed, with no observation lease.
assert.throws(() => http.request("http://127.0.0.1:1/"), /Docker candidate refused/);
assert.equal(nativeRequests, 0);
console.log(JSON.stringify({ passed: true, fakeCalls, nativeRequests, loaderCalls }));
