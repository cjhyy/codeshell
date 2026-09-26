// Exercise delivered Panel bytes in real project containers. Package installation
// uses the public SDK as an administrator; binding, storage and restore use HTTP.
// Controlled HTML-only updates prove package selection, not domain data migration.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ids = [
  "design-studio",
  "job-hunt-hq",
  "quant-lab",
  "starter-panel",
  "video-download",
  "video-studio",
];
const marker = "candidate-panel-lifecycle-controlled-update";
const key = "candidate-lifecycle-proof";

async function installInContainer(corePath, files) {
  const assert = (await import("node:assert/strict")).default;
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { previewLocalPanelApp, installReviewedLocalPanelApp } = await import(corePath);
  const output = [];
  for (const [id, entries] of files) {
    const root = `/tmp/candidate-panel-lifecycle/${id}`;
    for (const [relative, encoded] of entries) {
      const path = join(root, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(encoded, "base64"), { flag: "wx" });
    }
    const manifest = JSON.parse(await readFile(join(root, ".codeshell-panel/panel.json"), "utf8"));
    assert.equal(manifest.id, id);
    const source = { kind: "dir", path: root };
    const review = await previewLocalPanelApp(source);
    const installed = await installReviewedLocalPanelApp(
      source,
      review.reviewToken,
      new Date().toISOString(),
    );
    assert.equal(installed.id, id);
    assert.equal(installed.version, manifest.version);
    assert.match(installed.packageDigest, /^[a-f0-9]{64}$/);
    output.push({
      id,
      version: installed.version,
      packageDigest: installed.packageDigest,
      permissions: installed.permissions,
    });
  }
  return output;
}

async function controlledUpdate(corePath, original, marker) {
  const assert = (await import("node:assert/strict")).default;
  const { readFile, writeFile } = await import("node:fs/promises");
  const { previewLocalPanelApp, installReviewedLocalPanelApp, listInstalledPanelApps } =
    await import(corePath);
  const source = { kind: "dir", path: `/tmp/candidate-panel-lifecycle/${original.id}` };
  const manifest = JSON.parse(await readFile(source.path + "/.codeshell-panel/panel.json", "utf8"));
  const entry = source.path + "/" + manifest.entry;
  const review = await previewLocalPanelApp(source);
  const html = await readFile(entry, "utf8");
  assert.ok(!html.includes(marker));
  await writeFile(entry, html + `\n<!-- ${marker} -->\n`);
  await assert.rejects(
    installReviewedLocalPanelApp(source, review.reviewToken, new Date().toISOString(), {
      overwrite: true,
    }),
    /changed/i,
  );
  const retained = (await listInstalledPanelApps()).find((app) => app.id === original.id);
  assert.equal(
    retained.packageDigest,
    original.packageDigest,
    "Rejected update changed the installed package",
  );
  const reviewed = await previewLocalPanelApp(source);
  const updated = await installReviewedLocalPanelApp(
    source,
    reviewed.reviewToken,
    new Date().toISOString(),
    { overwrite: true },
  );
  assert.equal(
    updated.version,
    original.version,
    "Same version strings must not hide different package content",
  );
  assert.notEqual(updated.packageDigest, original.packageDigest);
  return { id: updated.id, version: updated.version, packageDigest: updated.packageDigest };
}

export async function verifyCandidatePanelLifecycle({
  docker,
  json,
  request,
  containerCore,
  packageRoot,
  containerA,
  containerB,
  projectA,
  projectB,
  panelHarness,
}) {
  const files = [];
  async function collect(root, prefix = "") {
    const result = [];
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) result.push(...(await collect(root, path + "/")));
      else {
        assert.ok(entry.isFile(), "Candidate packages must contain only regular files");
        result.push([path, await readFile(join(root, path), "base64")]);
      }
    }
    return result;
  }
  assert.deepEqual((await readdir(packageRoot)).sort(), ids);
  for (const id of ids) files.push([id, await collect(join(packageRoot, id))]);
  const run = async (container, fn, ...args) =>
    JSON.parse(
      await docker(["exec", "-i", container, "node", "--input-type=module"], {
        input: `console.log(JSON.stringify(await (${fn.toString()})(...${JSON.stringify(args)})));`,
      }),
    );
  const installed = await run(containerA, installInContainer, containerCore, files);
  assert.deepEqual(await run(containerB, installInContainer, containerCore, files), installed);
  const root = (project) => `/p/${project}/api/v1/panels`;
  const panel = async (project, id) => {
    const item = (await json(root(project))).panels.find((item) => item.id === id);
    assert.ok(item, `${id} missing from project ${project}`);
    assert.ok(item.compatibility.supported, `${id}: ${item.compatibility.reasons.join(", ")}`);
    return item;
  };
  const prepare = async (project, id) => {
    const current = await panel(project, id);
    assert.ok(current.bound);
    return json(root(project) + "/runtime/prepare", {
      method: "POST",
      body: { appId: id, revision: current.revision },
    });
  };
  const page = async (project, grant) => {
    const response = await request(`/p/${project}` + grant.src, {
      anonymous: true,
      origin: "null",
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const select = async (project, id, digest) => {
    const current = await panel(project, id);
    const review = await json(root(project) + `/${id}/restore-preview`, {
      method: "POST",
      body: { packageDigest: digest, expectedRevision: current.revision },
    });
    assert.equal(review.packageDigest, digest);
    assert.ok(review.compatibility.supported);
    assert.deepEqual(review.permissions, current.permissions);
    await json(root(project) + "/restore", {
      method: "POST",
      body: { reviewToken: review.reviewToken },
    });
    assert.equal((await panel(project, id)).packageDigest, digest);
  };
  const snapshots = new Map();
  const grants = new Map();
  for (const original of installed) {
    for (const project of [projectA, projectB]) {
      const current = await panel(project, original.id);
      await json(root(project) + `/${original.id}/binding`, {
        method: "PATCH",
        body: { bound: true, expectedRevision: current.revision },
      });
      const bound = await panel(project, original.id);
      assert.equal(bound.packageDigest, original.packageDigest);
      const grant = await prepare(project, original.id);
      grants.set(`${project}:${original.id}`, grant);
      assert.ok(!(await page(project, grant)).includes(marker));
      if (original.permissions.includes("storage")) {
        const saved = await panelHarness(project, grant).call("storage.compareAndSet", {
          key,
          expectedRevision: null,
          value: { project, panel: original.id, preserved: true },
        });
        assert.equal(saved.updated, true);
        snapshots.set(`${project}:${original.id}`, saved.snapshot);
      }
    }
  }
  console.log(
    "PASS: six actual candidate Panels installed and project-bound in two isolated containers; five storage-capable Panels persisted separate project data",
  );
  for (const original of installed) {
    const updated = await run(containerA, controlledUpdate, containerCore, original, marker);
    const oldGrant = grants.get(`${projectA}:${original.id}`);
    assert.equal((await panel(projectA, original.id)).packageDigest, original.packageDigest);
    assert.ok(
      !(await page(projectA, oldGrant)).includes(marker),
      "Catalog update must not replace the project's selected package",
    );
    const current = await panel(projectA, original.id);
    const history = await json(root(projectA) + `/${original.id}/versions`, {
      method: "POST",
      body: { expectedRevision: current.revision },
    });
    assert.ok(history.versions.some((item) => item.packageDigest === original.packageDigest));
    assert.ok(history.versions.some((item) => item.packageDigest === updated.packageDigest));
    await select(projectA, original.id, updated.packageDigest);
    assert.ok(
      [404, 410].includes(
        (await request(`/p/${projectA}` + oldGrant.src, { anonymous: true, origin: "null" }))
          .status,
      ),
    );
    const changed = await prepare(projectA, original.id);
    assert.ok((await page(projectA, changed)).includes(marker));
    if (original.permissions.includes("storage"))
      assert.deepEqual(
        await panelHarness(projectA, changed).call("storage.getSnapshot", { key }),
        snapshots.get(`${projectA}:${original.id}`),
      );
    await select(projectA, original.id, original.packageDigest);
    const restored = await prepare(projectA, original.id);
    assert.ok(!(await page(projectA, restored)).includes(marker));
    grants.set(`${projectA}:${original.id}`, restored);
    const other = grants.get(`${projectB}:${original.id}`);
    assert.equal((await panel(projectB, original.id)).packageDigest, original.packageDigest);
    assert.ok(!(await page(projectB, other)).includes(marker));
    if (original.permissions.includes("storage"))
      assert.deepEqual(
        await panelHarness(projectB, other).call("storage.getSnapshot", { key }),
        snapshots.get(`${projectB}:${original.id}`),
      );
  }
  console.log(
    "PASS: all six real packages reject stale reviewed updates, retain the pinned bytes across catalog changes, and restore through reviewed HTTP selection without losing project storage",
  );
  // Remove the source directories before restarting: only installed/retained bytes
  // in the project's persistent home may provide the next runtime.
  for (const container of [containerA, containerB])
    await docker([
      "exec",
      container,
      "node",
      "-e",
      'require("node:fs").rmSync("/tmp/candidate-panel-lifecycle", {recursive:true,force:true})',
    ]);
  return async () => {
    for (const original of installed) {
      const current = await panel(projectA, original.id);
      assert.equal(current.version, original.version);
      assert.equal(current.packageDigest, original.packageDigest);
      const grant = await prepare(projectA, original.id);
      assert.ok(!(await page(projectA, grant)).includes(marker));
      if (original.permissions.includes("storage"))
        assert.deepEqual(
          await panelHarness(projectA, grant).call("storage.getSnapshot", { key }),
          snapshots.get(`${projectA}:${original.id}`),
        );
      const old = grants.get(`${projectA}:${original.id}`);
      assert.ok(
        [404, 410].includes(
          (await request(`/p/${projectA}` + old.src, { anonymous: true, origin: "null" })).status,
        ),
      );
    }
    console.log(
      "PASS: after project stop/start and source removal, all six candidate packages reopen at their original digest with project storage preserved; controlled package updates do not prove domain-schema migration",
    );
  };
}
