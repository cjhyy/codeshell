import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProjectControlServer } from "./control-server.js";
import type { ProjectRuntimeProvider } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-project-control-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Shared workbench</title>");
  const running = new Set<string>();
  const provider: ProjectRuntimeProvider = {
    availability: async () => ({ available: true }),
    async ensure(project) {
      running.add(project.id);
      return {
        url: "http://127.0.0.1:65534",
        username: project.runtimeUsername,
        password: project.runtimePassword,
        generation: project.generation,
      };
    },
    async stop(project) {
      running.delete(project.id);
    },
    async status(project) {
      return running.has(project.id)
        ? { state: "running", url: "http://127.0.0.1:65534" }
        : { state: "stopped" };
    },
    close: async () => {},
  };
  const server = await startProjectControlServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: root,
    staticRootDir: root,
    provider,
  });
  cleanups.push(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const setup = await fetch(server.url + "/api/v1/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: server.url },
    body: JSON.stringify({
      token: server.bootstrapToken,
      username: "alice",
      password: "Test-password-23940",
    }),
  });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  await setup.arrayBuffer();
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers?: Record<string, string>,
  ) =>
    fetch(server.url + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: server.url,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { root, server, request, running, cookie };
}

test("authenticated project lifecycle serves one shared shell and never exposes credentials", async () => {
  const f = await fixture();
  expect((await fetch(f.server.url + "/")).status).toBe(200);
  expect((await fetch(f.server.url + "/api/v1/projects")).status).toBe(401);
  expect((await f.request("/api/v1/projects")).status).toBe(200);
  const created = await f.request("/api/v1/projects", "POST", { name: "Design" });
  expect(created.status).toBe(201);
  const { project } = (await created.json()) as {
    project: { id: string; status: string; generation: number };
  };
  expect(project.status).toBe("stopped");
  expect(Object.keys(project).sort()).toEqual(
    ["id", "name", "status", "generation", "createdAt", "updatedAt"].sort(),
  );
  const started = await f.request(`/api/v1/projects/${project.id}/start`, "POST", {});
  expect(started.status).toBe(200);
  expect(((await started.json()) as { project: { generation: number } }).project.generation).toBe(
    1,
  );
  expect(f.running.has(project.id)).toBe(true);
  expect((await f.request(`/api/v1/projects/${project.id}/stop`, "POST", {})).status).toBe(200);
  expect(f.running.has(project.id)).toBe(false);
  expect((await f.request("/api/v1/configuration")).status).toBe(404);
  expect((await f.request(`/p/${project.id}/api/v1/auth/status`)).status).toBe(404);
});

test("control mutations reject CSRF, caller-provided runtime paths, and invalid bodies", async () => {
  const f = await fixture();
  expect(
    (
      await f.request(
        "/api/v1/projects",
        "POST",
        { name: "Work" },
        { Origin: "https://other.example" },
      )
    ).status,
  ).toBe(403);
  expect((await f.request("/api/v1/projects", "POST", { name: "Work", cwd: "/" })).status).toBe(
    400,
  );
  expect(
    (await f.request("/api/v1/projects", "POST", { name: "Work", ownerId: "bob" })).status,
  ).toBe(400);
  expect((await f.request("/api/v1/projects", "POST", { name: "x".repeat(9000) })).status).toBe(
    413,
  );
  expect((await f.request("/api/v1/projects?workspace=/etc")).status).toBe(400);
  expect((await f.request("/api/v1/auth/logout", "POST", {})).status).toBe(200);
  expect((await f.request("/api/v1/projects", "POST", { name: "Work" })).status).toBe(401);
});

test("a second control process cannot open the same registry", async () => {
  const f = await fixture();
  await expect(
    startProjectControlServer({ host: "127.0.0.1", port: 0, dataDir: f.root }),
  ).rejects.toThrow();
  expect((await f.request("/api/v1/projects")).status).toBe(200);
});
