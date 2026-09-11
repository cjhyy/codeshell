import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PanelMediaService } from "./panel-media-service.js";
import { mediaDirectory, mediaScopeKey, writeMediaJson } from "./media-storage.js";
import type { MediaJob, MediaScope } from "./media-types.js";
import { spawnSync } from "node:child_process";

const available =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

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
    speechConfiguration: () => ({ models: [] }),
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
  await service?.jobs.shutdown();
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<{ scope: MediaScope; path: string }> {
  root = await mkdtemp(join(tmpdir(), "panel-media-service-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(workspace, "sample.mp4");
  const child = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=30:d=0.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.8",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await child.exited;
  if (code) throw new Error(await new Response(child.stderr).text());
  const scope = { appId: "video-studio", projectPath: workspace };
  service = new PanelMediaService({
    speechConfiguration: () => ({ models: [] }),
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

test.skipIf(!available)(
  "real source import, type-specific preparation, persistent lookup and MP4 render",
  async () => {
    const { scope } = await fixture();
    const imported = await completed(
      scope,
      await service!.importWorkspaceFiles(scope, scope.projectPath, ["sample.mp4"]),
    );
    const source = (imported.result as any).assets[0];
    expect(source.id).toMatch(/^asset-[a-f0-9]{64}$/);
    const prepared = (await service!.dispatch(scope, "media.prepare", {
      assetIds: [source.id],
    })) as { jobs: MediaJob[] };
    const result = (await completed(scope, prepared.jobs[0]!)).result as any;
    expect(result.inspection.kind).toBe("video");
    expect(result.inspection.audio.channels).toBeGreaterThan(0);
    expect(result.proxy.asset.id).toMatch(/^asset-/);
    expect(result.thumbnail.asset.id).toMatch(/^asset-/);
    expect(result.waveform.peaks.some((value: number) => value > 0.01)).toBe(true);
    expect(result.silence.detector).toBe("ffmpeg-silencedetect");
    expect(result.scenes.detector).toBe("ffmpeg-scene-change");
    const project = {
      schemaVersion: 1,
      id: "project",
      revision: 1,
      fps: 30,
      width: 160,
      height: 90,
      assets: [{ id: "clip-source", kind: "video" }],
      clips: [{ id: "clip", assetId: "clip-source", inFrame: 0, outFrame: 18, volume: 0.5 }],
      captions: [],
    };
    const rendered = await completed(
      scope,
      (await service!.dispatch(scope, "media.render", {
        project,
        sources: { "clip-source": source.id },
      })) as MediaJob,
    );
    expect((rendered.result as any).video.asset.mimeType).toBe("video/mp4");
    expect((rendered.result as any).frames).toBe(18);
    const output = join(root, "delivery.mp4");
    await service!.exportFile(scope, (rendered.result as any).video.asset.id, output);
    expect((await readFile(output)).byteLength).toBeGreaterThan(1000);
    await service!.jobs.shutdown();
    service = new PanelMediaService({
      speechConfiguration: () => ({ models: [] }),
      rootDirectory: join(root, "store"),
      isScopeAuthorized: () => true,
    });
    const restored = (await service.dispatch(scope, "media.assets.get", { id: source.id })) as any;
    expect(restored.preparation.proxy.asset.id).toBe(result.proxy.asset.id);
    const history = (await service.dispatch(scope, "media.jobs.list", {})) as any;
    expect(history.jobs.find((job: any) => job.id === rendered.id).status).toBe("succeeded");
    expect(history.jobs.every((job: any) => !("result" in job))).toBe(true);
  },
  60000,
);

test.skipIf(!available)(
  "workspace imports reject absolute paths, traversal, symlink escape and revoked scopes",
  async () => {
    const { scope, path } = await fixture();
    await symlink(root, join(scope.projectPath, "escape"));
    for (const paths of [
      [path],
      ["../sample.mp4"],
      ["escape/delivery.mp4"],
      [".private/movie.mp4"],
    ]) {
      await expect(
        service!.importWorkspaceFiles(scope, scope.projectPath, paths),
      ).rejects.toThrow();
    }
    await expect(
      service!.dispatch({ ...scope, appId: "other-app" }, "media.assets.list", {}),
    ).rejects.toThrow("revoked");
    expect(await service!.jobs.list(scope)).toHaveLength(0);
  },
  10000,
);

test.skipIf(!available || process.platform !== "darwin")(
  "built-in TTS publishes a scoped voice asset and survives an audible MP4 export",
  async () => {
    const { scope, path } = await fixture();
    const voices = (await service!.dispatch(scope, "media.tts.voices", {})) as any;
    expect(voices.available).toBe(true);
    expect(voices.voices.some((voice: any) => voice.id === voices.defaultVoiceId)).toBe(true);
    for (const input of [{ text: " " }, { text: "a".repeat(6001) }, { text: "你好", rate: 4 }])
      await expect(service!.dispatch(scope, "media.tts", input)).rejects.toThrow();
    await expect(
      service!.dispatch(scope, "media.tts", { text: "你好", voiceId: "not-installed" }),
    ).rejects.toThrow("已安装");
    expect(await service!.jobs.list(scope)).toHaveLength(0);
    const job = await completed(
      scope,
      (await service!.dispatch(scope, "media.tts", {
        text: "你好，这是一条有声音的视频。",
      })) as MediaJob,
    );
    expect(job.type).toBe("tts");
    const { asset, inspection, speech } = job.result as any;
    expect(speech.modelId).toBeUndefined();
    expect(asset.mimeType).toBe("audio/wav");
    expect(inspection.kind).toBe("audio");
    expect(inspection.durationSeconds).toBeGreaterThan(1);
    expect(speech.text).toBe("你好，这是一条有声音的视频。");
    expect(speech.voiceId).toBe(voices.defaultVoiceId);
    expect(JSON.stringify(job.result)).not.toContain(root);
    const prepared = (await service!.dispatch(scope, "media.assets.get", { id: asset.id })) as any;
    expect(prepared.preparation.inspection.audio.channels).toBeGreaterThan(0);
    const posterPath = join(root, "poster.png");
    const poster = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", posterPath]);
    expect(poster.status).toBe(0);
    const image = await service!.library.importFile(scope, posterPath);
    const frames = Math.floor(inspection.durationSeconds * 30);
    const rendered = await completed(
      scope,
      (await service!.dispatch(scope, "media.render", {
        project: {
          schemaVersion: 1,
          id: "tts-project",
          revision: 1,
          fps: 30,
          width: 160,
          height: 90,
          assets: [
            { id: "picture", kind: "image" },
            { id: "voice", kind: "audio" },
          ],
          clips: [
            { id: "picture-clip", assetId: "picture", inFrame: 0, outFrame: frames, volume: 0 },
          ],
          audioClips: [
            {
              id: "voice-clip",
              assetId: "voice",
              startFrame: 0,
              inFrame: 0,
              outFrame: frames,
              volume: 1,
            },
          ],
          captions: [],
        },
        sources: { picture: image.id, voice: asset.id },
      })) as MediaJob,
    );
    const outputId = (rendered.result as any).video.asset.id;
    const outputPath = await service!.library.resolvePath(scope, outputId);
    const decoded = spawnSync(
      "ffmpeg",
      ["-v", "error", "-i", outputPath, "-vn", "-ar", "8000", "-ac", "1", "-f", "f32le", "pipe:1"],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    expect(decoded.status).toBe(0);
    let sum = 0;
    for (let index = 0; index + 4 <= decoded.stdout.length; index += 4)
      sum += decoded.stdout.readFloatLE(index) ** 2;
    expect(Math.sqrt(sum / (decoded.stdout.length / 4))).toBeGreaterThan(0.005);
    await expect(
      service!.dispatch({ ...scope, appId: "another-app" }, "media.assets.get", { id: asset.id }),
    ).rejects.toThrow("revoked");
  },
  60000,
);

test.skipIf(!available)(
  "queued imports reject an ancestor symlink replacement even after Host restart",
  async () => {
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
      speechConfiguration: () => ({ models: [] }),
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
  },
  10000,
);
