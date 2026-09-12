import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PanelMediaService } from "./panel-media-service.js";
import { mediaDirectory, mediaScopeKey, writeMediaJson } from "./media-storage.js";
import type { MediaJob, MediaScope } from "./media-types.js";

let root = "";
let service: PanelMediaService | undefined;

test("transcript pagination keeps dense word timestamps below the bridge response budget", async () => {
  root = await mkdtemp(join(tmpdir(), "panel-media-transcript-"));
  const scope = { appId: "video-studio", projectPath: "/workspace" };
  const directory = await mediaDirectory(root, ["scopes", mediaScopeKey(scope), "analysis"]);
  const id = `asset-${"a".repeat(64)}`;
  const segments = Array.from({ length: 100 }, (_, index) => ({
    start: index,
    end: index + 1,
    text: "真实转写".repeat(500),
    words: [],
  }));
  await writeMediaJson(join(directory, `${id}-transcript.json`), {
    engine: "local-whisper",
    language: "zh",
    segments,
  });
  service = new PanelMediaService({
    rootDirectory: root,
    isScopeAuthorized: () => true,
  });
  let offset = 0;
  const collected: unknown[] = [];
  do {
    const result = (await service.dispatch(scope, "media.transcript", {
      assetId: id,
      offset,
      limit: 100,
    })) as any;
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(192 * 1024);
    expect(result.nextOffset).toBeGreaterThan(offset);
    offset = result.nextOffset;
    collected.push(...result.segments);
  } while (offset < segments.length);
  expect(collected).toEqual(segments);
});
afterEach(async () => {
  await service?.shutdown();
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<{ scope: MediaScope; path: string }> {
  root = await mkdtemp(join(tmpdir(), "panel-media-service-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(workspace, "sample.mp4");
  await writeFile(path, "opaque source bytes owned by the Panel");
  const scope = { appId: "video-studio", projectPath: workspace };
  service = new PanelMediaService({
    rootDirectory: join(root, "store"),
    isScopeAuthorized: (candidate) =>
      candidate.appId === scope.appId && candidate.projectPath === workspace,
  });
  return { scope, path };
}
async function completed(scope: MediaScope, job: MediaJob): Promise<MediaJob> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const next = await service!.jobs.get(scope, job.id);
    if (["succeeded", "failed", "cancelled"].includes(next.status)) {
      if (next.status !== "succeeded") throw new Error(JSON.stringify(next.error));
      return next;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for real media job");
}

test("workspace imports reject absolute paths, traversal, symlink escape and revoked scopes", async () => {
  const { scope, path } = await fixture();
  await symlink(root, join(scope.projectPath, "escape"));
  for (const paths of [
    [path],
    ["../sample.mp4"],
    ["escape/delivery.mp4"],
    [".private/movie.mp4"],
  ]) {
    await expect(service!.importWorkspaceFiles(scope, scope.projectPath, paths)).rejects.toThrow();
  }
  await expect(
    service!.dispatch({ ...scope, appId: "other-app" }, "media.assets.list", {}),
  ).rejects.toThrow("revoked");
  expect(await service!.jobs.list(scope)).toHaveLength(0);
}, 10000);

test("queued imports reject an ancestor symlink replacement even after Host restart", async () => {
  const { scope, path } = await fixture();
  const selectedDirectory = join(scope.projectPath, "selected");
  const outsideDirectory = join(root, "outside");
  await mkdir(selectedDirectory);
  await mkdir(outsideDirectory);
  await copyFile(path, join(selectedDirectory, "sample.mp4"));
  await copyFile(path, join(outsideDirectory, "sample.mp4"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = 0;
  service!.jobs.registerProcessor("hold", {
    run: async () => {
      running++;
      await gate;
    },
  });
  await service!.initialize();
  await service!.jobs.start(scope, { type: "hold", input: null });
  await service!.jobs.start(scope, { type: "hold", input: null });
  for (let attempt = 0; running < 2 && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  let imported: MediaJob;
  try {
    expect(running).toBe(2);
    imported = await service!.importWorkspaceFiles(scope, scope.projectPath, [
      "selected/sample.mp4",
    ]);
    expect(imported.status).toBe("queued");
    await rename(selectedDirectory, join(scope.projectPath, "original"));
    await symlink(outsideDirectory, selectedDirectory);
  } finally {
    const shutdown = service!.jobs.shutdown();
    release();
    await shutdown;
  }
  service = new PanelMediaService({
    rootDirectory: join(root, "store"),
    isScopeAuthorized: () => true,
  });
  await service.initialize();
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await service.jobs.get(scope, imported!.id);
    if (job.status === "failed") {
      expect(job.error?.message).toContain("Source changed since it was selected");
      expect(await service.library.list(scope)).toHaveLength(0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Replacement file was not rejected");
}, 10000);

test("legacy import retains its job envelope, opaque assets, document revisions and export after restart", async () => {
  const { scope, path } = await fixture();
  const imported = await completed(
    scope,
    await service!.importWorkspaceFiles(scope, scope.projectPath, ["sample.mp4"]),
  );
  const asset = (imported.result as any).assets[0];
  expect(asset.id).toMatch(/^asset-[a-f0-9]{64}$/);
  expect(imported.type).toBe("import");
  expect((imported.result as any).inspection).toBeUndefined();
  expect(
    ((await service!.dispatch(scope, "media.assets.get", { id: asset.id })) as any).preparation,
  ).toBeNull();
  const doc = { engine: "panel-owned", sources: [asset.id], arbitrarySchema: true };
  await service!.dispatch(scope, "media.document.set", {
    key: "project",
    baseRevision: 0,
    data: doc,
  });
  const output = join(root, "delivery.bin");
  await service!.exportFile(scope, asset.id, output);
  expect(await readFile(output)).toEqual(await readFile(path));
  await service!.shutdown();
  service = new PanelMediaService({
    rootDirectory: join(root, "store"),
    isScopeAuthorized: () => true,
  });
  expect(await service.dispatch(scope, "media.document.get", { key: "project" })).toMatchObject({
    revision: 1,
    data: doc,
  });
  expect(await service.dispatch(scope, "media.jobs.get", { id: imported.id })).toMatchObject({
    status: "succeeded",
    result: { assets: [asset] },
  });
  const status = (await service.dispatch(scope, "media.status", {})) as any;
  expect(status.processors).toEqual(["import", "recording"]);
  expect(status.processing).toBe("panel-native");
  for (const method of [
    "media.tts",
    "media.tts.setup",
    "media.prepare",
    "media.render",
    "media.scene",
    "media.audio.extract",
    "media.audio.enhance",
  ])
    await expect(service.dispatch(scope, method, {})).rejects.toThrow(
      `This operation now runs in the Panel native tools. Update the Panel and retry (${method}).`,
    );
});

test("historical receipts expose safe recipes without registering or rerunning processors", async () => {
  const { scope } = await fixture();
  const jobId = "job-historical";
  const directory = await mediaDirectory(join(root, "store"), [
    "scopes",
    mediaScopeKey(scope),
    "jobs",
    jobId,
  ]);
  const assetId = `asset-${"a".repeat(64)}`;
  await writeMediaJson(join(directory, "job.json"), {
    schemaVersion: 1,
    scope,
    id: jobId,
    type: "render",
    status: "failed",
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    input: {
      project: {
        name: "工程",
        assets: [{ id: "a", url: "file:///private/input.mov", path: "/private/input.mov" }],
        secret: "do-not-return",
      },
      sources: { a: assetId },
      credentials: { token: "do-not-return" },
      outputPath: "/private/out.mp4",
    },
  });
  const recipe = await service!.dispatch(scope, "media.jobs.recipe", { id: jobId });
  expect(recipe).toEqual({
    id: jobId,
    type: "render",
    params: { project: { name: "工程", assets: [{ id: "a" }] }, sources: { a: assetId } },
  });
  expect(JSON.stringify(recipe)).not.toContain("private");
  expect(JSON.stringify(recipe)).not.toContain("do-not-return");
  await expect(service!.dispatch(scope, "media.jobs.retry", { id: jobId })).rejects.toThrow(
    "Panel native tools",
  );
  expect((await service!.jobs.get(scope, jobId)).attempt).toBe(1);
  await expect(
    service!.dispatch({ ...scope, appId: "other" }, "media.jobs.recipe", { id: jobId }),
  ).rejects.toThrow();
  const imported = await completed(
    scope,
    await service!.importWorkspaceFiles(scope, scope.projectPath, ["sample.mp4"]),
  );
  await expect(service!.dispatch(scope, "media.jobs.recipe", { id: imported.id })).rejects.toThrow(
    "select its inputs",
  );
});
