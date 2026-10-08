import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { requestOnce } from "./request-once.js";

let server: ReturnType<typeof createServer>;
let origin: string;
let calls: Array<{ path: string; method: string; body: string }>;
beforeEach(async () => {
  calls = [];
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ path: request.url!, method: request.method!, body });
    if (request.url === "/lost") request.socket.destroy();
    else if (request.url === "/redirect") {
      response.writeHead(307, { Location: `${origin}/target` });
      response.end();
    } else if (request.url === "/wait") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"pending":');
    } else if (request.url === "/empty") {
      response.writeHead(204);
      response.end();
    } else {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end('{"error":"expired"}');
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

test("a consumed POST with a lost response has exactly one physical send", async () => {
  await expect(
    requestOnce(`${origin}/lost`, {
      method: "POST",
      body: new URLSearchParams({ refresh_token: "synthetic-rotating-token" }),
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(calls).toEqual([
    { path: "/lost", method: "POST", body: "refresh_token=synthetic-rotating-token" },
  ]);
});

test("redirects never forward a credential or replay a write", async () => {
  await expect(
    requestOnce(`${origin}/redirect`, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic" },
      body: "{}",
    }),
  ).rejects.toThrow("redirects");
  expect(calls.map((call) => call.path)).toEqual(["/redirect"]);
});

test("upstream HTTP failures remain visible to the caller without retry", async () => {
  const response = await requestOnce(`${origin}/denied`);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "expired" });
  expect(calls).toHaveLength(1);
  const empty = await requestOnce(`${origin}/empty`);
  expect(empty.status).toBe(204);
  expect(empty.body).toBeNull();
});

test("abort still bounds a response body after headers arrive", async () => {
  const controller = new AbortController();
  const response = await requestOnce(`${origin}/wait`, { signal: controller.signal });
  const read = response.text();
  controller.abort();
  await expect(read).rejects.toBeInstanceOf(Error);
  expect(calls).toHaveLength(1);
});

test("unsupported protocols and body types fail before network I/O", async () => {
  await expect(requestOnce("file:///private")).rejects.toThrow("protocol");
  await expect(requestOnce(`${origin}/target`, { body: new Blob(["private"]) })).rejects.toThrow(
    "body",
  );
  expect(calls).toHaveLength(0);
});
