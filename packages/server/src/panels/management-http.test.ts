import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelManagementHttp } from "./management-http.js";
import { publicPanelError } from "./management.js";

let root: string;
let previousHome: string | undefined;
let server: Server;
let url: string;
let owner: string | undefined;
let api: ReturnType<typeof createPanelManagementHttp>;
let commitFailure: Error | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cs-panel-http-"));
  previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  owner = "device-a";
  commitFailure = undefined;
  api = createPanelManagementHttp({
    cwd,
    ownerId: async () => owner,
    isAuthorized: async () => Boolean(owner),
    resolveCommit: async () => {
      if (commitFailure) throw commitFailure;
      return "a".repeat(40);
    },
  });
  server = createServer((request, response) => {
    void api.handle(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  api.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function request(path: string, method = "GET", body?: unknown) {
  return fetch(url + path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

test("management reads are authenticated and never cached", async () => {
  const response = await request("/api/v1/panels");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ panels: [], hasProject: true });
  owner = undefined;
  expect((await request("/api/v1/panels")).status).toBe(401);
});

test("HTTP rejects local source paths, overwrite flags, unsafe IDs and oversized bodies", async () => {
  expect(
    (await request("/api/v1/panels/preview", "POST", { source: { kind: "dir", path: root } }))
      .status,
  ).toBe(400);
  expect(
    (await request("/api/v1/panels/install", "POST", { reviewToken: "anything", overwrite: true }))
      .status,
  ).toBe(400);
  expect(
    (await request("/api/v1/panels/bad%2Fpath", "DELETE", { expectedRevision: "a".repeat(64) }))
      .status,
  ).toBe(400);
  expect(
    (await request("/api/v1/panels/preview", "POST", { source: "x".repeat(20_000) })).status,
  ).toBe(413);
  expect(
    (await request("/api/v1/panels/missing", "DELETE", { expectedRevision: "a".repeat(64) }))
      .status,
  ).toBe(404);
});

test("closed HTTP services cannot return an authenticated catalog", async () => {
  api.close();
  const response = await request("/api/v1/panels");
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "login_required" });
});

test("GitHub rate limits remain actionable in the real HTTP discovery response", async () => {
  commitFailure = new Error("GitHub API 速率限制（每小时 60 次未鉴权请求），稍后再试");
  const response = await request("/api/v1/panels/github/discover", "POST", {
    url: "https://github.com/cjhyy/codeshell-panel-apps",
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    code: "github_rate_limit",
    error: expect.stringContaining("GitHub 请求次数已达到限制"),
  });
});

test("known GitHub failures distinguish timeouts, unavailable repositories, upstream errors and networking", () => {
  const cases: Array<[Error, number, string]> = [
    [Object.assign(new Error("aborted"), { name: "AbortError" }), 504, "github_timeout"],
    [
      Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
      504,
      "github_timeout",
    ],
    [new Error("找不到仓库（404）"), 404, "github_not_found"],
    [new Error("GitHub source download returned HTTP 404 Not Found"), 404, "github_not_found"],
    [new Error("GitHub 拒绝访问（403）"), 403, "github_forbidden"],
    [new Error("GitHub API 429 Too Many Requests"), 429, "github_rate_limit"],
    [new Error("GitHub API 503 Service Unavailable"), 503, "github_unavailable"],
    [
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
      502,
      "github_network",
    ],
    [new Error("GitHub source download failed: fetch failed"), 502, "github_network"],
  ];
  for (const [error, status, code] of cases)
    expect(publicPanelError(error)).toMatchObject({ status, code });
  const internal = publicPanelError(new Error("Unable to open /private/secret.json"));
  expect(internal.status).toBe(503);
  expect(internal.message).not.toContain("/private/");
});
