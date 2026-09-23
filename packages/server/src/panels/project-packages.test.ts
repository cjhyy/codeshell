import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installReviewedLocalPanelApp,
  previewLocalPanelApp,
  listProjectPanelApps,
} from "@cjhyy/code-shell-core";
import { createPanelHttp } from "./http.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("real Hub HTTP serves and executes each project's retained package across catalog updates and restart", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cs-project-packages-http-")));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  cleanups.push(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "source");
  mkdirSync(join(source, ".codeshell-panel"), { recursive: true });
  mkdirSync(join(source, "app", "tools"), { recursive: true });
  async function install(version: string, overwrite = false) {
    const script = `process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"result",result:{version:${JSON.stringify(version)}}})));`;
    writeFileSync(join(source, "app/tools/version.mjs"), script);
    writeFileSync(join(source, "app/index.html"), `<!doctype html><body>Package ${version}</body>`);
    writeFileSync(
      join(source, ".codeshell-panel/panel.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "version-fixture",
        title: { default: "Version fixture" },
        version,
        entry: "app/index.html",
        icon: "panel",
        placement: "right-dock",
        singleton: true,
        permissions: ["context.workspace", "storage", "process", "resources"],
        nativeEntries: {
          version: {
            entry: "app/tools/version.mjs",
            sha256: createHash("sha256").update(script).digest("hex"),
          },
        },
      }),
    );
    const input = { kind: "dir" as const, path: source };
    const preview = await previewLocalPanelApp(input);
    return installReviewedLocalPanelApp(input, preview.reviewToken, new Date().toISOString(), {
      overwrite,
    });
  }
  async function host(name: string) {
    const cwd = join(root, name);
    mkdirSync(cwd, { recursive: true });
    const api = createPanelHttp({
      cwd,
      dataDir: join(root, "data-" + name),
      host: "hub",
      ownerId: async () => "owner",
      isAuthorized: async () => true,
    });
    const server = createServer((request, response) => {
      void (async () =>
        (await api.handleAssets(request, response)) || api.handle(request, response))()
        .then((handled) => {
          if (!handled) response.writeHead(404).end();
        })
        .catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await api.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    cleanups.push(close);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    async function request(path: string, method = "GET", body?: unknown) {
      return fetch(base + path, {
        method,
        headers: { origin: base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function catalog() {
      const response = await request("/api/v1/panels");
      expect(response.status).toBe(200);
      return (await response.json()).panels[0];
    }
    async function bind(bound: boolean) {
      const panel = await catalog();
      const response = await request("/api/v1/panels/version-fixture/binding", "PATCH", {
        bound,
        expectedRevision: panel.revision,
      });
      expect(response.status).toBe(200);
      return (await response.json()).panels[0];
    }
    async function prepare() {
      const panel = await catalog();
      const response = await request("/api/v1/panels/runtime/prepare", "POST", {
        appId: panel.id,
        revision: panel.revision,
      });
      expect(response.status).toBe(200);
      return response.json();
    }
    async function page(grant: { src: string }) {
      const response = await fetch(base + grant.src, { headers: { origin: "null" } });
      expect(response.status).toBe(200);
      return response.text();
    }
    async function run(grant: { instanceId: string }, version: string) {
      const route = "/api/v1/panels/runtime/" + grant.instanceId;
      const pending = request(route + "/call", "POST", {
        method: "tasks.start",
        params: { entry: "version", input: { request: {} }, recovery: "retry" },
      });
      const deadline = Date.now() + 5000;
      let confirmed = false;
      while (Date.now() < deadline) {
        const events = await (await request(route + "/events?after=0")).json();
        const confirm = events.events.find((event: any) => event.event === "host.confirm");
        if (confirm) {
          expect(
            (
              await request(route + "/confirm", "POST", {
                requestId: confirm.payload.requestId,
                allowed: true,
              })
            ).status,
          ).toBe(200);
          confirmed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!confirmed) {
        api.cancelOwner("owner");
        await pending;
        throw new Error("No task confirmation");
      }
      const response = await pending;
      expect(response.status).toBe(200);
      const job = await response.json();
      const selected = await catalog();
      expect(job.package).toEqual({ version, packageDigest: selected.packageDigest });
      let current;
      while (Date.now() < deadline) {
        const status = await request(route + "/call", "POST", {
          method: "tasks.get",
          params: { id: job.id },
        });
        expect(status.status).toBe(200);
        current = await status.json();
        if (["succeeded", "failed", "cancelled"].includes(current.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(current).toMatchObject({
        status: "succeeded",
        result: { version },
        package: job.package,
      });
      return job.id;
    }
    return { cwd, api, request, catalog, bind, prepare, page, run, close };
  }

  await install("1.0.0");
  const first = await host("project-a"),
    second = await host("project-b");
  await first.bind(true);
  const old = await second.bind(true);
  const original = await second.prepare();
  expect(await second.page(original)).toContain("Package 1.0.0");
  // This project is not discovered until after the global catalog changes.
  const dormantPath = join(root, "dormant-project");
  mkdirSync(join(dormantPath, ".code-shell"), { recursive: true });
  writeFileSync(
    join(dormantPath, ".code-shell/settings.json"),
    JSON.stringify({
      panelAppOverrides: { "version-fixture": "on" },
      migrationNote: "preserve",
    }),
  );
  await install("2.0.0", true);
  const dormant = await host("dormant-project");
  expect(await dormant.catalog()).toMatchObject({ version: "1.0.0", bound: true });
  expect(
    JSON.parse(readFileSync(join(dormantPath, ".code-shell/settings.json"), "utf8")),
  ).toMatchObject({
    panelAppPins: { "version-fixture": { version: "1.0.0", packageDigest: old.packageDigest } },
    migrationNote: "preserve",
  });
  const migrated = await dormant.prepare();
  expect(await dormant.page(migrated)).toContain("Package 1.0.0");
  await dormant.run(migrated, "1.0.0");
  await dormant.close();
  // A catalog update never changes a pinned project or revokes its open page.
  expect(await second.catalog()).toMatchObject({ version: "1.0.0", revision: old.revision });
  expect(await second.page(original)).toContain("Package 1.0.0");
  const firstOldJob = await first.run(await first.prepare(), "1.0.0");
  await first.bind(false);
  await first.bind(true);
  const newer = await first.prepare();
  expect(await first.page(newer)).toContain("Package 2.0.0");
  const oldHistory = await first.request(
    `/api/v1/panels/runtime/${newer.instanceId}/call`,
    "POST",
    {
      method: "tasks.get",
      params: { id: firstOldJob },
    },
  );
  expect(oldHistory.status).toBe(200);
  expect(await oldHistory.json()).toMatchObject({
    readOnly: true,
    package: { version: "1.0.0", packageDigest: old.packageDigest },
    result: { version: "1.0.0" },
  });
  // Fail before showing a consent request for an operation that cannot proceed.
  const retry = await first.request(`/api/v1/panels/runtime/${newer.instanceId}/call`, "POST", {
    method: "tasks.retry",
    params: { id: firstOldJob },
  });
  expect(retry.status).not.toBe(200);
  expect(await retry.text()).toContain("仅供查看");
  await first.run(newer, "2.0.0");
  const historyResponse = await first.request("/api/v1/panels/version-fixture/versions", "POST", {
    expectedRevision: (await first.catalog()).revision,
  });
  expect(historyResponse.status).toBe(200);
  const versions = await historyResponse.json();
  expect(versions.versions.map((item: any) => item.version).sort()).toEqual(["1.0.0", "2.0.0"]);
  const restorePreview = await first.request(
    "/api/v1/panels/version-fixture/restore-preview",
    "POST",
    {
      expectedRevision: versions.expectedRevision,
      packageDigest: old.packageDigest,
    },
  );
  expect(restorePreview.status).toBe(200);
  expect(
    (
      await first.request("/api/v1/panels/restore", "POST", {
        reviewToken: (await restorePreview.json()).reviewToken,
      })
    ).status,
  ).toBe(200);
  const recovered = await first.prepare();
  expect(await first.page(recovered)).toContain("Package 1.0.0");
  await first.run(recovered, "1.0.0");
  const originalHistory = await first.request(
    `/api/v1/panels/runtime/${recovered.instanceId}/call`,
    "POST",
    {
      method: "tasks.get",
      params: { id: firstOldJob },
    },
  );
  expect(await originalHistory.json()).toMatchObject({
    readOnly: false,
    package: { version: "1.0.0", packageDigest: old.packageDigest },
  });
  const oldJob = await second.run(original, "1.0.0");
  await second.close();
  const restarted = await host("project-b");
  expect(await restarted.catalog()).toMatchObject({ version: "1.0.0", revision: old.revision });
  const restored = await restarted.prepare();
  expect(await restarted.page(restored)).toContain("Package 1.0.0");
  const history = await restarted.request(
    `/api/v1/panels/runtime/${restored.instanceId}/call`,
    "POST",
    {
      method: "tasks.get",
      params: { id: oldJob },
    },
  );
  expect(history.status).toBe(200);
  expect(await history.json()).toMatchObject({
    id: oldJob,
    status: "succeeded",
    result: { version: "1.0.0" },
    package: { version: "1.0.0", packageDigest: old.packageDigest },
  });
  // A corrupt retained package cannot fall back to the valid latest catalog.
  const retained = (await listProjectPanelApps(restarted.cwd))[0]!;
  writeFileSync(join(retained.installPath, "app/tools/version.mjs"), "tampered");
  const damagedResponse = await restarted.request("/api/v1/panels");
  expect(damagedResponse.status).toBe(200);
  const damaged = await damagedResponse.json();
  expect(damaged.panels).toEqual([]);
  expect(damaged.issues).toMatchObject([
    { id: retained.id, code: "package_unavailable", version: "1.0.0" },
  ]);
  expect(
    (
      await restarted.request(`/api/v1/panels/runtime/${restored.instanceId}/call`, "POST", {
        method: "tasks.start",
        params: { entry: "version", input: { request: {} } },
      })
    ).status,
  ).not.toBe(200);
  const repairHistoryResponse = await restarted.request(
    "/api/v1/panels/version-fixture/versions",
    "POST",
    { expectedRevision: damaged.issues[0].revision },
  );
  expect(repairHistoryResponse.status).toBe(200);
  const repairHistory = await repairHistoryResponse.json();
  expect(repairHistory.current.unavailable).toBe(true);
  expect(repairHistory.versions.map((item: any) => item.version)).toEqual(["2.0.0"]);
  const repairResponse = await restarted.request(
    "/api/v1/panels/version-fixture/restore-preview",
    "POST",
    {
      expectedRevision: repairHistory.expectedRevision,
      packageDigest: repairHistory.versions[0].packageDigest,
    },
  );
  expect(repairResponse.status).toBe(200);
  const repair = await repairResponse.json();
  expect(repair.addedPermissions).toEqual(repair.permissions);
  expect(
    (await restarted.request("/api/v1/panels/restore", "POST", { reviewToken: repair.reviewToken }))
      .status,
  ).toBe(200);
  const repaired = await restarted.prepare();
  expect(await restarted.page(repaired)).toContain("Package 2.0.0");
  await restarted.run(repaired, "2.0.0");
  const preserved = await restarted.request(
    `/api/v1/panels/runtime/${repaired.instanceId}/call`,
    "POST",
    { method: "tasks.get", params: { id: oldJob } },
  );
  expect(await preserved.json()).toMatchObject({
    id: oldJob,
    result: { version: "1.0.0" },
    readOnly: true,
  });
  expect(
    readFileSync(
      join(process.env.HOME!, ".code-shell/panel-apps/version-fixture/app/index.html"),
      "utf8",
    ),
  ).toContain("2.0.0");
}, 20000);
