import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAudioExtractProcessor,
  validateAudioExtractInput,
  type AudioExtractResult,
} from "./media-audio-extract.js";
import { MediaLibrary } from "./media-library.js";
import { PanelMediaService } from "./panel-media-service.js";
import { runMediaProcess } from "./media-process-runner.js";
import type { MediaJob, MediaJobContext } from "./media-types.js";

const roots: string[] = [];
const services: PanelMediaService[] = [];
const available = ["ffmpeg", "ffprobe"].every(
  (command) => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0,
);
const mediaTest = available ? test : test.skip;
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const id = `asset-${"a".repeat(64)}`;
test("reference extraction rejects paths, unbounded or ambiguous source ranges", () => {
  const valid = { assetId: id, inFrame: 30, outFrame: 150, fps: 30 };
  expect(validateAudioExtractInput(valid)).toEqual(valid);
  for (const changes of [
    { assetId: "/private/voice.wav" },
    { path: "x" },
    { fps: 60 },
    { fps: undefined },
    { inFrame: -1 },
    { inFrame: 0.1 },
    { inFrame: NaN },
    { outFrame: Infinity },
    { outFrame: 119 },
    { outFrame: 931 },
    { outFrame: 30 },
  ])
    expect(() => validateAudioExtractInput({ ...valid, ...changes })).toThrow();
});

async function fixture(video = false) {
  const root = await mkdtemp(join(tmpdir(), "audio-extract-"));
  roots.push(root);
  const scope = { appId: "video-studio", projectPath: root };
  const path = join(root, video ? "source.mp4" : "source.wav");
  // Distinct halves verify that the source selection (4–8 s), not the whole file, is used.
  const args = video
    ? [
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=32x32:r=30:d=10",
        "-itsoffset",
        "2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=8",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
      ]
    : [
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=if(lt(t\\,4)\\,0.2*sin(2*PI*440*t)\\,0.2*sin(2*PI*880*t)):s=48000:d=10",
        "-c:a",
        "pcm_s16le",
      ];
  await runMediaProcess("ffmpeg", ["-v", "error", "-nostdin", ...args, path], {
    signal: AbortSignal.timeout(15000),
  });
  const library = new MediaLibrary({ rootDirectory: join(root, "store") });
  const asset = await library.importFile(scope, path);
  const context: MediaJobContext = {
    scope,
    jobId: "test",
    attempt: 1,
    signal: new AbortController().signal,
    workDir: root,
    cacheDir: join(root, "cache"),
    outputDir: join(root, "out"),
    reportProgress: async () => {},
  };
  const processor = createAudioExtractProcessor({
    resolveAssetPath: (bound, id) => library.resolvePath(bound, id),
    publishArtifact: (bound, output, mimeType, ctx) =>
      library.importFile(bound, output, { mimeType, signal: ctx.signal }),
  });
  return { root, scope, path, library, asset, context, processor };
}
async function pcm(path: string) {
  const { stdout } = await runMediaProcess(
    "ffmpeg",
    ["-v", "error", "-i", path, "-f", "f32le", "-ar", "48000", "-ac", "1", "pipe:1"],
    { signal: AbortSignal.timeout(10000) },
  );
  return Float32Array.from({ length: stdout.length / 4 }, (_, i) => stdout.readFloatLE(i * 4));
}
mediaTest("extracts the exact selected four seconds as a separate scoped mono WAV", async () => {
  const f = await fixture();
  const input = { assetId: f.asset.id, inFrame: 120, outFrame: 240, fps: 30 };
  const result = (await f.processor.run(input, f.context)) as AudioExtractResult;
  expect(result.inspection.durationSeconds).toBe(4);
  expect(result.inspection.audio).toMatchObject({ sampleRate: 48000, channels: 1 });
  expect(result.asset.id).not.toBe(f.asset.id);
  expect(result.provenance).toMatchObject({
    sourceAssetId: f.asset.id,
    inFrame: 120,
    outFrame: 240,
  });
  const samples = await pcm(await f.library.resolvePath(f.scope, result.asset.id));
  const tone = (hz: number) =>
    Math.abs(
      samples.reduce(
        (sum, sample, i) => sum + sample * Math.sin((2 * Math.PI * hz * i) / 48000),
        0,
      ) / samples.length,
    );
  expect(tone(880)).toBeGreaterThan(0.09);
  expect(tone(440)).toBeLessThan(0.001);
  expect(await readdir(f.context.outputDir)).toHaveLength(0);
  await expect(
    f.processor.run(input, { ...f.context, scope: { ...f.scope, projectPath: "/foreign" } }),
  ).rejects.toThrow();
  await expect(f.processor.run({ ...input, outFrame: 420 }, f.context)).rejects.toThrow("超出");
  await expect(
    f.processor.run(input, { ...f.context, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
});
mediaTest(
  "video extraction retains leading silence when its audio stream starts late",
  async () => {
    const f = await fixture(true);
    const result = (await f.processor.run(
      { assetId: f.asset.id, inFrame: 30, outFrame: 150, fps: 30 },
      f.context,
    )) as AudioExtractResult;
    const samples = await pcm(await f.library.resolvePath(f.scope, result.asset.id));
    const rms = (start: number, end: number) => {
      const values = samples.slice(start * 48000, end * 48000);
      return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    };
    expect(samples.length).toBe(4 * 48000);
    expect(rms(0, 0.8)).toBeLessThan(0.001);
    expect(rms(1.1, 3.9)).toBeGreaterThan(0.05);
  },
);
mediaTest(
  "Host extraction publishes a durable job without exposing paths or accepting a foreign scope",
  async () => {
    const f = await fixture();
    const service = new PanelMediaService({
      rootDirectory: join(f.root, "host"),
      isScopeAuthorized: () => true,
    });
    services.push(service);
    const asset = await service.library.importFile(f.scope, f.path);
    const input = { assetId: asset.id, inFrame: 120, outFrame: 240, fps: 30 };
    await expect(
      service.dispatch({ ...f.scope, projectPath: "/foreign" }, "media.audio.extract", input),
    ).rejects.toThrow();
    const job = (await service.dispatch(f.scope, "media.audio.extract", input)) as MediaJob;
    let final = job;
    for (let i = 0; i < 200 && !["succeeded", "failed", "cancelled"].includes(final.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      final = await service.jobs.get(f.scope, job.id);
    }
    expect(final.status).toBe("succeeded");
    expect((final.result as AudioExtractResult).inspection.durationSeconds).toBe(4);
    expect(JSON.stringify(final)).not.toContain(f.root);
  },
);

mediaTest(
  "damaged input and conversion failures expose a useful error without Host paths",
  async () => {
    const f = await fixture();
    const damaged = join(f.root, "damaged.wav");
    await writeFile(damaged, "not an audio file");
    const input = { assetId: f.asset.id, inFrame: 0, outFrame: 120, fps: 30 };
    for (const options of [
      { resolveAssetPath: async () => damaged },
      { resolveAssetPath: async () => f.path, ffmpegPath: join(f.root, "missing-ffmpeg") },
    ]) {
      const processor = createAudioExtractProcessor({
        ...options,
        publishArtifact: async () => {
          throw new Error("must not publish");
        },
      });
      const failure = await processor.run(input, f.context).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("提取失败");
      expect((failure as Error).message).not.toContain(f.root);
      expect((failure as Error).message).not.toContain("ffmpeg");
    }
  },
);
