/**
 * Real production acceptance test, deliberately using a deterministic edit plan.
 * This does not pretend to exercise a configured LLM. It exercises the same Host
 * media jobs, local ASR, HyperFrames renderer, caption renderer and MP4 pipeline.
 * Bundle with esbuild (platform=node, format=esm, external=electron), run Electron.
 */
import { app, nativeImage } from "electron";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PanelMediaService } from "../src/main/media/panel-media-service.js";
import { MediaCaptionRenderer } from "../src/main/media/media-caption-renderer.js";
import type { MediaJob, MediaScope } from "../src/main/media/media-types.js";
import type { MediaRenderProject } from "../src/main/media/media-processors.js";

app.disableHardwareAcceleration();
app.on("window-all-closed", () => undefined);
const execute = promisify(execFile);
const output = resolve(process.argv[2] ?? "artifacts/video-studio/production-smoke");
const controller = new AbortController();
const evidence: Record<string, any> = {
  version: 1,
  startedAt: new Date().toISOString(),
  decisionEngine: "deterministic acceptance fixture; no configured LLM invoked",
  sourceText:
    "你好，这是视频工作台的自动制作测试。我们先整理素材，再识别语音和字幕。最后加入章节画面与背景音乐，导出完整视频。",
  jobs: [],
};
let service: PanelMediaService | undefined;
const captionRenderer = new MediaCaptionRenderer();
const probe = async (path: string) =>
  JSON.parse(
    (
      await execute(
        "ffprobe",
        ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
        { signal: controller.signal },
      )
    ).stdout,
  );
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const saveEvidence = () =>
  writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));

async function run(): Promise<void> {
  await mkdir(output, { recursive: true });
  if (
    (await exists(join(output, "evidence.json"))) &&
    !(await exists(join(output, "first-run-evidence.json")))
  )
    await copyFile(join(output, "evidence.json"), join(output, "first-run-evidence.json"));
  const workspace = join(output, "workspace");
  await mkdir(workspace, { recursive: true });
  const scope: MediaScope = { appId: "video-studio", projectPath: workspace };
  const events = new Map<string, Array<{ elapsedMs: number; stage?: string; fraction?: number }>>();
  const began = Date.now();
  service = new PanelMediaService({
    rootDirectory: join(output, "store"),
    isScopeAuthorized: (value) =>
      value.appId === scope.appId && value.projectPath === scope.projectPath,
    renderCaptionPng: (request, context) => captionRenderer.render(request, context),
    onChanged: (_scope, job) => {
      const history = events.get(job.id) ?? [];
      const previous = history.at(-1);
      if (
        !previous ||
        job.progress?.stage !== previous.stage ||
        Date.now() - began - previous.elapsedMs > 1000
      ) {
        history.push({ elapsedMs: Date.now() - began, ...job.progress });
        events.set(job.id, history);
      }
      if (["failed", "succeeded", "cancelled"].includes(job.status)) captionRenderer.close(job.id);
    },
  });
  const wait = async (job: MediaJob, label: string): Promise<any> => {
    process.stdout.write(`${label}: ${job.id}\n`);
    const started = Date.now(),
      deadline = started + 240000;
    while (Date.now() < deadline) {
      const next = await service!.jobs.get(scope, job.id);
      if (["failed", "cancelled", "succeeded"].includes(next.status)) {
        evidence.jobs.push({
          label,
          jobId: next.id,
          type: next.type,
          status: next.status,
          elapsedMs: Date.now() - started,
          attempt: next.attempt,
          progress: events.get(next.id) ?? [],
          result: next.result,
          error: next.error,
        });
        await saveEvidence();
        if (next.status !== "succeeded") throw new Error(`${label}: ${JSON.stringify(next.error)}`);
        return next.result;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await service!.jobs.cancel(scope, job.id);
    throw new Error(`${label} exceeded four minutes`);
  };

  const spoken = join(workspace, "speech.aiff"),
    source = join(workspace, "source.mp4"),
    music = join(workspace, "background.wav");
  if (!(await exists(spoken)))
    await execute("say", ["-v", "Tingting", "-r", "155", "-o", spoken, evidence.sourceText], {
      signal: controller.signal,
    });
  const spokenProbe = await probe(spoken),
    sourceSeconds = Number(spokenProbe.format.duration);
  assert(sourceSeconds > 3 && sourceSeconds < 45);
  if (!(await exists(source)))
    await execute(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x20364a:s=640x360:r=30:d=${sourceSeconds / 2}`,
        "-f",
        "lavfi",
        "-i",
        `color=c=0x294a42:s=640x360:r=30:d=${sourceSeconds / 2}`,
        "-i",
        spoken,
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
        "-shortest",
        "-movflags",
        "+faststart",
        source,
      ],
      { signal: controller.signal },
    );
  if (!(await exists(music)))
    await execute(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=0.08*sin(2*PI*196*t)+0.03*sin(2*PI*293.66*t):s=48000:d=${sourceSeconds + 4}`,
        "-c:a",
        "pcm_s16le",
        music,
      ],
      { signal: controller.signal },
    );
  evidence.runtime = await service.dispatch(scope, "media.status", {});
  assert.equal(evidence.runtime.ffmpeg.available, true);
  assert.equal(evidence.runtime.transcription.available, true);
  assert.equal(evidence.runtime.hyperframes.available, true);
  evidence.sourceProbe = await probe(source);

  const imported = await wait(
    await service.importFiles(scope, [source, music]),
    "import actual video and BGM",
  );
  const [videoAsset, musicAsset] = imported.assets;
  const preparation = (await service.dispatch(scope, "media.prepare", {
    assetIds: [videoAsset.id],
    transcribe: true,
  })) as { jobs: MediaJob[] };
  const prepared = await wait(preparation.jobs[0]!, "prepare video with local timestamped ASR");
  assert.equal(prepared.inspection.video.codec, "h264");
  assert(prepared.proxy.asset.id && prepared.thumbnail.asset.id);
  assert(prepared.waveform.peaks.some((peak: number) => peak > 0.01));
  assert(prepared.transcription.segmentCount > 0);
  const musicPreparation = (await service.dispatch(scope, "media.prepare", {
    assetIds: [musicAsset.id],
  })) as { jobs: MediaJob[] };
  await wait(musicPreparation.jobs[0]!, "prepare independent background audio");

  const segments: Array<{
    start: number;
    end: number;
    text: string;
    words: Array<{ start: number; end: number; text: string }>;
  }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await service.dispatch(scope, "media.transcript", {
      assetId: videoAsset.id,
      offset,
      limit: 100,
    })) as any;
    segments.push(...page.segments);
    if (segments.length >= page.total) break;
  }
  assert(segments.length > 0 && segments.every((segment) => segment.end > segment.start));
  assert(segments.some((segment) => segment.words.some((word) => word.end > word.start)));
  assert(/[\u3400-\u9fff]/.test(segments.map((segment) => segment.text).join("")));
  evidence.transcript = { engine: "local-whisper", model: "base", segments };
  evidence.analysis = {
    silence: await service.dispatch(scope, "media.analysis", {
      assetId: videoAsset.id,
      kind: "silence",
      limit: 100,
    }),
    scenes: await service.dispatch(scope, "media.analysis", {
      assetId: videoAsset.id,
      kind: "scenes",
      limit: 100,
    }),
  };
  // Completed preparation requests must re-enter processor cache validation.
  // Only concurrent queued/running requests may reuse the same public job ID.
  const repeated = (await service.dispatch(scope, "media.prepare", {
    assetIds: [videoAsset.id],
    transcribe: true,
  })) as { jobs: MediaJob[] };
  assert.notEqual(repeated.jobs[0]!.id, preparation.jobs[0]!.id);
  const cached = await wait(
    repeated.jobs[0]!,
    "repeat public preparation from verified cached artifacts",
  );
  assert.equal(cached.proxy.asset.id, prepared.proxy.asset.id);
  assert.equal(cached.thumbnail.asset.id, prepared.thumbnail.asset.id);
  evidence.cache = {
    sameProxyId: true,
    sameThumbnailId: true,
    publicPreparationJobIdsDiffer: true,
  };

  const chapter = await wait(
    (await service.dispatch(scope, "media.scene", {
      params: {
        kind: "chapter",
        title: "从素材到成片",
        subtitle: "真实语音 · 中文字幕 · 章节与配乐",
        eyebrow: "VIDEO STUDIO / ACCEPTANCE",
        durationSeconds: 2,
        width: 640,
        height: 360,
        palette: { background: "#102a28", foreground: "#edf7ee", accent: "#b6efca" },
      },
    })) as MediaJob,
    "render a real HyperFrames chapter",
  );
  assert(chapter.asset.id && chapter.scene.contentHash && chapter.scene.rendererVersion);
  const chapterFrames = Math.round(chapter.durationSeconds * 30);
  const first = Math.max(0, Math.floor(Math.min(...segments.map((segment) => segment.start)) * 30));
  const last = Math.min(
    Math.floor(prepared.inspection.durationSeconds * 30),
    Math.ceil(Math.max(...segments.map((segment) => segment.end)) * 30),
  );
  assert(last > first);
  const totalFrames = chapterFrames + last - first;
  const subtitleRuns: Array<{ start: number; end: number; text: string }> = [];
  for (const segment of segments) {
    if (!segment.words.length) {
      subtitleRuns.push(segment);
      continue;
    }
    let words: typeof segment.words = [];
    const flush = () => {
      if (words.length)
        subtitleRuns.push({
          start: words[0]!.start,
          end: words.at(-1)!.end,
          text: words
            .map((word) => word.text)
            .join("")
            .trim(),
        });
      words = [];
    };
    for (const word of segment.words) {
      words.push(word);
      if (
        /[，,。！？!?；;]$/.test(word.text.trim()) ||
        words.map((entry) => entry.text).join("").length >= 24 ||
        word.end - words[0]!.start >= 4
      )
        flush();
    }
    flush();
  }
  const captions = subtitleRuns
    .filter((segment) => segment.text.trim())
    .map((segment, index) => ({
      id: `caption-${index}`,
      startFrame: Math.max(chapterFrames, chapterFrames + Math.round(segment.start * 30) - first),
      endFrame: Math.min(totalFrames, chapterFrames + Math.round(segment.end * 30) - first),
      text: segment.text.trim(),
    }))
    .filter((caption) => caption.endFrame > caption.startFrame);
  assert(
    captions.every(
      (caption, index) => index === 0 || captions[index - 1]!.endFrame <= caption.startFrame,
    ),
  );
  const project: MediaRenderProject = {
    schemaVersion: 1,
    revision: 1,
    fps: 30,
    width: 640,
    height: 360,
    assets: [
      { id: videoAsset.id, kind: "video" },
      { id: musicAsset.id, kind: "audio" },
      { id: chapter.asset.id, kind: "video" },
    ],
    clips: [
      { id: "chapter", assetId: chapter.asset.id, inFrame: 0, outFrame: chapterFrames, volume: 1 },
      { id: "speech", assetId: videoAsset.id, inFrame: first, outFrame: last, volume: 1 },
    ],
    captions,
    audioClips: [
      {
        id: "background",
        assetId: musicAsset.id,
        startFrame: 0,
        inFrame: 0,
        outFrame: totalFrames,
        volume: 0.18,
      },
    ],
  };
  evidence.plan = {
    explanation:
      "Deterministic acceptance plan: preserve the actual first-to-last ASR speech range, prepend the generated chapter, group actual timestamped words by punctuation/24 characters/4 seconds without correcting recognition, shift captions by the chapter duration, add independent low-volume BGM.",
    project,
  };
  await writeFile(join(output, "project.json"), JSON.stringify(project, null, 2));
  const rendered = await wait(
    (await service.dispatch(scope, "media.render", { project })) as MediaJob,
    "render burned Chinese captions and independent BGM to MP4",
  );
  const video = join(output, "production.mp4"),
    srtPath = join(output, "production.srt");
  await service.exportFile(scope, rendered.video.asset.id, video);
  await service.exportFile(scope, rendered.subtitles.asset.id, srtPath);
  const inspected = await probe(video),
    srt = await readFile(srtPath, "utf8");
  assert.equal(
    inspected.streams.find((stream: any) => stream.codec_type === "video").codec_name,
    "h264",
  );
  assert.equal(
    inspected.streams.find((stream: any) => stream.codec_type === "audio").codec_name,
    "aac",
  );
  assert(Math.abs(Number(inspected.format.duration) - totalFrames / 30) < 0.12);
  assert.equal(srt.split(" --> ").length - 1, captions.length);
  for (const caption of captions) assert(srt.includes(caption.text));
  const srtTimes = [
    ...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})/g),
  ].map((match) => [
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000,
    Number(match[5]) * 3600 + Number(match[6]) * 60 + Number(match[7]) + Number(match[8]) / 1000,
  ]);
  assert(
    srtTimes.every(
      ([start, end]) =>
        start! >= chapterFrames / 30 && end! > start! && end! <= totalFrames / 30 + 0.001,
    ),
  );

  const frames = [
    { name: "chapter", seconds: 0.9 },
    ...captions.slice(0, 3).map((caption, index) => ({
      name: `caption-${index + 1}`,
      seconds: (caption.startFrame + caption.endFrame) / 60,
    })),
  ];
  const frameEvidence: Array<{
    name: string;
    seconds: number;
    path: string;
    whiteCaptionPixels: number;
  }> = [];
  for (const frame of frames) {
    const path = join(output, `${frame.name}.png`);
    await execute(
      "ffmpeg",
      ["-v", "error", "-y", "-ss", String(frame.seconds), "-i", video, "-frames:v", "1", path],
      { signal: controller.signal },
    );
    const image = nativeImage.createFromPath(path),
      bitmap = image.toBitmap(),
      size = image.getSize();
    assert.equal(size.width, 640);
    assert.equal(size.height, 360);
    let whiteCaptionPixels = 0;
    for (let y = 230; y < 340; y++)
      for (let x = 0; x < 640; x++) {
        const pixel = (y * 640 + x) * 4;
        if (bitmap[pixel]! > 210 && bitmap[pixel + 1]! > 210 && bitmap[pixel + 2]! > 210)
          whiteCaptionPixels++;
      }
    if (frame.name.startsWith("caption"))
      assert(whiteCaptionPixels > 80, `Missing burned caption at ${frame.seconds}s`);
    frameEvidence.push({ ...frame, path, whiteCaptionPixels });
  }
  const pcm = await execute(
    "ffmpeg",
    ["-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"],
    { signal: controller.signal, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
  );
  const rms = (start: number, end: number) => {
    let sum = 0,
      count = 0;
    for (
      let sample = Math.floor(start * 8000);
      sample < Math.min(pcm.stdout.length / 4, Math.floor(end * 8000));
      sample++
    ) {
      sum += pcm.stdout.readFloatLE(sample * 4) ** 2;
      count++;
    }
    return Math.sqrt(sum / Math.max(1, count));
  };
  const chapterRms = rms(0.3, 1.5),
    speechRms = rms(
      captions[0]!.startFrame / 30 + 0.2,
      Math.min(captions[0]!.endFrame / 30, captions[0]!.startFrame / 30 + 2),
    );
  assert(chapterRms > 0.001, "Independent BGM is absent from the silent chapter");
  assert(speechRms > chapterRms * 1.2, "Source speech is absent from the mixed output");
  evidence.output = {
    path: video,
    srtPath,
    probe: inspected,
    frames: frameEvidence,
    chapterRms,
    speechRms,
  };
  evidence.assertions = [
    "real local Chinese ASR with segment and word times",
    "persistent type-specific preparation and verified cache reuse",
    "real HyperFrames chapter rendered and inserted",
    "captions shifted from actual source transcript and visibly burned",
    "independent BGM audible during the silent chapter",
    "source speech remains audible",
    "H264/AAC MP4 and consistent SRT frame timing",
  ];
  evidence.passed = true;
  evidence.completedAt = new Date().toISOString();
  await saveEvidence();
  await service.jobs.shutdown();
  process.stdout.write(`Production smoke passed: ${video}\n`);
  app.quit();
}

void app
  .whenReady()
  .then(run)
  .catch(async (error) => {
    evidence.passed = false;
    evidence.error = error instanceof Error ? error.stack : String(error);
    await mkdir(output, { recursive: true });
    await saveEvidence();
    process.stderr.write(`${evidence.error}\n`);
    controller.abort();
    await service?.jobs.shutdown();
    app.exit(1);
  });
