/** Real yt-dlp + FFmpeg + durable Host task + immutable resource smoke.
 * Pass the task Panel package path; no user project or account is read.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PanelToolJobService,
  PanelAppProcessService,
  PanelResourceService,
  createPanelToolExecutor,
} from "../packages/server/dist/index.panels.js";

const panelDir = process.argv[2];
if (!panelDir) throw new Error("Pass the video-download Panel package directory.");
const entry = resolve(panelDir, "app/tools/download.mjs");
const entryHash = createHash("sha256")
  .update(await readFile(entry))
  .digest("hex");
const root = await realpath(await mkdtemp(join(tmpdir(), "codeshell-download-task-")));
const scope = { appId: "video-download", projectPath: join(root, "project"), revision: entryHash };
let service, resourceService, processes, http;
const run = promisify(execFile);
const events = [];
let requests = 0;
let slow = true,
  slowRequested = false;
try {
  await mkdir(scope.projectPath);
  const source = join(root, "fixture.mp4");
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=128x72:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      source,
    ],
    { timeout: 20000 },
  );
  const bytes = await readFile(source),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  http = createServer((request, response) => {
    if (!["/fixture.mp4", "/slow.mp4"].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    requests++;
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
    if (request.method === "HEAD") response.end();
    else {
      if (request.url === "/slow.mp4") slowRequested = true;
      const timer = setTimeout(
        () => response.end(bytes),
        request.url === "/slow.mp4" && slow ? 30000 : 150,
      );
      response.on("close", () => clearTimeout(timer));
    }
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${http.address().port}/fixture.mp4`;
  let ownerId = 0;
  processes = new PanelAppProcessService({
    resolvePackageEntry: async (_owner, name) => {
      assert.equal(name, "download-runtime");
      return { path: entry, sha256: entryHash };
    },
    confirmExecution: async () => true,
    isOwnerAuthorized: async () => true,
  });
  resourceService = new PanelResourceService({
    rootDirectory: join(root, "resources"),
    isScopeAuthorized: async () => true,
  });
  const executor = createPanelToolExecutor({
    processes,
    resources: resourceService,
    owner: (job, send) => ({
      guestId: --ownerId,
      appId: scope.appId,
      appTitle: "Download smoke",
      revision: scope.revision,
      send,
    }),
    releaseOwner() {},
    authorize: async () => {},
    authorizeConnections: async () => {
      throw new Error("No credentials in smoke");
    },
    appDataDirectory: async () => root,
    sealedRoot: join(root, "sealed"),
  });
  const options = {
    rootDir: join(root, "tasks"),
    ...executor,
    isAuthorized: async () => true,
    onEvent: (job) => events.push({ id: job.id, status: job.status }),
  };
  service = new PanelToolJobService(options);
  const input = {
    entry: { name: "download-runtime", sha256: entryHash },
    recovery: "retry",
    requestKey: "one-download",
    input: {
      request: { action: "download", url, configuration: { format: "best" } },
      directoryArguments: [{ argumentName: "--job-dir", directory: "job" }],
    },
  };
  const [first, duplicate] = await Promise.all([
    service.start(scope, input),
    service.start(scope, input),
  ]);
  assert.equal(first.id, duplicate.id, "Duplicate start must attach to the same task");
  const deadline = Date.now() + 60000;
  let final;
  while (Date.now() < deadline) {
    final = await service.get(scope, first.id);
    if (!["queued", "running", "cancelling"].includes(final.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(final.status, "succeeded", JSON.stringify(final.error));
  assert.equal(final.attempt, 1);
  assert.equal(final.result.artifacts.length, 1);
  const artifact = final.result.artifacts[0];
  assert.equal(artifact.sha256, sha256);
  assert.equal(artifact.bytes, bytes.length);
  assert.equal(artifact.asset.id, `asset-${sha256}`);
  const read = await resourceService.dispatch(scope, "resources.read", {
    assetId: artifact.asset.id,
    offset: 0,
    length: bytes.length,
  });
  assert.deepEqual(Buffer.from(read.dataBase64, "base64"), bytes);
  const other = { ...scope, projectPath: join(root, "other") };
  await assert.rejects(service.get(other, first.id), /does not belong/);
  await assert.rejects(resourceService.dispatch(other, "resources.get", { id: artifact.asset.id }));
  // Cancel an actual network-bound downloader, then explicitly resume the same task.
  const slowInput = structuredClone(input);
  slowInput.requestKey = "cancel-and-resume";
  slowInput.input.request.url = url.replace("fixture.mp4", "slow.mp4");
  const cancellable = await service.start(scope, slowInput);
  const cancellationDeadline = Date.now() + 30000;
  while (!slowRequested && Date.now() < cancellationDeadline)
    await new Promise((done) => setTimeout(done, 50));
  assert.ok(slowRequested, "The real downloader must reach the network before cancellation");
  const cancelled = await service.cancel(scope, cancellable.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result, undefined);
  slow = false;
  const resumed = await service.retry(scope, cancelled.id);
  assert.equal(resumed.id, cancelled.id);
  const resumeDeadline = Date.now() + 30000;
  let completed;
  while (Date.now() < resumeDeadline) {
    completed = await service.get(scope, resumed.id);
    if (!["queued", "running", "cancelling"].includes(completed.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(completed.status, "succeeded", JSON.stringify(completed.error));
  assert.equal(completed.attempt, 2);
  assert.equal(completed.result.artifacts[0].sha256, sha256);
  await service.shutdown();
  service = new PanelToolJobService(options);
  const reopened = await service.get(scope, first.id);
  assert.equal(reopened.status, "succeeded");
  assert.equal(reopened.result.artifacts[0].asset.id, artifact.asset.id);
  assert.equal((await service.list(scope)).length, 2);
  assert.ok(events.some((item) => item.status === "running"));
  assert.ok(requests > 0);
  console.log(
    "Real download task passed: stable ID, duplicate submission, actual MP4 bytes, resource capture, project isolation, real cancellation/resume, restart recovery.",
  );
} finally {
  await service?.shutdown();
  processes?.close();
  await resourceService?.shutdown();
  if (http) await new Promise((done) => http.close(done));
  await rm(root, { recursive: true, force: true });
}
