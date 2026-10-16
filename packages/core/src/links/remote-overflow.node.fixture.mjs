// Run with Node after bundling the production source. Bun 1.3.11's node:http
// client can stall multi-MiB bodies even from an independent Node server.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const iterations = Number(process.argv[2] ?? 1);
assert.equal(process.versions.bun, undefined, "This transport fixture requires the Node runtime");
assert.ok(Number.isInteger(iterations) && iterations > 0 && iterations <= 1000);
const fixtureHome = process.env.CODE_SHELL_TEST_HOME;
assert.ok(fixtureHome, "This fixture requires an isolated test environment");
const nativeHttp = http.request;
const nativeHttps = https.request;
const nativeFetch = globalThis.fetch;
let allowedPort = 0;
let deniedNetwork = 0;
let physicalRequests = 0;
let receivedRequests = 0;
let closedServers = 0;
let canceledResponses = 0;
const unhandled = [];
const onUnhandled = (error) => unhandled.push(String(error));
process.on("unhandledRejection", onUnhandled);

function assertOwned(input) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    allowedPort === 0 ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) !== allowedPort
  ) {
    deniedNetwork++;
    throw new Error("Figma overflow fixture denied outside network");
  }
}
http.request = function (input, ...rest) {
  assertOwned(input);
  physicalRequests++;
  return nativeHttp.call(this, input, ...rest);
};
https.request = function () {
  deniedNetwork++;
  throw new Error("Figma overflow fixture denied outside network");
};
globalThis.fetch = async (input, init) => {
  assertOwned(input);
  return nativeFetch(input, { ...init, redirect: "error" });
};
syncBuiltinESMExports();

try {
  // Prove that named builtin imports and fetch cannot escape before loading
  // producers. Only these four intentional probes may be denied.
  const { request } = await import("node:http");
  assert.throws(() => request("http://127.0.0.1:1/"), /denied outside network/);
  assert.throws(() => request("http://127.0.0.1/"), /denied outside network/);
  assert.throws(() => https.request("https://example.test/"), /denied outside network/);
  await assert.rejects(fetch("https://example.test/"), /denied outside network/);
  assert.equal(deniedNetwork, 4);

  const { CredentialStore } = await import("../credentials/store.ts");
  const { PlaintextCipher } = await import("../credentials/cipher.ts");
  const { beginRemoteLinkAuthorization, completeRemoteLinkAuthorization, executeRemoteLinkAction } =
    await import("./remote.ts");
  const { requestOnce } = await import("./request-once.ts");
  const file = "FileAllowed123";
  const connectionId = "12345678-1234-1234-1234-123456789abc";
  const grantId = "12345678-1234-1234-1234-123456789def";
  const actions = [
    "read_design_content",
    "get_nodes",
    "get_images",
    "get_image_fills",
    "get_comments",
  ];
  const scopes = actions.map((action) => `figma:${action}`);

  for (let iteration = 0; iteration < iterations; iteration++) {
    let actionResult;
    let actionStatus = 200;
    const requests = [];
    const pendingCloses = new Map();
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      receivedRequests++;
      const body = req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(raw))
        : raw
          ? JSON.parse(raw)
          : {};
      requests.push({ path: req.url, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/pending/")) {
        res.once("close", () => {
          canceledResponses++;
          pendingCloses.get(req.url)();
        });
        res.write('{"pending":');
        return;
      }
      if (req.url === "/oauth/token")
        return res.end(
          JSON.stringify({
            access_token: "DOWNSTREAM-PRIVATE",
            refresh_token: "ROTATING-PRIVATE",
            expires_in: 900,
            token_type: "Bearer",
            scope: scopes.join(" "),
          }),
        );
      if (req.url === "/api/v1/data/authorization")
        return res.end(
          JSON.stringify({
            version: 1,
            providerId: "figma",
            connectionId,
            grantId,
            account: { id: "figma-account", login: "fixture", label: "Fixture account" },
            actions,
            scopes,
            resources: [{ id: "files", items: [{ id: file, label: "Selected fixture" }] }],
            resourceGroups: [{ id: "files", items: [{ id: file, label: "Selected fixture" }] }],
          }),
        );
      res.statusCode = actionStatus;
      // Keep the one-shot response that exposed the Bun compatibility issue.
      res.end(
        JSON.stringify(
          actionStatus === 200 ? { result: actionResult } : { error: "Synthetic upstream failure" },
        ),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    allowedPort = server.address().port;
    const issuer = `http://127.0.0.1:${allowedPort}`;
    const directory = mkdtempSync(join(fixtureHome, "figma-node-overflow-"));
    try {
      const store = new CredentialStore(undefined, new PlaintextCipher(), directory);
      const attempt = beginRemoteLinkAuthorization(
        { issuer, clientId: "registered-client", redirectUri: "http://127.0.0.1:4900/callback" },
        Date.now(),
        { providerId: "figma", actions },
      );
      store.save(
        "user",
        await completeRemoteLinkAuthorization(
          attempt,
          `${attempt.configuration.redirectUri}?code=once&state=${attempt.state}`,
          "selected-link",
          "Selected Link",
        ),
      );
      const execute = (
        params = { file_url_or_key: `https://www.figma.com/design/${file}/Fixture` },
      ) =>
        executeRemoteLinkAction(
          { id: "selected-link", grantId, scope: "full", action: "read_design_content", params },
          { store },
        );
      const content = "x".repeat(3 * 1024 * 1024);
      actionResult = {
        name: "Large file",
        document: { id: "0:0", type: "DOCUMENT", description: content },
      };
      assert.equal((await execute({ file_key: file, full: true })).document.description, content);
      actionResult = {
        name: "Too large",
        document: { id: "0:0", type: "DOCUMENT", description: "x".repeat(8 * 1024 * 1024) },
      };
      await assert.rejects(execute(), { code: "response_too_large" });
      await assert.rejects(execute(), /get_nodes/);
      assert.equal(store.resolve("selected-link").meta.linkRemoteState, "connected");
      actionResult = {
        name: "Selected structure",
        document: { id: "0:0", type: "DOCUMENT", children: [] },
      };
      for (const status of [200, 413, 200]) {
        actionStatus = status;
        if (status === 413) await assert.rejects(execute(), { code: "response_too_large" });
        else {
          const selected = await execute({ file_key: file, depth: 1 });
          assert.equal(selected.name, "Selected structure");
          assert.equal(selected.requestedDepth, 1);
          assert.deepEqual(requests.at(-1).body, { file_url_or_key: file, depth: 1 });
        }
      }
      assert.equal(store.resolve("selected-link").meta.linkRemoteState, "connected");

      for (const mode of ["abort", "cancel"]) {
        const path = `/pending/${mode}`;
        const closed = new Promise((resolve) => pendingCloses.set(path, resolve));
        const controller = new AbortController();
        const response = await requestOnce(issuer + path, { signal: controller.signal });
        const reader = response.body.getReader();
        assert.equal((await reader.read()).done, false);
        if (mode === "abort") {
          const rejected = assert.rejects(reader.read(), Error);
          controller.abort();
          await rejected;
        } else await reader.cancel();
        reader.releaseLock();
        await closed;
      }
      assert.equal(requests.length, 10, "Each action and cancellation has one physical request");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      closedServers++;
      allowedPort = 0;
      rmSync(directory, { recursive: true, force: true });
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deniedNetwork, 4);
  assert.equal(physicalRequests, iterations * 10);
  assert.equal(receivedRequests, physicalRequests);
  assert.equal(closedServers, iterations);
  assert.equal(canceledResponses, iterations * 2);
  assert.deepEqual(unhandled, []);
  console.log(
    JSON.stringify({
      result: "pass",
      iterations,
      physicalRequests,
      receivedRequests,
      closedServers,
      canceledResponses,
      deniedNetwork,
      unhandled,
    }),
  );
} finally {
  http.request = nativeHttp;
  https.request = nativeHttps;
  globalThis.fetch = nativeFetch;
  syncBuiltinESMExports();
  process.removeListener("unhandledRejection", onUnhandled);
}
