// Real Docker volumes, actual shared backup/restore and restored Cloud startup.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, appendFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupProjectInstallation,
  restoreProjectInstallation,
  startProjectControlServer,
} from "../packages/server/dist/index.serve.js";
import { ProjectRegistry } from "../packages/server/dist/project-runtime/registry.js";
import { HubAuthStore } from "../packages/server/dist/hub/auth-store.js";
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  }).trim();
const helperImage = docker(["image", "inspect", "node:22-bookworm-slim", "--format", "{{.Id}}"]);
const root = await mkdtemp(join(tmpdir(), "codeshell-backup-smoke-"));
const dataDir = join(root, "control"),
  destination = join(root, "backup"),
  restored = join(root, "restored");
const installs = new Set();
let registry, server, busy;
const login = { username: "backup-owner", password: "backup-fixture-password-long" };
const label = "io.codeshell.project-runtime";
try {
  await mkdir(dataDir);
  registry = new ProjectRegistry(dataDir);
  const installation = registry.installationId;
  installs.add(installation);
  const project = registry.create(login.username, "Backed-up project");
  registry.create(login.username, "Never started");
  registry.update(project.id, { status: "stopped", generation: 1 });
  const auth = new HubAuthStore({ dataDir });
  const originalGrant = await auth.setup({ ...login, token: auth.initialize() });
  const names = ["data", "workspace"].map(
    (kind) => `codeshell-${installation}-${project.id}-${kind}`,
  );
  for (const [i, name] of names.entries()) {
    docker([
      "volume",
      "create",
      "--label",
      `${label}.installation=${installation}`,
      "--label",
      `${label}.project=${project.id}`,
      "--label",
      `${label}.owner=${project.ownerId}`,
      name,
    ]);
    docker([
      "run",
      "--rm",
      "--network=none",
      "--mount",
      `type=volume,source=${name},target=/volume`,
      helperImage,
      "node",
      "-e",
      `const f=require('node:fs');f.chownSync('/volume',1000,1000);f.mkdirSync('/volume/private',{mode:0o700});f.writeFileSync('/volume/private/value','snapshot-${i}');f.chownSync('/volume/private',1000,1000);f.chownSync('/volume/private/value',1000,1000);f.symlinkSync('private/value','/volume/link');f.linkSync('/volume/private/value','/volume/hard');`,
    ]);
  }
  await assert.rejects(
    backupProjectInstallation({ dataDir, destination, helperImage }),
    /Another project controller/,
  );
  registry.close();
  registry = undefined;
  busy = docker([
    "run",
    "-d",
    "--network=none",
    "--label",
    `io.codeshell.backup-smoke=${installation}`,
    "--mount",
    `type=volume,source=${names[0]},target=/volume`,
    helperImage,
    "node",
    "-e",
    "setInterval(()=>{},1000)",
  ]);
  await assert.rejects(
    backupProjectInstallation({ dataDir, destination, helperImage }),
    /running container/,
  );
  docker(["rm", "-f", busy]);
  busy = undefined;
  const saved = await backupProjectInstallation({ dataDir, destination, helperImage });
  assert.equal(saved.volumes, 2);
  assert.equal((await stat(join(destination, "manifest.json"))).mode & 0o777, 0o600);
  const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
  // Mutating the original after backup must not change the recovered point in time.
  docker([
    "run",
    "--rm",
    "--mount",
    `type=volume,source=${names[1]},target=/volume`,
    helperImage,
    "node",
    "-e",
    "require('node:fs').writeFileSync('/volume/private/value','after-backup')",
  ]);
  const result = await restoreProjectInstallation({
    source: destination,
    destination: restored,
    helperImage,
  });
  installs.add(result.installationId);
  assert.notEqual(result.installationId, installation);
  const recoveredAuth = new HubAuthStore({ dataDir: restored });
  assert.equal(recoveredAuth.authenticate(originalGrant.token), null);
  const freshGrant = await recoveredAuth.login(login);
  for (const [i, kind] of ["data", "workspace"].entries()) {
    const volume = `codeshell-${result.installationId}-${project.id}-${kind}`;
    const observed = JSON.parse(
      docker([
        "run",
        "--rm",
        "--network=none",
        "--read-only",
        "--mount",
        `type=volume,source=${volume},target=/volume,readonly`,
        helperImage,
        "node",
        "-e",
        "const f=require('node:fs');console.log(JSON.stringify({value:f.readFileSync('/volume/private/value','utf8'),uid:f.statSync('/volume/private/value').uid,link:f.readlinkSync('/volume/link'),hard:f.statSync('/volume/hard').ino===f.statSync('/volume/private/value').ino}))",
      ]),
    );
    assert.deepEqual(observed, {
      value: `snapshot-${i}`,
      uid: 1000,
      link: "private/value",
      hard: true,
    });
  }
  const original = docker([
    "run",
    "--rm",
    "--mount",
    `type=volume,source=${names[1]},target=/volume,readonly`,
    helperImage,
    "node",
    "-e",
    "process.stdout.write(require('node:fs').readFileSync('/volume/private/value','utf8'))",
  ]);
  assert.equal(original, "after-backup");
  server = await startProjectControlServer({
    dataDir: restored,
    host: "127.0.0.1",
    port: 0,
    runtimeImage: "codeshell-project-runtime:project-cloud-panels",
  });
  const headers = { Cookie: `cs_hub_session=${freshGrant.token}` };
  const response = await fetch(server.url + "/api/v1/projects", { headers });
  assert.equal(response.status, 200);
  const list = await response.json();
  assert.equal(list.projects.length, 2);
  assert(list.projects.every((p) => p.status === "stopped"));
  assert.equal(
    (
      await fetch(server.url + "/api/v1/projects", {
        headers: { Cookie: `cs_hub_session=${originalGrant.token}` },
      })
    ).status,
    401,
  );
  const started = await fetch(server.url + `/api/v1/projects/${project.id}/start`, {
    method: "POST",
    headers: { ...headers, Origin: server.url, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(started.status, 200, await started.text());
  const restoredContainer = `codeshell-${result.installationId}-${project.id}`;
  assert.equal(
    docker([
      "exec",
      restoredContainer,
      "node",
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('/workspace/private/value','utf8'))",
    ]),
    "snapshot-1",
  );
  await server.close();
  server = undefined;
  // A later backup of the never-started restored project is still valid.
  await backupProjectInstallation({
    dataDir: restored,
    destination: join(root, "second-backup"),
    helperImage,
  });
  await appendFile(join(destination, manifest.volumes[0].file), "corrupt");
  await assert.rejects(
    restoreProjectInstallation({
      source: destination,
      destination: join(root, "corrupt-restore"),
      helperImage,
    }),
    /checksum/,
  );
  const invalidTar = Buffer.from("not a valid tar archive");
  await writeFile(join(destination, manifest.volumes[0].file), invalidTar);
  manifest.volumes[0].digest = {
    sha256: createHash("sha256").update(invalidTar).digest("hex"),
    bytes: invalidTar.length,
  };
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest));
  const failed = join(root, "failed-restore");
  await assert.rejects(
    restoreProjectInstallation({ source: destination, destination: failed, helperImage }),
    /archive operation failed/,
  );
  assert.equal(await readFile(join(failed, "restore-in-progress"), "utf8"), "1\n");
  const failedId = JSON.parse(
    await readFile(join(failed, "project-control/registry.json"), "utf8"),
  ).installationId;
  installs.add(failedId);
  assert.equal(
    docker(["volume", "ls", "-q", "--filter", `label=${label}.installation=${failedId}`]),
    "",
  );
  await assert.rejects(
    startProjectControlServer({ dataDir: failed, host: "127.0.0.1", port: 0 }),
    /restore is incomplete/,
  );
  console.log(
    "✓ Real Docker Cloud backup/restore: offline guards, volume bytes/ownership/links, new installation, original preservation, session revocation, authenticated Cloud reopening and actual project restart, rebackup, corruption rejection and failed-extraction cleanup.",
  );
} finally {
  registry?.close();
  await server?.close();
  if (busy) docker(["rm", "-f", busy]);
  try {
    installs.add(
      JSON.parse(await readFile(join(restored, "project-control/registry.json"), "utf8"))
        .installationId,
    );
  } catch {}
  for (const installation of installs) {
    if (!/^[a-f0-9-]{36}$/.test(installation)) continue;
    for (const [kind, args] of [
      ["container", ["ps", "-aq"]],
      ["network", ["network", "ls", "-q"]],
      ["volume", ["volume", "ls", "-q"]],
    ]) {
      const ids = docker([...args, "--filter", `label=${label}.installation=${installation}`])
        .split(/\s+/)
        .filter(Boolean);
      for (const id of ids) docker([kind, "rm", ...(kind === "container" ? ["-f"] : []), id]);
    }
  }
  await rm(root, { recursive: true, force: true });
}
