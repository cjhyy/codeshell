import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  createMediaJobProcessors,
  inspectMediaFile,
  type MediaRenderProject,
} from "./media-processors.js";
import { runMediaProcess } from "./media-process-runner.js";
import type { MediaJobContext } from "./media-types.js";

const available =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
const signal = () => new AbortController().signal;

function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => number[]): Buffer {
  const crc = (data: Buffer) => {
    let value = 0xffffffff;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.skipIf(!available)("real local media processors", () => {
  let root = "",
    serial = 0;
  const files = new Map<string, string>();
  const events: Array<{ fraction?: number; stage?: string }> = [];
  const context = async (jobSignal = signal()): Promise<MediaJobContext> => {
    const base = join(root, `job-${++serial}`);
    await mkdir(base, { recursive: true });
    return {
      scope: { appId: "video-studio", projectPath: root },
      jobId: String(serial),
      attempt: 1,
      signal: jobSignal,
      workDir: join(base, "work"),
      outputDir: join(base, "output"),
      cacheDir: join(root, "cache"),
      reportProgress: async (event) => {
        events.push(event);
      },
    };
  };
  const handlers = () =>
    createMediaJobProcessors({
      resolveAssetPath: async (_scope, assetId) => {
        const file = files.get(assetId);
        if (!file) throw new Error("Unknown authorized asset");
        return file;
      },
      whisperModelPath: join(homedir(), ".cache", "whisper", "tiny.pt"),
      renderCaptionPng: async ({ width, height, texts }, job) => {
        const output = join(
          job.workDir,
          `caption-${createHash("sha256").update(JSON.stringify(texts)).digest("hex")}.png`,
        );
        await writeFile(
          output,
          rgbaPng(width, height, (x, y) =>
            texts.length && x >= 20 && x < width - 20 && y >= height - 30 && y < height - 10
              ? [255, 255, 255, 255]
              : [0, 0, 0, 0],
          ),
        );
        return output;
      },
    });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "codeshell-media-processors-"));
    const video = join(root, "original user's recording.mp4"),
      audio = join(root, "audio.wav"),
      image = join(root, "still.png");
    await runMediaProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=160x90:r=30:d=1.2",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=160x90:r=30:d=1.2",
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=if(between(t\\,0.6\\,1.2)\\,0\\,0.1*sin(2*PI*440*t)):s=48000:d=2.4",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-map",
        "2:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        video,
      ],
      { signal: signal() },
    );
    await runMediaProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:sample_rate=48000:duration=2.4",
        audio,
      ],
      { signal: signal() },
    );
    await writeFile(
      image,
      rgbaPng(160, 90, () => [0, 150, 40, 255]),
    );
    files.set("video", video);
    files.set("audio", audio);
    files.set("image", image);
  }, 20000);
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("inspects actual codecs, creates proxies/thumbnails, and detects measured audio and cuts", async () => {
    const processors = handlers();
    const inspected: any = await processors.inspect!.run({ assetId: "video" }, await context());
    expect(inspected.inspection.video.codec).toBe("h264");
    expect(inspected.inspection.video.width).toBe(160);
    expect(inspected.inspection.audio.codec).toBe("aac");
    expect(inspected.inspection.durationSeconds).toBeCloseTo(2.4, 1);
    expect(inspected.inspection.video.variableFrameRate).toBe(false);
    const proxy: any = await processors.proxy!.run(
      { assetId: "video", maxWidth: 160 },
      await context(),
    );
    expect((await stat(proxy.proxy.path)).size).toBeGreaterThan(1000);
    const thumbnail: any = await processors.thumbnail!.run(
      { assetId: "video", seconds: 1.5, width: 160 },
      await context(),
    );
    expect((await readFile(thumbnail.thumbnail.path)).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const waveform: any = await processors.waveform!.run(
      { assetId: "video", points: 128 },
      await context(),
    );
    expect(Math.max(...waveform.peaks)).toBeGreaterThan(0.05);
    expect(Math.min(...waveform.rms)).toBeLessThan(0.001);
    const silence: any = await processors.silence!.run(
      { assetId: "video", minSeconds: 0.3 },
      await context(),
    );
    expect(
      silence.intervals.some(
        (item: any) => Math.abs(item.start - 0.6) < 0.1 && Math.abs(item.end - 1.2) < 0.1,
      ),
    ).toBe(true);
    const scenes: any = await processors.scenes!.run(
      { assetId: "video", threshold: 0.05 },
      await context(),
    );
    expect(scenes.cuts.some((seconds: number) => Math.abs(seconds - 1.2) < 0.1)).toBe(true);
    expect(events.some((event) => event.fraction === 1)).toBe(true);
  }, 30000);

  test("stores complete long analysis with a bounded job response", async () => {
    const path = join(root, "rapid-scene-changes.mp4");
    await runMediaProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=32x32:r=30:d=71,geq=lum='mod(floor(N/2),2)*255':cb=128:cr=128",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        path,
      ],
      { signal: signal() },
    );
    files.set("rapid", path);
    const result: any = await handlers().scenes!.run(
      { assetId: "rapid", threshold: 0.05 },
      await context(),
    );
    const complete = JSON.parse(await readFile(result.analysis.path, "utf8"));
    expect(result.truncated).toBe(true);
    expect(result.cuts.length).toBe(1024);
    expect(result.totalCount).toBeGreaterThan(1024);
    expect(complete.cuts.length).toBe(result.totalCount);
    expect(complete.cuts.at(-1)).toBeGreaterThan(70.9);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(192 * 1024);
  }, 20000);

  test("reuses verified persistent artifacts and regenerates an evicted cache file", async () => {
    const processors = handlers(),
      input = { assetId: "image", width: 128 };
    const first: any = await processors.thumbnail!.run(input, await context());
    events.length = 0;
    const second: any = await processors.thumbnail!.run(input, await context());
    expect(second.thumbnail.path).toBe(first.thumbnail.path);
    expect(events.some((event) => event.stage === "cached")).toBe(true);
    await unlink(first.thumbnail.path);
    const third: any = await processors.thumbnail!.run(input, await context());
    expect(third.thumbnail.path).not.toBe(first.thumbnail.path);
    expect((await stat(third.thumbnail.path)).size).toBeGreaterThan(0);
  }, 15000);

  test("renders video/audio/image source ranges, an independent soundtrack and timed burned overlays to MP4", async () => {
    const original = await readFile(files.get("video")!);
    const project: MediaRenderProject = {
      schemaVersion: 1,
      revision: 4,
      fps: 30,
      width: 160,
      height: 90,
      assets: [
        { id: "video", kind: "video" },
        { id: "audio", kind: "audio" },
        { id: "image", kind: "image" },
      ],
      clips: [
        { id: "v", assetId: "video", inFrame: 0, outFrame: 24, volume: 1 },
        { id: "a", assetId: "audio", inFrame: 0, outFrame: 15, volume: 0.5 },
        { id: "i", assetId: "image", inFrame: 0, outFrame: 21, volume: 1 },
      ],
      captions: [
        { id: "c1", startFrame: 6, endFrame: 18, text: "First caption" },
        { id: "c2", startFrame: 45, endFrame: 60, text: "Second caption" },
      ],
      audioClips: [
        { id: "music", assetId: "audio", startFrame: 0, inFrame: 0, outFrame: 60, volume: 0.2 },
      ],
    };
    const result: any = await handlers().render!.run({ project }, await context());
    expect(result.subtitleMode).toBe("burn");
    expect(result.inspection.video.codec).toBe("h264");
    expect(result.inspection.audio.codec).toBe("aac");
    expect(result.durationSeconds).toBeCloseTo(2, 1);
    expect(await readFile(result.subtitles.path, "utf8")).toContain(
      "00:00:00,200 --> 00:00:00,600",
    );
    const pixel = async (time: number) => {
      const { stdout } = await runMediaProcess(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          String(time),
          "-i",
          result.video.path,
          "-vf",
          "crop=2:2:80:70",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { signal: signal() },
      );
      return [...stdout.subarray(0, 3)];
    };
    expect((await pixel(0.3)).every((channel) => channel > 220)).toBe(true);
    expect((await pixel(1)).every((channel) => channel < 30)).toBe(true);
    expect((await pixel(1.7)).every((channel) => channel > 220)).toBe(true);
    expect(await readFile(files.get("video")!)).toEqual(original);
    const inspected = await inspectMediaFile(result.video.path, await context());
    expect(inspected.durationSeconds).toBeCloseTo(2, 1);
  }, 30000);

  test("exports a caption-free MP4 without publishing an empty SRT", async () => {
    const published: string[] = [];
    const processors = createMediaJobProcessors({
      resolveAssetPath: async (_scope, assetId) => files.get(assetId)!,
      publishArtifact: async (_scope, path, mimeType) => {
        expect((await stat(path)).size).toBeGreaterThan(0);
        published.push(mimeType);
        return { id: "published" };
      },
    });
    const project: MediaRenderProject = {
      schemaVersion: 1,
      revision: 9,
      fps: 30,
      width: 160,
      height: 90,
      assets: [{ id: "video", kind: "video" }],
      clips: [{ id: "v", assetId: "video", inFrame: 0, outFrame: 15, volume: 1 }],
      captions: [],
    };
    const result: any = await processors.render!.run({ project }, await context());
    expect(result.subtitles).toBeNull();
    expect(published).toEqual(["video/mp4"]);
  }, 15000);

  test("rejects disguised local and network playlists before following their references", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end("unexpected request");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      const playlists = [
        `ffconcat version 1.0\nfile '${files.get("audio")}'\n`,
        `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:2.4,\nhttp://127.0.0.1:${address.port}/secret.ts\n#EXT-X-ENDLIST\n`,
        `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:2.4,\n${files.get("audio")}\n#EXT-X-ENDLIST\n`,
      ];
      for (const [index, content] of playlists.entries()) {
        const malicious = join(root, `disguised-${index}.mp4`);
        await writeFile(malicious, content);
        files.set(`disguised-${index}`, malicious);
        await expect(inspectMediaFile(malicious, await context())).rejects.toThrow(
          /whitelist|Invalid data/,
        );
        await expect(
          handlers().proxy!.run({ assetId: `disguised-${index}` }, await context()),
        ).rejects.toThrow(/whitelist|Invalid data/);
      }
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  test("cancels every handler before effects and terminates an active FFmpeg task with real progress", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const processor of Object.values(handlers()))
      await expect(
        processor.run({ assetId: "video" }, await context(controller.signal)),
      ).rejects.toMatchObject({ name: "AbortError" });
    const running = new AbortController();
    let measured = false;
    const started = Date.now();
    await expect(
      runMediaProcess(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostdin",
          "-progress",
          "pipe:1",
          "-re",
          "-f",
          "lavfi",
          "-i",
          "color=red:s=160x90:r=30:d=30",
          "-f",
          "null",
          "-",
        ],
        {
          signal: running.signal,
          durationSeconds: 30,
          onProgress: () => {
            measured = true;
            running.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(measured).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);

  test.skipIf(process.env.CODESHELL_MEDIA_TEST_ASR !== "1")(
    "runs real local Chinese Whisper transcription with segment and word times",
    async () => {
      const spoken = join(root, "spoken.aiff");
      await runMediaProcess(
        "say",
        ["-v", "Tingting", "-r", "150", "-o", spoken, "你好，这是视频剪辑测试。请保留重要内容。"],
        { signal: signal() },
      );
      files.set("spoken", spoken);
      const result: any = await handlers().transcribe!.run(
        { assetId: "spoken", language: "zh" },
        await context(),
      );
      const transcript = JSON.parse(await readFile(result.transcript.path, "utf8"));
      expect(transcript.engine).toBe("local-whisper");
      expect(transcript.language).toBe("zh");
      expect(transcript.text.trim().length).toBeGreaterThan(0);
      expect(result.segmentCount).toBeGreaterThan(0);
      expect(result.wordCount).toBeGreaterThan(0);
      expect(
        transcript.segments.every(
          (segment: any) => segment.end > segment.start && segment.start >= 0,
        ),
      ).toBe(true);
      expect(
        transcript.segments.some((segment: any) =>
          segment.words.some((word: any) => word.end > word.start),
        ),
      ).toBe(true);
    },
    120000,
  );
});
