import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installReviewedLocalPanelApp, previewLocalPanelApp } from "@cjhyy/code-shell-core";
import { startHeadlessServer, type HeadlessServer } from "./headless-server.js";

let server: HeadlessServer | undefined;
let root: string | undefined;
const previousHome = process.env.HOME;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Hub panel routes enforce authentication and Origin, share bindings, and revoke asset grants on logout", async () => {
  root = mkdtempSync(join(tmpdir(), "cs-hub-panels-"));
  process.env.HOME = join(root, "home");
  const cwd = join(root, "workspace");
  const source = join(root, "source");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(source, ".codeshell-panel"), { recursive: true });
  mkdirSync(join(source, "app"));
  writeFileSync(
    join(source, ".codeshell-panel/panel.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "hub-fixture",
      title: { default: "Hub fixture" },
      version: "1.0.0",
      entry: "app/index.html",
      icon: "panel",
      placement: "right-dock",
      singleton: true,
      permissions: ["context.workspace", "storage"],
    }),
  );
  writeFileSync(
    join(source, "app/index.html"),
    "<!doctype html><html><head></head><body>fixture</body></html>",
  );
  const input = { kind: "dir" as const, path: source };
  const preview = await previewLocalPanelApp(input);
  await installReviewedLocalPanelApp(input, preview.reviewToken, new Date().toISOString());
  server = await startHeadlessServer({
    cwd,
    dataDir: join(root, "data"),
    workerEntryPath: join(root, "unused-worker.cjs"),
    staticRootDir: source,
    authMode: "hub",
    port: 0,
  });
  const base = server.url;
  const setup = await fetch(base + "/api/v1/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      token: server.bootstrapToken,
      username: "tester",
      password: "test-panel-password-123",
    }),
  });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get("set-cookie")!.split(";", 1)[0]!;
  async function request(path: string, method = "GET", body?: unknown, origin = base) {
    return fetch(base + path, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  expect((await fetch(base + "/api/v1/panels")).status).toBe(401);
  expect((await request("/api/v1/panels", "GET", undefined, "https://other.example")).status).toBe(
    403,
  );
  expect((await fetch(base + "/api/v1/panel-assets/missing/app/index.html")).status).toBe(404);
  const catalog = (await (await request("/api/v1/panels")).json()) as any;
  expect(catalog.panels).toHaveLength(1);
  expect(catalog.panels[0].bound).toBe(false);
  const binding = await request("/api/v1/panels/hub-fixture/binding", "PATCH", {
    bound: true,
    expectedRevision: catalog.panels[0].revision,
  });
  expect(binding.status).toBe(200);
  const latest = (await binding.json()) as any;
  const prepare = await request("/api/v1/panels/runtime/prepare", "POST", {
    appId: "hub-fixture",
    revision: latest.panels[0].revision,
  });
  expect(prepare.status).toBe(200);
  const grant = (await prepare.json()) as any;
  const asset = await fetch(base + grant.src, { headers: { origin: "null" } });
  expect(asset.status).toBe(200);
  expect(asset.headers.get("access-control-allow-origin")).toBe("*");
  expect(asset.headers.get("content-security-policy")).toContain("sandbox allow-scripts;");
  expect(await asset.text()).toContain("_codeshell_bridge.js");
  const call = `/api/v1/panels/runtime/${grant.instanceId}/call`;
  expect(
    (
      await request(call, "POST", {
        method: "storage.set",
        params: { key: "hello", value: "world" },
      })
    ).status,
  ).toBe(200);
  expect((await request(call, "POST", { method: "process.exec", params: {} })).status).toBe(501);
  expect((await request("/api/v1/auth/logout", "POST", {})).status).toBe(200);
  expect((await fetch(base + grant.src, { headers: { origin: "null" } })).status).toBe(404);
  expect(
    (await request(call, "POST", { method: "storage.get", params: { key: "hello" } })).status,
  ).toBe(401);
});
