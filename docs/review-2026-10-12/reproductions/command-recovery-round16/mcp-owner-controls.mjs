import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-native-smoke-")) throw new Error("Use maintained native isolator");
const repo = process.cwd(), evidence = dirname(fileURLToPath(import.meta.url));
const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard(origin);
const { createHubMcpConfiguration } = await import(`${repo}/packages/server/dist/hub/mcp-configuration.js`);
const { createHubAuth } = await import(`${repo}/packages/server/dist/hub/auth-http.js`);
const dir = mkdtempSync(join(tmpdir(), "owned-mcp-controls-"));
mkdirSync(join(dir, ".code-shell"));
writeFileSync(join(dir, ".code-shell", "settings.json"), JSON.stringify({ mcpServers: {
  owned: { transport: "streamable-http", url: `${origin}/owned-mcp`, enabled: false },
} }));
let api;
const revoked = [];
const auth = await createHubAuth({ dataDir: join(dir, "auth-data"), publicOrigin: origin, onRevoke: (id) => { revoked.push(id); api?.cancelOwner(id); } });
api = createHubMcpConfiguration({ cwd: dir,
  // Exact production owner/auth callbacks: no gate, delayed auth or fake identity.
  isAuthorized: async (req) => !!(await auth.authenticate(req)),
  ownerId: async (req) => (await auth.authenticate(req))?.id,
  probeTimeoutMs: 1500,
});
let assertions = 0, mode = "complete", initializes = 0, upstreamClosed = 0, partialRequest, partialResponse, partialDone = false;
let cookieA, cookieB;
const upstream = new Set(), clients = new Set(), ownRequests = new Set(), observations = [];
const check = (value, label) => { assertions++; assert.ok(value, label); };
const equal = (actual, expected, label) => { assertions++; assert.deepEqual(actual, expected, label); };
async function until(test, label, timeout = 3000) {
  const start = Date.now(); while (!test()) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await delay(5); }
}
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/owned-mcp") {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      if (message.method === "initialize") {
        initializes++;
        if (mode === "hang") { upstream.add(res); res.once("close", () => { upstream.delete(res); upstreamClosed++; }); return; }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "owned", version: "1" } }
        : { tools: [{ name: "owned_echo", inputSchema: { type: "object", properties: {} } }] } }));
      return;
    }
    if (await auth.handle(req, res)) return;
    // Same admission checks used by headless handleHttp, followed by the actual MCP module.
    if (!(await auth.authenticate(req))) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "login required" })); return; }
    if (!auth.isOriginAllowed(req)) { res.writeHead(403); res.end(); return; }
    if (req.headers["x-owned-partial"] === "yes") { partialRequest = req; partialResponse = res; }
    const handled = await api.handle(req, res);
    if (req.headers["x-owned-partial"] === "yes") partialDone = true;
    if (!handled) { res.writeHead(404); res.end(); }
  } catch (error) { console.error("unexpected owned fixture route error", error); res.destroy(error); }
});
server.on("connection", (socket) => { clients.add(socket); socket.once("close", () => clients.delete(socket)); });
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
function call(path, cookie = cookieA, body = {}) {
  return fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
}
const endpoint = "/api/v1/mcp/servers/owned/";
const credentials = { username: "owned-reviewer", password: "owned-review-password", deviceName: "owned-A" };
function rawProbe(partial = false) {
  const req = request(`${origin}${endpoint}probe`, { method: "POST", headers: { origin, "content-type": "application/json", "content-length": "2", cookie: cookieA, ...(partial ? { "x-owned-partial": "yes" } : {}) } });
  ownRequests.add(req); req.once("close", () => ownRequests.delete(req)); req.on("error", () => {});
  if (partial) { req.flushHeaders(); req.write("{"); } else req.end("{}");
  return req;
}
const deadline = setTimeout(() => { for (const req of ownRequests) req.destroy(); for (const res of upstream) res.destroy(); for (const socket of clients) socket.destroy(); void api.close(); }, 10000);
try {
  const setup = await call("/api/v1/auth/setup", undefined, { ...credentials, token: auth.bootstrapToken });
  equal(setup.status, 200); cookieA = setup.headers.get("set-cookie").split(";", 1)[0]; const identityA = (await setup.json()).session.id;
  const loginB = await call("/api/v1/auth/login", "", { ...credentials, deviceName: "owned-B" });
  equal(loginB.status, 200); cookieB = loginB.headers.get("set-cookie").split(";", 1)[0]; const identityB = (await loginB.json()).session.id;
  check(identityA !== identityB);

  // Actual pre-registration wait is body upload, not an artificial owner callback.
  const partial = rawProbe(true);
  await until(() => !!partialRequest, "real request admitted, JSON body not completed");
  equal(initializes, 0);
  const earlyCancel = await call(endpoint + "cancel-probe"); equal(earlyCancel.status, 200); equal(await earlyCancel.json(), { cancelled: false });
  partial.destroy();
  await until(() => partialResponse.destroyed && partialDone, "real partial request abort settles without starting probe");
  equal(initializes, 0);
  observations.push({ phase: "early-body-abort", actualAuth: true, cancelFoundNoProbe: true, originalSocketDestroyed: partialRequest.socket.destroyed, upstreamInitializeRequests: initializes });

  const normal = await call(endpoint + "probe"); equal(normal.status, 200); equal((await normal.json()).status, "ok");
  mode = "hang";
  let before = initializes, closedBefore = upstreamClosed;
  const pending = call(endpoint + "probe"); await until(() => initializes === before + 1, "registered real probe starts");
  const occupied = await call(endpoint + "probe"); equal(occupied.status, 429); await occupied.arrayBuffer();
  const wrong = await call(endpoint + "cancel-probe", cookieB); equal(await wrong.json(), { cancelled: false });
  const cancel = await call(endpoint + "cancel-probe"); equal(await cancel.json(), { cancelled: true });
  const pendingResponse = await pending; equal(pendingResponse.status, 200); equal((await pendingResponse.json()).status, "cancelled");
  await until(() => upstreamClosed > closedBefore, "own upstream closes after actual cancellation");
  observations.push({ phase: "cancel-owner", sameOwnerCapacity429: true, otherOwnerCannotCancel: true, cancelled: true, upstreamClosed: true });

  before = initializes; closedBefore = upstreamClosed;
  const disconnect = rawProbe(); await until(() => initializes === before + 1, "registered disconnect control starts");
  disconnect.destroy(); await until(() => upstreamClosed > closedBefore, "real disconnected HTTP probe closes upstream");
  mode = "complete";
  const retry = await call(endpoint + "probe"); equal(retry.status, 200); equal((await retry.json()).status, "ok");
  observations.push({ phase: "disconnect-retry", upstreamClosed: true, nextProbe: "ok" });

  mode = "hang"; before = initializes; closedBefore = upstreamClosed;
  const revokePending = call(endpoint + "probe"); await until(() => initializes === before + 1, "registered logout control starts");
  const logout = await call("/api/v1/auth/logout"); equal(logout.status, 200); await logout.arrayBuffer();
  check(revoked.includes(identityA)); await until(() => upstreamClosed > closedBefore, "logout cancels MCP owner's upstream");
  const revokedResponse = await revokePending; equal(revokedResponse.status, 401); await revokedResponse.arrayBuffer();
  const rejected = await call(endpoint + "probe"); equal(rejected.status, 401); await rejected.arrayBuffer();
  mode = "complete";
  const other = await call(endpoint + "probe", cookieB); equal(other.status, 200); equal((await other.json()).status, "ok");
  observations.push({ phase: "logout-isolation", revokedOwner: true, upstreamClosed: true, oldCookie401: true, otherCookieProbe: "ok" });
  console.log(`PASS native actual-auth MCP early body abort/cancel/disconnect/logout recovery; ${assertions} assertions`);
} finally {
  clearTimeout(deadline); for (const req of ownRequests) req.destroy(); await api.close();
  for (const res of upstream) res.destroy(); for (const socket of clients) socket.destroy();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(evidence, "mcp-owner-controls-observed.json"), JSON.stringify({ origin, node: process.version, assertions, observations }, null, 2));
}
