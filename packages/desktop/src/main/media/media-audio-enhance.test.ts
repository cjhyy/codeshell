import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAudioEnhanceProcessor,
  validateAudioEnhanceInput,
  type AudioEnhanceResult,
} from "./media-audio-enhance.js";
import { MediaLibrary } from "./media-library.js";
import { runMediaProcess } from "./media-process-runner.js";
import type { MediaJobContext } from "./media-types.js";

const available = ["ffmpeg", "ffprobe"].every(
  (command) => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0,
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function wav(duration: number, sample: (time: number, index: number) => number): Buffer {
  const count = Math.round(duration * 48000),
    data = Buffer.alloc(44 + count * 2);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24);
  data.writeUInt32LE(96000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++)
    data.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, sample(i / 48000, i))) * 32767),
      44 + i * 2,
    );
  return data;
}
async function fixture(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "enhance-audio-"));
  roots.push(root);
  const scope = { appId: "video-studio", projectPath: root };
  const library = new MediaLibrary({ rootDirectory: join(root, "store") });
  const path = join(root, "source.wav");
  await writeFile(path, bytes);
  const source = await library.importFile(scope, path);
  let sequence = 0;
  const context = async (signal = new AbortController().signal): Promise<MediaJobContext> => {
    const dir = join(root, `attempt-${++sequence}`);
    await mkdir(dir);
    return {
      scope,
      jobId: `job-${sequence}`,
      attempt: 1,
      signal,
      workDir: dir,
      outputDir: dir,
      cacheDir: dir,
      reportProgress: async () => {},
    };
  };
  const processor = createAudioEnhanceProcessor({
    resolveAssetPath: (bound, id) => library.resolvePath(bound, id),
    publishArtifact: (bound, path, mimeType, ctx) =>
      library.importFile(bound, path, { mimeType, signal: ctx.signal, name: "enhanced.wav" }),
  });
  return { root, scope, library, path, source, context, processor };
}
async function samples(path: string): Promise<Float32Array> {
  const { stdout } = await runMediaProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      "48000",
      "pipe:1",
    ],
    { signal: AbortSignal.timeout(10000), maxStdoutBytes: 16 * 1024 * 1024 },
  );
  return Float32Array.from({ length: stdout.length / 4 }, (_, index) =>
    stdout.readFloatLE(index * 4),
  );
}
function rms(data: Float32Array, start = 0, end = data.length / 48000): number {
  const selected = data.subarray(Math.floor(start * 48000), Math.floor(end * 48000));
  return Math.sqrt(selected.reduce((sum, value) => sum + value * value, 0) / selected.length);
}
function tone(data: Float32Array, hz: number): number {
  let real = 0,
    imaginary = 0;
  for (let i = 0; i < data.length; i++) {
    real += data[i]! * Math.cos((2 * Math.PI * hz * i) / 48000);
    imaginary += data[i]! * Math.sin((2 * Math.PI * hz * i) / 48000);
  }
  return (2 * Math.hypot(real, imaginary)) / data.length;
}

test("enhancement accepts only scoped asset IDs and fixed bounded controls", () => {
  const id = `asset-${"a".repeat(64)}`;
  expect(validateAudioEnhanceInput({ assetId: id })).toEqual({
    assetId: id,
    preset: "balanced",
    denoise: true,
    normalize: true,
  });
  for (const input of [
    { assetId: "/etc/passwd" },
    { assetId: id, preset: "unknown" },
    { assetId: id, denoise: "yes" },
    { assetId: id, filters: "amovie=/tmp/private" },
  ])
    expect(() => validateAudioEnhanceInput(input)).toThrow();
});

test.skipIf(!available)(
  "real denoising lowers background noise and low-frequency hum without trimming or overwriting",
  async () => {
    let seed = 12345;
    const bytes = wav(4, (time) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (
        (seed / 4294967296 - 0.5) * 0.018 +
        0.08 * Math.sin(2 * Math.PI * 20 * time) +
        (time >= 1 && time < 3 ? 0.09 * Math.sin(2 * Math.PI * 440 * time) : 0)
      );
    });
    const { source, library, scope, processor, context } = await fixture(bytes);
    const originalPath = await library.resolvePath(scope, source.id);
    const before = createHash("sha256")
      .update(await readFile(originalPath))
      .digest("hex");
    const off = (await processor.run(
      { assetId: source.id, denoise: false, normalize: false },
      await context(),
    )) as AudioEnhanceResult;
    const on = (await processor.run(
      { assetId: source.id, preset: "balanced", normalize: false },
      await context(),
    )) as AudioEnhanceResult;
    const original = await samples(originalPath),
      untreated = await samples(await library.resolvePath(scope, off.asset.id)),
      treated = await samples(await library.resolvePath(scope, on.asset.id));
    expect(treated.length).toBe(4 * 48000);
    expect(on.inspection.durationSeconds).toBe(4);
    expect(tone(untreated, 20)).toBeLessThan(tone(original, 20) * 0.12);
    expect(rms(treated, 0.25, 0.8)).toBeLessThan(rms(untreated, 0.25, 0.8) * 0.9);
    expect(rms(treated, 1.3, 2.7)).toBeGreaterThan(0.025);
    expect(on.asset.id).not.toBe(source.id);
    expect(on.provenance.sourceAssetId).toBe(source.id);
    expect(
      createHash("sha256")
        .update(await readFile(originalPath))
        .digest("hex"),
    ).toBe(before);
  },
  20000,
);

test.skipIf(!available)(
  "measured normalization equalizes quiet and loud sources, limits peaks and preserves digital silence",
  async () => {
    const outputs: Float32Array[] = [];
    for (const amplitude of [0.015, 0.18, 0]) {
      const { source, library, scope, processor, context } = await fixture(
        wav(3, (time) => amplitude * Math.sin(2 * Math.PI * 440 * time)),
      );
      const result = (await processor.run(
        { assetId: source.id, denoise: false },
        await context(),
      )) as AudioEnhanceResult;
      const data = await samples(await library.resolvePath(scope, result.asset.id));
      outputs.push(data);
      expect(data.length).toBe(3 * 48000);
      expect(data.every((value) => Math.abs(value) <= 0.9)).toBe(true);
    }
    expect(rms(outputs[0]!)).toBeGreaterThan(0.1);
    expect(rms(outputs[0]!) / rms(outputs[1]!)).toBeCloseTo(1, 1);
    expect(rms(outputs[2]!)).toBe(0);
  },
  20000,
);

test.skipIf(!available)(
  "video audio extraction pads the source tail and leaves the complete video source intact",
  async () => {
    const { root, scope, library, path, context, processor } = await fixture(
      wav(1, (time) => 0.1 * Math.sin(2 * Math.PI * 700 * time)),
    );
    const videoPath = join(root, "recorded.mp4");
    await runMediaProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=160x90:r=30:d=2.5",
        "-itsoffset",
        "0.5",
        "-i",
        path,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        videoPath,
      ],
      { signal: AbortSignal.timeout(10000) },
    );
    const video = await library.importFile(scope, videoPath);
    const result = (await processor.run(
      { assetId: video.id, denoise: false, normalize: false },
      await context(),
    )) as AudioEnhanceResult;
    expect(result.inspection.kind).toBe("audio");
    expect(result.inspection.durationSeconds).toBeCloseTo(2.5, 3);
    const data = await samples(await library.resolvePath(scope, result.asset.id));
    expect(rms(data, 0, 0.35)).toBeLessThan(0.001);
    expect(rms(data, 0.65, 1.3)).toBeGreaterThan(0.03);
    expect(rms(data, 1.8, 2.45)).toBeLessThan(0.001);
    expect(await readFile(await library.resolvePath(scope, video.id))).toEqual(
      await readFile(videoPath),
    );
  },
  20000,
);

test.skipIf(!available)(
  "cancellation stops active conversion, cleans output and never publishes a partial derivative",
  async () => {
    const { source, library, scope, processor, context } = await fixture(
      wav(60, (time) => 0.1 * Math.sin(2 * Math.PI * 440 * time)),
    );
    const controller = new AbortController(),
      ctx = await context(controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    ctx.reportProgress = async (progress) => {
      if (progress.stage === "enhance" && !timer) timer = setTimeout(() => controller.abort(), 30);
    };
    try {
      await expect(processor.run({ assetId: source.id, normalize: false }, ctx)).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(controller.signal.aborted).toBe(true);
    expect(await readdir(ctx.outputDir)).toEqual([]);
    expect(await library.list(scope)).toHaveLength(1);
    expect(processor.recovery).toBe("restart");
  },
  20000,
);
